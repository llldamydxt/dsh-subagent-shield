/**
 * dsh-subagent-shield v4 —— 子代理信息隔断（保护对象细到「工作区 / 窗口」）
 *
 * 相对 v3 的变化：
 *   · 判定不再用"一刀切的根目录前缀"，而是**把目标路径解析成 (工作区, 窗口)**，
 *     再按规则文件逐目标决定保护与否（见 classifyTarget / isProtected）。
 *   · 规则存在 <DSH_HOME>\subagent-shield-rules.json，由设置页面通过 HTTP 读写。
 *   · 新增 GET/POST /dsh-subagent-shield/rules，以及 /status 里带上工作区/窗口清单。
 *
 * 语义：
 *   defaultPolicy = 'protect'（默认保护全部）或 'allow'（默认不保护，只保护下面点名的）
 *   然后按 窗口 > 工作区 > 默认 的优先级逐层覆盖：
 *     windows:    { "<session id>": true|false }
 *     workspaces: { "<cwd 编码目录名>": true|false }
 *
 * 边界（不变）：这是工具层策略围栏；路径族精确判定，命令族只能文本启发式。
 */

import z from '@deepseek-ai/schemastery'
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'

const WIDGET_FILE = join(dirname(fileURLToPath(import.meta.url)), 'widget.js')
const WIDGET_SRC = '/dsh-subagent-shield/widget.js'
const STATUS_SRC = '/dsh-subagent-shield/status'
const RULES_SRC = '/dsh-subagent-shield/rules'

/** 真实版本号：从自己的 package.json 读，别再手写字面量（踩过：接口报 0.4.0 而实际 0.4.5）。 */
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? 'unknown'
  } catch { return 'unknown' }
})()

export const name = 'dsh-subagent-shield'

/** webServer 用可选注入：headless 等没有 web server 的形态自动跳过。 */
export const inject = ['commands']

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  scope: z.union(['subagents', 'all']).default('subagents').volatile(),
  mode: z.union(['all', 'window']).default('all').volatile(),
  protectSessions: z.boolean().default(true).volatile(),
  protectProjcache: z.boolean().default(true).volatile(),
  protectCredentials: z.boolean().default(true).volatile(),
  guardShellText: z.boolean().default(true).volatile(),
  // ★ 「谁写的谁拥有」——子代理写出的文件自动归它，别的子代理读不了（自动臂间隔离）。
  //   默认开：符合"随手建个文件夹、开个窗口、派两个子代理就跑对照实验"的用法。
  //   不需要时两条退路：① 设置里关掉这一项；② 把那个窗口在「按窗口」里设成「放行」。
  autoOwnWrites: z.boolean().default(true).volatile(),
  // ★ `%DSH_HOME%` 默认全拒（工作区子树除外）。
  //   原来的策略是"点名保护几类目录"—— 而**清单不可能完备**：独立验证（对照实验 01）
  //   实测到 4 条没覆盖的通道（attachments / request-images / files-v3 / logs），
  //   其中两条是**整幅内容**（别的会话的原图与请求截图）。改成默认全拒后，这类"又漏一条"不再出现。
  denyHomeByDefault: z.boolean().default(true).volatile(),
  // ★ 标签豁免：名字里含这些词的子代理**不受「谁写的谁拥有」管辖** —— 让「写一个、独立审一个」
  //   不必每次敲 /shield 放行。逗号分隔。⚠️ 只对归属层生效：%DSH_HOME% 默认全拒与
  //   protectedPaths **照旧拦**（复核者能读别人的产物，但不能读宿主记录）。
  ownerExemptLabels: z.string().default('复核,审计,评审,独立,复算,对抗,验证,verify,review,audit,recompute,adversarial').volatile(),
  auditEnabled: z.boolean().default(true).volatile(),
  auditFile: z.string().default('').volatile(),
  dshHome: z.string().default('').volatile(),
})

// ═══════════════════════════════════════════ 纯函数（可完整单测）

/**
 * 每个工具**真正持有路径的参数名**（照 dsh-tool-fs / dsh-tool-fs-search 的真实 schema 抄的）。
 *
 * ⚠ 踩过的坑：`glob` / `grep` 的 `pattern` 是**必填**、`path` 是**可选**（默认会话工作区）。
 *   只查 `path` 时，子代理把绝对路径写进 `pattern`、`path` 留空，检查就整段跳过 ——
 *   实测被这样绕过去一次（glob 列举出 137 条别的会话路径）。
 *   教训同 `settingsScope`：**参数名不能靠猜，要去读真实 schema**。
 */
const PATH_ARGS = {
  read: ['file_path'], read_image: ['file_path'], write: ['file_path'], edit: ['file_path'],
  str_replace_editor: ['path'],
  glob: ['path', 'pattern'],
  grep: ['path', 'pattern', 'include'],
}
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'run_code', 'cordis_define'])
/** 会**产生新文件**的工具（写入后要登记归属）。 */
export const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'multi_edit', 'apply_patch', 'create_file'])

/**
 * 比对两份配置快照，返回可读差异（纯函数，便于单测）。
 *
 * 为什么：使用者提的纪律要求 —— 「改本插件前先跟用户说一声，别为了考试作弊把监考老师踢出去」。
 * 拦不住（同一用户同一台机器），所以只能**留痕**。
 *
 * @param prev - 上次看到的快照（null 表示没有基线）
 * @param now - 本次读到的快照
 * @returns 形如 ["enabled: true → false"]；无差异或无基线时返回 []
 */
export function diffConfig(prev, now) {
  if (!prev || !now) return []
  const keys = new Set([...Object.keys(prev), ...Object.keys(now)])
  const out = []
  for (const k of keys) {
    const a = prev[k] === undefined ? '(无)' : String(prev[k])
    const b = now[k] === undefined ? '(无)' : String(now[k])
    if (a !== b) out.push(k + ': ' + a + ' → ' + b)
  }
  return out
}
/** 会**列举/搜索**目录的工具（按"整个目录里有没有别人的产物"判）。 */
export const LIST_TOOLS = new Set(['glob', 'grep'])

