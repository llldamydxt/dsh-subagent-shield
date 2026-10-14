#!/usr/bin/env node
/**
 * dsh-subagent-shield —— 语义层「族谱矩阵」测试
 *
 * 存在的原因：今晚 4 个真漏洞是**同一族** ——
 *   「拿不到确定的目标 → 回落到宽松默认 → 放行」。
 *   · settingsScope（服务名臆想）
 *   · glob/grep 的 pattern 参数没查
 *   · 目录级路径（ws/sid 为 null）回落 defaultPolicy
 *   · 通配符 token（** / *）回落 defaultPolicy
 * 靠红队"碰运气"抓它们效率太低。这里改成**穷举**：
 *
 *   ① 把「规范」**独立重写一遍**当预言机（oracle，不看实现写的）
 *   ② 对 身份 × 规则 × 类别 的叉乘逐个比对 —— 两个独立实现不一致处即漏洞
 *   ③ 再对 形态 × 类别 × 工具参数 的叉乘穷举（混淆与参数名维度）
 *   ④ 最后钉住一条**总不变式**：只有"具体且明确豁免"才放行，其余一律拦
 *
 * 只在沙箱里跑，不碰正在用的 DSH。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findCheckout, findDshBin, nodeExe, sampleHome } from './_env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 插件根自动识别，兼容两种布局：
//   ① 作者测试台：<台>\独立测试台\ + <台>\隔离插件\  ② git 仓库：<仓库>\test\ + <仓库>\lib\
const PLUGIN_SRC = existsSync(join(HERE, '..', '隔离插件', 'lib', 'index.js')) ? join(HERE, '..', '隔离插件') : join(HERE, '..')
const CHECKOUT = findCheckout()
const HOME = sampleHome()   // 只当"受保护根"样例，不读写

const results = []
const check = (title, ok, detail = '') => {
  results.push({ title, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${title}${detail ? '  —— ' + detail : ''}`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const sandbox = join(tmpdir(), 'dsh-isolated-tests', 'matrix-' + stamp)
const cleanup = () => { try { rmSync(sandbox, { recursive: true, force: true }) } catch { } }
process.on('SIGINT', () => { cleanup(); process.exit(130) })

function installForUnitTests(dest) {
  mkdirSync(join(dest, '..', 'node_modules', '@deepseek-ai'), { recursive: true })
  const smLink = join(dest, '..', 'node_modules', '@deepseek-ai', 'schemastery')
  try { rmSync(smLink, { recursive: true, force: true }) } catch { }
  spawnSync('cmd', ['/c', 'mklink', '/J', smLink, join(CHECKOUT, 'node_modules', '@deepseek-ai', 'schemastery')], { stdio: 'ignore' })
  spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, dest, '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
}

console.log('🐋 dsh-subagent-shield —— 族谱矩阵测试')
console.log(`   插件: ${PLUGIN_SRC}`)
console.log(`   沙箱: ${sandbox}\n`)

// ═══════════════════════════════════════════════════════════════
// ① 预言机：**照规范散文重写**，不参考实现代码
//    规范：优先级 具体窗口 > 具体工作区 > 目录级(祖先) > defaultPolicy；
//          目录级/通配/未知 一律按"后代的并集"处理 —— 只要下面还有受保护对象就拦。
// ═══════════════════════════════════════════════════════════════
const concrete = (v) => typeof v === 'string' && v.length > 0 && !/[*?]/.test(v)
const has = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k)

/** 规范实现（独立于插件实现） */
function spec({ kind, ws, sid }, rules, cats) {
  if (kind === 'credentials') return cats.protectCredentials !== false
  if (kind === 'sessions' && cats.protectSessions === false) return false
  if (kind === 'projcache' && cats.protectProjcache === false) return false

  const W = rules.workspaces || {}, N = rules.windows || {}
  const anyWin = Object.values(N).some(Boolean)
  const anyWs = Object.values(W).some(Boolean)
  const dflt = (rules.defaultPolicy ?? 'protect') !== 'allow'
  /** 目录级 / 不确定目标的判定：默认保护，或下面还有任何受保护对象 */
  const ancestor = () => dflt || anyWin || anyWs

  if (kind === 'projcache') {
    if (!concrete(sid)) return ancestor()   // 通配或缺失的 sid → 保守
    if (has(N, sid)) return Boolean(N[sid])
    return dflt
  }
  // sessions
  // 规范第 1 条：**任一身份不确定（通配/缺失）⇒ 先保守**，
  //   不再去看"被点名的窗口" —— 通配前缀代表查询面很宽，不能只凭一个名字就放行。
  //   （实测：ws="**" + sid="sid-1"(已豁免) 这一格，实现选择拦，是对的）
  if (!concrete(sid) || !concrete(ws)) {
    if (concrete(ws) && has(W, ws) && W[ws] === true) return true   // 该工作区被点名保护
    return ancestor()
  }
  // 规范第 2 条：两侧都具体 = 单个叶子 → 具体窗口 > 具体工作区 > 默认策略
  if (has(N, sid)) return Boolean(N[sid])
  if (has(W, ws)) return Boolean(W[ws])
  return dflt
}

