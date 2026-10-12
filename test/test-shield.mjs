#!/usr/bin/env node
/**
 * 子代理信息隔断 v2 —— 独立测试
 * 全部在 %TEMP%\dsh-isolated-tests\ 沙箱里跑，绝不碰你正在用的 DSH_HOME。
 *
 *   A 层 纯策略    evaluateCall / resolveWindowPolicy / normalizePath / isSubagentAgent
 *   B 层 挂载接线  假 ctx 捕获真监听器与 /shield 命令，按真调用形状驱动
 *   C 层 真启动    临时 DSH_HOME + 出厂模板 + 装上插件
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import net from 'node:net'
import { findCheckout, findDshBin, nodeExe, sampleHome } from './_env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 插件根自动识别，兼容两种布局：
//   ① 作者测试台：<台>\独立测试台\ + <台>\隔离插件\  ② git 仓库：<仓库>\test\ + <仓库>\lib\
const PLUGIN_SRC = existsSync(join(HERE, '..', '隔离插件', 'lib', 'index.js')) ? join(HERE, '..', '隔离插件') : join(HERE, '..')
const CHECKOUT = findCheckout()
const DSH_BIN = findDshBin()
const NODE_EXE = nodeExe()
const HOME = sampleHome()   // 只当"受保护根"样例，不读写

const results = []
const check = (layer, title, ok, detail = '') => {
  results.push({ layer, title, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} [${layer}] ${title}${detail ? '  —— ' + detail : ''}`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const sandbox = join(tmpdir(), 'dsh-isolated-tests', stamp)
let child = null
const cleanup = () => {
  try { if (child) spawnSync('cmd', ['/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { }
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { }
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })

function installForUnitTests(dest) {
  mkdirSync(join(dest, '..', 'node_modules', '@deepseek-ai'), { recursive: true })
  const smLink = join(dest, '..', 'node_modules', '@deepseek-ai', 'schemastery')
  try { rmSync(smLink, { recursive: true, force: true }) } catch { }
  spawnSync('cmd', ['/c', 'mklink', '/J', smLink, join(CHECKOUT, 'node_modules', '@deepseek-ai', 'schemastery')], { stdio: 'ignore' })
  spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, dest, '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
}

function waitPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => { s.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tick, 400) })
    }
    tick()
  })
}

console.log('🐋 子代理信息隔断 v2 —— 独立测试（只在沙箱里跑）')
console.log(`   插件: ${PLUGIN_SRC}`)
console.log(`   沙箱: ${sandbox}\n`)

try {
  const unitHome = join(sandbox, 'unit-home')
  mkdirSync(unitHome, { recursive: true })
  const unitDir = join(sandbox, 'unit', 'dsh-subagent-shield')
  installForUnitTests(unitDir)
  const mod = await import(pathToFileURL(join(unitDir, 'lib', 'index.js')).href)
  const {
    normalizePath, selfRoots, classifyTarget, classifyTargetLoose, isProtected, anyProtectionActive, effectiveStatus,
    decodeWorkspaceLabel, isSubagentAgent, resolveWindowPolicy, evaluateCall,
  } = mod

  const auditPath = join(unitHome, 'subagent-shield-audit.jsonl')
  const WS_A = 'ws-alpha', WS_B = 'ws-beta'
  const SID_A = 'session-aaaa', SID_B = 'session-bbbb'
  const FILE_A = `${unitHome}\\sessions\\${WS_A}\\${SID_A}\\session.v4.jsonl.zstd`
  const FILE_B = `${unitHome}\\sessions\\${WS_B}\\${SID_B}\\session.v4.jsonl.zstd`
  const PROJ_A = `${unitHome}\\storages\\session_projcache\\sessions\\${SID_A}.json`
  const CRED = `${unitHome}\\.credentials.yaml`
  const RULES_FILE = `${unitHome}\\subagent-shield-rules.json`
  const STATE_FILE = `${unitHome}\\subagent-shield-state.json`
  const OK_FILE = 'C:\\work\\repo\\data.csv'
  const SUB = true, PARENT = false

  // 规则夹具
  const R_PROTECT = { defaultPolicy: 'protect', workspaces: {}, windows: {} }
  const R_ALLOW = { defaultPolicy: 'allow', workspaces: {}, windows: {} }
  const R_ALLOW_WS = { defaultPolicy: 'allow', workspaces: { [WS_A]: true }, windows: {} }
  const R_WIN_WINS = { defaultPolicy: 'protect', workspaces: { [WS_A]: true }, windows: { [SID_A]: false } }
  const R_EXEMPT_WS = { defaultPolicy: 'protect', workspaces: { [WS_A]: false }, windows: {} }
  const CAT_ALL = { protectSessions: true, protectProjcache: true, protectCredentials: true }

  // ───────────────────────────────────────── A 层
  console.log('── A 层 纯策略')
  check('A', 'normalizePath 消解 ..', normalizePath('C:\\a\\b\\..\\c') === 'c:\\a\\c')
  check('A', 'normalizePath 统一正反斜杠与大小写', normalizePath('C:/A/B') === 'c:\\a\\b')
  check('A', 'selfRoots 对空 home 返回空（不乱拦）', selfRoots('', '').length === 0)
  check('A', '本插件的规则/状态文件永远保护', selfRoots(unitHome, auditPath).some((r) => r.path.endsWith('rules.json')))
  // ★★ 回归：账本必须**无条件**保护（此前只在 auditEnabled=true 时才交给判定）
  check('A', '★★ 默认路径的账本即使不传 auditFile 也受保护',
    selfRoots(unitHome).some((r) => r.path.endsWith('subagent-shield-audit.jsonl')))
  check('A', '★★ 关掉账本开关（auditFile 传空）时账本仍受保护',
    Boolean(evaluateCall({ name: 'read', args: { file_path: auditPath }, isSubagent: SUB, home: unitHome, auditFile: '', rules: R_PROTECT, cats: CAT_ALL })?.reason))
  check('A', '★★ 子代理写账本也被拦（write 走同一条路径判定）',
    Boolean(evaluateCall({ name: 'write', args: { file_path: auditPath, content: 'x' }, isSubagent: SUB, home: unitHome, auditFile: auditPath, rules: R_PROTECT, cats: CAT_ALL })?.reason))
  // ★★ 回归（评审 P1）：自定义账本路径时，**默认账本仍在磁盘上**，必须一并保护
  {
    const custom = `${unitHome}\\my-own-ledger.jsonl`
    const roots = selfRoots(unitHome, custom).map((r) => r.path)
    check('A', '★★ 自定义 auditFile 时，默认账本路径仍受保护',
      roots.includes(normalizePath(auditPath)) && roots.includes(normalizePath(custom)))
    check('A', '★★ 读默认账本（自定义 auditFile 下）→ 拦',
      Boolean(evaluateCall({ name: 'read', args: { file_path: auditPath }, isSubagent: SUB, home: unitHome, auditFile: custom, rules: R_PROTECT, cats: CAT_ALL })?.reason))
    check('A', '★★ 读自定义账本 → 也拦',
      Boolean(evaluateCall({ name: 'read', args: { file_path: custom }, isSubagent: SUB, home: unitHome, auditFile: custom, rules: R_PROTECT, cats: CAT_ALL })?.reason))
  }
  // ★★ 回归（评审 P4）：`storages` 本目录（projcache 的父目录）也归 projcache 类
  check('A', '★★ storages 本目录被归类为 projcache（目录列举也是信息泄露）',
    classifyTarget(unitHome, `${unitHome}\\storages`)?.kind === 'projcache')

  // ★ v4 新增：目标路径 → (工作区, 窗口)
  check('A', '★ classifyTarget 认出会话文件的工作区与窗口', (() => {
    const i = classifyTarget(unitHome, FILE_A); return i?.kind === 'sessions' && i.ws === WS_A && i.sid === SID_A
  })())
  check('A', '★ classifyTarget 认出投影缓存属于哪个窗口', classifyTarget(unitHome, PROJ_A)?.sid === SID_A)
  check('A', 'classifyTarget 认出凭据文件', classifyTarget(unitHome, CRED)?.kind === 'credentials')
  check('A', 'classifyTarget 对无关路径返回 null', classifyTarget(unitHome, OK_FILE) === null)
  check('A', '★ sessions2 不会被误认成 sessions', classifyTarget(unitHome, `${unitHome}\\sessions2\\x`) === null)

  // ★ 规则求值（优先级：窗口 > 工作区 > 默认）
  check('A', '★ 默认 protect：会话/缓存/凭据都受保护',
    isProtected(classifyTarget(unitHome, FILE_A), R_PROTECT, CAT_ALL) === true &&
    isProtected(classifyTarget(unitHome, PROJ_A), R_PROTECT, CAT_ALL) === true &&
    isProtected(classifyTarget(unitHome, CRED), R_PROTECT, CAT_ALL) === true)
  check('A', '★ 默认 allow：未点名的会话不受保护，但凭据仍受保护',
    isProtected(classifyTarget(unitHome, FILE_A), R_ALLOW, CAT_ALL) === false &&
    isProtected(classifyTarget(unitHome, CRED), R_ALLOW, CAT_ALL) === true)
  check('A', '★ 点名工作区：只有该工作区的会话受保护',
    isProtected(classifyTarget(unitHome, FILE_A), R_ALLOW_WS, CAT_ALL) === true &&
    isProtected(classifyTarget(unitHome, FILE_B), R_ALLOW_WS, CAT_ALL) === false)
  check('A', '★ 窗口规则优先于工作区规则', isProtected(classifyTarget(unitHome, FILE_A), R_WIN_WINS, CAT_ALL) === false)
  check('A', '★ 工作区可以单独豁免',
    isProtected(classifyTarget(unitHome, FILE_A), R_EXEMPT_WS, CAT_ALL) === false &&
    isProtected(classifyTarget(unitHome, FILE_B), R_EXEMPT_WS, CAT_ALL) === true)
  check('A', '关掉 sessions 这一类 → 放行（逐项开关有效）',
    isProtected(classifyTarget(unitHome, FILE_A), R_PROTECT, { ...CAT_ALL, protectSessions: false }) === false)
  check('A', '关掉凭据这一类 → 放行', isProtected(classifyTarget(unitHome, CRED), R_PROTECT, { ...CAT_ALL, protectCredentials: false }) === false)

  // ★★ 回归（真实泄露）：默认不保护 + 逐条全 true 时，**目录级路径**不能成为后门
  //    实测：glob 把 path 指向 sessions 根 → 列出 138 条别的会话路径
  const R_ALLOW_MIX = { defaultPolicy: 'allow', workspaces: { [WS_A]: true }, windows: { [SID_B]: true } }
  const SESS_ROOT = { kind: 'sessions', ws: null, sid: null }
  const PROJ_ROOT = { kind: 'projcache', sid: null }
  check('A', '★★ sessions 根：默认不保护但有对象被点名 → 仍拦（目录后门）',
    isProtected(SESS_ROOT, R_ALLOW_MIX, CAT_ALL) === true)
  check('A', '★★ projcache 根：同上 → 仍拦', isProtected(PROJ_ROOT, R_ALLOW_MIX, CAT_ALL) === true)
  check('A', '★★ 未点名的目录级路径：有对象被点名 → 仍拦',
    isProtected({ kind: 'sessions', ws: 'ws-unknown', sid: null }, R_ALLOW_MIX, CAT_ALL) === true)
  check('A', '★★ 被豁免工作区的目录级：其下还有窗口被点名 → 仍拦',
    isProtected({ kind: 'sessions', ws: WS_A, sid: null }, { defaultPolicy: 'allow', workspaces: { [WS_A]: false }, windows: { [SID_B]: true } }, CAT_ALL) === true)
  check('A', '★★ 默认不保护且**无任何**对象被点名 → 根目录放行（没保护要拦什么）',
    isProtected(SESS_ROOT, R_ALLOW, CAT_ALL) === false)
  check('A', '★★ 默认保护 + 某工作区豁免 → 根目录仍拦（别的还受保护）',
    isProtected(SESS_ROOT, R_EXEMPT_WS, CAT_ALL) === true)
  check('A', '★★ 不过度收紧：被豁免工作区里的具体文件仍然放行',
    isProtected(classifyTarget(unitHome, FILE_A), R_EXEMPT_WS, CAT_ALL) === false)
  check('A', '★★ glob 用 path 指 sessions 根 → 拦（这次泄露的原样复现）',
    Boolean(evaluateCall({ name: 'glob', args: { pattern: '**\\*.jsonl.zstd', path: `${unitHome}\\sessions` }, isSubagent: SUB, home: unitHome, auditFile: auditPath, rules: R_ALLOW_MIX, cats: CAT_ALL })?.reason))

  // ★★ 回归：通配符 token 不能被当成"没点名"而放行（V1/V4 那条被"零结果"掩盖的缝）
  const GLOB_ABS = `${unitHome}\\sessions\\**\\*.jsonl.zstd`
  check('A', '★★ glob：绝对路径 pattern（含 ** 通配）→ 拦（此前是静默零结果）',
    Boolean(evaluateCall({ name: 'glob', args: { pattern: GLOB_ABS }, isSubagent: SUB, home: unitHome, auditFile: auditPath, rules: R_ALLOW_MIX, cats: CAT_ALL })?.reason))
  check('A', '★★ grep：include 绝对路径（含 ** 通配）→ 拦',
    Boolean(evaluateCall({ name: 'grep', args: { pattern: 'x', include: GLOB_ABS }, isSubagent: SUB, home: unitHome, auditFile: auditPath, rules: R_ALLOW_MIX, cats: CAT_ALL })?.reason))
  check('A', '★★ 通配 sid → 按祖先拦', isProtected({ kind: 'projcache', sid: '*.json' }, R_ALLOW_MIX, CAT_ALL) === true)
  check('A', '★★ 通配工作区 → 按祖先拦', isProtected({ kind: 'sessions', ws: '**', sid: null }, R_ALLOW_MIX, CAT_ALL) === true)
  check('A', '★★ 不过度收紧：具体且被豁免的窗口仍然放行',
    isProtected({ kind: 'sessions', ws: 'ws-x', sid: 'sid-exempt' },
      { defaultPolicy: 'allow', workspaces: {}, windows: { 'sid-exempt': false } }, CAT_ALL) === false)

  // 窗口策略
  check('A', 'mode=all 默认隔断', resolveWindowPolicy('all', undefined) === true)
  check('A', 'mode=all + 本窗口 off → 豁免', resolveWindowPolicy('all', false) === false)
  check('A', 'mode=window 默认不隔断', resolveWindowPolicy('window', undefined) === false)
  check('A', '★ mode=window + 本窗口 on → 只隔断这一个窗口', resolveWindowPolicy('window', true) === true)

  // cmd 命令：默认 protect
  const T = (title, call, wantDeny) => {
    const r = evaluateCall({ home: unitHome, auditFile: auditPath, rules: R_PROTECT, cats: CAT_ALL, guardShellText: true, ...call })
    const hit = Boolean(r?.reason)
    check('A', title, wantDeny ? hit : r === null, wantDeny ? '已拒' : (hit ? '误伤：' + String(r.reason).split('\n')[0] : '放行'))
  }
  T('子代理读父会话文件 → 拦', { name: 'read', args: { file_path: FILE_A }, isSubagent: SUB }, true)
  T('子代理读兄弟会话文件 → 拦', { name: 'read', args: { file_path: FILE_B }, isSubagent: SUB }, true)
  T('子代理读会话目录本身 → 拦', { name: 'read', args: { file_path: `${unitHome}\\sessions` }, isSubagent: SUB }, true)
  T('子代理读自己的工作区文件 → 放行', { name: 'read', args: { file_path: OK_FILE }, isSubagent: SUB }, false)
  T('用 .. 绕 → 拦', { name: 'read', args: { file_path: `${unitHome}\\sessions\\..\\sessions\\x` }, isSubagent: SUB }, true)
  T('大小写不同 → 拦', { name: 'read', args: { file_path: FILE_A.toUpperCase() }, isSubagent: SUB }, true)
  T('正斜杠 → 拦', { name: 'read', args: { file_path: FILE_A.replace(/\\/g, '/') }, isSubagent: SUB }, true)
  T('\\\\?\\ 前缀 → 拦', { name: 'read', args: { file_path: '\\\\?\\' + FILE_A }, isSubagent: SUB }, true)
  T('带引号 → 拦', { name: 'read', args: { file_path: `"${FILE_A}"` }, isSubagent: SUB }, true)
  T('★ 相似前缀 sessions2 → 放行（不误伤）', { name: 'read', args: { file_path: `${unitHome}\\sessions2\\x` }, isSubagent: SUB }, false)
  T('凭据文件 → 拦', { name: 'read', args: { file_path: CRED }, isSubagent: SUB }, true)
  T('projcache（grep）→ 拦', { name: 'grep', args: { path: `${unitHome}\\storages\\session_projcache` }, isSubagent: SUB }, true)
  T('glob 指向会话目录 → 拦', { name: 'glob', args: { path: `${unitHome}\\sessions` }, isSubagent: SUB }, true)
  T('子代理写入会话目录 → 拦', { name: 'write', args: { file_path: FILE_A }, isSubagent: SUB }, true)
  T('子代理读审计账本 → 拦', { name: 'read', args: { file_path: auditPath }, isSubagent: SUB }, true)
  T('★ 子代理读规则文件 → 拦（自己的规则也不许改）', { name: 'read', args: { file_path: RULES_FILE }, isSubagent: SUB }, true)
  T('pwsh 用 $env:DSH_HOME 拼 → 拦（启发式）', { name: 'pwsh', args: { command: 'Get-Content "$env:DSH_HOME\\sessions\\x\\session.v4.jsonl.zstd"' }, isSubagent: SUB }, true)
  T('pwsh 写死路径 → 拦（启发式）', { name: 'pwsh', args: { command: `Get-Content ${FILE_A}` }, isSubagent: SUB }, true)
  T('pwsh 普通命令 → 放行', { name: 'pwsh', args: { command: 'Get-ChildItem . -Force' }, isSubagent: SUB }, false)
  T('★ 关掉命令族启发式后同样命令 → 放行（开关有效）', { name: 'pwsh', args: { command: `Get-Content ${FILE_A}` }, isSubagent: SUB, guardShellText: false }, false)
  T('★ 关掉 sessions 保护后 → 放行（按项开关有效）',
    { name: 'read', args: { file_path: FILE_A }, isSubagent: SUB, cats: { ...CAT_ALL, protectSessions: false } }, false)
  T('参数缺失不崩 → 放行', { name: 'read', args: {}, isSubagent: SUB }, false)

  // ★ v4 新增：细到工作区 / 窗口
  const G = (title, call, rules, wantDeny, cats = CAT_ALL) => {
    const r = evaluateCall({ home: unitHome, auditFile: auditPath, rules, cats, guardShellText: true, ...call })
    const hit = Boolean(r?.reason)
    check('A', title, wantDeny ? hit : r === null, wantDeny ? '已拒' : (hit ? '误伤' : '放行'))
  }
  G('★ 默认不保护：未点名的工作区会话 → 放行', { name: 'read', args: { file_path: FILE_A }, isSubagent: SUB }, R_ALLOW, false)
  G('★ 默认不保护 + 点名该工作区 → 拦', { name: 'read', args: { file_path: FILE_A }, isSubagent: SUB }, R_ALLOW_WS, true)
  G('★ 点名只影响被点的工作区（另一个仍放行）', { name: 'read', args: { file_path: FILE_B }, isSubagent: SUB }, R_ALLOW_WS, false)
  G('★ 默认不保护 + 点名该窗口的投影缓存 → 拦',
    { name: 'read', args: { file_path: PROJ_A }, isSubagent: SUB },
    { defaultPolicy: 'allow', workspaces: {}, windows: { [SID_A]: true } }, true)
  G('★ 默认不保护 + 未点名的投影缓存 → 放行', { name: 'read', args: { file_path: PROJ_A }, isSubagent: SUB }, R_ALLOW, false)
  G('★ 窗口豁免优先于工作区保护', { name: 'read', args: { file_path: FILE_A }, isSubagent: SUB }, R_WIN_WINS, false)
  G('★ 默认不保护且无点名时，命令族按类别判断、不再拿会话路径乱拦',
    { name: 'pwsh', args: { command: `Get-Content ${FILE_A}` }, isSubagent: SUB }, R_ALLOW, false)
  G('★ 但凭据那一类还开着 → 命令行提到凭据仍然拦',
    { name: 'pwsh', args: { command: `Get-Content ${CRED}` }, isSubagent: SUB }, R_ALLOW, true)
  check('A', '★ anyProtectionActive：默认不保护且无点名、凭据也关 → 全关',
    anyProtectionActive(R_ALLOW, { protectSessions: true, protectProjcache: true, protectCredentials: false }) === false)
  check('A', '★ anyProtectionActive：凭据仍保护 → 仍算有保护',
    anyProtectionActive(R_ALLOW, CAT_ALL) === true)

  // ★ 隔断范围：scope=subagents 父会话放行；scope=all 父会话也挡
  const pCall = (scope, name = 'read') => ({
    name, isSubagent: PARENT, scope, home: unitHome, rules: R_PROTECT, cats: CAT_ALL,
    args: name === 'pwsh' ? { command: `Get-Content ${FILE_A}` } : { file_path: FILE_A },
  })
  check('A', '★ scope=subagents：父会话读会话文件 → 放行', evaluateCall(pCall('subagents')) === null)
  check('A', '★ scope=all：父会话读会话文件 → 也拦', Boolean(evaluateCall(pCall('all'))?.reason))
  check('A', 'scope=all 的拒绝理由带"怎么放行"的提示', String(evaluateCall(pCall('all'))?.reason ?? '').includes('/shield off'))
  check('A', 'scope=all：父会话跑 pwsh 读会话 → 也拦', Boolean(evaluateCall(pCall('all', 'pwsh'))?.reason))
  check('A', 'scope=subagents：父会话跑 pwsh 读会话 → 放行', evaluateCall(pCall('subagents', 'pwsh')) === null)
  check('A', '不传 scope 时默认 subagents（父会话放行，不误伤）',
    evaluateCall({ name: 'read', args: { file_path: FILE_A }, isSubagent: PARENT, home: unitHome, rules: R_PROTECT, cats: CAT_ALL }) === null)

  check('A', 'decodeWorkspaceLabel 还原 ~XXXX 转义', decodeWorkspaceLabel('--C-Users-me-~8BBA~5B50--').includes('论子'))

  // ★★ 回归：glob/grep 的 pattern 参数（真实 schema 里是必填，path 才是可选）
  //    实测被这样绕过去一次：绝对路径塞进 pattern、path 留空 → glob 列出了 137 条别的会话路径
  const globCall = (args) => evaluateCall({ name: 'glob', args, isSubagent: SUB, home: unitHome, auditFile: auditPath, rules: R_PROTECT, cats: CAT_ALL, guardShellText: true })
  const grepCall = (args) => evaluateCall({ name: 'grep', args, isSubagent: SUB, home: unitHome, auditFile: auditPath, rules: R_PROTECT, cats: CAT_ALL, guardShellText: true })
  check('A', '★★ glob：path 指会话目录 → 拦', Boolean(globCall({ pattern: '**/*.jsonl.zstd', path: `${unitHome}\\sessions` })?.reason))
  check('A', '★★ glob：绝对路径塞进 pattern、不传 path → 拦（就是被绕过的那一手）',
    Boolean(globCall({ pattern: `${unitHome}\\sessions\\**\\*.jsonl.zstd` })?.reason))
  check('A', '★★ glob：正常模式（工作区内找 ts）→ 放行', globCall({ pattern: '**/*.ts', path: 'C:\\work\\repo' }) === null)
  check('A', '★★ grep：include 指会话目录 → 拦', Boolean(grepCall({ pattern: 'x', include: `${unitHome}\\sessions\\**` })?.reason))
  check('A', '★★ grep：裸词 pattern（sessions）→ 放行（不误伤普通搜索）', grepCall({ pattern: 'sessions', path: 'C:\\work\\repo' }) === null)

  // classifyTargetLoose 用真实世界的 `.dsh` 形状测（沙箱里的 home 尾段是 `home`，形状不同）
  const REAL_HOME = 'C:\\Users\\me\\.dsh'
  check('A', '★★ 宽松识别：绝对路径', classifyTargetLoose(REAL_HOME, 'C:\\Users\\me\\.dsh\\sessions\\x\\y')?.kind === 'sessions')
  check('A', '★★ 宽松识别：相对逃逸（..\\..\\.dsh\\sessions\\**）', classifyTargetLoose(REAL_HOME, '..\\..\\.dsh\\sessions\\**\\*.zstd')?.kind === 'sessions')
  check('A', '★★ 宽松识别：相对逃逸的投影缓存', classifyTargetLoose(REAL_HOME, '..\\..\\.dsh\\storages\\session_projcache\\sessions\\x.json')?.kind === 'projcache')
  check('A', '★★ 宽松识别：凭据文件', classifyTargetLoose(REAL_HOME, 'x\\.dsh\\.credentials.yaml')?.kind === 'credentials')
  check('A', '★★ 宽松识别：无关字符串不认', classifyTargetLoose(REAL_HOME, '**/*.ts') === null)
  check('A', '★★ 宽松识别：sessions2 不误判（必须有分隔符收束）', classifyTargetLoose(REAL_HOME, 'C:\\Users\\me\\.dsh\\sessions2\\x') === null)
  check('A', '★★ 宽松识别：路径里出现过 .dsh\\sessions 才认（相对逃逸 pattern 走这条路）',
    Boolean(evaluateCall({ name: 'glob', args: { pattern: '..\\..\\.dsh\\sessions\\**' }, isSubagent: SUB, home: REAL_HOME, rules: R_PROTECT, cats: CAT_ALL })?.reason))

  // ★ 实际生效状态（页面红字横幅的依据）
  const CFG_OK = { enabled: true, scope: 'subagents', mode: 'all', protectSessions: true, protectProjcache: true, protectCredentials: true }
  const E = (config, rules, overrides = {}) => effectiveStatus({ config, rules, overrides })
  check('A', '★ 生效状态：默认配置 + 默认保护全部 → 生效', E(CFG_OK, R_PROTECT).active === true && E(CFG_OK, R_PROTECT).level === 'ok')
  check('A', '★ 生效状态：mode=window 且无窗口被点名 → 未生效（正是踩过的那个坑）',
    E({ ...CFG_OK, mode: 'window' }, R_PROTECT).active === false)
  check('A', '★ 生效状态：mode=window 但有窗口被点名 → 生效',
    E({ ...CFG_OK, mode: 'window' }, R_PROTECT, { 'w1': true }).active === true)
  check('A', '★ 生效状态：全部设成 false 且凭据也关 → 未生效',
    E({ ...CFG_OK, protectCredentials: false }, { defaultPolicy: 'protect', workspaces: { a: false }, windows: {} }).active === false)
  check('A', '★ 生效状态：全部 false 但凭据仍开 → 生效，但给出"只剩凭据"提示',
    (() => { const r = E(CFG_OK, { defaultPolicy: 'protect', workspaces: { a: false }, windows: {} }); return r.active === true && r.reasons.some((x) => x.includes('只剩凭据')) })())
  check('A', '★ 生效状态：默认不保护且无点名 + 凭据开 → 生效但提示会话未被拦',
    (() => { const r = E(CFG_OK, R_ALLOW); return r.active === true && r.reasons.some((x) => x.includes('实际未被拦截')) })())
  check('A', '★ 生效状态：总开关关闭 → 未生效', E({ ...CFG_OK, enabled: false }, R_PROTECT).active === false)

  // ★ 命令族护栏的真实边界（特征化测试：把已知行为钉住，行为一变就报警）
  const obf = (cmd) => evaluateCall({ name: 'pwsh', args: { command: cmd }, isSubagent: SUB, home: unitHome, auditFile: auditPath, rules: R_PROTECT, cats: CAT_ALL, guardShellText: true })
  const P = `${unitHome}\\sessions\\${WS_A}\\${SID_A}\\session.v4.jsonl.zstd`
  check('A', '★ 边界：直白写出路径 → 拦', Boolean(obf(`Get-Content "${P}"`)))
  check('A', '★ 边界：只藏目录、露出文件名 → 仍被拦（文件名模式也是针）',
    Boolean(obf(`$p = '${unitHome}\\sess' + 'ions\\${WS_A}\\${SID_A}\\session.v4.jsonl.zstd'; Get-Content $p`)))
    // ★ 这条曾经是「穿过」；加了朴素去混淆还原（把 ' + ' 接起来）之后**被拦住了**。
    check('A', '★ 边界：目录和文件名都拆开拼接 → 现在被拦（去混淆还原生效）',
      Boolean(obf(`$d = '${unitHome}\\sess' + 'ions\\${WS_A}\\${SID_A}'; $f = 'sess' + 'ion.v4.jsonl.zstd'; Get-Content ($d + '\\' + $f)`)))
  check('A', '★ 边界：[char] 编码构造路径 → 穿过', obf('$p = [char]67 + [char]58 + [char]92; Get-Content $p') === null)
    check('A', '★ 边界：base64 还原路径 → 仍不拦，但记 warn（留痕）',
      (() => { const r = obf('$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'QzpcXHg=\')); Get-Content $p'); return Boolean(r?.warn) && r.reason === undefined })())
  check('A', '★ 误报：只打印路径、零文件访问 → 也会被拦（子代理实测确认）', Boolean(obf(`Write-Output '${P}'`)))
  check('A', '★ 误报边界：裸词 sessions / projcache 不被拦', obf("Write-Output 'sessions projcache DECOY'") === null)

  check('A', 'isSubagentAgent 认 origin=subagent', isSubagentAgent({ session: { header: { origin: 'subagent' } } }) === true)
  check('A', 'isSubagentAgent 认 delegationDepth>0', isSubagentAgent({ session: { header: { delegationDepth: 1 } } }) === true)
  check('A', 'isSubagentAgent 对父会话返回 false', isSubagentAgent({ session: { header: { delegationDepth: 0 } } }) === false)

  // ───────────────────────────────────────── B 层
  console.log('\n── B 层 挂载接线（假 ctx 驱动真监听器与命令）')
  const cfg = (o = {}) => ({
    enabled: { get: () => o.enabled ?? true }, mode: { get: () => o.mode ?? 'all' },
    scope: { get: () => o.scope ?? 'subagents' },
    dshHome: { get: () => unitHome }, auditFile: { get: () => auditPath },
    protectSessions: { get: () => o.protectSessions ?? true }, protectProjcache: { get: () => true },
    protectCredentials: { get: () => true }, guardShellText: { get: () => o.guardShellText ?? true },
    auditEnabled: { get: () => o.auditEnabled ?? true },
  })
  const mount = (o) => {
    const listeners = [], commands = []
    const ctx = { on: (e, f) => listeners.push({ e, f }), commands: { register: (d) => { commands.push(d); return () => { } } } }
    mod.apply(ctx, cfg(o))
    const pre = () => listeners.find((l) => l.e === 'tools/pre-execute').f
    return {
      listeners, commands,
      run: async (exec) => { let n = false; const d = await pre()(exec, async () => { n = true; return { kind: 'allow' } }); return { d, n } },
      invoke: (raw, sessionId) => commands[0].handler({ rawInput: raw, agent: { session: { header: { id: sessionId } } } }),
    }
  }
  const subExec = (name, args, win) => ({ name, arguments: args, agent: { session: { header: { id: 'sub-1', origin: 'subagent', delegationDepth: 1, parentSession: win } } } })
  const parExec = (name, args, id) => ({ name, arguments: args, agent: { session: { header: { id: id ?? 'session-win', delegationDepth: 0 } } } })

  const m0 = mount({})
  check('B', 'apply 不抛错且注册了监听器', m0.listeners.length === 1, m0.listeners.map((l) => l.e).join(','))
  check('B', '注册了 /shield 命令', m0.commands.length === 1 && m0.commands[0].name === 'shield')

  let r = await m0.run(subExec('read', { file_path: FILE_A }, 'session-win'))
  check('B', 'mode=all：子代理读会话 → deny 且不调 next', r.d?.kind === 'deny' && !r.n)
  check('B', 'deny 理由含"请勿重试"', String(r.d?.reason ?? '').includes('请勿重试'))

  r = await m0.run(parExec('read', { file_path: FILE_A }))
  check('B', '★ 父会话读会话 → 放行 next', r.d?.kind === 'allow' && r.n)
  r = await m0.run(parExec('pwsh', { command: `Get-Content ${FILE_A}` }))
  check('B', '★ 父会话跑 pwsh 读会话 → 放行', r.d?.kind === 'allow' && r.n)

  // 审计账本（事后检测）
  await new Promise((res) => setTimeout(res, 50))
  let ledger = []
  try { ledger = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { }
  check('B', '事后账本：拒绝被记入 JSONL', ledger.length >= 1, `条数=${ledger.length}`)
  check('B', '账本行含 tool / window / caller / scope 四要素',
    ledger[0]?.tool === 'read' && ledger[0]?.window === 'session-win' && ledger[0]?.caller === 'sub-1' && ledger[0]?.scope === 'subagents',
    JSON.stringify(ledger[0] ?? {}))

  // 按窗口控制
  const m1 = mount({ mode: 'window' })
  r = await m1.run(subExec('read', { file_path: FILE_A }, 'session-A'))
  check('B', '★ mode=window 默认：子代理不被隔断', r.d?.kind === 'allow' && r.n)
  let res1 = m1.invoke('on', 'session-A')
  check('B', '/shield on 返回成功', res1?.kind === 'success', String(res1?.text ?? '').split('\n')[1] ?? '')
  r = await m1.run(subExec('read', { file_path: FILE_A }, 'session-A'))
  check('B', '★ on 之后：本窗口子代理被隔断', r.d?.kind === 'deny')
  r = await m1.run(subExec('read', { file_path: FILE_A }, 'session-B'))
  check('B', '★★ 只隔断单一窗口：别的窗口不受影响', r.d?.kind === 'allow' && r.n)
  check('B', '状态文件已持久化本窗口覆盖', existsSync(join(unitHome, 'subagent-shield-state.json')))

  const res2 = m1.invoke('off', 'session-A')
  check('B', '/shield off 生效', res2?.kind === 'success' && (await m1.run(subExec('read', { file_path: FILE_A }, 'session-A'))).d?.kind === 'allow')
  const res3 = m1.invoke('clear', 'session-A')
  check('B', '/shield clear 生效（回到默认）', res3?.kind === 'success')
  const res4 = m1.invoke('status', 'session-A')
  check('B', '/shield status 有输出且显示范围', res4?.kind === 'success' && String(res4.text).includes('scope='), String(res4?.text ?? '').split('\n')[2] ?? '')
  const res5 = m1.invoke('乱写', 'session-A')
  check('B', '未知参数 → 报错而不是静默', res5?.kind === 'error')

  // scope=all：父会话也一起挡，且开关立刻能放行
  const mA = mount({ scope: 'all' })
  r = await mA.run(parExec('read', { file_path: FILE_A }))
  check('B', '★ scope=all：父会话读会话 → deny', r.d?.kind === 'deny' && !r.n)
  check('B', '父会话被挡时，理由里给出放行办法', String(r.d?.reason ?? '').includes('/shield off'))
  mA.invoke('off', 'session-win')
  r = await mA.run(parExec('read', { file_path: FILE_A }))
  check('B', '★★ scope=all 下 /shield off → 父会话立刻放行（开关真的管用）', r.d?.kind === 'allow' && r.n)
  r = await mA.run(subExec('read', { file_path: FILE_A }, 'session-win'))
  check('B', 'scope=all 下 /shield off 同时放行该窗口的子代理', r.d?.kind === 'allow' && r.n)

  const mE = mount({ scope: 'all', enabled: false })
  r = await mE.run(parExec('read', { file_path: FILE_A }))
  check('B', '★ 总开关关闭：scope=all 也不再挡父会话', r.d?.kind === 'allow' && r.n)

  // mode=all + 本窗口 off 的豁免
  const m2 = mount({ mode: 'all' })
  m2.invoke('off', 'session-A')
  r = await m2.run(subExec('read', { file_path: FILE_A }, 'session-A'))
  check('B', '★ mode=all 下用 /shield off 豁免本窗口', r.d?.kind === 'allow' && r.n)

  // 总开关
  const m3 = mount({ enabled: false })
  r = await m3.run(subExec('read', { file_path: FILE_A }, 'session-win'))
  check('B', '总开关关闭 → 一律放行', r.d?.kind === 'allow' && r.n)

  // 判定内部出错必须放行
  const m4 = mount({})
  const badExec = { name: 'read', get arguments() { throw new Error('boom') }, agent: { session: { header: { origin: 'subagent', parentSession: 'w' } } } }
  r = await m4.run(badExec)
  check('B', '判定内部出错 → 放行，绝不阻断工具管道', r.d?.kind === 'allow' && r.n)

  // ───────────────────────────────────────── C 层
  console.log('\n── C 层 真启动（临时 DSH_HOME + 出厂模板）')
  const home = join(sandbox, 'home')
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, DSH_HOME: home }
  const sc = spawnSync(NODE_EXE, [DSH_BIN, 'testprobe', '--from-default-profile', 'web', '--dump-config'], { env, encoding: 'utf8', timeout: 120000 })
  const prof = join(home, 'profiles', 'testprobe')
  check('C', '沙箱里脚手架出独立 profile', sc.status === 0 && existsSync(join(prof, 'package.json')), `exit=${sc.status}`)
  if (existsSync(join(prof, 'package.json'))) {
    spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, join(prof, 'node_modules', 'dsh-subagent-shield'), '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
    writeFileSync(join(prof, 'cordis.patch.yml'),
      '# sandbox shield v2 patch\n- insert:\n    - id: dsh-subagent-shield\n      name: dsh-subagent-shield\n', 'utf8')
    const outPath = join(sandbox, 'boot.out.log'); const errPath = join(sandbox, 'boot.err.log')
    const outFd = openSync(outPath, 'w'); const errFd = openSync(errPath, 'w')
    child = spawn(NODE_EXE, [DSH_BIN, 'testprobe', '--port', '3099', '--no-open'],
      { cwd: prof, env, stdio: ['ignore', outFd, errFd], windowsHide: true })
    const up = await waitPort(3099, 90000)
    closeSync(outFd); closeSync(errFd)
    const out = readFileSync(outPath, 'utf8'); const err = readFileSync(errPath, 'utf8')
    check('C', '整棵插件树能加载并起监听', up, `listening=${up}`)
    check('C', '插件已挂载（stdout 证据）', out.includes('[subagent-shield] 已挂载'), out.split('\n').find((l) => l.includes('subagent-shield')) ?? '(未见)')
    check('C', 'stderr 干净', err.trim() === '', err.trim().slice(0, 200))
    try { child.kill() } catch { }
    spawnSync('cmd', ['/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    child = null
    await new Promise((r2) => setTimeout(r2, 600))
    check('C', '测试实例收掉、端口释放', !(await waitPort(3099, 1200)))
  }
} catch (e) {
  check('??', '测试本身出错', false, String(e?.stack ?? e))
} finally {
  cleanup()
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(64))
console.log(`  共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
failed.forEach((f) => console.log(`    · [${f.layer}] ${f.title}  ${f.detail}`))
console.log(`  沙箱已清理: ${!existsSync(sandbox)}`)
console.log('='.repeat(64))
process.exit(failed.length ? 1 : 0)