/** 去引号、`/`→`\`、去 `\\?\`、消解 `.`/`..`、统一小写。空输入返回空串。 */
export function normalizePath(input) {
  // ⚠ 空输入必须返回空串，不能返回 `'\'`：
  //   否则 `normalizePath(x) || 默认值` 这种兜底会因 `'\'` 是 truthy 而走错分支。
  //   实测踩过：账本的默认路径兜底因此失效，账本文件失去保护。
  if (typeof input !== 'string' || input.trim() === '') return ''
  let p = input.trim()
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, -1)
  p = p.replace(/\//g, '\\').replace(/^\\\\\?\\/, '')
  const m = /^([a-zA-Z]:)?(.*)$/.exec(p)
  const drive = (m[1] ?? '').toUpperCase()
  const parts = []
  for (const seg of m[2].split('\\')) {
    if (!seg || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  return `${drive}\\${parts.join('\\')}`.toLowerCase()
}

/** 本插件自己的文件（账本/状态/规则）永远保护，与用户规则无关。 */
export function selfRoots(home, auditFile) {
  const h = normalizePath(home).replace(/\\+$/, '')
  if (!h) return []
  const rs = [
    { path: `${h}\\subagent-shield-state.json`, label: '本插件的窗口开关状态文件' },
    { path: `${h}\\subagent-shield-rules.json`, label: '本插件的保护规则文件' },
    // ★ 产物归属登记表也要保护：它是"谁写的谁拥有"的唯一凭据，被子代理改掉就等于关掉隔离
    { path: `${h}\\subagent-shield-owns.json`, label: '本插件的产物归属登记表' },
  ]
  // 账本**无条件**保护，而且要**两个路径都保护**：
  //   · 默认路径：即使关掉了"记录新拒绝"、或把账本改到了别处，**历史账本仍躺在默认路径上**，
  //     里面含着别的工作区/窗口的路径与 id（元数据）。
  //   踩过两次同一个坑：第一次是"只在 auditEnabled=true 时才交给判定"，
  //   第二次是"只保护当前 auditFile 指向的那一个"（自定义路径时默认路径失守）。
  //   所以：默认路径恒常并入，自定义路径不同则一并并入。
  const defAudit = `${h}\\subagent-shield-audit.jsonl`
  rs.push({ path: defAudit, label: '本插件的违规审计账本（默认路径）' })
  const custom = normalizePath(auditFile)
  if (custom && custom !== defAudit) {
    rs.push({ path: custom, label: '本插件的违规审计账本（自定义路径）' })
  }
  return rs
}

/**
 * 把一个目标路径解析成「它属于哪个工作区 / 哪个窗口 / 哪一类保护对象」。
 * @returns {{kind:'sessions'|'projcache'|'credentials', ws?:string|null, sid?:string|null}|null}
 */
export function classifyTarget(home, rawPath) {
  const h = normalizePath(home).replace(/\\+$/, '')
  const t = normalizePath(rawPath)
  if (!h || !t) return null
  if (t === `${h}\\.credentials.yaml`) return { kind: 'credentials' }
  const sessRoot = `${h}\\sessions`
  if (t === sessRoot) return { kind: 'sessions', ws: null, sid: null }
  if (t.startsWith(`${sessRoot}\\`)) {
    const rel = t.slice(sessRoot.length + 1).split('\\').filter(Boolean)
    return { kind: 'sessions', ws: rel[0] ?? null, sid: rel[1] ?? null }
  }
  const projRoot = `${h}\\storages\\session_projcache`
  if (t === projRoot) return { kind: 'projcache', sid: null }
  // `${h}\storages` 本目录也归 projcache 类（按祖先并集判）。
  // 为什么：`isProtected` 的立场是"目录列举本身也是信息泄露"，
  // 而列出 storages 就能确认 session_projcache 的存在与位置；不覆盖它就是自相矛盾。
  if (t === `${h}\\storages`) return { kind: 'projcache', sid: null }
  if (t.startsWith(`${projRoot}\\`)) {
    const tail = t.slice(projRoot.length + 1)
    const sid = tail.replace(/^sessions\\/, '').replace(/\.json$/i, '')
    return { kind: 'projcache', sid: sid || null }
  }
  return null
}

/**
 * 规则表的派生聚合值（"有没有任何一条 true"），**按规则对象缓存**。
 *
 * 为什么必须有缓存：`Object.values(rules.windows).some(Boolean)` 每次判定都铺开整张表。
 * 实测（本机）：规则 0 条 4.7 µs → 6400 条 **3439 µs（3.4 ms，732×）**，
 * 而读无关文件的快路径全程恒定 ~15 µs。设置页的设计意图恰恰是"逐条点名"，
 * 所以这个劣化正好惩罚它自己的主用法。
 *
 * 缓存安全的**前提**：规则变更时**换一个新对象**，而不是就地改字段
 * （`loadRules()` 本来就换新对象；POST /rules 也已改成换新对象）。用 WeakMap
 * 就没有失效逻辑要维护，也不会阻止旧对象被回收。
 */
const aggCache = new WeakMap()
function aggOf(rules) {
  if (!rules || typeof rules !== 'object') return { anyWin: false, anyWs: false }
  let a = aggCache.get(rules)
  if (!a) {
    a = {
      anyWin: Object.values(rules.windows ?? {}).some(Boolean),
      anyWs: Object.values(rules.workspaces ?? {}).some(Boolean),
    }
    aggCache.set(rules, a)
  }
  return a
}

/**
 * 该目标是否受保护。
 *
 * 优先级：**具体窗口 > 具体工作区 > 目录级（后代的并集）> defaultPolicy**
 *
 * ⚠ 为什么"目录级"不能直接回落到 defaultPolicy —— 实测漏过一手：
 *   `defaultPolicy=allow` + 逐条全部 `true`（"只拦住点名的"）时，把 `path` 指向
 *   `…\.dsh\sessions` **根目录**，解析出来 `{ws:null, sid:null}`，没有任何具体对象可查，
 *   回落到 `allow` → **放行** → glob 一次列出 138 条别的会话路径。
 *   点名的上级目录成了后门。
 *
 * 正确语义：**祖先按后代的并集判** —— 只要它下面还有任何一个对象是"拦"的，
 * 对它的目录级查询就必须拦（否则等于绕过）。目录列举本身也是信息泄露。
 */
export function isProtected(info, rules, cats = {}) {
  if (!info) return false
  const has = (obj, k) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, k)
  if (info.kind === 'credentials') return cats.protectCredentials !== false

  const dflt = (rules?.defaultPolicy ?? 'protect') !== 'allow'
  const { anyWin, anyWs } = aggOf(rules)
  /** 目录级（拿不到具体对象）时的判定：默认保护，或下面还有任何受保护的对象 */
  const ancestorProtected = (extra) => Boolean(extra) || dflt || anyWin || anyWs

  /**
   * 是不是"一个具体对象"。
   * `**` / `*` / `?` 这种**通配符代表一批对象**，必然包含受保护的那些 ——
   * 必须按祖先处理，**绝不能因为它不在规则表里就回落到宽松默认**。
   * 实测踩过：`pattern = <home>\sessions\**\*.jsonl.zstd` 解析出 ws=`**`、sid=`*.jsonl.zstd`，
   * 两者都不在规则表 → 回落到 defaultPolicy=allow → **放行**（当时只是恰好没匹配到文件才没泄露）。
   */
  const concrete = (s) => typeof s === 'string' && s.length > 0 && !/[*?]/.test(s)

  if (info.kind === 'projcache') {
    if (cats.protectProjcache === false) return false
    if (info.sid && !concrete(info.sid)) return ancestorProtected(anyWin)   // 通配 sid = 一批窗口
    if (info.sid && has(rules?.windows, info.sid)) return Boolean(rules.windows[info.sid])
    if (!info.sid) return ancestorProtected(anyWin)                         // projcache 根
    return dflt
  }

  if (cats.protectSessions === false) return false
  // 规范第 1 条：**任一身份不确定（通配 / 缺失）⇒ 先保守**，不再去看"被点名的窗口"。
  //   通配前缀代表查询面很宽，不能只凭一个具体名字就放行。
  //   （族谱矩阵 M1 抓到过内部不自洽：ws=null+sid 已豁免 会放行，ws=**+同一 sid 却拦。）
  if (!concrete(info.sid) || !concrete(info.ws)) {
    // 唯一例外：这个具体工作区被点名"保护" → 必须拦
    if (concrete(info.ws) && has(rules?.workspaces, info.ws) && rules.workspaces[info.ws] === true) return true
    return ancestorProtected(false)
  }
  if (has(rules?.windows, info.sid)) return Boolean(rules.windows[info.sid])
  if (info.ws && has(rules?.workspaces, info.ws)) {
    // 该工作区被单独设过。
    // ⚠ 目录级查询（sid 为空）不能只看这个工作区的 flag：
    //   `defaultPolicy=protect` 时，它下面**未点名的窗口仍然受保护**，列举该目录
    //   会拿到那些窗口的 id（元数据泄漏）。所以 dflt 也要算进来。
    //   这条由「族谱矩阵」M2 抓到。
    if (!info.sid) return Boolean(rules.workspaces[info.ws]) || anyWin || dflt
    return Boolean(rules.workspaces[info.ws])
  }
  if (info.ws && !info.sid) return ancestorProtected(false)  // 未点名工作区的目录级
  if (!info.ws) return ancestorProtected(false)              // sessions 根
  return dflt
}

const SHELL_NEEDLES = [
  { cat: 'sessions', re: /\.dsh[\\/]+sessions/i, why: '会话落盘目录' },
  { cat: 'sessions', re: /DSH_HOME[^\r\n]{0,60}[\\/]sessions/i, why: '会话落盘目录（用 $env:DSH_HOME 拼出来的）' },
  { cat: 'sessions', re: /session(_projcache|\.v\d+\.jsonl|\.jsonl)/i, why: '会话文件或投影缓存' },
  { cat: 'sessions', re: /[\\/]sessions[\\/]/i, why: '会话落盘目录' },
  { cat: 'sessions', re: /--C-Users-[^\s"'\\/]*--/i, why: '按 cwd 编码的工作区会话目录' },
  // ★ 补：宿主数据目录本身（默认全拒之后，连"碰一下 .dsh"都该拦）
  // ★ 分隔符集合要够全：实测漏过 ';'（`...\.dsh'; Get-ChildItem $p` 放行过）
  { cat: 'sessions', re: /[\\/]\.dsh(?:[\\/]|["'\s;,)|&`]|$)/i, why: '宿主数据目录 %DSH_HOME%' },
  { cat: 'sessions', re: /attachments[\\/]+v1|request-images|files-v3\.json|llm-deepseek/i, why: '宿主数据目录里的附件/截图/登记表' },
  { cat: 'credentials', re: /\.credentials\.ya?ml/i, why: '宿主凭据文件' },
  { cat: 'state', re: /subagent-shield-(audit|state|rules|owns)\.json/i, why: '本插件的账本/状态/规则/归属登记文件' },
]

/**
 * 把**朴素混淆**还原成字面量，再交给上面的正则判定。
 *
 * 为什么加：独立验证（对照实验 01）里，臂把 `sessions` 用 `String.fromCharCode` / `[char]NN`
 * 拼出来就绕过了文本匹配。
 *
 * ⚠️ 这**只是提高成本**：变量、base64、`Resolve-Path`、`cmd /c` 套壳仍然能绕 ——
 * 它永远不是边界（宿主层没有读隔离，已查证：DSH 的沙箱是 WRITE_RESTRICTED，只限制写）。
 */
export function deobfuscate(text) {
  let s = String(text ?? '')
  // String.fromCharCode(115,101,...) / fromCharCode(0x73,...)
  s = s.replace(/fromCharCode\s*\(([^)]{0,400})\)/gi, (m, args) => {
    try {
      const codes = args.split(',').map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n))
      if (!codes.length) return m
      return codes.map((n) => String.fromCharCode(n)).join('')
    } catch { return m }
  })
  // [char]115 / [char]0x73 / [char]0X73
  s = s.replace(/\[char\]\s*(0x[0-9a-f]+|\d+)/gi, (m, v) => {
    const n = /^0x/i.test(v) ? parseInt(v, 16) : Number(v)
    return Number.isFinite(n) ? String.fromCharCode(n) : m
  })
  // \x73  \u0073
  s = s.replace(/\\x([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/\\u([0-9a-f]{4})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
  // PowerShell 的 -join/字符串拼接里常见的 '' + 分段还原：把 '…'+'…' 直接接起来
  s = s.replace(/'\s*\+\s*'/g, '')
  s = s.replace(/"\s*\+\s*"/g, '')
  return s
}

/**
 * 紧凑副本：把引号 / 加号 / 空白 / 反引号全抹掉。
 *
 * 为什么要它：`[char]67 + [char]58 + ... + '.dsh'` 展开后是 `C + : + \ + ... + '.dsh'`，
 * 片段之间还留着 `+` 与引号 → 路径不连续 → 单看去混淆结果会漏（实测漏过 STEP8）。
 * 抹掉之后 `\.dsh;` 就连起来了。
 */
export function compactify(text) {
  return String(text ?? '').replace(/[\s'+`"]/g, '')
}

/**
 * "绕过可疑"的判据（只记 `warn`，不拦截）。
 *
 * 为什么要它：01 的独立验证发现——**成功的偷在账本里零痕迹**（账本只有 deny，没有 allow/warn）。
 * 于是"事后检测"只剩安慰作用。这条把"可疑"变成有痕迹：
 * 不阻止绕过，但让你能在事后把那一轮实验作废。
 */
const SUSPECT_NEEDLES = [
  { re: /28\s*,?\s*[Bb]5\s*,?\s*2[Ff]\s*,?\s*[Ff][Dd]/, why: '出现 zstd 帧魔数（可能在校验/解码落盘记录）' },
  { re: /zstdDecompress|createZstdDecompress|zstd\.d|DecompressSync/i, why: '调用 zstd 解压（落盘记录是多帧 zstd）' },
  { re: /fromCharCode|\[char\]/i, why: '用码点拼字符串（常见于拼敏感路径）' },
  { re: /\.dsh|DSH_HOME/i, why: '命令行里出现宿主数据目录' },
  { re: /base64|FromBase64String|-enc\b/i, why: 'base64 解码（常见于编码后绕过文本匹配）' },
  // ★★ 读盘类 API：**不拦**，只为「有人在用程序读盘」留个痕。
  //    动机（使用者的思路）：程序化读盘不可能凭空发生 —— 它总要调用读盘 API。
  //    插件看不出它读什么，但能看出**它在读**。
  { re: /readFileSync|readFile\(|readdirSync|readdir\(|createReadStream|openSync|fs\.promises/i, why: '调用了文件读取 API（程序化读盘的前置动作）' },
]

const denyText = (what, extra = '', scopeNote = '') =>
  `【已隔断】不得访问${what}。\n${extra}这是策略决定，不是临时故障，请勿重试或用其它方式绕过。${scopeNote}`

/**
 * 某一类保护当前是否真的开着（决定命令族启发式里**这一类**的针要不要生效）。
 * 分类判断的意义：把凭据保护关掉、或默认改成"不保护且没点名"时，
 * 命令族不该继续拿会话路径去误伤正常命令。
 */
export function shellCategoryActive(cat, rules, cats = {}) {
  if (cat === 'state') return true
  if (cat === 'credentials') return cats.protectCredentials !== false
  const anyTrue = (o) => Boolean(o) && Object.values(o).some(Boolean)
  if ((rules?.defaultPolicy ?? 'protect') !== 'allow') {
    return cats.protectSessions !== false || cats.protectProjcache !== false
  }
  return anyTrue(rules?.windows) || anyTrue(rules?.workspaces)
}

/** 用户可见的保护里，还有没有任何一类是开着的（不含"永远保护的本插件文件"）。 */
export function anyProtectionActive(rules, cats = {}) {
  return shellCategoryActive('credentials', rules, cats) || shellCategoryActive('sessions', rules, cats)
}

/**
 * 算出"当前到底有没有在拦东西"。
 *
 * 存在的意义：页面上有三层开关（总闸 mode / 默认策略 / 逐条覆盖）＋总开关＋三个类别开关，
 * 它们能**互相静默抵消** —— 实测踩过一次：mode=window 且全部窗口被设成 false，
 * 界面看着正常，实际上一条都没拦（19 条攻击全部得手）。所以必须由宿主算清楚、页面红字报警。
 *
 * @returns {{active:boolean, level:'ok'|'warn'|'off', reasons:string[], detail:object}}
 */
export function effectiveStatus(input = {}) {
  const { config = {}, rules = {}, overrides = {} } = input
  const reasons = []
  const enabled = config.enabled !== false
  const mode = config.mode === 'window' ? 'window' : 'all'
  const scope = config.scope === 'all' ? 'all' : 'subagents'
  const cats = {
    sessions: config.protectSessions !== false,
    projcache: config.protectProjcache !== false,
    credentials: config.protectCredentials !== false,
  }
  const vals = [...Object.values(rules.workspaces ?? {}), ...Object.values(rules.windows ?? {})]
  const anyTrue = vals.some((v) => v === true)
  const allFalse = vals.length > 0 && vals.every((v) => v === false)
  const dflt = (rules.defaultPolicy ?? 'protect') !== 'allow'

  // ① 总闸：mode=window 时必须有一个被点名为 true 的窗口，逐条检查才会跑
  const gateOpen = mode === 'window' ? Object.values(overrides ?? {}).some((v) => v === true) : true

  // ② 路径族还有没有保护对象
  const targetsProtected = dflt ? !allFalse : anyTrue
  const sessionsOn = cats.sessions && targetsProtected
  const projOn = cats.projcache && targetsProtected
  const credOn = cats.credentials

  if (!enabled) reasons.push('总开关已关闭')
  if (enabled && !gateOpen) reasons.push('模式=window，但没有任何窗口被点名 → 所有子代理都不过闸')
  if (enabled && gateOpen && !sessionsOn && !projOn && !credOn) {
    reasons.push(allFalse
      ? '所有工作区/窗口都被单独设成了"不保护"，且凭据保护也关了'
      : '默认不保护且没有任何工作区/窗口被点名，且凭据保护也关了')
  }

  const active = reasons.length === 0
  if (active && !sessionsOn && !projOn) reasons.push('会话记录与投影缓存实际未被拦截（只剩凭据受保护）')
  if (active && mode === 'window') reasons.push('模式=window：只有被点名窗口的子代理会受检查')

  return {
    active,
    level: (!enabled || !gateOpen) ? 'off' : (active ? (reasons.length ? 'warn' : 'ok') : 'off'),
    reasons,
    detail: {
      enabled, mode, scope, gateOpen, targetsProtected, allFalse, anyTrue,
      defaultPolicy: rules.defaultPolicy ?? 'protect', categories: cats,
    },
  }
}

/**
 * 核心判定。
 * @returns {{reason:string, kind:string, target:string}|null}
 */
/**
 * 是不是同一个窗口。
 *
 * 为什么要容错：DSH 里同一个会话在不同字段下**格式不一致** ——
 *   账本实测 `window` = `session-2db5727b-…`（带前缀），而 `caller` = `0aca95e5-…`（裸 uuid）。
 * 归属窗口是使用者从设置页复制的，若谁多一个 `session-` 前缀就永远匹配不上、
 * 归属者会被自己的目录拦住 —— 所以两边都剥前缀、忽略大小写再比。
 */
export function sameWindow(a, b) {
  const n = (v) => String(v ?? '').trim().toLowerCase().replace(/^session-/, '')
  const na = n(a)
  return Boolean(na) && na === n(b)
}

/**
 * 命中所配置的「自定义受保护路径」。
 *
 * 存在的理由：护盾原先只管 DSH 自己的记录（会话/投影/凭据），**完全不管实验产物**。
 * 实测：子代理 C 能直接读到兄弟臂写下的文件 —— 而在真对照实验里，
 * "A 臂看到 B 臂的产物"比"翻会话记录"常见得多。
 *
 * `owner` 是**归属窗口**：只有它（以及它的子代理）能碰这个目录，别的窗口一律拦。
 * 这样"臂 A 写自己的产物、读不到臂 B 的"就成了机制，而不是靠人记得守纪律。
 *
 * @returns {{path:string, owner:string|null}|null}
 */
export function matchProtectedPath(target, rules) {
  const t = normalizePath(target)
  if (!t) return null
  const list = Array.isArray(rules?.protectedPaths) ? rules.protectedPaths : []
  for (const e of list) {
    const p = normalizePath(e?.path)
    if (!p) continue
    // 要求以分隔符结尾，避免 `…\臂A` 误吃 `…\臂A2`
    if (t === p || t.startsWith(`${p}\\`)) {
      return { path: p, owner: e?.owner ? String(e.owner) : null, label: e?.label ? String(e.label) : null }
    }
  }
  return null
}

/**
 * 这次调用算不算这条规则的「归属者」。
 *
 * 三种判据（**任一条命中即放行**），覆盖三种跑法：
 *
 * 1. `owner` = 窗口 id         → 一臂一窗口。窗口是隔离的自然单位。
 * 2. `label` = 子代理的标签     → **一窗口多子代理**（父会话开两个子代理当两臂）。
 *    标签就是派子代理时填的 description，所以**派之前身份就定了**，没有先有鸡还是先有蛋的问题。
 * 3. `owner` = 子代理自己的会话 id → 子代理自报（它读得到 `$env:DSH_SESSION_ID`）。
 *
 * ⚠️ 判据 1 的坑（实测）：同一个窗口下的两个子代理 `parentSession` 完全相同，
 * 所以**只靠窗口分不开它们** —— 这正是判据 2 存在的理由。
 *
 * @param {{window?:string|null, callerId?:string|null, label?:string|null}} who 调用者身份
 * @param {{owner?:string|null, label?:string|null}} entry 规则条目
 */
export function isOwnerCall(who, entry) {
  if (!entry) return false
  if (entry.owner && (sameWindow(who?.window, entry.owner) || sameWindow(who?.callerId, entry.owner))) return true
  // 标签匹配：允许子串（规则里写 "臂A"，description 是 "臂A（基线组）" 也认）
  if (entry.label) {
    const want = String(entry.label).trim().toLowerCase()
    const got = String(who?.label ?? '').trim().toLowerCase()
    if (want && got && got.includes(want)) return true
  }
  return false
}

/**
 * 「谁写的谁拥有」——自动臂间隔离（判定部分，纯函数，可完整单测）。
 *
 * 为什么需要它：`protectedPaths` 要求**先知道哪个目录归哪个臂**（还要填归属、还要求每臂一个子目录）。
 * 但最常见的实际情况是"随手建一个文件夹、开个窗口、派两个子代理各做一遍" —— 那时没人愿意先配规则。
 * 这个功能让归属**自动**发生：
 *
 *   子代理写出的文件 → 自动登记成它的（会话 id + 标签）
 *   别的子代理来读/改/列 → 拦住
 *   它自己 → 照常
 *   父会话 → 照常（审计通道必须留着）
 *
 * ⚠️ 边界（必须说清，否则会被当成"安全边界"）：
 *   ① 只管**走工具管线**的写入（`write` / `edit`）。子代理用 `pwsh` 写出来的文件**登记不到**
 *      —— 命令文本里拿不到真实落盘路径。所以它是**防手滑**，不是防对抗。
 *   ② 父会话写的文件**不登记**（否则子代理连任务书都读不到）
 *      → **答案键仍然要靠你自己放对地方**，这条它替不了。
 *   ③ 这是一张插件自己维护的登记表，不是文件系统所有权；删掉或换机器就没了。
 */

/** 这个路径登记在谁名下（没登记 → null）。 */
export function ownerOf(state, normPath) {
  const o = state?.owned?.[normPath]
  return o && typeof o === 'object' ? o : null
}

/** 这个路径是否被手动放行（含其下所有文件）。 */
export function isShared(state, normPath) {
  const list = Array.isArray(state?.shared) ? state.shared : []
  for (const s of list) {
    const p = normalizePath(s)
    if (!p) continue
    if (normPath === p || normPath.startsWith(`${p}\\`)) return true
  }
  return false
}

/**
 * 这个路径是不是"别人的"（别人的 → 返回那条登记；自己的 / 没登记 / 已放行 → null）。
 * who = { callerId, label }
 */
export function isForeignOwned(state, normPath, who) {
  if (!normPath) return null
  if (isShared(state, normPath)) return null
  const o = ownerOf(state, normPath)
  if (!o) return null
  if (sameWindow(o.by, who?.callerId)) return null      // 自己写的
  // ★ 父会话：它自己窗口里的子代理写的产物算"自己的"（编排者要能读产物）；
  //   别的窗口的子代理写的仍然算"别人的"（独立验证 §5.4：原来父会话对归属层完全不设防）。
  if (who?.parentWin && o.win && sameWindow(o.win, who.parentWin)) return null
  return o
}

/**
 * 这个目录**直接下**有没有"别人的"登记文件（给 glob / grep 用）。
 *
 * 为什么列目录也要管：产物挤在同一个目录里时（最常见！），列一下就能看到别人有哪些文件、
 * 甚至用 grep 搜出别人的内容。所以"目录里存在别人的产物"就拦这一整个列举动作。
 */
export function dirHasForeignOwned(state, normDir, who) {
  if (!normDir) return null
  const pre = `${normDir}\\`
  for (const [p, o] of Object.entries(state?.owned ?? {})) {
    if (!p.startsWith(pre)) continue
    if (p.slice(pre.length).includes('\\')) continue     // 只看直接子项
    if (isShared(state, p)) continue
    if (sameWindow(o?.by, who?.callerId)) continue
    return { path: p, ...o }
  }
  return null
}

/**
 * 把一个文件登记到某个调用者名下（**就地**改 state，不做 IO —— 落盘交给钩子）。
 * 超过上限（默认 3000 条）按登记时间淘汰最旧的，避免无限膨胀。
 */
/**
 * 这个标签是不是「豁免归属」的（复核者）。
 * 判据：标签里**含**任一关键词（大小写不敏感、逗号分隔）。空标签 → 不豁免（宁严勿松）。
 */
export function isOwnerExempt(label, csv) {
  const l = String(label ?? '')
  const keys = String(csv ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!l.trim() || !keys.length) return false
  // ★★ 必须**以方括号标记开头**才算豁免：`[复核] 独立复核员` / `【review】…`。
  //   为什么改（独立验证报告 §8.4）：原实现是「标签里包含关键词即豁免」，
  //   于是「实现并验证 X」这种普通描述也会**意外**拿到整层豁免 —— 等于把钥匙挂在门口。
  const m = /^\s*[[【]\s*([^\]】]{1,40}?)\s*[\]】]/.exec(l)
  if (!m) return false
  return keys.some((k) => m[1].toLowerCase().includes(k))
}

/**
 * 把文本里**像 base64 的长串**解出来，拼成一段附加文本用于判定。
 *
 * 为什么（第二轮独立验证 §4.2/§5.3）：判定面是命令原文，于是
 *   `$z='<base64>'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($z)); Get-Content $p`
 * 这类"同一次调用内解码并使用"一穿到底 —— 它读出了受保护文件正文，**还读出了本插件的账本**。
 *
 * ⚠️ 只提高成本：再编一层（自定义表、压缩、外部命令取值）仍可绕 —— **不是边界**。
 */
export function decodeBase64Bits(text) {
  const out = []
  const re = /[A-Za-z0-9+/]{16,}={0,2}/g
  let m
  while ((m = re.exec(String(text ?? String())))) {
    try {
      const buf = Buffer.from(m[0], 'base64')
      if (!buf.length) continue
      const u8 = buf.toString('utf8')
      if (u8 && !u8.includes('\uFFFD')) out.push(u8)
      const u16 = buf.toString('utf16le')
      if (u16 && !u16.includes('\uFFFD')) out.push(u16)
    } catch { }
  }
  return out.join('\n')
}

/** 正则转义（受保护目录名里可能有 . ( ) 等）。 */
export function escapeRe(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * **变量还原**：把命令里"先赋值、后拼接"的路径还原成字面量，再拿去做文本判定。
 *
 * 为什么（独立验证报告 §8.1/§8.9）：判定面是命令原文，于是
 *   `$d=[char]0x8BBA+...; $root='C:\…\'+$d; Get-ChildItem $root`
 * 这类"跨语句拼接"一穿到底 —— 作者自己也承认"一个变量就能整体让开"。
 * 本函数做**最朴素的一层**：还原 `$x=…` / `$env:X=…` 的字符串拼接，并把
 * `$env:DSH_HOME`（已知值）展开成真实路径。
 *
 * ⚠️ 只提高成本：嵌套、数组 join、base64、外部命令取值仍可绕 —— **不是边界**。
 */
export function expandVars(text, home) {
  let s = deobfuscate(text)
  const vars = new Map()
  if (home) vars.set('env:DSH_HOME', String(home))
  if (home) vars.set('DSH_HOME', String(home))
  const re = /\$(env:)?([A-Za-z_]\w*)\s*=\s*([^\r\n;]+)/g
  let m
  while ((m = re.exec(s))) {
    const name = (m[1] ? 'env:' : '') + m[2]
    const val = String(m[3]).replace(/['"+`\s]/g, '')
    if (val) vars.set(name, val)
  }
  if (!vars.size) return s
  // 做两轮替换（够覆盖"用变量拼变量"的一层）
  for (let round = 0; round < 2; round++) {
    for (const [k, v] of vars) s = s.split('$' + k).join(v)
  }
  return s
}

export function registerOwned(state, normPath, who, cap = 3000) {
  if (!state || !state.owned || !normPath || !who?.callerId) return false
  state.owned[normPath] = { by: who.callerId, label: who.label ?? null, win: who.win ?? null, ts: new Date().toISOString() }
  const ks = Object.keys(state.owned)
  if (ks.length > cap) {
    ks.sort((a, b) => String(state.owned[a]?.ts).localeCompare(String(state.owned[b]?.ts)))
    for (const k of ks.slice(0, ks.length - cap)) delete state.owned[k]
  }
  return true
}

export function evaluateCall(call) {
  const { name, args, isSubagent, scope = 'subagents', home, auditFile, rules = {}, cats = {}, guardShellText = true, window: callerWindow = null, caller: callerId = null, label: callerLabel = null, autoOwnWrites = false, ownState = null, denyHome = false, workspaceRoot = null, ownerExemptLabels = '' } = call ?? {}
  const blocked = scope === 'all' ? true : Boolean(isSubagent)
  if (!blocked) return null
  if (typeof name !== 'string') return null
  const parentNote = (!isSubagent && scope === 'all')
    ? '\n（当前 scope=all，父会话同样受约束。要放行：设置里关总开关，或在本窗口执行 /shield off）'
    : ''
  const argOf = (k) => (args && typeof args === 'object' ? args[k] : undefined)

  // 一、路径族：把该工具**所有可能带路径的参数**都过一遍
  //    （glob/grep 的 pattern 是必填、path 可选 —— 只查 path 会被绕过去，实测踩过）
  const pathKeys = PATH_ARGS[name]
  if (pathKeys) {
    for (const key of pathKeys) {
      const raw = argOf(key)
      if (typeof raw !== 'string' || !raw) continue
      const t = normalizePath(raw)
      if (!t) continue
      // ★ 自定义拦住目录（臂间隔离）：只有归属者（窗口 / 子代理标签 / 会话 id）能碰
      const custom = matchProtectedPath(t, rules)
      if (custom) {
        const isOwner = isOwnerCall({ window: callerWindow, callerId, label: callerLabel }, custom)
        if (!isOwner) {
          // ⚠ 文案要按**实际配的那一种归属**说，别一律说"未指定归属窗口"
          //   （踩过：纯标签规则被拒时，提示却说"未指定归属窗口"，误导排查）
          const who = custom.label
            ? `（归属者：标签「${custom.label}」，本调用的标签不匹配）`
            : custom.owner
              ? `（归属者：窗口 ${String(custom.owner).replace(/^session-/, '').slice(0, 12)}…，本调用不是它）`
              : '（这条规则没设归属，对所有人拦住）'
          return { reason: denyText(`自定义拦住目录${who}`, `参数 ${key}：${raw}\n`, parentNote), kind: 'custom', target: String(raw ?? '') }
        }
      }
      for (const r of selfRoots(home, auditFile)) {
        if (r.path && (t === r.path || t.startsWith(`${r.path}\\`))) {
          return { reason: denyText(r.label, `参数 ${key}：${raw}\n`, parentNote), kind: 'state', target: String(raw ?? '') }
        }
      }
      // ★★ %DSH_HOME% 默认全拒（工作区子树除外）。
      //    比"点名保护几类目录"强的地方：**不怕漏**。独立验证实测到的 4 条未覆盖通道
      //    （attachments / request-images / files-v3 / logs）以及以后新增的，一并覆盖。
      if (denyHome) {
        const h = normalizePath(home)
        const ws = normalizePath(workspaceRoot)
        if (h && (t === h || t.startsWith(`${h}\\`)) && !(ws && (t === ws || t.startsWith(`${ws}\\`)))) {
          return { reason: denyText('宿主数据目录（%DSH_HOME%，默认全拒）', `参数 ${key}：${raw}\n`, parentNote), kind: 'home', target: String(raw ?? '') }
        }
      }
      const info = classifyTargetLoose(home, raw)
      if (info && isProtected(info, rules, cats)) {
        const what = info.kind === 'credentials' ? '宿主凭据文件'
          : info.kind === 'projcache' ? '会话投影缓存（明文，含进行中的草稿）'
            : '会话落盘记录'
        const where = info.sid ? `（窗口 ${info.sid}）` : info.ws ? `（工作区 ${info.ws}）` : ''
        return { reason: denyText(what + where, `参数 ${key}：${raw}\n`, parentNote), kind: info.kind, target: String(raw ?? '') }
      }
    }
  }

  // ★ 标签豁免：复核者不受归属层管辖（但**不**豁免 %DSH_HOME% 默认全拒与 protectedPaths）
  const ownExempt = isOwnerExempt(callerLabel, ownerExemptLabels)

  // 「谁写的谁拥有」的逃生门提示（路径族与命令族共用）
  const ownHint = '（要放行：在本窗口执行 /shield 放行 <该文件或目录>；'
    + '或把本窗口在设置里设为「放行」；或在设置里关掉「谁写的谁拥有」；'
    + '要长期豁免，请让复核者的标签**以 [复核] 这样的方括号标记开头**；'
    + '历史遗留的归属可以 /shield 清空归属 一次清掉）\n'

  // 二、「谁写的谁拥有」——自动臂间隔离
  //
  // 判据：这个文件**已被别的子代理登记** → 拦；是它自己写的 → 放行；没登记（父会话写的）→ 放行。
  // 列目录类（glob / grep）额外管一层：目录**直接下**有别人的产物 → 拦整个列举动作
  //   （产物挤在同一个目录里时，列一下就能看到别人有哪些文件）。
  if (autoOwnWrites && (isSubagent || scope === 'all') && callerId && pathKeys && !ownExempt) {
    const who = { callerId, label: callerLabel, win: callerWindow, parentWin: isSubagent ? null : callerWindow }
    const hint = ownHint
    for (const key of pathKeys) {
      const raw = argOf(key)
      if (typeof raw !== 'string' || !raw) continue
      const t = normalizePath(raw)
      if (!t) continue
      if (LIST_TOOLS.has(name)) {
        if (key !== 'path') continue                      // glob/grep 只看它要搜的目录，pattern 不当路径用
        const hit = dirHasForeignOwned(ownState, t, who)
        if (hit) {
          const by = hit.label ? `标签「${hit.label}」` : String(hit.by ?? '').replace(/^session-/, '').slice(0, 12) + '…'
          return {
            reason: denyText(`由别的子代理写出的产物（该目录里有 ${by} 的文件）`, `参数 ${key}：${raw}\n` + hint, parentNote),
            kind: 'owned', target: String(raw ?? ''),
          }
        }
        continue
      }
      const hit = isForeignOwned(ownState, t, who)
      if (hit) {
        const by = hit.label ? `标签「${hit.label}」` : String(hit.by ?? '').replace(/^session-/, '').slice(0, 12) + '…'
        return {
          reason: denyText(`由别的子代理写出的文件（归属 ${by}）`, `参数 ${key}：${raw}\n` + hint, parentNote),
          kind: 'owned', target: String(raw ?? ''),
        }
      }
      // 写入类：放行之后把它登记成"这个子代理的"（就地登记；钩子负责落盘）
      if (WRITE_TOOLS.has(name) && key === (name === 'str_replace_editor' ? 'path' : 'file_path')) registerOwned(ownState, t, who)
    }
  }

  // 二·五、脚本正文（**前置活动**）：子代理写脚本时，正文里出现宿主数据路径 → 拦。
  //   为什么放这里：程序化读盘必须先"写脚本"或"跑命令"。以前只查命令行文本，
  //   于是"把路径写进脚本 + 用干净命令跑它"完全无声通过（实测反例）。
  //   ★ 只对**子代理**生效：父会话（开发/运维）要能写这类脚本。
  //   ⚠️ 仍是文本启发式：把路径拼出来/编码后再写进脚本仍可绕 —— 只提高成本。
  if (guardShellText && isSubagent && WRITE_TOOLS.has(name)) {
    const body = String(argOf('content') ?? argOf('new_string') ?? '')
    if (body) {
      const flatBody = deobfuscate(body)
      const flatBodyTight = compactify(flatBody)
      for (const n of SHELL_NEEDLES) {
        if (!shellCategoryActive(n.cat, rules, cats)) continue
        if (n.re.test(flatBody) || n.re.test(flatBodyTight)) {
          return {
            reason: denyText('写入含宿主数据路径的脚本',
              '（脚本正文命中，属启发式判定 —— 这等于把\u201c用程序读盘\u201d前置化）\n' + ownHint,
              parentNote),
            kind: 'script', target: body.slice(0, 200),
          }
        }
      }
    }
  }

  // 三、命令族：
  //   ★ 归属检查（"谁写的谁拥有"）与文本启发式**解耦**：
  //     以前整个分支挂在 guardShellText 下，于是"关掉护栏" = 连"用命令读别人的产物"也不拦了。
  //     两者性质不同 —— 归属是臂间隔离（该一直生效），文本针只是启发式（可关）。
  if (SHELL_TOOLS.has(name)) {
    const text = String(argOf('command') ?? argOf('code') ?? '')
    // ★ 先做**朴素混淆还原**（码点拼接 / 转义 / 字符串相加），再拿去做文本匹配。
    //   独立验证（对照实验 01）里 `String.fromCharCode` / `[char]NN` 拼 sessions 就绕过了。
    //   ⚠️ 只提高成本：变量、base64、Resolve-Path、cmd /c 套壳仍可绕 —— 永远不是边界。
    const flatText = deobfuscate(text)
    const flatTight = compactify(flatText)   // ★ 紧凑副本：对付片段拼接
    // ★★ 变量还原 + 紧凑：对付「先赋值、后拼接」与「$env:DSH_HOME」（独立验证 §8.1/§8.9）
    const flatExpRaw = expandVars(text, home)      // ★ 未压缩：保留引号，`.dsh"` 这类边界才匹配得上
    const flatExp = compactify(flatExpRaw)
    const b64Bits = decodeBase64Bits(text)        // ★ base64 解出来的明文（§4.2/§5.3）
    for (const n of SHELL_NEEDLES) {
      if (!guardShellText) break   // ★ 护栏关着 → 文本针不生效（但下面的归属检查照跑）
      if (!shellCategoryActive(n.cat, rules, cats)) continue
      if (n.re.test(flatText) || n.re.test(flatTight) || n.re.test(flatExp) || n.re.test(flatExpRaw) || (b64Bits && n.re.test(b64Bits))) {
        return { reason: denyText(n.why, '（命令行文本命中，属启发式判定）\n', parentNote), kind: 'shell', target: text.slice(0, 200) }
      }
    }
    // ★★ 「谁写的谁拥有」在**命令族**里也要拦 —— 这一条是补漏洞：
    //    原先只接了路径族，结果子代理换 `pwsh Get-Content <别人文件的绝对路径>` 就把隔离绕过去了（实测读到）。
    //    仍然是**文本启发式**：变量、拼接、base64 能绕 —— 与命令族其它模式同一条边界。
    if (autoOwnWrites && (isSubagent || scope === 'all') && callerId && ownState && !ownExempt) {
      const who = { callerId, label: callerLabel, win: callerWindow, parentWin: isSubagent ? null : callerWindow }
      const flat = flatText.toLowerCase().replace(/\//g, '\\')
      const byOf = (o) => (o?.label ? `标签「${o.label}」` : String(o?.by ?? '').replace(/^session-/, '').slice(0, 12) + '…')
      for (const [p, o] of Object.entries(ownState.owned ?? {})) {
        if (isShared(ownState, p)) continue
        if (sameWindow(o?.by, callerId)) continue
        // 全路径 或 最后两段（"目录\文件名"）——比裸文件名准，又比全路径宽容
        const seg = p.split('\\').filter(Boolean)
        const tail2 = seg.slice(-2).join('\\')
        if (flat.includes(p) || (tail2 && flat.includes(tail2))) {
          return {
            reason: denyText(`由别的子代理写出的文件（归属 ${byOf(o)}）`, '（命令行文本命中，属启发式判定）\n' + ownHint, parentNote),
            kind: 'owned', target: text.slice(0, 200),
          }
        }
      }
      // 目录级：**只在命令看起来是在"列/读"那个目录时**才整条拒 ——
      //   否则子代理在公共产物目录里批量校验**自己的**产物也会被误伤（01 实测踩到）。
      //   不是枚举动作 → 不拦，留给文末的"可疑"记录。
      // ★★ 独立验证报告 §8.3：共用目录里 `pwsh Get-Content <自己刚写的文件>`
      //    被"该目录里有别人的产物"连坐 —— 连"读自己写的东西"这条承诺都不成立。
      //    修法：命令点名的文件**属于自己** → 跳过目录级连坐（文件级"别人的"仍然拦）。
      let touchesOwnFile = false
      for (const [po, oo] of Object.entries(ownState.owned ?? {})) {
        if (!(sameWindow(oo?.by, callerId) || String(oo?.by) === String(callerId))) continue
        const seg2 = po.split('\\').filter(Boolean)
        const t2 = seg2.slice(-2).join('\\')
        if (flat.includes(po) || (t2 && flat.includes(t2))) { touchesOwnFile = true; break }
      }
      const ENUM = /(get-childitem|\bgci\b|\bdir\b|\bls\b|\bfind\b|select-string|findstr|\bgc\b|get-content|\btype\b|\bcat\b)/i
      if (!touchesOwnFile && ENUM.test(flat)) {
      const dirs = new Set()
      for (const p of Object.keys(ownState.owned ?? {})) {
        const d = dirname(p)
        if (d && d !== '.' && d !== '\\') dirs.add(d)
      }
      for (const d of dirs) {
        if (!flat.includes(d)) continue
        const hit = dirHasForeignOwned(ownState, d, who)
        if (hit) {
          return {
            reason: denyText(`由别的子代理写出的产物（该目录里有 ${byOf(hit)} 的文件）`, '（命令行文本命中，属启发式判定）\n' + ownHint, parentNote),
            kind: 'owned', target: text.slice(0, 200),
          }
        }
      }
      }
    }
    // ★ 自定义受保护路径：命令文本里**字面**出现也要拦（同样认归属窗口）
    //   注意这仍是文本启发式：拼接/变量/base64 可绕 —— 与命令族其它模式同一条边界。
    // ★★ 独立验证报告 §8.1：这条以前只做**字面**比对（连 deobfuscate 都没走）。
    //    现在四个面都查：原样 / 去混淆 / 紧凑副本 / **变量还原**，并加查裸目录名。
    const toWin = (x) => String(x).toLowerCase().replace(/\//g, '\\')
    const flatAll = [toWin(text), toWin(flatText), toWin(flatTight), toWin(flatExpRaw), toWin(flatExp), b64Bits ? toWin(b64Bits) : '']
    for (const e of (Array.isArray(rules?.protectedPaths) ? rules.protectedPaths : [])) {
      const p = normalizePath(e?.path)
      if (!p) continue
      const base = p.split('\\').filter(Boolean).pop() || ''
      const reBase = base.length >= 2 ? new RegExp('[\\\\/]' + escapeRe(base) + '(?:[\\\\/]|[\"\'\\s;,)|&`]|$)', 'i') : null
      const hitp = flatAll.some((f) => f.includes(p) || (reBase && reBase.test(f)))
      if (!hitp) continue
      const isOwner = isOwnerCall({ window: callerWindow, callerId, label: callerLabel }, { owner: e?.owner, label: e?.label })
      if (isOwner) continue
      return { reason: denyText('自定义拦住目录（命令行文本命中，属启发式判定）', '', parentNote), kind: 'custom', target: text.slice(0, 200) }
    }
    // ★★ 可疑（只记 warn，**不拦**）：让"绕过尝试"在账本里留下痕迹。
    //    01 的独立验证最要命的一条发现是——**成功的偷在账本里零痕迹**。
    //    这条不能阻止绕过，但能让你事后把那一轮实验作废。
    if (guardShellText) {
      for (const s of SUSPECT_NEEDLES) {
        if (s.re.test(flatText)) return { warn: { kind: 'bypass-suspect', why: s.why, target: text.slice(0, 200) } }
      }
    }
  }
  return null
}

/**
 * 宽松版目标识别：精确判定失败时，再看这个字符串里**有没有出现受保护树的形状**。
 *
 * 为什么要它：`glob`/`grep` 的 `pattern` 可以把绝对路径或 `..\..\.dsh\sessions\**\*`
 * 这种相对逃逸写进去，靠"解析成绝对路径再比前缀"是抓不到的（拿不到工作区 cwd）。
 * 这里退一步用**形状匹配**：按 DSH_HOME 的末段目录名（通常 `.dsh`）去找
 * `\<base>\sessions` / `\<base>\storages\session_projcache` / `\<base>\.credentials.yaml`。
 *
 * @returns {{kind:'sessions'|'projcache'|'credentials', ws:null, sid:null}|null}
 */
export function classifyTargetLoose(home, rawPath) {
  const exact = classifyTarget(home, rawPath)
  if (exact) return exact
  const h = normalizePath(home).replace(/\\+$/, '')
  const t = normalizePath(rawPath)
  if (!h || !t) return null
  const base = h.split('\\').filter(Boolean).pop()
  if (!base) return null
  const tail = `\\${base}\\`
  if (!t.includes(tail)) return null

  // 目录标记必须**以分隔符（或结尾 / 通配）收束**，
  // 否则 `<home>\sessions2` 会被误判成 `<home>\sessions`（实测踩过）。
  const looksLikeDir = (marker) => t.includes(`${marker}\\`) || t.endsWith(marker) || t.includes(`${marker}*`)
  if (looksLikeDir(`${tail}storages\\session_projcache`)) return { kind: 'projcache', ws: null, sid: null }
  if (looksLikeDir(`${tail}sessions`)) return { kind: 'sessions', ws: null, sid: null }
  if (t.includes(`${tail}.credentials.yaml`)) return { kind: 'credentials', ws: null, sid: null }
  return null
}

/** 从会话目录名（--C-Users-…-~8BBA~5B50~7A97~53E3--）尽力还原成可读路径。 */
export function decodeWorkspaceLabel(dirName) {
  if (typeof dirName !== 'string') return ''
  let s = dirName.replace(/^--/, '').replace(/--$/, '')
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  return s.replace(/-/g, '\\')
}

// ═══════════════════════════════════════════ 挂载

export function apply(ctx, config) {
  const flag = (k, d) => { try { const v = config?.[k]?.get?.(); return v === undefined || v === null ? d : Boolean(v) } catch { return d } }
  const str = (k, d = '') => { try { const v = config?.[k]?.get?.(); return v ? String(v) : d } catch { return d } }
  const home = () => str('dshHome') || process.env.DSH_HOME || ''
  const auditFile = () => str('auditFile') || (home() ? `${home()}\\subagent-shield-audit.jsonl` : '')
  const rulesFile = () => (home() ? `${home()}\\subagent-shield-rules.json` : '')
  const stateFile = () => (home() ? `${home()}\\subagent-shield-state.json` : '')
  const cats = () => ({
    protectSessions: flag('protectSessions', true),
    protectProjcache: flag('protectProjcache', true),
    protectCredentials: flag('protectCredentials', true),
  })
  const hasOwn = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k)

  // ── 规则
  let rules = { version: 1, defaultPolicy: 'protect', workspaces: {}, windows: {}, protectedPaths: [] }
  /** 把外部写进来的 protectedPaths 洗干净（path 必填；owner / label 可选）。 */
  const cleanProtectedPaths = (v) => (Array.isArray(v) ? v : [])
    .filter((e) => e && typeof e.path === 'string' && e.path.trim())
    .slice(0, 200)
    .map((e) => {
      const out = { path: e.path.trim() }
      if (e.owner && String(e.owner).trim()) out.owner = String(e.owner).trim()
      if (e.label && String(e.label).trim()) out.label = String(e.label).trim()
      return out
    })
  const loadRules = () => {
    try {
      const f = rulesFile()
      if (!f || !existsSync(f)) return
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (j && typeof j === 'object') {
        rules = {
          version: 1,
          defaultPolicy: j.defaultPolicy === 'allow' ? 'allow' : 'protect',
          workspaces: (j.workspaces && typeof j.workspaces === 'object') ? j.workspaces : {},
          windows: (j.windows && typeof j.windows === 'object') ? j.windows : {},
          protectedPaths: cleanProtectedPaths(j.protectedPaths),
        }
      }
    } catch { }
  }
  const saveRules = () => {    try {
      const f = rulesFile()
      if (!f) return false
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, JSON.stringify(rules, null, 2) + '\n', 'utf8')
      return true
    } catch (e) { console.log(`[subagent-shield] 规则写盘失败：${e?.message ?? e}`); return false }
  }

  // ── 「谁写的谁拥有」登记表（自动臂间隔离的唯一凭据）
  const ownFile = () => { const h = home(); return h ? join(h, 'subagent-shield-owns.json') : null }
  const OWN_CAP = 3000
  let ownState = { version: 1, owned: {}, shared: [] }
  let ownedAtBoot = 0
  const loadOwn = () => {
    try {
      const f = ownFile()
      if (!f || !existsSync(f)) return
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (j && typeof j === 'object') {
        ownState = {
          version: 1,
          owned: (j.owned && typeof j.owned === 'object') ? j.owned : {},
          shared: Array.isArray(j.shared) ? j.shared.filter((x) => typeof x === 'string') : [],
        }
        ownedAtBoot = Object.keys(ownState.owned).length
      }
    } catch { }
  }
  const saveOwn = () => {
    try {
      const f = ownFile()
      if (!f) return false
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, JSON.stringify(ownState, null, 2) + '\n', 'utf8')
      return true
    } catch { return false }
  }
  /** /shield 放行|收回：手动把某个路径（含其下）对所有人放开 / 收回。 */
  const setShared = (rawPath, on) => {
    const p = normalizePath(rawPath)
    if (!p) return false
    if (on) { if (!ownState.shared.some((x) => normalizePath(x) === p)) ownState.shared.push(p) }
    else ownState.shared = ownState.shared.filter((x) => normalizePath(x) !== p)
    saveOwn()
    return true
  }

  // ── 窗口强制覆盖（/shield 命令写）
  const overrides = new Map()
  const loadState = () => {
    try {
      const f = stateFile()
      if (!f || !existsSync(f)) return
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (j?.windows && typeof j.windows === 'object') {
        for (const [k, v] of Object.entries(j.windows)) if (typeof v === 'boolean') overrides.set(k, v)
      }
      if (j?.cfgSeen && typeof j.cfgSeen === 'object') cfgSeenSaved = j.cfgSeen
      if (typeof j?.cfgSchema === 'number') cfgSchemaSeen = j.cfgSchema
    } catch { }
  }
  const saveState = () => {
    try {
      const f = stateFile()
      if (!f) return
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, JSON.stringify({ version: 2, updatedAt: new Date().toISOString(), windows: Object.fromEntries(overrides), cfgSeen: cfgSnap, cfgSchema: CFG_SCHEMA }, null, 2), 'utf8')
    } catch (e) { console.log(`[subagent-shield] 状态写盘失败：${e?.message ?? e}`) }
  }

  // ── 统计：**本次会话**与**账本历史**必须分开
  //    踩过：`seedStats` 直接把账本行数写进 `stats.total`，于是每次重启小窗都带着
  //    41 次的旧计数回来，还把历史明细当成刚发生的记录显示，并配一句"（账本未启用）"
  //    —— 有数据却说账本没开，自相矛盾。
  const stats = { total: 0, windows: new Set(), recent: [] }        // 本次进程内
  const history = { total: 0, windows: new Set(), recent: [] }      // 从账本文件读到的历史
  const rememberDeny = (row) => {
    stats.total += 1
    if (row?.window) stats.windows.add(row.window)
    stats.recent.push(row)
    if (stats.recent.length > 8) stats.recent.shift()
  }
  // ★★ 告警：两类事件要能「顶到小窗上」，而不是埋在账本里
  //   ① bypass —— 有子代理试图绕过隔断（码点拼接 / base64 / 解 zstd / 读盘 API…）
  //   ② config —— 有人改了插件配置（关开关、改 scope、动关键词）
  const alerts = { bypass: { count: 0, last: null }, config: { count: 0, last: null } }
  const rememberWarn = (kind, row) => {
    const key = kind === 'config-changed' ? 'config' : 'bypass'
    const a = alerts[key]
    a.count += 1
    a.last = { ts: row?.ts || new Date().toISOString(), why: String(row?.why ?? ''), tool: String(row?.tool ?? ''), target: String(row?.target ?? '').slice(0, 120) }
  }
  const seedStats = () => {
    try {
      const f = auditFile()
      if (!f || !existsSync(f)) return
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
      rowsAtBoot = lines.length
      history.total = lines.length
      for (const l of lines) { try { const r = JSON.parse(l); if (r?.window) history.windows.add(r.window) } catch { } }
      history.recent = lines.slice(-8).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { }
  }
  let rowsAtBoot = 0
  let appended = 0
  let warnCount = 0
  // ★★ 配置变更留痕：启动时快照，之后每次 /status 比对 ——
  //    "把监考老师踢出去"这件事必须留下不可抵赖的记录。
  // [键, 类型, 缺省值] —— ★ scope/mode 是**字符串**，必须用 str 读，
  //   否则 'subagents' → 'all' 会被读成 true → true，改动检测不到（踩过）。
  // ★ 快照编号：增删快照项、或改过存储类型，就把它 +1。
  //   这样「插件自己升级了」不会被当成「用户改了配置」（踩过：0.8.7 升级后报了 3 条误报）。
  const CFG_SCHEMA = 2
  const CFG_KEYS = [
    ['enabled', 'bool', true], ['scope', 'str', 'subagents'], ['mode', 'str', 'all'],
    ['guardShellText', 'bool', true], ['denyHomeByDefault', 'bool', true],
    ['autoOwnWrites', 'bool', true], ['ownerExemptLabels', 'str', ''],
  ]
  const cfgNow = () => {
    const o = {}
    for (const [k, ty, d] of CFG_KEYS) o[k] = ty === 'str' ? str(k, d) : flag(k, d)
    return o
  }
  let cfgSnap = null
  let cfgDrift = null
  let cfgSeenSaved = null
  let cfgSchemaSeen = 0
  const auditCfgChange = (diff, since) => {
    cfgDrift = { at: new Date().toISOString(), diff, since }
    rememberWarn('config-changed', { ts: cfgDrift.at, why: '本插件配置被改动（' + since + '检测到）', tool: '-', target: diff.join('; ') })
    warnCount += 1
    audit({ action: 'warn', kind: 'config-changed', tool: '-', target: diff.join('; ').slice(0, 300), why: '本插件配置被改动（' + since + '检测到；改之前应当先告诉使用者）', window: null, scope: str('scope', 'subagents'), callerIsSubagent: null, caller: null, mode: str('mode', 'all') })
    saveState()
  }
  const checkCfgDrift = () => {
    try {
      const now = cfgNow()
      if (!cfgSnap) {
        cfgSnap = now
        // ★ 只有编号一致才比 —— 否则那是「插件自己升级了」，不是「用户改了配置」
        const diff = cfgSchemaSeen === CFG_SCHEMA ? diffConfig(cfgSeenSaved, now) : []
        if (diff.length) auditCfgChange(diff, '跨重启')
        else saveState()
        return cfgDrift
      }
      const diff = diffConfig(cfgSnap, now)
      if (!diff.length) return cfgDrift
      cfgSnap = now
      auditCfgChange(diff, '本次运行中')
      return cfgDrift
    } catch { return cfgDrift }
  }
  const audit = (row) => {
    const stamped = { ts: new Date().toISOString(), ...row }
    if (!flag('auditEnabled', true)) return stamped
    try {
      const f = auditFile()
      if (!f) return stamped
      mkdirSync(dirname(f), { recursive: true })
      appendFileSync(f, JSON.stringify(stamped) + '\n', 'utf8')
      appended += 1
    } catch { }
    return stamped
  }

  // ── 工作区 / 窗口 清单（给设置页面用）
  const listWorkspaces = () => {
    const h = home(); const root = h ? `${h}\\sessions` : ''
    const out = []
    if (!root || !existsSync(root)) return out
    for (const nm of readdirSync(root)) {
      const dir = join(root, nm)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      let sessions = []
      try { sessions = readdirSync(dir).filter((x) => { try { return statSync(join(dir, x)).isDirectory() } catch { return false } }) } catch { }
      let latest = 0
      for (const s of sessions) { try { latest = Math.max(latest, statSync(join(dir, s)).mtimeMs) } catch { } }
      out.push({
        key: nm,
        label: decodeWorkspaceLabel(nm),
        sessions: sessions.length,
        latest,
        protected: hasOwn(rules.workspaces, nm) ? Boolean(rules.workspaces[nm]) : (rules.defaultPolicy !== 'allow'),
      })
    }
    return out.sort((a, b) => b.latest - a.latest)
  }
  const listWindows = () => {
    const h = home(); const root = h ? `${h}\\sessions` : ''
    const out = []
    if (!root || !existsSync(root)) return out
    for (const wsName of readdirSync(root)) {
      const wsDir = join(root, wsName)
      try { if (!statSync(wsDir).isDirectory()) continue } catch { continue }
      let subs = []
      try { subs = readdirSync(wsDir) } catch { continue }
      for (const sid of subs) {
        const sd = join(wsDir, sid)
        try { if (!statSync(sd).isDirectory()) continue } catch { continue }
        let latest = 0
        try { latest = statSync(sd).mtimeMs } catch { }
        out.push({
          id: sid, workspace: wsName, label: decodeWorkspaceLabel(wsName), latest,
          protected: hasOwn(rules.windows, sid) ? Boolean(rules.windows[sid]) : (rules.defaultPolicy !== 'allow'),
        })
      }
    }
    return out.sort((a, b) => b.latest - a.latest).slice(0, 60)
  }

  // ── 调用者身份：子代理标签
  //
  // 标签 = **派这个子代理时填的 description**。实测它会被写进子会话的一条记录：
  //   {"type":"subagent/descriptor","seq":6,"data":{"mode":"one-shot","provider":"spawn","label":"臂A"}}
  //
  // 为什么需要它：同一个窗口下的两个子代理 `parentSession` **完全相同**（实测），
  // 所以只靠窗口分不开它们 —— 而"父会话开两个子代理当两臂"正是最常见的跑法。
  // 有了标签，**派之前身份就定了**，不存在"先有鸡还是先有蛋"。
  //
  // 取标签两条路，先快后稳，结果按会话 id 缓存：
  //   ① `subagents` 服务 `get(childId)`（可用就用，形状不符就退）
  //   ② 直接读子会话的记录文件、解析那行 descriptor（**已离线验证**）
  const labelCache = new Map()
  const labelTries = new Map()

  /** 从子会话的记录文件里解析出 label（多帧 zstd，只需头几帧）。 */
  const labelFromSessionLog = (sessionId) => {
    try {
      const sessRoot = join(home(), 'sessions')
      if (!existsSync(sessRoot)) return null
      for (const cwdDir of readdirSync(sessRoot)) {
        const f = join(sessRoot, cwdDir, sessionId, 'session.v4.jsonl.zstd')
        if (!existsSync(f)) continue
        const raw = readFileSync(f)
        const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
        const offs = []
        let i = raw.indexOf(MAGIC, 0)
        while (i !== -1 && offs.length < 10) { offs.push(i); i = raw.indexOf(MAGIC, i + 4) }
        let text = ''
        for (let k = 0; k < offs.length; k++) {
          const end = k + 1 < offs.length ? offs[k + 1] : raw.length
          try { text += zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8') } catch { }
        }
        const m = text.match(/"type":"subagent\/descriptor"[\s\S]{0,400}?"label":"((?:[^"\\]|\\.)*)"/)
          ?? text.match(/"label":"((?:[^"\\]|\\.)*)"/)
        if (m) { try { return JSON.parse(`"${m[1]}"`) } catch { return m[1] } }
      }
    } catch { }
    return null
  }

  let labelViaService = null
  try {
    ctx.inject(['subagents'], (c) => {
      labelViaService = (id) => {
        try {
          const act = c.subagents?.get?.(id)
          const lab = act?.descriptor?.label ?? act?.create?.descriptor?.label ?? act?.label ?? act?.options?.label
          return (typeof lab === 'string' && lab.trim()) ? lab.trim() : null
        } catch { return null }
      }
    })
  } catch { }

  /** 拿到某个调用者的标签（拿不到就返回 null —— 只会让判定更严，不会误放行）。 */
  const labelOf = (agent) => {
    try {
      const id = agent?.session?.header?.id
      if (!id) return null
      if (labelCache.has(id)) return labelCache.get(id)
      const lab = (labelViaService ? labelViaService(id) : null) ?? labelFromSessionLog(id)
      // 只在拿到、或试过 3 次之后才缓存 null：避免"首次调用早于 descriptor 落盘"被永久记住
      const n = (labelTries.get(id) ?? 0) + 1
      labelTries.set(id, n)
      if (lab || n >= 3) labelCache.set(id, lab)
      return lab
    } catch { return null }
  }

  // ── 事前隔断
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (flag('enabled', true)) {
        const agent = exec?.agent
        const isSub = isSubagentAgent(agent)
        const scope = str('scope', 'subagents')
        if (scope === 'all' || isSub) {
          const win = windowOf(agent)
          if (resolveWindowPolicy(str('mode', 'all'), win ? overrides.get(win) : undefined)) {
            // 「谁写的谁拥有」：evaluateCall 会**就地**往 ownState 里登记；这里负责落盘。
            // 只在登记数量变了时才写文件（避免每次工具调用都写一遍 JSON）。
            const ownBefore = flag('autoOwnWrites', true) ? Object.keys(ownState.owned).length : 0
            const hit = evaluateCall({
              name: exec?.name,
              args: exec?.arguments ?? exec?.input ?? exec?.args,
              isSubagent: isSub,
              scope,
              home: home(),
              auditFile: auditFile(),
              rules,
              cats: cats(),
              guardShellText: flag('guardShellText', true),
              window: win,
              caller: agent?.session?.header?.id ?? null,
              label: isSub ? labelOf(agent) : null,
              autoOwnWrites: flag('autoOwnWrites', true),
              ownState,
              denyHome: flag('denyHomeByDefault', true),
              ownerExemptLabels: str('ownerExemptLabels', '复核,审计,评审,独立,复算,对抗,验证,verify,review,audit,recompute,adversarial'),
              workspaceRoot: agent?.session?.header?.cwd ?? null,
            })
            if (hit?.warn) {
              warnCount += 1
              rememberWarn(hit.warn.kind, { ts: new Date().toISOString(), why: hit.warn.why, tool: exec?.name, target: hit.warn.target })
              audit({
                action: 'warn', kind: hit.warn.kind, tool: exec?.name, target: hit.warn.target, why: hit.warn.why,
                window: win, scope, callerIsSubagent: isSub, caller: agent?.session?.header?.id ?? null, mode: str('mode', 'all'),
              })
            } else if (hit) {
              rememberDeny(audit({
                action: 'deny', kind: hit.kind, tool: exec?.name, target: hit.target,
                window: win, scope, callerIsSubagent: isSub,
                caller: agent?.session?.header?.id ?? null, mode: str('mode', 'all'),
              }))
              return { kind: 'deny', reason: hit.reason }
            }
            // 登记数变了（这次调用写入了新文件）→ 落盘
            if (Object.keys(ownState.owned).length !== ownBefore) saveOwn()
          }
        }
      }
    } catch (error) {
      console.log(`[subagent-shield] 判定异常（已放行）：${error?.message ?? error}`)
    }
    return next()
  })

  try {
    loadRules()
    loadState()
    loadOwn()
    seedStats()

    // ── /shield 命令
    ctx.commands.register({
      definitionId: 'dsh-subagent-shield/shield',
      name: 'shield',
      description: '子代理信息隔断：按窗口开关（on / off / clear / status）；放行|收回 <路径> 管产物归属；清空归属 清空登记表。⚠️ 要改动本插件或其配置前，先告诉使用者（配置改动会被记进账本）',
      input: { hint: 'on | off | clear | status | 放行 <路径> | 收回 <路径> | 清空归属' },
      handler: (invocation) => {
        try {
          const win = invocation?.agent?.session?.header?.id ?? null
          if (!win) return { kind: 'error', text: '拿不到当前会话 id，无法按窗口设置。' }
          const rawAll = String(invocation?.rawInput ?? '').trim()
          const raw = rawAll.toLowerCase()
          const mode = str('mode', 'all')

          // ★ 放行 / 收回 <路径>：手动把一个路径（含其下）对所有人放开 / 收回。
          //   这是"谁写的谁拥有"的逃生门：默认开，遇到"一个子代理写、另一个子代理审"时用它。
          const m = /^(放行|收回|share|unshare)\s+(.+)$/i.exec(rawAll)
          if (m) {
            const on = /^(放行|share)$/i.test(m[1])
            const p = m[2].trim().replace(/^["']|["']$/g, '')
            if (!setShared(p, on)) return { kind: 'error', text: `路径看不懂：${p}` }
            const n = ownState.shared.length
            return {
              kind: 'success',
              text: [
                `${on ? '已放行' : '已收回'}：${p}`,
                on ? '（含它下面的所有文件 —— 别的子代理现在可以读/改了）' : '（恢复"谁写的谁拥有"）',
                `当前放行列表共 ${n} 条：${ownState.shared.slice(0, 5).join('  ') || '（空）'}`,
              ].join('\n'),
            }
          }

          // ★ 清空归属：归属表是**全局 + 永久**的（跨项目、跨会话累积），
          //   作者会话结束后仍会拦住所有新子代理 —— 所以需要一个一键清理口。
          const mClearOwn = /^(清空归属|清空|clearown|clear-own)$/i.exec(rawAll)
          if (mClearOwn) {
            const before = Object.keys(ownState.owned).length + ownState.shared.length
            ownState.owned = {}
            ownState.shared = []
            saveOwn()
            return {
              kind: 'success',
              text: [
                `已清空归属表：删除 ${before} 条登记（${Object.keys(ownState.owned).length} 条归属 + ${ownState.shared.length} 条放行）`,
                '之后新写出的文件会重新登记；已经存在的文件不再属于任何人（所有子代理都能读）。',
              ].join('\n'),
            }
          }

          if (raw === 'on') { overrides.set(win, true); saveState() }
          else if (raw === 'off') { overrides.set(win, false); saveState() }
          else if (raw === 'clear') { overrides.delete(win); saveState() }
          else if (raw !== '' && raw !== 'status') return { kind: 'error', text: `未知参数 "${raw}"。可用：on / off / clear / status / 放行 <路径> / 收回 <路径> / 清空归属` }
          const scope = str('scope', 'subagents')
          const ownN = Object.keys(ownState.owned).length
          return {
            kind: 'success',
            text: [
              `本窗口 ${win}`,
              `隔断状态：${resolveWindowPolicy(mode, overrides.get(win)) ? '开启' : '关闭'}`,
              `隔断范围 scope=${scope}（${scope === 'all' ? '父会话也一起挡' : '只挡子代理，父会话不受限'}）`,
              `默认策略 ${rules.defaultPolicy}；点名保护：工作区 ${Object.values(rules.workspaces).filter(Boolean).length} 个 / 窗口 ${Object.values(rules.windows).filter(Boolean).length} 个`,
              `谁写的谁拥有：${flag('autoOwnWrites', true) ? '开' : '关'}（已登记产物 ${ownN} 个，手动放行 ${ownState.shared.length} 条）`,
              '精细设置：设置 → 信息隔断',
            ].join('\n'),
          }
        } catch (e) { return { kind: 'error', text: `shield 命令出错：${e?.message ?? e}` } }
      },
    })

    // ── Web 形态：接口 + 小窗注入
    ctx.inject(['webServer'], (child) => {
      try {
        if (!existsSync(WIDGET_FILE)) { console.log('[subagent-shield] 未找到 widget.js，跳过状态小窗'); return }
        const disposers = []
        /** GUI 的鉴权服务（可选注入）。cordis 里直接读未声明的服务会抛错，所以用嵌套 inject。 */
        let conn = null
        try {
          child.inject(['connection'], (c2) => { conn = c2.connection })
        } catch (e) { console.log('[subagent-shield] 取 connection 鉴权服务失败（退化为只给计数）：' + String(e?.message ?? e)) }
        const sendJson = (res, status, value) => {
          const body = JSON.stringify(value)
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(Buffer.byteLength(body)) })
          res.end(body)
        }
        const readBody = (req, limit = 64 * 1024) => new Promise((resolve) => {
          let size = 0; const chunks = []
          req.on('data', (c) => { size += c.length; if (size > limit) { resolve(''); req.destroy(); return } chunks.push(c) })
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          req.on('error', () => resolve(''))
        })
        /**
         * 鉴权：把本插件自己开的路由挂到 **GUI 自己的鉴权层**后面。
         *
         * 为什么必须做（评审 P3 实证）：`webServer.register` 注册的路由**不在** GUI 鉴权层后面
         * （`WebRoute` 只有 kind/path/handler，没有鉴权选项）。所以原版 `/status` 不带 cookie
         * 就返回 200，内容含 24 个工作区的**解码后可读路径**、60 个窗口 id、8 条拒绝明细 ——
         * 插件成了自己的后门：即使把会话记录锁得再紧，一个 curl 就拿到清单。
         *
         * `connection` 服务提供的就是 GUI 自己用的那套判定：
         *   `requestRejection(req)` → undefined(通过) / 401 / 403（先过 Host/Origin 栅栏，再验 cookie）
         * 用**可选注入**读取：没有 connection 的形态（非 web）不给清单，只给计数。
         * 同源页面请求（小窗、设置页）自带 cookie 与同源 Origin，会正常通过。
         */
        const connectionOf = () => conn
        const authOf = (req) => {
          if (!conn || typeof conn.requestRejection !== 'function') return 'reduced'
          let r
          try { r = conn.requestRejection(req) } catch { return 'reduced' }
          if (r === undefined) return 'full'
          return (r === 401 || r === 403) ? r : 'reduced'
        }
        const denyAuth = (res, code) => {
          const body = code === 403 ? 'forbidden' : 'unauthorized'
          res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)) })
          res.end(body)
        }

        const statusPayload = (withDetail = true) => ({
          plugin: name, version: PKG_VERSION,
          config: {
            enabled: flag('enabled', true), scope: str('scope', 'subagents'), mode: str('mode', 'all'),
            protectSessions: flag('protectSessions', true), protectProjcache: flag('protectProjcache', true),
            protectCredentials: flag('protectCredentials', true), guardShellText: flag('guardShellText', true),
            autoOwnWrites: flag('autoOwnWrites', true),
            denyHomeByDefault: flag('denyHomeByDefault', true),
            ownerExemptLabels: str('ownerExemptLabels', '复核,审计,评审,独立,复算,对抗,验证,verify,review,audit,recompute,adversarial'),
            auditEnabled: flag('auditEnabled', true), auditFile: flag('auditEnabled', true) ? auditFile() : '',
          },
          // ★★ 配置有没有被悄悄改过（"把监考老师踢出去"的痕迹）
          configDrift: checkCfgDrift(),
          // ★★ 小窗红字告警的数据源
          alert: { bypass: alerts.bypass, config: alerts.config },
          // 账本完整性：文件行数 vs 本进程应写的行数 —— 对不上就是账本被动过
          ledger: (() => {
            let actual = 0
            try { const f = auditFile(); if (f && existsSync(f)) actual = readFileSync(f, 'utf8').split('\n').filter(Boolean).length } catch { }
            const expected = rowsAtBoot + appended
            return { rowsAtBoot, appended, expected, actual, tampered: actual < expected, warns: warnCount }
          })(),
          // 「谁写的谁拥有」的现状（设置页显示 + 事后核查）
          own: {
            enabled: flag('autoOwnWrites', true),
            total: Object.keys(ownState.owned).length,
            shared: ownState.shared.slice(0, 20),
            // ★ 篡改可检测：文件里的登记数 < 内存里的 → 归属表被动过（被删或被改写都会命中）
            tampered: (() => {
              try {
                const mem = Object.keys(ownState.owned).length
                const f = ownFile()
                if (!f) return false
                if (!existsSync(f)) return mem > 0
                const j = JSON.parse(readFileSync(f, 'utf8'))
                return Object.keys(j?.owned ?? {}).length < mem
              } catch { return false }
            })(),
            entriesAtBoot: ownedAtBoot,
            recent: Object.entries(ownState.owned)
              .sort((a, b) => String(b[1]?.ts).localeCompare(String(a[1]?.ts)))
              .slice(0, 8)
              .map(([p, o]) => ({ path: p, label: o?.label ?? null, by: String(o?.by ?? '').slice(0, 12), ts: o?.ts ?? null })),
          },
          // 宿主算好的"当前到底有没有在拦东西"——页面据此显红字
          effective: effectiveStatus({
            config: {
              enabled: flag('enabled', true), scope: str('scope', 'subagents'), mode: str('mode', 'all'),
              protectSessions: flag('protectSessions', true), protectProjcache: flag('protectProjcache', true),
              protectCredentials: flag('protectCredentials', true),
            },
            rules,
            overrides: Object.fromEntries(overrides),
          }),
          rules: withDetail ? rules : { defaultPolicy: rules.defaultPolicy },
          counts: { workspaces: listWorkspaces().length, windows: listWindows().length },
          // 清单与拒绝明细只在**通过鉴权**时给（reduced 模式只给计数）
          workspaces: withDetail ? listWorkspaces() : [],
          windows: withDetail ? listWindows() : [],
          // 本次会话 vs 账本历史，分开给（小窗据此区分显示，不再把历史当刚发生）
          denied: {
            total: stats.total,
            windows: stats.windows.size,
            historyTotal: history.total,
            historyWindows: history.windows.size,
            auditEnabled: flag('auditEnabled', true),
            source: stats.recent.length > 0 ? 'session' : (history.recent.length > 0 ? 'history' : 'none'),
          },
          // 优先给本次会话的明细；本次没有才回落到账本历史（并已用 source 标明）
          recent: withDetail ? (stats.recent.length > 0 ? stats.recent : history.recent).slice(-8) : [],
          detail: withDetail,
        })

        disposers.push(child.webServer.register({
          kind: 'exact', path: WIDGET_SRC,
          handler: (req, res) => {
            try {
              const body = readFileSync(WIDGET_FILE, 'utf8')
              res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(Buffer.byteLength(body)) })
              res.end(body)
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('subagent-shield: cannot read widget.js: ' + String(e?.message ?? e))
            }
          },
        }))

        disposers.push(child.webServer.register({
          kind: 'exact', path: STATUS_SRC,
          handler: (req, res) => {
            try {
              const auth = authOf(req)
              if (auth === 401 || auth === 403) { denyAuth(res, auth); return }
              // 'full' = 通过 GUI 鉴权；'reduced' = 没有 connection 服务 → 只给计数，不给清单
              sendJson(res, 200, statusPayload(auth === 'full'))
            } catch (e) { sendJson(res, 500, { error: String(e?.message ?? e) }) }
          },
        }))

        disposers.push(child.webServer.register({
          kind: 'exact', path: RULES_SRC,
          handler: (req, res) => {
            // 规则里含"点名了哪些工作区/窗口"（元数据），读写都要求通过鉴权
            const auth = authOf(req)
            if (auth !== 'full') { denyAuth(res, auth === 'reduced' ? 401 : auth); return }
            if (req.method !== 'POST') { sendJson(res, 200, { rules }); return }
            readBody(req).then((text) => {
              let patch = null
              try { patch = text ? JSON.parse(text) : null } catch { sendJson(res, 400, { error: 'invalid-json' }); return }
              if (!patch || typeof patch !== 'object') { sendJson(res, 400, { error: 'invalid-body' }); return }
              try {
                // ⚠ 必须**换一个新对象**，不能就地改：
                //   `aggOf()` 按规则对象的身份做 WeakMap 缓存；就地改会让缓存变成陈旧值。
                const next = {
                  version: 1,
                  defaultPolicy: (patch.defaultPolicy === 'protect' || patch.defaultPolicy === 'allow')
                    ? patch.defaultPolicy : rules.defaultPolicy,
                  workspaces: { ...rules.workspaces },
                  windows: { ...rules.windows },
                  // ★ 自定义受保护路径：整体替换语义（前端每次提交完整列表）
                  protectedPaths: Array.isArray(patch.protectedPaths)
                    ? cleanProtectedPaths(patch.protectedPaths)
                    : (rules.protectedPaths ?? []),
                }
                for (const bucket of ['workspaces', 'windows']) {
                  const src = patch[bucket]
                  if (!src || typeof src !== 'object') continue
                  for (const [k, v] of Object.entries(src)) {
                    if (typeof k !== 'string' || !k) continue
                    if (v === null) delete next[bucket][k]
                    else next[bucket][k] = Boolean(v)
                  }
                }
                rules = next
                saveRules()
                sendJson(res, 200, { ok: true, rules, workspaces: listWorkspaces(), windows: listWindows() })
              } catch (e) { sendJson(res, 500, { error: String(e?.message ?? e) }) }
            })
          },
        }))

        try {
          disposers.push(child.webServer.tapIndex((html) => {
            if (typeof html !== 'string' || html.includes(WIDGET_SRC)) return html
            const tag = `<script defer src="${WIDGET_SRC}"></script>`
            return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
          }))
        } catch (e) { console.log('[subagent-shield] tapIndex 不可用：' + String(e?.message ?? e)) }

        try {
          disposers.push(child.on('webserver/index-inject', (table) => {
            try {
              if (!Array.isArray(table)) return
              for (const row of table) if (row && row.kind === 'script-src' && row.src === WIDGET_SRC) return
              table.push({ kind: 'script-src', placement: 'body', src: WIDGET_SRC })
            } catch { }
          }))
        } catch { }

        child.effect(() => () => { for (const d of disposers) { try { d() } catch { } } })
        console.log(`[subagent-shield] 接口就绪：${STATUS_SRC} / ${RULES_SRC}　小窗：${WIDGET_SRC}`)
      } catch (e) {
        console.log(`[subagent-shield] 状态接口装配失败（已吞掉）：${String(e?.message ?? e)}`)
      }
    })

    console.log(`[subagent-shield] 已挂载 v4；DSH_HOME=${home()}；scope=${str('scope', 'subagents')}；defaultPolicy=${rules.defaultPolicy}；工作区规则 ${Object.keys(rules.workspaces).length} 条；窗口规则 ${Object.keys(rules.windows).length} 条`)
  } catch (error) {
    console.log(`[subagent-shield] 挂载失败（已吞掉，不影响宿主）：${error?.message ?? error}`)
  }
}

// ═══ 子代理识别 / 窗口归属 / 窗口策略（与 v3 相同）

export function isSubagentAgent(agent) {
  const h = agent?.session?.header
  if (!h) return false
  if (h.origin === 'subagent') return true
  if (typeof h.delegationDepth === 'number' && h.delegationDepth > 0) return true
  return typeof h.parentSession === 'string' && h.parentSession.length > 0
}

export function windowOf(agent) {
  const h = agent?.session?.header
  if (!h) return null
  return h.parentSession ?? h.id ?? null
}

export function resolveWindowPolicy(mode, override) {
  const dflt = mode !== 'window'
  return typeof override === 'boolean' ? override : dflt
}