// ═══════════════════════════════════════════════════════════════
// ② 叉乘：身份 × 规则 × 类别
// ═══════════════════════════════════════════════════════════════
const WS_TOKENS = ['ws-alpha', 'ws-beta', 'ws-unknown', null, '', '**', '*']
const SID_TOKENS = ['sid-1', 'sid-2', 'sid-unknown', null, '', '*.jsonl.zstd', '**']
const KINDS = ['sessions', 'projcache', 'credentials']
const RULE_SETS = [
  ['默认保护·无覆盖', { defaultPolicy: 'protect', workspaces: {}, windows: {} }],
  ['默认放行·无覆盖', { defaultPolicy: 'allow', workspaces: {}, windows: {} }],
  ['默认放行·点名工作区', { defaultPolicy: 'allow', workspaces: { 'ws-alpha': true }, windows: {} }],
  ['默认放行·点名窗口', { defaultPolicy: 'allow', workspaces: {}, windows: { 'sid-1': true } }],
  ['默认保护·豁免工作区', { defaultPolicy: 'protect', workspaces: { 'ws-alpha': false }, windows: {} }],
  ['默认保护·豁免窗口', { defaultPolicy: 'protect', workspaces: {}, windows: { 'sid-1': false } }],
  ['窗口豁免盖过工作区', { defaultPolicy: 'protect', workspaces: { 'ws-alpha': true }, windows: { 'sid-1': false } }],
  ['默认放行·全 false', { defaultPolicy: 'allow', workspaces: { 'ws-alpha': false, 'ws-beta': false }, windows: { 'sid-1': false, 'sid-2': false } }],
  ['默认放行·全 true', { defaultPolicy: 'allow', workspaces: { 'ws-alpha': true, 'ws-beta': true }, windows: { 'sid-1': true, 'sid-2': true } }],
  ['混合真假', { defaultPolicy: 'allow', workspaces: { 'ws-alpha': true, 'ws-beta': false }, windows: { 'sid-1': false, 'sid-2': true } }],
]
const CAT_SETS = [
  ['三类全开', { protectSessions: true, protectProjcache: true, protectCredentials: true }],
  ['凭据关', { protectSessions: true, protectProjcache: true, protectCredentials: false }],
  ['会话关', { protectSessions: false, protectProjcache: true, protectCredentials: true }],
  ['三类全关', { protectSessions: false, protectProjcache: false, protectCredentials: false }],
]

let mod = null
try {
  const unitDir = join(sandbox, 'unit', 'dsh-subagent-shield')
  installForUnitTests(unitDir)
  mod = await import(pathToFileURL(join(unitDir, 'lib', 'index.js')).href)

  console.log('── M1 预言机比对：身份 × 规则 × 类别')
  let cases = 0
  const violations = []
  for (const kind of KINDS) {
    for (const ws of WS_TOKENS) {
      for (const sid of SID_TOKENS) {
        // projcache 只看 sid；sessions 两者都看；credentials 都不看
        if (kind === 'projcache' && ws !== 'ws-alpha') continue          // 去重
        if (kind === 'credentials' && (ws !== 'ws-alpha' || sid !== 'sid-1')) continue
        for (const [rName, rules] of RULE_SETS) {
          for (const [cName, cats] of CAT_SETS) {
            cases++
            const info = { kind, ws, sid }
            const want = spec(info, rules, cats)
            const got = mod.isProtected(info, rules, cats) === true
            if (want !== got) {
              violations.push({ kind, ws, sid, rName, cName, want, got, rules, cats })
            }
          }
        }
      }
    }
  }
  check(`M1 预言机比对：${cases} 组组合零分歧`, violations.length === 0,
    violations.length
      ? `${violations.length} 处分歧，前 3 处：` + violations.slice(0, 3).map((v) => `[${v.kind} ws=${JSON.stringify(v.ws)} sid=${JSON.stringify(v.sid)} ${v.rName}/${v.cName}] 规范=${v.want} 实现=${v.got}`).join(' ； ')
      : '规范与实现在整个叉乘上一致')

  console.log('\n── M2 总不变式：放行必须落在「用户显式允许的范围内」')
  // 独立于预言机的安全性质（不重跑实现）：
  //   · 被点名 protect 的具体对象，放行就是错的（不论默认策略）
  //   · 默认放行时，未点名放行 = 用户明确要的，合法
  //   · 默认保护时，放行必须能追溯到一条具体豁免
  const allowedIsJustified = ({ kind, ws, sid }, rules) => {
    const W = rules.workspaces || {}, N = rules.windows || {}
    const anyWin = Object.values(N).some(Boolean)
    const dflt = (rules.defaultPolicy ?? 'protect') !== 'allow'
    if (concrete(sid) && has(N, sid) && N[sid] === true) return false          // 点名 protect 却放行
    if (!concrete(sid) && concrete(ws) && has(W, ws) && W[ws] === true) return false  // 点名保护的工作区，目录级被放行
    if (!dflt) return true                                                     // 默认放行：未点名即合法
    if (concrete(sid) && has(N, sid) && N[sid] === false) return true           // 具体窗口点名豁免
    if (concrete(sid) && concrete(ws) && !has(N, sid) && has(W, ws) && W[ws] === false) return true  // 具体文件落在豁免工作区
    if (!concrete(sid) && concrete(ws) && has(W, ws) && W[ws] === false && !anyWin) return true      // 整片确无保护
    return false
  }
  const ALLOW_RULES = [
    ['默认保护·无覆盖', { defaultPolicy: 'protect', workspaces: {}, windows: {} }],
    ['默认放行·无覆盖', { defaultPolicy: 'allow', workspaces: {}, windows: {} }],
    ['默认保护·豁免工作区', { defaultPolicy: 'protect', workspaces: { 'ws-beta': false }, windows: {} }],
    ['默认保护·豁免窗口', { defaultPolicy: 'protect', workspaces: {}, windows: { 'sid-2': false } }],
    ['默认放行·点名拦住一个窗口', { defaultPolicy: 'allow', workspaces: {}, windows: { 'sid-1': true } }],
    ['默认保护·豁免工作区但点名保护一个窗口', { defaultPolicy: 'protect', workspaces: { 'ws-beta': false }, windows: { 'sid-1': true } }],
  ]
  let unsafe = 0
  const unsafeCases = []
  let allowedTotal = 0
  for (const kind of KINDS) {
    for (const ws of WS_TOKENS) for (const sid of SID_TOKENS) {
      if (kind === 'projcache' && ws !== 'ws-alpha') continue
      if (kind === 'credentials' && (ws !== 'ws-alpha' || sid !== 'sid-1')) continue
      for (const [rName, rules] of ALLOW_RULES) {
        const info = { kind, ws, sid }
        if (kind === 'credentials') continue                    // 凭据的放行只在"三类全关"时，由 M5 覆盖
        const got = mod.isProtected(info, rules, CAT_SETS[0][1])
        if (got) continue
        allowedTotal++
        if (!allowedIsJustified(info, rules)) {
          unsafe++
          if (unsafeCases.length < 6) unsafeCases.push(`${rName} / ${kind} ws=${JSON.stringify(ws)} sid=${JSON.stringify(sid)}`)
        }
      }
    }
  }
  check(`M2 放行全部落在显式允许范围内（共检查 ${allowedTotal} 组放行）`, unsafe === 0,
    unsafe ? `${unsafe} 组越界放行：${unsafeCases.join('；')}` : '没有一组越界')

  console.log('\n── M3 具体且明确豁免 → 必须放行（不误伤）')
  const exemptOk = []
  const checksExempt = [
    [{ kind: 'sessions', ws: 'ws-beta', sid: 'sid-x' }, { defaultPolicy: 'protect', workspaces: { 'ws-beta': false }, windows: {} }],
    [{ kind: 'sessions', ws: 'ws-alpha', sid: 'sid-2' }, { defaultPolicy: 'protect', workspaces: {}, windows: { 'sid-2': false } }],
    [{ kind: 'projcache', ws: null, sid: 'sid-2' }, { defaultPolicy: 'protect', workspaces: {}, windows: { 'sid-2': false } }],
    [{ kind: 'sessions', ws: 'ws-x', sid: 'sid-x' }, { defaultPolicy: 'allow', workspaces: {}, windows: {} }],
  ]
  for (const [info, rules] of checksExempt) {
    const got = mod.isProtected(info, rules, CAT_SETS[0][1])
    exemptOk.push(!got ? true : false)
  }
  check('M3 明确豁免的具体对象仍放行', exemptOk.every(Boolean),
    `${exemptOk.filter(Boolean).length}/${exemptOk.length} 条放行`)

  console.log('\n── M4 形态 × 类别 × 工具参数 叉乘')
  const WS_ENC = '--C-Users-me-~8BBA~5B50~7A97~53E3--'
  const P_SESS = `${HOME}\\sessions\\${WS_ENC}\\sid-1\\session.v4.jsonl.zstd`
  const P_PROJ = `${HOME}\\storages\\session_projcache\\sessions\\sid-1.json`
  const P_CRED = `${HOME}\\.credentials.yaml`
  const P_RULE = `${HOME}\\subagent-shield-rules.json`
  const FORMS = [
    ['原样', (p) => p],
    ['正斜杠', (p) => p.replace(/\\/g, '/')],
    ['整体大写', (p) => p.toUpperCase()],
    ['双引号包裹', (p) => `"${p}"`],
    ['\\\\?\\ 前缀', (p) => '\\\\?\\' + p],
    ['叠 ../', (p) => p.replace('\\sessions\\', '\\sessions\\..\\sessions\\')],
    ['叠 .\\', (p) => p.replace('\\sessions\\', '\\.\\sessions\\')],
    ['重复分隔符', (p) => p.replace('\\sessions\\', '\\\\sessions\\\\')],
  ]
  const TOOL_ARG = [
    ['read', 'file_path', (p) => ({ file_path: p })],
    ['write', 'file_path', (p) => ({ file_path: p, content: 'x' })],
    ['edit', 'file_path', (p) => ({ file_path: p, old_string: 'a', new_string: 'b' })],
    ['glob(path)', 'path', (p) => ({ pattern: '**/*.x', path: p })],
    ['glob(pattern)', 'pattern', (p) => ({ pattern: p })],
    ['grep(path)', 'path', (p) => ({ pattern: 'x', path: p })],
    ['grep(include)', 'include', (p) => ({ pattern: 'x', include: p })],
  ]
  const TARGETS = [['会话文件', P_SESS], ['投影缓存', P_PROJ], ['凭据', P_CRED], ['规则文件', P_RULE]]
  const R_PROTECT = { defaultPolicy: 'protect', workspaces: {}, windows: {} }
  let combos = 0
  const leaks = []
  for (const [tName, p] of TARGETS) {
    for (const [fName, form] of FORMS) {
      for (const [tool, argName, build] of TOOL_ARG) {
        combos++
        const h = mod.evaluateCall({
          name: tool.split('(')[0], args: build(form(p)), isSubagent: true,
          home: HOME, auditFile: `${HOME}\\subagent-shield-audit.jsonl`, rules: R_PROTECT, cats: CAT_SETS[0][1], guardShellText: true,
        })
        if (!h) leaks.push(`${tName}/${fName}/${tool}(${argName})`)
      }
    }
  }
  check(`M4 形态×目标×工具 ${combos} 组组合全部拦住`, leaks.length === 0,
    leaks.length ? `${leaks.length} 组漏网：` + leaks.slice(0, 6).join('，') : '8 种形态 × 4 类目标 × 7 种工具参数，全拦')

  console.log('\n── M5 零保护时不该乱拦（防过度收紧）')
  const NO_PROTECT = { defaultPolicy: 'allow', workspaces: {}, windows: {} }
  const NO_CATS = { protectSessions: false, protectProjcache: false, protectCredentials: false }
  let overBlocked = 0
  for (const [tName, p] of TARGETS.filter(([n]) => n !== '规则文件')) {
    for (const [tool, , build] of TOOL_ARG) {
      const h = mod.evaluateCall({
        name: tool.split('(')[0], args: build(p), isSubagent: true,
        home: HOME, auditFile: '', rules: NO_PROTECT, cats: NO_CATS, guardShellText: true,
      })
      if (h) overBlocked++
    }
  }
  check('M5 三类全关 + 默认放行 → 普通目标放行（不误伤）', overBlocked === 0, overBlocked ? `${overBlocked} 组被误拦` : '组合零误拦')

  console.log('\n── M6 自身文件永远保护（与用户规则无关）')
  let selfLeaks = 0
  for (const p of [P_RULE, `${HOME}\\subagent-shield-state.json`, `${HOME}\\subagent-shield-audit.jsonl`]) {
    for (const [tool, , build] of TOOL_ARG) {
      const h = mod.evaluateCall({
        name: tool.split('(')[0], args: build(p), isSubagent: true,
        home: HOME, auditFile: `${HOME}\\subagent-shield-audit.jsonl`,
        rules: NO_PROTECT, cats: NO_CATS, guardShellText: false,
      })
      if (!h) selfLeaks++
    }
  }
  check('M6 即使保护全关，插件自身文件仍拦住', selfLeaks === 0, selfLeaks ? `${selfLeaks} 组漏网` : '规则/状态/账本 × 7 种工具参数，全拦')

  // ★★ 回归（评审 P2）：规则条数不该影响单次判定耗时
  //    原版每次判定都 `Object.values(rules.windows).some(Boolean)` 铺开整张表：
  //    实测 0 条 4.7 µs → 6400 条 3439 µs（732×）。而设置页的主用法恰恰是逐条点名，
  //    这个劣化正好惩罚它自己的推荐用法。修法：按规则对象身份缓存聚合值。
  console.log('\n── M7 性能：规则条数不该拖慢单次判定（评审 P2）')
  const mkRules = (n) => {
    const w = {}
    for (let i = 0; i < n; i++) w['sid-' + i] = true
    w['sid-1'] = true
    return { defaultPolicy: 'allow', workspaces: {}, windows: w }
  }
  const benchUs = (rules) => {
    const call = {
      name: 'read',
      args: { file_path: `${HOME}\\sessions\\--C-Users-me-~8BBA~5B50~7A97~53E3--\\sid-1\\session.v4.jsonl.zstd` },
      isSubagent: true, home: HOME, auditFile: '', rules, cats: CAT_SETS[0][1], guardShellText: true,
    }
    for (let i = 0; i < 3000; i++) mod.evaluateCall(call)      // 预热（含首次聚合计算）
    const t0 = process.hrtime.bigint()
    const N = 20000
    for (let i = 0; i < N; i++) mod.evaluateCall(call)
    return Number(process.hrtime.bigint() - t0) / N / 1000     // µs
  }
  const us0 = benchUs(mkRules(0))
  const us3k = benchUs(mkRules(3000))
  const ratio = us3k / Math.max(us0, 0.001)
  check(`M7 规则 0 → 3000 条：单次判定增长 ${ratio.toFixed(2)}×（阈值 < 10）`, ratio < 10,
    `${us0.toFixed(2)} µs → ${us3k.toFixed(2)} µs（未修时是几百倍）`)

  // ★★ 回归（评审 P7）：这三格**反直觉但实测为准**，显式钉住，
  //    免得下一个人按散文规范把判定改坏（评审者自己按散文推错了 3 次）。
  console.log('\n── M8 反直觉三格（allow + 无人点名）')
  const R_NONE = { defaultPolicy: 'allow', workspaces: {}, windows: {} }
  const R_SOME = { defaultPolicy: 'protect', workspaces: {}, windows: {} }
  const odd = [
    ['ws 具体 + sid 通配（**）', { kind: 'sessions', ws: 'ws-alpha', sid: '**' }],
    ['ws 通配（**）+ sid 具体', { kind: 'sessions', ws: '**', sid: 'sid-1' }],
    ['ws 缺失 + sid 具体', { kind: 'sessions', ws: null, sid: 'sid-1' }],
  ]
  for (const [label, info] of odd) {
    const allow = mod.isProtected(info, R_NONE, CAT_SETS[0][1])
    const prot = mod.isProtected(info, R_SOME, CAT_SETS[0][1])
    check(`M8 ${label}：allow+无人点名 → 放行；改回 protect → 拦`, allow === false && prot === true,
      `allow=${allow ? '拦' : '放行'}  protect=${prot ? '拦' : '放行'}（祖先并集为空时无处可保守）`)
  }
  // ★★ 臂间隔离（自定义受保护路径）—— 为什么加：护盾原先只管 DSH 自己的记录，
  //    **完全不管实验产物**。实测子代理 C 能直接读到兄弟臂写下的文件，
  //    而在真对照实验里"A 臂看到 B 臂的产物"比"翻会话记录"常见得多。
  console.log('\n── M9 臂间隔离：自定义受保护路径（path + 归属窗口）')
  {
    const LAB = 'C:\\lab'
    const ARM_A = `${LAB}\\armA`
    const ARM_B = `${LAB}\\armB`
    const WIN_A = 'session-aaaa-1111'
    const WIN_B = 'session-bbbb-2222'
    const R_B = { defaultPolicy: 'protect', workspaces: {}, windows: {}, protectedPaths: [{ path: ARM_B, owner: WIN_B }] }
    const R_B_NOOWNER = { defaultPolicy: 'protect', workspaces: {}, windows: {}, protectedPaths: [{ path: ARM_B }] }
    const call = (file, win, rules) => mod.evaluateCall({
      name: 'read', args: { file_path: file }, isSubagent: true, scope: 'subagents',
      home: HOME, auditFile: '', rules, cats: CAT_SETS[0][1], guardShellText: true, window: win,
    })

    check('M9 非归属窗口读臂B 目录 → 拦', Boolean(call(`${ARM_B}\\out.json`, WIN_A, R_B)))
    check('M9 归属窗口（臂B 自己）读 → 放行', !call(`${ARM_B}\\out.json`, WIN_B, R_B))
    check('M9 归属窗口的子代理也放行（window 相同）', !call(`${ARM_B}\\sub\\x.txt`, WIN_B, R_B))
    check('M9 命中拒绝文案里点明"归属者"', /归属者/.test(String(call(`${ARM_B}\\out.json`, WIN_A, R_B)?.reason ?? '')),
      String(call(`${ARM_B}\\out.json`, WIN_A, R_B)?.reason ?? '').slice(0, 90))
    check('M9 未指定 owner → 对所有人受保护', Boolean(call(`${ARM_B}\\out.json`, WIN_B, R_B_NOOWNER)))
    check('M9 目录本身（不含分隔符）也拦', Boolean(call(ARM_B, WIN_A, R_B)))
    check('M9 ★ 前缀碰撞：…\\armB2 不能被 …\\armB 误吃', !call(`${ARM_B}2\\out.json`, WIN_A, R_B))
    check('M9 大小写 / 正斜杠变体照样命中', Boolean(call(`c:/LAB/ARMB/out.json`, WIN_A, R_B)))
    check('M9 `..` 穿越：armA\\..\\armB\\x → 仍命中', Boolean(call(`${ARM_A}\\..\\armB\\x.txt`, WIN_A, R_B)))
    check('M9 臂A 自己的目录不受影响', !call(`${ARM_A}\\out.json`, WIN_A, R_B))
    check('M9 ★ 配了自定义路径也不影响原有保护（会话仍拦）',
      Boolean(call(`${HOME}\\sessions\\ws\\sid\\session.v4.jsonl.zstd`, WIN_A, R_B)))

    // 命令族：字面出现路径文本
    const sh = (cmd, win, rules) => mod.evaluateCall({
      name: 'pwsh', args: { command: cmd }, isSubagent: true, scope: 'subagents',
      home: HOME, auditFile: '', rules, cats: CAT_SETS[0][1], guardShellText: true, window: win,
    })
    check('M9 命令行字面出现臂B 路径 → 拦', Boolean(sh(`Get-Content "${ARM_B}\\out.json"`, WIN_A, R_B)))
    check('M9 归属窗口执行同样命令 → 放行', !sh(`Get-Content "${ARM_B}\\out.json"`, WIN_B, R_B))
    check('M9 命令族拒绝文案标明是启发式', /启发式/.test(String(sh(`type ${ARM_B}\\out.json`, WIN_A, R_B)?.reason ?? '')))

    // ★ 前缀容错：DSH 里同一会话的 id 有时带 session- 前缀有时不带（账本实测过）
    check('M9 ★ 归属比较容错 session- 前缀（带/不带都算同一个窗口）',
      !call(`${ARM_B}\\out.json`, 'bbbb-2222', R_B) && !call(`${ARM_B}\\out.json`, 'session-bbbb-2222', R_B),
      'owner=session-bbbb-2222，两种写法都应放行')
    check('M9 ★ 前缀容错不会把不同窗口算成同一个',
      Boolean(call(`${ARM_B}\\out.json`, 'session-cccc-3333', R_B)) === true,
      '别的窗口仍应被拦')
    check('M9 sameWindow 的直接行为',
      mod.sameWindow('session-x1', 'x1') && mod.sameWindow('X1', 'session-x1') && !mod.sameWindow('x1', 'x2'))
    // ★★ 标签归属：**一个窗口开多个子代理**时区分臂（这正是"子代理能跑"的关键）
    const R_LAB = { defaultPolicy: 'protect', workspaces: {}, windows: {}, protectedPaths: [{ path: ARM_B, label: 'Arm B' }] }
    const callL = (file, who) => mod.evaluateCall({
      name: 'read', args: { file_path: file }, isSubagent: true, scope: 'subagents',
      home: HOME, auditFile: '', rules: R_LAB, cats: CAT_SETS[0][1], guardShellText: true, ...who,
    })
    check('M9 ★ 标签匹配 → 放行（同一窗口下的臂B）',
      !callL(`${ARM_B}\\out.json`, { window: WIN_A, caller: 'sub-b', label: 'Arm B of demo' }))
    check('M9 ★ 标签不匹配 → 拦住（同一窗口下的臂A）',
      Boolean(callL(`${ARM_B}\\out.json`, { window: WIN_A, caller: 'sub-a', label: 'Arm A of demo' })))
    check('M9 ★ 没有标签的调用者 → 拦住（不会误放行）',
      Boolean(callL(`${ARM_B}\\out.json`, { window: WIN_A, caller: 'sub-a', label: null })))
    check('M9 ★ owner 直接等于子代理自己的会话 id → 放行（子代理自报）',
      !mod.evaluateCall({
        name: 'read', args: { file_path: `${ARM_B}\\x` }, isSubagent: true, scope: 'subagents',
        home: HOME, auditFile: '', cats: CAT_SETS[0][1],
        rules: { defaultPolicy: 'protect', workspaces: {}, windows: {}, protectedPaths: [{ path: ARM_B, owner: 'sub-b' }] },
        window: WIN_A, caller: 'sub-b', label: null,
      }))
    check('M9 ★ isOwnerCall 的三种判据各自成立',
      mod.isOwnerCall({ window: 'w1' }, { owner: 'w1' }) &&
      mod.isOwnerCall({ callerId: 'c1' }, { owner: 'c1' }) &&
      mod.isOwnerCall({ label: 'Arm B（基线）' }, { label: 'arm b' }) &&
      !mod.isOwnerCall({ label: 'Arm A' }, { label: 'arm b' }) &&
      !mod.isOwnerCall({}, { owner: 'w1' }))
    check('M9 ★ 命令族也认标签',
      !mod.evaluateCall({
        name: 'pwsh', args: { command: `type "${ARM_B}\\x"` }, isSubagent: true, scope: 'subagents',
        home: HOME, auditFile: '', rules: R_LAB, cats: CAT_SETS[0][1], guardShellText: true,
        window: WIN_A, caller: 'sub-b', label: 'Arm B of demo',
      }))
    // ★ 拒绝文案要按**实际配的那一种归属**说
    //   （踩过：纯标签规则被拒时提示却说"未指定归属窗口"，排查时会被带偏）
    check('M9 ★ 纯标签规则的拒绝文案点明是标签不匹配',
      /标签/.test(String(callL(`${ARM_B}\\out.json`, { window: WIN_A, caller: 'sub-a', label: 'Arm A' })?.reason ?? '')),
      String(callL(`${ARM_B}\\out.json`, { window: WIN_A, caller: 'sub-a', label: 'Arm A' })?.reason ?? '').slice(0, 80))
    check('M9 ★ 真没设归属时才说"没设归属"',
      /没设归属/.test(String(call(`${ARM_B}\\out.json`, WIN_A, R_B_NOOWNER)?.reason ?? '')),
      String(call(`${ARM_B}\\out.json`, WIN_A, R_B_NOOWNER)?.reason ?? '').slice(0, 80))
  // ★★ 「谁写的谁拥有」——自动臂间隔离
  //    为什么需要：protectedPaths 要求先知道"哪个目录归哪个臂"（还要每臂一个子目录）；
  //    而这个功能的用法是"随手建个文件夹、开个窗口、派两个子代理各做一遍"，那时没人愿意先配规则。
  console.log('\n── M10 谁写的谁拥有（自动臂间隔离）')
  {
    const P1 = 'C:\\lab\\out\\a.js'
    const P2 = 'C:\\lab\\out\\b.js'
    const OWN = {
      version: 1, shared: [],
      owned: { [mod.normalizePath(P1)]: { by: 'sub-a', label: '臂A', ts: '2026-10-11T00:00:00Z' } },
    }
    const call = (file, who, extra = {}) => mod.evaluateCall({
      name: 'read', args: { file_path: file }, isSubagent: true, scope: 'subagents',
      home: HOME, auditFile: '', rules: {}, cats: {}, guardShellText: true,
      autoOwnWrites: true, ownState: OWN, ...who, ...extra,
    })

    check('M10 ★ 别的子代理读它写出的文件 → 拦', call(P1, { caller: 'sub-b' })?.kind === 'owned',
      JSON.stringify(call(P1, { caller: 'sub-b' })?.reason ?? '').slice(0, 70))
    check('M10 ★ 它自己读 → 放行', !call(P1, { caller: 'sub-a' }))
    check('M10 没登记过的文件 → 放行（父会话写的都算公共）', !call(P2, { caller: 'sub-b' }))
    check('M10 ★ 拒绝文案里直接给出逃生门', /shield 放行/.test(String(call(P1, { caller: 'sub-b' })?.reason ?? '')))
    check('M10 手动放行（目录级）之后 → 放行',
      !call(P1, { caller: 'sub-b' }, { ownState: { version: 1, owned: OWN.owned, shared: ['C:\\lab\\out'] } }))
    check('M10 关掉开关就不管', !call(P1, { caller: 'sub-b' }, { autoOwnWrites: false }))
    check('M10 父会话不受影响（审计通道）',
      !mod.evaluateCall({
        name: 'read', args: { file_path: P1 }, isSubagent: false, scope: 'subagents',
        home: HOME, auditFile: '', rules: {}, cats: {}, autoOwnWrites: true, ownState: OWN, caller: null,
      }))
    check('M10 大小写 / 正斜杠变体照样命中', call('c:/LAB/OUT/A.js', { caller: 'sub-b' })?.kind === 'owned')

    // 写入要登记
    const st = { version: 1, owned: {}, shared: [] }
    mod.evaluateCall({
      name: 'write', args: { file_path: P2, content: 'x' }, isSubagent: true, scope: 'subagents',
      home: HOME, auditFile: '', rules: {}, cats: {}, autoOwnWrites: true, ownState: st,
      caller: 'sub-b', label: '臂B',
    })
    const rec = st.owned[mod.normalizePath(P2)]
    check('M10 ★ write 之后自动登记到它名下（带标签）',
      rec?.by === 'sub-b' && rec?.label === '臂B', JSON.stringify(rec ?? null))
    mod.evaluateCall({
      name: 'edit', args: { file_path: P2, old_string: 'a', new_string: 'b' }, isSubagent: true, scope: 'subagents',
      home: HOME, auditFile: '', rules: {}, cats: {}, autoOwnWrites: true, ownState: st,
      caller: 'sub-b', label: '臂B',
    })
    check('M10 edit 也算写入（不会因为改自己的文件被拦）', Object.keys(st.owned).length === 1)

    // 列目录类：产物挤在同一个目录里时，列一下就能看到别人有哪些文件
    const g = (dir, who, extra = {}) => mod.evaluateCall({
      name: 'glob', args: { path: dir, pattern: '**/*.js' }, isSubagent: true, scope: 'subagents',
      home: HOME, auditFile: '', rules: {}, cats: {}, autoOwnWrites: true, ownState: OWN, ...who, ...extra,
    })
    check('M10 ★ glob 一个"里面有别人产物"的目录 → 拦', g('C:\\lab\\out', { caller: 'sub-b' })?.kind === 'owned')
    check('M10 glob 自己那个目录 → 放行（里面是自己写的）', !g('C:\\lab\\out', { caller: 'sub-a' }))
    check('M10 glob 无关目录 → 放行', !g('C:\\lab\\other', { caller: 'sub-b' }))
    const gr = (dir, who) => mod.evaluateCall({
      name: 'grep', args: { path: dir, pattern: 'secret' }, isSubagent: true, scope: 'subagents',
      home: HOME, auditFile: '', rules: {}, cats: {}, autoOwnWrites: true, ownState: OWN, ...who,
    })
    check('M10 grep 同样管（不然搜一下就抄到了）', gr('C:\\lab\\out', { caller: 'sub-b' })?.kind === 'owned')

    // 纯函数直接行为
    check('M10 ★ 三个纯函数各自成立',
      mod.isForeignOwned(OWN, mod.normalizePath(P1), { callerId: 'sub-b' }) !== null &&
      mod.isForeignOwned(OWN, mod.normalizePath(P1), { callerId: 'sub-a' }) === null &&
      mod.isForeignOwned(OWN, mod.normalizePath(P1), { callerId: 'sub-b' })?.label === '臂A' &&
      mod.isShared({ shared: ['C:\\lab\\out'] }, mod.normalizePath(P1)) === true &&
      mod.isShared({ shared: ['C:\\lab\\out'] }, mod.normalizePath('C:\\labother\\x.js')) === false &&
      mod.dirHasForeignOwned(OWN, 'c:\\lab\\out', { callerId: 'sub-b' }) !== null &&
      mod.dirHasForeignOwned(OWN, 'c:\\lab', { callerId: 'sub-b' }) === null)   // 只看直接子项
  }

  // ★★ 命令族也必须拦 —— 这是**补漏洞**：
  //    第一版只接了路径族，实测子代理换 `pwsh Get-Content <别人的绝对路径>` 就读到了。
  {
    const P1 = 'C:\\lab\\out\\a.js'
    const OWN = {
      version: 1, shared: [],
      owned: { [mod.normalizePath(P1)]: { by: 'sub-a', label: '臂A', ts: '2026-10-11T00:00:00Z' } },
    }
    const sh = (cmd, who, extra = {}) => mod.evaluateCall({
      name: 'pwsh', args: { command: cmd }, isSubagent: true, scope: 'subagents',
      home: HOME, auditFile: '', rules: {}, cats: {}, guardShellText: true,
      autoOwnWrites: true, ownState: OWN, ...who, ...extra,
    })
    check('M10 ★★ 命令族：读别人的绝对路径 → 拦',
      sh(`Get-Content -LiteralPath "${P1}"`, { caller: 'sub-b' })?.kind === 'owned',
      String(sh(`Get-Content -LiteralPath "${P1}"`, { caller: 'sub-b' })?.reason ?? '').slice(0, 64))
    check('M10 ★★ 命令族：列那个目录 → 拦',
      sh('Get-ChildItem "C:\\lab\\out" | Select-Object -ExpandProperty Name', { caller: 'sub-b' })?.kind === 'owned')
    check('M10 ★★ 命令族：只写"最后两段"（不带盘符）也拦得住',
      sh('type out\\a.js', { caller: 'sub-b' })?.kind === 'owned')
    check('M10 命令族：它自己执行同样命令 → 放行', !sh(`Get-Content "${P1}"`, { caller: 'sub-a' }))
    check('M10 命令族：放行过的路径 → 放行',
      !sh(`Get-Content "${P1}"`, { caller: 'sub-b' }, { ownState: { version: 1, owned: OWN.owned, shared: ['C:\\lab\\out'] } }))
    check('M10 命令族：开关关掉就不管', !sh(`Get-Content "${P1}"`, { caller: 'sub-b' }, { autoOwnWrites: false }))
    check('M10 命令族：无关命令不受影响', !sh('Get-Date', { caller: 'sub-b' }))
    // ★ 目录级连坐**只在「列/读」动作下**才拦 —— 否则在公共产物目录里批量校验自己的产物会被误伤（01 实测）
    check('M10 ★ 只提到那个目录、不做枚举 → 不拦（修误伤）',
      !sh('Set-Location "C:\\lab\\out"; Write-Output hello', { caller: 'sub-b' }),
      String(sh('Set-Location "C:\\lab\\out"; Write-Output hello', { caller: 'sub-b' })?.reason ?? '(放行)').slice(0, 60))
    check('M10 ★ 一旦做枚举（Get-ChildItem）→ 仍然拦',
      sh('Get-ChildItem "C:\\lab\\out"', { caller: 'sub-b' })?.kind === 'owned')
  }

    // ★★ 标签豁免：复核者不受归属层管辖（但**不**豁免 %DSH_HOME% 默认全拒）
    {
      const EP = 'C:\\lab\\out\\exempt-probe.js'
      const EOWN = {
        version: 1, shared: [],
        owned: { [mod.normalizePath(EP)]: { by: 'sub-a', label: '臂A', ts: '2026-10-11T00:00:00Z' } },
      }
      const EC = (who, extra = {}) => mod.evaluateCall({
        name: 'read', args: { file_path: EP }, isSubagent: true, scope: 'subagents',
        home: HOME, auditFile: '', rules: {}, cats: {}, guardShellText: true,
        autoOwnWrites: true, ownState: EOWN, ownerExemptLabels: '复核,verify,review,audit', ...who, ...extra,
      })
      check('M10 ★★ 复核者（标签含 复核）读别人的产物 → 放行（豁免）',
        !EC({ caller: 'sub-r', label: '独立复核员' }))
      check('M10 ★★ 复核者（英文 review）→ 也放行',
        !EC({ caller: 'sub-r', label: 'Adversarial validity review' }))
      check('M10 非复核者（标签不含关键词）→ 仍然拦',
        EC({ caller: 'sub-b', label: '臂B' })?.kind === 'owned')
      check('M10 没标签 → 不豁免（宁严勿松）',
        EC({ caller: 'sub-b', label: null })?.kind === 'owned')
      check('M10 ★★ 豁免**只管归属**：复核者读 %DSH_HOME% 记录 → 仍然拦（默认全拒）',
        (() => {
          const r = mod.evaluateCall({
            name: 'read', args: { file_path: `${HOME}\\sessions\\ws\\sid\\session.v4.jsonl.zstd` },
            isSubagent: true, scope: 'subagents', home: HOME, auditFile: '', rules: {}, cats: {},
            guardShellText: true, autoOwnWrites: true, ownState: EOWN, denyHome: true,
            ownerExemptLabels: '复核,verify', caller: 'sub-r', label: '独立复核员',
          })
          return r?.kind === 'home'
        })())
      check('M10 可配：把关键词换成别的，旧关键词就不再豁免',
        EC({ caller: 'sub-r', label: '独立复核员' }, { ownerExemptLabels: 'zzz' })?.kind === 'owned')
      check('M10 ★★ 复核者也不受**命令族**归属管辖（可以 cat 别人的产物）',
        !mod.evaluateCall({
          name: 'pwsh', args: { command: `type "${EP}"` }, isSubagent: true, scope: 'subagents',
          home: HOME, auditFile: '', rules: {}, cats: {}, guardShellText: true,
          autoOwnWrites: true, ownState: EOWN, ownerExemptLabels: '复核,verify',
          caller: 'sub-r', label: '独立复核员',
        }))
      check('M10 isOwnerExempt 的直接行为',
        mod.isOwnerExempt('独立复核员', '复核,verify') === true &&
        mod.isOwnerExempt('Adversarial review', 'verify,review') === true &&
        mod.isOwnerExempt('臂A', '复核,verify') === false &&
        mod.isOwnerExempt('', '复核') === false &&
        mod.isOwnerExempt('臂A', '') === false)
    }
    // matchProtectedPath 的直接行为（导出函数，便于别处复用）
    check('M9 matchProtectedPath 返回 path 与 owner',
      mod.matchProtectedPath(`${ARM_B}\\x`, R_B)?.owner === WIN_B)
    check('M9 空规则 / 空列表 → null', mod.matchProtectedPath(`${ARM_B}\\x`, {}) === null)
  }
} catch (e) {
  check('测试本身出错', false, String(e?.stack ?? e))
} finally {
  cleanup()
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(64))
console.log(`  共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
failed.forEach((f) => console.log(`    · ${f.title}  ${f.detail}`))
console.log(`  沙箱已清理: ${!existsSync(sandbox)}`)
console.log('='.repeat(64))
process.exit(failed.length ? 1 : 0)
