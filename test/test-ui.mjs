#!/usr/bin/env node
/**
 * dsh-subagent-shield —— UI 部分独立测试
 *
 *   U1 配置卡（无头）    假 window / 假 React / 假 ctx：模块 id、卡片 key、组件能渲染、改值会写回
 *   U2 小窗脚本（无头）  假 DOM / 假 localStorage / 假 fetch：挂载、拖动、收起、关闭、拉数据
 *   U3 宿主接口（无头）  假 ctx + 假 webServer：两个路由、index 注入、/status 数据与计数
 *   U4 沙箱真启动        临时 DSH_HOME 装上插件起 3099，验挂载日志与路由可达性
 *
 * 全程在 %TEMP%\dsh-isolated-tests\ 沙箱里跑，不碰正在用的 DSH。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
// 插件根自动识别，兼容两种布局：
//   ① 作者测试台：<台>\独立测试台\ + <台>\隔离插件\  ② git 仓库：<仓库>\test\ + <仓库>\lib\
const PLUGIN_SRC = existsSync(join(HERE, '..', '隔离插件', 'lib', 'index.js')) ? join(HERE, '..', '隔离插件') : join(HERE, '..')
const DSH_BIN = (process.env.DSH_BIN || findDshBin()) ?? ''
const NODE_EXE = process.env.DSH_NODE || process.execPath
/** dsh 安装根（用于取真实客户端包做交叉验证） */
const CHECKOUT = DSH_BIN ? dirname(dirname(dirname(dirname(dirname(DSH_BIN))))) : ''

function findDshBin() {
  const cands = []
  if (process.env.DSH_CHECKOUT) cands.push(join(process.env.DSH_CHECKOUT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const root of [process.env.DSH_NPX_CACHE, 'D:\\DSH\\npm-cache\\_npx', join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')]) {
    if (!root || !existsSync(root)) continue
    for (const d of readdirSync(root)) cands.push(join(root, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  return cands.find((p) => existsSync(p))
}

const results = []
const check = (layer, title, ok, detail = '') => {
  results.push({ layer, title, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} [${layer}] ${title}${detail ? '  —— ' + detail : ''}`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const sandbox = join(tmpdir(), 'dsh-isolated-tests', 'ui-' + stamp)
let child = null
const cleanup = () => {
  try { if (child) spawnSync('cmd', ['/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { }
  // ⚠ 沙箱里可能有指向安装目录的 junction：必须先拆链接再删树
  for (const j of [join(sandbox, 'unit', 'node_modules'), join(sandbox, 'home', 'profiles', 'node_modules')]) {
    try { if (existsSync(j)) spawnSync('cmd', ['/c', 'rmdir', j], { stdio: 'ignore' }) } catch { }
  }
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { }
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })

// ══════════════════════════════════════ 假 React
function makeFakeReact() {
  const R = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => { }],
    useEffect: () => { },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    useSyncExternalStore: (sub, get) => get(),
    Fragment: Symbol('Fragment'),
  }
  return R
}
const walk = (n, out = []) => {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) { for (const x of n) walk(x, out); return out }
  out.push(n)
  for (const c of (n.children || [])) walk(c, out)
  return out
}

// ══════════════════════════════════════ 假 DOM（够 widget.js 用）
function makeFakeDom() {
  const byId = new Map()
  const mk = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), id: '', textContent: '', children: [], style: {},
      parent: null, offsetWidth: 320, offsetHeight: 140, _ev: {},
      appendChild(c) { c.parent = node; node.children.push(c); if (c.id) byId.set(c.id, c); return c },
      removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); return c },
      get firstChild() { return node.children[0] ?? null },
      addEventListener(t, fn) { (node._ev[t] = node._ev[t] || []).push(fn) },
      removeEventListener() { },
      setPointerCapture() { },
      getBoundingClientRect() { return { width: 320, height: 140 } },
      fire(t, e = {}) { for (const fn of (node._ev[t] || [])) fn({ target: node, preventDefault() { }, ...e }) },
    }
    return node
  }
  const document = {
    readyState: 'complete', visibilityState: 'visible',
    body: mk('body'), documentElement: mk('html'),
    createElement: (t) => mk(t),
    getElementById: (id) => byId.get(id) ?? null,
    addEventListener() { }, removeEventListener() { },
  }
  const store = new Map()
  const win = {
    innerWidth: 1280, innerHeight: 800,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    addEventListener() { }, removeEventListener() { },
    document, requestAnimationFrame: (fn) => { fn(); return 1 },
  }
  return { win, document, store, mk }
}

console.log('🐋 dsh-subagent-shield —— UI 测试（只在沙箱里跑）')
console.log(`   插件: ${PLUGIN_SRC}`)
console.log(`   沙箱: ${sandbox}\n`)

try {
  // ───────────────────────────────────── U1 配置卡
  console.log('── U1 配置卡（无头：假 window / 假 React / 假 ctx）')
  const clientSrc = readFileSync(join(PLUGIN_SRC, 'lib', 'client.js'), 'utf8')
  let loaded = null
  const fakeWindow = { __ModuleLoader__: { load: (m) => { loaded = m } }, localStorage: { getItem: () => null, setItem: () => { } } }
  new Function('window', `${clientSrc}\nreturn window.__ModuleLoader__.load`)(fakeWindow)
  check('U1', '走的是 window.__ModuleLoader__.load', loaded !== null)
  check('U1', '模块 id = 包名', loaded?.id === 'dsh-subagent-shield', `id=${loaded?.id}`)

  const react = makeFakeReact()
  const mod = loaded.factory((id) => { if (id === 'react') return react; throw new Error('意外 require: ' + id) })
  check('U1', '导出 name / inject / apply', mod?.name === 'dsh-subagent-shield' && Array.isArray(mod?.inject) && typeof mod?.apply === 'function', `inject=${JSON.stringify(mod?.inject)}`)

  const mutateCalls = []
  const snapshot = {
    status: 'ready', revision: 5, writable: true, base: {}, user: {},
    value: {
      enabled: true, scope: 'subagents', mode: 'all',
      protectSessions: true, protectProjcache: true, protectCredentials: true,
      guardShellText: true, auditEnabled: true, auditFile: '', dshHome: '',
    },
  }
  const registered = []
  let injectedSlot = null
  // ★ 假 ctx 必须**照真实 API 造**（SettingsFormScope：getSnapshot / subscribe / mutate），
  //   否则测试会自己骗自己 —— 之前用杜撰的 `settingsScope` 就是这么漏掉线上故障的。
  const fakeCtx = {
    configForms: {
      get: (ns) => ({
        namespace: ns,
        getSnapshot: () => snapshot,
        subscribe: () => () => { },
        mutate: (ops, rev) => { mutateCalls.push({ ops, rev }); return Promise.resolve(true) },
      }),
      whileServed: (nsList, cb) => { cb(); return () => { } },
    },
    locale: { register: () => { }, bind: () => (k) => k },
    slots: { inject: (n, fn) => { injectedSlot = n; fn() }, register: (o, c) => { registered.push({ o, c }); return () => { } } },
    effect: (fn) => { const d = fn(); return () => { } },
  }
  let applyErr = null
  try { mod.apply(fakeCtx) } catch (e) { applyErr = e }
  check('U1', 'apply 不抛错', applyErr === null, applyErr ? String(applyErr.message) : '')
  check('U1', '★ 注册成独立设置分区 settings.section', injectedSlot === 'settings.section', `slot=${injectedSlot}`)
  check('U1', '分区 id = profile 条目 id', registered[0]?.o?.id === 'dsh-subagent-shield', `id=${registered[0]?.o?.id}`)
  check('U1', '分区有 order / label / locale（照真实分区注册）',
    typeof registered[0]?.o?.order === 'number' && typeof registered[0]?.o?.label === 'function' && Boolean(registered[0]?.o?.locale),
    JSON.stringify({ order: registered[0]?.o?.order, label: registered[0]?.o?.label?.(), locale: registered[0]?.o?.locale }))

  // ★★ 交叉验证 ①：声明的客户端服务名必须**真实存在**（拿真实包的 inject 声明当白名单）
  //    这条就是为了防住「凭空写了个 settingsScope → 插件永远 pending → 界面 Failed to load plugins」
  const knownClientServices = new Set()
  const knownSlotNames = new Set()
  for (const base of [join(CHECKOUT, 'node_modules', '@deepseek-ai'),
                      join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai')]) {
    if (!base || !existsSync(base)) continue
    for (const d of readdirSync(base)) {
      if (!d.startsWith('dsh-client') && !d.startsWith('dsh-skin')) continue
      const f = join(base, d, 'lib', 'client.js')
      if (!existsSync(f)) continue
      const txt = readFileSync(f, 'utf8')
      for (const m of txt.matchAll(/(?:const inject = |exports\.inject = )\[([^\]]*)\]/g)) {
        for (const raw of m[1].split(',')) {
          const v = raw.trim().replace(/^["']|["']$/g, '')
          if (v) knownClientServices.add(v)
        }
      }
      for (const m of txt.matchAll(/slots\.inject\(\s*["']([^"']+)["']/g)) knownSlotNames.add(m[1])
      for (const m of txt.matchAll(/name:\s*["']([a-z][a-z0-9.]*\.[a-z][a-z0-9.]*)["']/g)) knownSlotNames.add(m[1])
    }
  }
  const unknown = (mod.inject || []).filter((s) => !knownClientServices.has(s))
  check('U1', '★★ 声明的客户端服务名都真实存在（防臆想）', unknown.length === 0,
    unknown.length ? `不存在的服务：${unknown.join(', ')}（真实包用到的名字有 ${[...knownClientServices].sort().join(', ')}）` : `inject=${JSON.stringify(mod.inject)}`)
  // ★★ 交叉验证 ②：注册的槽名也必须是真实存在于真实包里的
  check('U1', '★★ 注册的槽名 settings.section 在真实包里出现过', knownSlotNames.has('settings.section'),
    `已知槽名样例：${[...knownSlotNames].slice(0, 12).join(', ')}`)

  let tree = null, renderErr = null
  try { tree = registered[0].c() } catch (e) { renderErr = e }
  check('U1', '组件能渲染且不抛错', renderErr === null, renderErr ? String(renderErr.message) : '')

  const nodes = walk(tree)
  const inputs = nodes.filter((n) => n.type === 'input')
  const boxes = inputs.filter((n) => n.props?.type === 'checkbox')
  const buttons = nodes.filter((n) => n.type === 'button')
  check('U1', '渲染出复选框组（开关 + 策略 + 逐项）', boxes.length >= 8, `复选框 ${boxes.length} 个`)

  // 写回必须走 SettingsFormScope.mutate([{op:'set',path:[key],value}], revision)
  const wroteKey = (key) => mutateCalls.some((m) => m.ops?.[0]?.op === 'set' && m.ops[0].path?.[0] === key)
  const allText = JSON.stringify(tree)

  boxes[0]?.props?.onChange?.({ target: { checked: false } })
  check('U1', '拨总开关 → mutate 写 enabled', wroteKey('enabled'), JSON.stringify(mutateCalls.at(-1) ?? {}))
  check('U1', '写回带上了 revision 围栏', mutateCalls.every((m) => m.rev === 5), JSON.stringify(mutateCalls.map((m) => m.rev)))
  check('U1', '页面里有 scope / mode / 逐项保护的开关文案',
    allText.includes('subagents') && allText.includes('window（') && allText.includes('投影缓存'))
  check('U1', '页面里有「按工作区」「按窗口」两段（v4 的颗粒度）',    allText.includes('按工作区') && allText.includes('按窗口'))
  check('U1', '默认策略二选一（默认全拦 / 只拦点名的）',
    allText.includes('默认把全部拦住') && allText.includes('默认全部放行'))
  check('U1', '存在"状态小窗"开关按钮',
    buttons.some((b) => String(b.children?.[0] ?? '').includes('状态小窗')),
    buttons.map((b) => String(b.children?.[0] ?? '')).join(' / ').slice(0, 120))
  // ★★ 臂间隔离：设置页要有入口（否则使用者没法配置这个机制）
  check('U1', '★★ 页面里有「臂间隔离」区与「添加一条」按钮',
    allText.includes('臂间隔离') && allText.includes('自定义拦住目录') &&
    buttons.some((b) => String(b.children?.[0] ?? '').includes('添加一条')),
    `按钮：${buttons.map((b) => String(b.children?.[0] ?? '')).join(' / ').slice(0, 160)}`)

  // ★ 全开 / 全清 按钮（纯逻辑单测 + 渲染里确实接了按钮）
  const H = mod.__helpers || {}
  check('U1', '★ 全开/全清：导出纯逻辑', typeof H.allChecked === 'function' && typeof H.selectAllPatch === 'function')
  check('U1', '★ 全开/全清：全未选中 → 按钮应为"全开"', H.allChecked([{ protected: false }, { protected: false }]) === false)
  check('U1', '★ 全开/全清：全选中 → 按钮应为"全清空"', H.allChecked([{ protected: true }, { protected: true }]) === true)
  check('U1', '★ 全开/全清：只选了一半 → 仍算未全开', H.allChecked([{ protected: true }, { protected: false }]) === false)
  check('U1', '★ 全开/全清：空列表不算全开（按钮显示"全开"）', H.allChecked([]) === false)
  const pOn = H.selectAllPatch('workspaces', [{ key: 'a' }, { key: 'b' }], true)
  const pOff = H.selectAllPatch('workspaces', [{ key: 'a' }, { key: 'b' }], false)
  check('U1', '★ 全开补丁：每个工作区都置 true', pOn.workspaces.a === true && pOn.workspaces.b === true, JSON.stringify(pOn))
  check('U1', '★ 全清补丁：每个工作区都置 false', pOff.workspaces.a === false && pOff.workspaces.b === false, JSON.stringify(pOff))
  check('U1', '★ 窗口组用 id 当键', H.selectAllPatch('windows', [{ id: 's1' }], true).windows.s1 === true)
  check('U1', '★ 渲染里确实接了「全开」按钮', allText.includes('全开'))

  // ★ 零拦截横幅（页面红字）的纯逻辑
  const B = H.bannerFor
  check('U1', '★ 横幅：导出纯逻辑', typeof B === 'function')
  check('U1', '★ 横幅：生效时不显示', B({ active: true, reasons: [] }) === null && B(null) === null)
  check('U1', '★ 横幅：未生效时显示并带上原因',
    String(B({ active: false, reasons: ['模式=window，但没有任何窗口被点名'] })).includes('当前没有任何拦截生效') &&
    String(B({ active: false, reasons: ['模式=window，但没有任何窗口被点名'] })).includes('没有任何窗口被点名'))
  check('U1', '★ 横幅：未生效但没给原因也不崩', String(B({ active: false })).includes('当前没有任何拦截生效'))
  check('U1', '★ 界面用词不再有歧义：出现「拦住 / 放行」而非「受保护」',
    allText.includes('拦住') && allText.includes('放行') && !allText.includes('受保护'))

  // ───────────────────────────────────── U2 小窗脚本
  console.log('\n── U2 小窗脚本（无头：假 DOM / 假 localStorage / 假 fetch）')
  const widgetSrc = readFileSync(join(PLUGIN_SRC, 'lib', 'widget.js'), 'utf8')
  const dom = makeFakeDom()
  const fetched = []
  let intervalCount = 0
  const payload = {
    plugin: 'dsh-subagent-shield', version: '0.2.0',
    config: { enabled: true, scope: 'subagents', mode: 'all' },
    windows: [{ id: 'session-abc', override: false }],
    denied: { total: 3, windows: 2, historyTotal: 41, historyWindows: 1, auditEnabled: false, source: 'session' },
    recent: [{ ts: '2026-10-10T08:53:28.007Z', tool: 'read', kind: 'credentials', window: 'session-abc' }],
    auditFile: 'C:/x/audit.jsonl',
  }
  const g = {
    window: dom.win, document: dom.document,
    localStorage: dom.win.localStorage,
    fetch: (url, opts) => { fetched.push([url, opts]); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) }) },
    requestAnimationFrame: (fn) => { fn(); return 1 },
    setInterval: () => { intervalCount++; return 1 },
    clearInterval: () => { },
    console,
  }
  let wErr = null
  try {
    new Function('window', 'document', 'localStorage', 'fetch', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'console', widgetSrc)(
      g.window, g.document, g.localStorage, g.fetch, g.requestAnimationFrame, g.setInterval, g.clearInterval, g.console)
  } catch (e) { wErr = e }
  check('U2', '脚本执行不抛错', wErr === null, wErr ? String(wErr.message) : '')

  const root = dom.document.getElementById('dsh-subagent-shield-widget')
  check('U2', '挂载出了小窗节点', Boolean(root))
  check('U2', '小窗挂在 document.body 上', dom.document.body.children.some((c) => c.id === 'dsh-subagent-shield-widget'))
  check('U2', '默认可见（display=block）', root?.style?.display === 'block', `display=${root?.style?.display}`)

  await new Promise((r) => setTimeout(r, 30))
  check('U2', '拉了 /dsh-subagent-shield/status', fetched.some((f) => f[0] === '/dsh-subagent-shield/status'), JSON.stringify(fetched[0]?.[0] ?? ''))
  check('U2', 'fetch 带 same-origin 凭据', fetched[0]?.[1]?.credentials === 'same-origin')
  check('U2', '启动轮询（setInterval 被调用）', intervalCount >= 1, `interval=${intervalCount}`)

  const header = root?.children?.[0]
  const body = root?.children?.[1]
  const stateLine = body?.children?.[0]
  check('U2', '状态行渲染出配置摘要', String(stateLine?.textContent ?? '').includes('subagents'), String(stateLine?.textContent ?? ''))

  // ★★ 回归（使用者报「浮窗奇奇怪怪的」）——两个真实缺陷：
  //   ① 把账本累计行数当成"已拒绝 N 次"直接显示 → 每次重启都带着旧计数回来；
  //      还配一句"（账本未启用）"，有数据却说账本没开，自相矛盾。
  //   ② 时间戳 `String(iso).slice(11,19)` 取的是 ISO 里的 **UTC** 部分 →
  //      UTC+8 的用户看到的时间少 8 小时（21:46 的拒绝显示成 13:46）。
  {
    const countLine = String(body?.children?.[1]?.textContent ?? '')
    check('U2', '★★ 计数值区分「本次」与「账本历史」',
      countLine.includes('本次拒绝 3 次') && countLine.includes('账本历史 41 次'),
      countLine.slice(0, 120))
    check('U2', '★★ 账本停写时给出说明，而不是"账本未启用"这种自相矛盾的话',
      countLine.includes('账本已停止写入') && !countLine.includes('账本未启用'),
      countLine.slice(0, 120))
    // ★★ 回归：无记录时，计数行与列表占位**不能都说同一句话**（展开后看到重复两行）。
    //    真测：拿"零记录"的 payload 渲染一遍，数"还没有拒绝记录"出现几次。
    {
      const domZ = makeFakeDom()
      const zeroPayload = {
        plugin: 'dsh-subagent-shield', version: '0.4.8',
        config: { enabled: true, scope: 'subagents', mode: 'all' },
        denied: { total: 0, windows: 0, historyTotal: 0, historyWindows: 0, auditEnabled: true, source: 'none' },
        recent: [], auditFile: '/x/audit.jsonl',
      }
      const gZ = {
        window: domZ.win, document: domZ.document, localStorage: domZ.win.localStorage,
        fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(zeroPayload) }),
        requestAnimationFrame: (fn) => { fn(); return 1 },
        setInterval: () => 1, clearInterval: () => { }, console,
      }
      new Function('window', 'document', 'localStorage', 'fetch', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'console', widgetSrc)(
        gZ.window, gZ.document, gZ.localStorage, gZ.fetch, gZ.requestAnimationFrame, gZ.setInterval, gZ.clearInterval, gZ.console)
      await new Promise((r) => setTimeout(r, 40))
      const zRoot = domZ.document.body.children.find((c) => c.id === 'dsh-subagent-shield-widget')
      const gather = (n, acc = []) => { if (!n) return acc; if (n.textContent) acc.push(String(n.textContent)); for (const k of (n.children ?? [])) gather(k, acc); return acc }
      const zText = gather(zRoot).join(' | ')
      const times = (zText.match(/还没有拒绝记录/g) ?? []).length
      check('U2', '★★ 无记录时"还没有拒绝记录"只出现一次（不重复两行）', times === 1,
        `出现 ${times} 次；文本：${zText.slice(0, 140)}`)
      check('U2', '★★ 无记录时计数行仍显示「本次 0 次」', zText.includes('本次 0 次'), zText.slice(0, 120))
    }
    // 明细行的时间必须是**本地时区**（这条用例的 ts 是 08:53:28Z）
    // 注意：明细在 listBox 里，不是 body 的直接子节点 → 递归收集文本
    const collect = (n, acc = []) => { if (!n) return acc; if (n.textContent) acc.push(String(n.textContent)); for (const k of (n.children ?? [])) collect(k, acc); return acc }
    const rowText = collect(body).join(' | ')
    const expect = (() => { const d = new Date('2026-10-10T08:53:28.007Z'); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` })()
    check('U2', '★★ 明细时间按本地时区渲染（不是 ISO 里的 UTC）', rowText.includes(expect), `期望含 ${expect}；实际 ${rowText.slice(0, 110)}`)
  }

  // 拖动：pointerdown 记锚点 → pointermove 改位置
  const beforeLeft = root?.style?.left
  header?.fire('pointerdown', { clientX: 500, clientY: 200 })
  header?.fire('pointermove', { clientX: 560, clientY: 240 })
  check('U2', '拖动会改变位置', root?.style?.left !== beforeLeft, `${beforeLeft} → ${root?.style?.left}`)
  header?.fire('pointerup', {})
  check('U2', '松手后位置写进 localStorage', [...dom.store.keys()].some((k) => k.includes('pos')), [...dom.store.keys()].join(','))

  // 收起
  // ⚠ 按**文字**找按钮，不要按下标 —— 标题行里插一个状态块就会让 children[2] 变成空白占位，
  //   测试会静默点错元素（这次就是这么被撞出来的）。
  const findInHeader = (re) => (header?.children ?? []).find((c) => re.test(String(c?.textContent ?? '').trim()))
  const btnMin = findInHeader(/^[⌃⌄−▸]$/)
  const btnClose = findInHeader(/^✕$/)
  check('U2', '标题栏里能找到 折叠箭头 与 ✕（按文字定位）', Boolean(btnMin) && Boolean(btnClose))
  btnMin?.fire('click')
  check('U2', '点折叠箭头能收起（body 隐藏）', body?.style?.display === 'none', `body.display=${body?.style?.display}`)
  check('U2', '收起状态被记住', dom.store.get('dsh-subagent-shield:widget:min') === '1')

  // ★★ 回归（使用者报「是不是不显示啊」）——收起后不能只剩一条空横条：
  //    必须 ① 箭头变成 ⌄（雪佛龙）表示可展开 ② 标题行里看得见关键状态 ③ 点标题栏也能展开
  {
    const arrow = findInHeader(/^⌄$/)
    check('U2', '★★ 收起后箭头变成 ⌄（雪佛龙朝下，点了往下展开）', Boolean(arrow), `找到：${(header?.children ?? []).map((c) => JSON.stringify(String(c?.textContent ?? '').trim())).join(' ')}`)
    const chip = (header?.children ?? []).find((c) => /本次|已关闭/.test(String(c?.textContent ?? '')))
    check('U2', '★★ 收起后标题栏里显示状态（不再是空横条）',
      Boolean(chip) && chip.style.display !== 'none', `状态块：${JSON.stringify(String(chip?.textContent ?? ''))}`)
    // 真实浏览器里 click 之前一定有 pointerdown/pointerup —— 测试也要照这个序列发，
    // 否则会吃到上一次拖动留下的"刚拖过"标志（这次就是这么误判的）。
    const realClick = (node) => {
      node?.fire('pointerdown', { clientX: 420, clientY: 260 })
      node?.fire('pointerup', {})
      node?.fire('click')
    }
    realClick(header)
    check('U2', '★★ 点标题栏即可展开（不只靠那个小箭头）', body?.style?.display === 'flex' && dom.store.get('dsh-subagent-shield:widget:min') === '0', `body.display=${body?.style?.display}`)
    // 拖完再松手不应该被当成"点击"而误展开/误收起
    header?.fire('pointerdown', { clientX: 400, clientY: 300 })
    header?.fire('pointermove', { clientX: 500, clientY: 340 })
    header?.fire('pointerup', {})
    header?.fire('click')
    check('U2', '★★ 拖动之后的那次 click 不会被当成展开/收起', body?.style?.display === 'flex', `body.display=${body?.style?.display}`)
  }

  // 关闭 → 只剩圆点；点圆点恢复
  btnClose?.fire('click')
  const dot = dom.document.body.children.find((c) => c !== root)
  check('U2', '点 ✕ 后小窗隐藏、圆点出现', root?.style?.display === 'none' && dot?.style?.display === 'flex', `root=${root?.style?.display} dot=${dot?.style?.display}`)
  check('U2', '关闭状态写进 localStorage', dom.store.get('dsh-subagent-shield:widget') === 'off')
  dot?.fire('click')
  check('U2', '点圆点恢复小窗', root?.style?.display === 'block' && dot?.style?.display === 'none')

  // ★ 回归：关掉之后**不能永久消失**
  //   （v3 的真实 bug：localStorage=off 时脚本直接 return，连圆点都不挂，用户再也找不回来）
  const dom2 = makeFakeDom()
  dom2.store.set('dsh-subagent-shield:widget', 'off')
  let interval2 = 0
  const fetched2 = []
  const g2 = {
    window: dom2.win, document: dom2.document, localStorage: dom2.win.localStorage,
    fetch: (u, o) => { fetched2.push([u, o]); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) }) },
    requestAnimationFrame: (fn) => { fn(); return 1 },
    setInterval: () => { interval2++; return 1 }, clearInterval: () => { }, console,
  }
  new Function('window', 'document', 'localStorage', 'fetch', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'console', widgetSrc)(
    g2.window, g2.document, g2.localStorage, g2.fetch, g2.requestAnimationFrame, g2.setInterval, g2.clearInterval, g2.console)
  const root2 = dom2.document.getElementById('dsh-subagent-shield-widget')
  const dot2 = dom2.document.body.children.find((c) => c !== root2)
  check('U2', '★ 上次关闭过（localStorage=off）：仍然挂载，面板隐藏但圆点在',
    Boolean(root2) && root2.style.display === 'none' && dot2?.style?.display === 'flex',
    `root=${root2?.style?.display} dot=${dot2?.style?.display}`)
  check('U2', '★ 关闭态下不去拉数据（省事）', fetched2.length === 0 && interval2 === 0, `fetch=${fetched2.length} interval=${interval2}`)
  dot2?.fire('click')
  check('U2', '★ 点圆点能恢复，不再永久消失', root2?.style?.display === 'block' && dot2?.style?.display === 'none')
  check('U2', '★ 恢复后把状态写回 on', dom2.store.get('dsh-subagent-shield:widget') === 'on')

  // ───────────────────────────────────── U3 宿主接口
  console.log('\n── U3 宿主接口（无头：假 ctx + 假 webServer）')
  const unitDir = join(sandbox, 'unit')
  mkdirSync(unitDir, { recursive: true })
  const smLink = join(unitDir, 'node_modules', '@deepseek-ai', 'schemastery')
  mkdirSync(dirname(smLink), { recursive: true })
  const checkout = DSH_BIN ? dirname(dirname(dirname(dirname(dirname(DSH_BIN))))) : ''
  const smSrc = join(checkout, 'node_modules', '@deepseek-ai', 'schemastery')
  if (existsSync(smSrc)) spawnSync('cmd', ['/c', 'mklink', '/J', smLink, smSrc], { stdio: 'ignore' })
  const pkgDir = join(unitDir, 'node_modules', 'dsh-subagent-shield')
  spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, pkgDir, '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
  const hostMod = await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href)

  const unitHome = join(sandbox, 'unit-home')
  mkdirSync(unitHome, { recursive: true })
  const routes = [], taps = [], listeners = [], commands = [], injectCalls = []
  // GUI 鉴权服务的假实现：默认"通过"（undefined）。改它就能模拟未鉴权。
  const authState = { reject: undefined }
  const fakeConnection = { requestRejection: () => authState.reject }
  const childCtx = {
    webServer: {
      register: (o) => { routes.push(o); return () => { } },
      tapIndex: (fn) => { taps.push(fn); return () => { } },
    },
    // 插件用**嵌套可选注入**取 connection（cordis 里直接读未声明的服务会抛错）
    inject: (deps, cb) => { if (deps.includes('connection')) cb({ connection: fakeConnection }); return () => { } },
    on: (e, fn) => { listeners.push({ e, fn }); return () => { } },
    effect: (fn) => { const d = fn(); return () => { } },
  }
  const hostCtx = {
    on: (e, fn) => { listeners.push({ e, fn }); return () => { } },
    commands: { register: (d) => { commands.push(d); return () => { } } },
    inject: (deps, cb) => { injectCalls.push(deps); cb(childCtx); return () => { } },
  }
  const hostCfg = (o = {}) => ({
    enabled: { get: () => o.enabled ?? true }, scope: { get: () => o.scope ?? 'subagents' },
    mode: { get: () => o.mode ?? 'all' }, dshHome: { get: () => unitHome }, auditFile: { get: () => '' },
    protectSessions: { get: () => true }, protectProjcache: { get: () => true },
    protectCredentials: { get: () => true }, guardShellText: { get: () => true }, auditEnabled: { get: () => true },
    autoOwnWrites: { get: () => o.autoOwnWrites ?? true },
    denyHomeByDefault: { get: () => o.denyHomeByDefault ?? true },
  })
  let hErr = null
  try { hostMod.apply(hostCtx, hostCfg()) } catch (e) { hErr = e }
  check('U3', 'apply 不抛错', hErr === null, hErr ? String(hErr.message) : '')
  check('U3', '可选注入都走嵌套 ctx.inject（webServer + subagents），不进必需 inject',
    injectCalls.length >= 1 &&
    injectCalls.some((d) => Array.isArray(d) && d.includes('webServer')) &&
    injectCalls.some((d) => Array.isArray(d) && d.includes('subagents')),
    JSON.stringify(injectCalls))
  check('U3', '必需 inject 里只有 commands', JSON.stringify(hostMod.inject) === '["commands"]', JSON.stringify(hostMod.inject))
  check('U3', '注册了三个 exact 路由（脚本 / 状态 / 规则）', routes.length === 3 && routes.every((r) => r.kind === 'exact'), routes.map((r) => r.path).join(', '))
  check('U3', '路由路径正确',
    ['/dsh-subagent-shield/widget.js', '/dsh-subagent-shield/status', '/dsh-subagent-shield/rules'].every((p) => routes.some((r) => r.path === p)),
    routes.map((r) => r.path).join(', '))

  const html0 = '<html><body><div id="app"></div></body></html>'
  const html1 = taps[0]?.(html0)
  const html2 = taps[0]?.(html1)
  check('U3', 'tapIndex 注入了脚本标签', String(html1).includes('<script defer src="/dsh-subagent-shield/widget.js"></script>'))
  check('U3', '注入是幂等的（第二次不再加）', html1 === html2)
  check('U3', '脚本插在 </body> 之前', String(html1).indexOf('widget.js') < String(html1).indexOf('</body>'))

  const table = []
  const inj = listeners.find((l) => l.e === 'webserver/index-inject')
  inj?.fn(table); inj?.fn(table)
  check('U3', 'index-inject 行注入一次（去重）', table.length === 1 && table[0].kind === 'script-src', JSON.stringify(table))

  // /status 处理器
  const statusRoute = routes.find((r) => r.path === '/dsh-subagent-shield/status')
  const callRoute = (route, req = {}) => new Promise((resolve) => {
    const res = {
      _code: 0, _body: '', _headers: {},
      writeHead(c, hh) { res._code = c; res._headers = hh || {} },
      end(b) { res._body = b; resolve({ code: res._code, body: res._body, headers: res._headers }) },
    }
    const handlers = {}
    const fakeReq = {
      method: req.method || 'GET',
      on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return fakeReq },
      destroy() { },
    }
    try { route.handler(fakeReq, res) } catch (e) { resolve({ code: -1, body: String(e?.message ?? e) }); return }
    if (req.body !== undefined) {
      for (const fn of (handlers.data || [])) fn(Buffer.from(req.body))
      for (const fn of (handlers.end || [])) fn()
    }
  })
  let st = await callRoute(statusRoute)
  let json = JSON.parse(st.body)
  check('U3', '/status 返回 200 JSON', st.code === 200 && json.plugin === 'dsh-subagent-shield', `code=${st.code}`)
  check('U3', '/status 含配置摘要与计数', json.config?.scope === 'subagents' && json.denied?.total === 0, JSON.stringify(json.denied))
  check('U3', '/status 不返回任何凭据内容', !JSON.stringify(json).includes('sk-') && !('credentials' in (json.config || {})))
  check('U3', '/status 标出了是否给了明细（detail 标志）', json.detail === true)

  // ★★ 回归（评审 P3）：插件自己开的路由必须挂在 GUI 鉴权层后面
  //    原版不带 cookie 就返回 200 + 24 个工作区可读路径 + 60 个窗口 id —— 插件成了自己的后门。
  const rulesRouteAuth = routes.find((r) => r.path === '/dsh-subagent-shield/rules')
  authState.reject = 401
  const noAuthStatus = await callRoute(statusRoute)
  check('U3', '★★ 未鉴权 /status → 401（不再泄漏清单）', noAuthStatus.code === 401, `code=${noAuthStatus.code} body=${String(noAuthStatus.body).slice(0, 40)}`)
  const noAuthRules = await callRoute(rulesRouteAuth, { method: 'POST', body: '{"defaultPolicy":"allow"}' })
  check('U3', '★★ 未鉴权 POST /rules → 401（不能匿名改规则）', noAuthRules.code === 401, `code=${noAuthRules.code}`)
  const noAuthRulesGet = await callRoute(rulesRouteAuth)
  check('U3', '★★ 未鉴权 GET /rules → 401', noAuthRulesGet.code === 401, `code=${noAuthRulesGet.code}`)
  authState.reject = 403
  const forbidden = await callRoute(statusRoute)
  check('U3', '★★ 跨站/Host 栅栏不通过 → 403', forbidden.code === 403, `code=${forbidden.code}`)
  authState.reject = undefined

  // 没有鉴权服务时（非 web 形态）→ 只给计数，不给清单
  const savedRejection = fakeConnection.requestRejection
  delete fakeConnection.requestRejection
  const reduced = await callRoute(statusRoute)
  let reducedJson = {}
  try { reducedJson = JSON.parse(reduced.body) } catch { }
  check('U3', '★★ 拿不到鉴权服务 → 降级为只给计数（不给工作区/窗口/明细）',
    reduced.code === 200 && reducedJson.detail === false &&
    Array.isArray(reducedJson.workspaces) && reducedJson.workspaces.length === 0 &&
    Array.isArray(reducedJson.recent) && reducedJson.recent.length === 0 &&
    Boolean(reducedJson.counts) && typeof reducedJson.counts.workspaces === 'number',
    `code=${reduced.code} detail=${reducedJson.detail} counts=${JSON.stringify(reducedJson.counts)}`)
  const reducedRules = await callRoute(rulesRouteAuth, { method: 'POST', body: '{}' })
  check('U3', '★★ 降级模式下 /rules 写入仍 401（写操作绝不放行）', reducedRules.code === 401, `code=${reducedRules.code}`)
  fakeConnection.requestRejection = savedRejection

  // ★★ 臂间隔离：自定义拦住目录的读写通道（设置页就是靠这条 POST 落盘的）
  {
    const body = JSON.stringify({
      protectedPaths: [
        { path: 'C:\\lab\\armB', owner: 'session-win-1' },
        { path: '   ' },                    // 空路径 → 应被丢掉
        { path: 'C:\\lab\\armC' },          // 无 owner → 对所有人拦住
        { path: 'C:\\lab\\armD', owner: '  ' },  // owner 是空白 → 当成无 owner
      ],
    })
    const r = await callRoute(rulesRouteAuth, { method: 'POST', body })
    let rulesBack = {}
    try { rulesBack = JSON.parse(r.body).rules || {} } catch { }
    const pp = rulesBack.protectedPaths || []
    check('U3', '★★ 自定义拦住目录能写进规则并回读', r.code === 200 && pp.length === 3,
      `code=${r.code} 条数=${pp.length} ${JSON.stringify(pp)}`)
    check('U3', '★★ 空路径被丢掉、空白 owner 被清掉',
      pp.length === 3 && pp[0].owner === 'session-win-1' && !('owner' in pp[1]) && !('owner' in pp[2]),
      JSON.stringify(pp))
    const st2 = await callRoute(statusRoute)
    let names = []
    try { names = (JSON.parse(st2.body).rules.protectedPaths || []).map((x) => x.path) } catch { }
    check('U3', '★★ /status 会带出自定义拦住目录（设置页据此渲染）',
      names.includes('C:\\lab\\armB') && names.includes('C:\\lab\\armC'), JSON.stringify(names))
    // 复原，别影响后面的用例
    await callRoute(rulesRouteAuth, { method: 'POST', body: JSON.stringify({ protectedPaths: [] }) })
  }

  // ★★ 自动臂间隔离（谁写的谁拥有）：设置页要有开关，/status 要带出现状
  check('U1', '★★ 页面里有「谁写的谁拥有」开关（自动臂间隔离）',
    allText.includes('谁写的谁拥有') && allText.includes('自动臂间隔离') && allText.includes('shield 放行'),
    '（应含开关名与逃生门提示）')
  {
    const st3 = await callRoute(statusRoute)
    let own = null, autoOwn = null
    try { const j = JSON.parse(st3.body); own = j.own; autoOwn = j.config.autoOwnWrites } catch { }
    check('U3', '★★ /status 带出「谁写的谁拥有」的现状（开关 + 已登记数 + 放行列表）',
      autoOwn === true && Boolean(own) && typeof own.total === 'number' && Array.isArray(own.shared) && Array.isArray(own.recent),
      `autoOwnWrites=${autoOwn} own=${JSON.stringify(own).slice(0, 120)}`)
  }

  // 触发一次拒绝，看计数与最近记录
  const pre = listeners.find((l) => l.e === 'tools/pre-execute')
  const subExec = { name: 'read', arguments: { file_path: join(unitHome, 'sessions', 'x', 'session.v4.jsonl.zstd') },
    agent: { session: { header: { id: 'sub-9', origin: 'subagent', delegationDepth: 1, parentSession: 'session-win-1' } } } }
  let nextCalled = false
  const decision = await pre.fn(subExec, async () => { nextCalled = true; return { kind: 'allow' } })
  check('U3', '拒绝仍然生效（隔离本体未被 UI 改动影响）', decision?.kind === 'deny' && !nextCalled)
  st = await callRoute(statusRoute)
  json = JSON.parse(st.body)
  check('U3', '拒绝后 /status 计数 +1', json.denied?.total === 1, JSON.stringify(json.denied))
  check('U3', '拒绝后 /status 带出最近记录', json.recent?.length === 1 && json.recent[0].tool === 'read', JSON.stringify(json.recent?.[0] ?? {}))
  check('U3', '拒绝后 /status 标出所属窗口', json.recent?.[0]?.window === 'session-win-1')

  // ★ v4 新增：规则接口 + 规则真的影响判定（细到工作区）
  const rulesRoute = routes.find((r) => r.path === '/dsh-subagent-shield/rules')
  const rulesGet = JSON.parse((await callRoute(rulesRoute)).body)
  check('U3', '★ GET /rules 返回当前规则', rulesGet.rules?.defaultPolicy === 'protect', JSON.stringify(rulesGet.rules))
  const rulesPost = JSON.parse((await callRoute(rulesRoute, {
    method: 'POST', body: JSON.stringify({ defaultPolicy: 'allow', workspaces: { 'ws-keep': true } }),
  })).body)
  check('U3', '★ POST /rules 能改默认策略与点名工作区',
    rulesPost.ok === true && rulesPost.rules.defaultPolicy === 'allow' && rulesPost.rules.workspaces['ws-keep'] === true,
    JSON.stringify(rulesPost.rules))
  const rulesPath = join(unitHome, 'subagent-shield-rules.json')
  check('U3', '★ 规则落盘成 subagent-shield-rules.json',
    existsSync(rulesPath) && readFileSync(rulesPath, 'utf8').includes('ws-keep'))
  check('U3', '★ POST 错误 JSON → 400（不崩）', (await callRoute(rulesRoute, { method: 'POST', body: '{oops' })).code === 400)

  const subAt = (ws, sid) => ({
    name: 'read', args: { file_path: join(unitHome, 'sessions', ws, sid, 'session.v4.jsonl.zstd') },
    agent: { session: { header: { id: 'sub-' + sid, origin: 'subagent', delegationDepth: 1, parentSession: 'w1' } } },
  })
  let passed = false
  const d1 = await pre.fn(subAt('ws-other', 's1'), async () => { passed = true; return { kind: 'allow' } })
    // ★ 语义变更（v0.8.0）：%DSH_HOME% 改成默认全拒 —— 即使按类别的保护全关、默认策略设成 allow，
    //   宿主数据目录仍然拦（否则就得维护一份永远补不完的清单）。
    check('U3', '★★ 默认全拒：%DSH_HOME% 下的路径 → 仍拦（与按类别开关无关）',
      d1?.kind === 'deny' && passed === false, String(d1?.reason ?? '').split('\n')[0])
    {
      const listeners2 = []
      const ctx2 = {
        on: (e, fn) => { listeners2.push({ e, fn }); return () => { } },
        commands: { register: () => () => { } },
        inject: (d, cb) => { cb(childCtx); return () => { } },
      }
      hostMod.apply(ctx2, hostCfg({ denyHomeByDefault: false }))
      const pre2 = listeners2.find((l) => l.e === 'tools/pre-execute')
      if (pre2) {
        let passed2 = false
        const d1b = await pre2.fn(subAt('ws-other', 's9'), async () => { passed2 = true; return { kind: 'allow' } })
        check('U3', '开关关掉（denyHomeByDefault=false）→ 回到按类别判定，未点名工作区放行',
          d1b?.kind !== 'deny' && passed2 === true, String(d1b?.reason ?? '').split('\n')[0])
      }
    }
  const d2 = await pre.fn(subAt('ws-keep', 's2'), async () => ({ kind: 'allow' }))
  check('U3', '★ 点名的工作区仍然拦', d2?.kind === 'deny', String(d2?.reason ?? '').split('\n')[0])

  // ★★ 归属登记表的**篡改可检测**：登记一条 → 把文件改小 → /status 的 own.tampered 应为 true
  {
    const ownsPath = join(unitHome, 'subagent-shield-owns.json')
    const subWrite = {
      name: 'write', args: { file_path: join(unitHome, 'probe-owned.txt'), content: 'x' },
      agent: { session: { header: { id: 'sub-own-1', origin: 'subagent', delegationDepth: 1, parentSession: 'w1', cwd: unitHome } } },
    }
    let okW = false
    await pre.fn(subWrite, async () => { okW = true; return { kind: 'allow' } })
    const stA = await callRoute(statusRoute)
    let ownA = null
    try { ownA = JSON.parse(stA.body).own } catch { }
    check('U3', '★★ 子代理写入后归属表落盘，且未篡改时 tampered=false',
      okW === true && ownA && ownA.total >= 1 && ownA.tampered === false,
      JSON.stringify({ total: ownA?.total, tampered: ownA?.tampered, entriesAtBoot: ownA?.entriesAtBoot }))
    if (existsSync(ownsPath)) {
      writeFileSync(ownsPath, JSON.stringify({ version: 1, owned: {}, shared: [] }, null, 2) + '\n', 'utf8')
      const stB = await callRoute(statusRoute)
      let ownB = null
      try { ownB = JSON.parse(stB.body).own } catch { }
      check('U3', '★★ 把归属表改小 → /status 报 tampered=true（被动手能查出来）',
        ownB && ownB.tampered === true, JSON.stringify({ total: ownB?.total, tampered: ownB?.tampered }))
    } else {
      check('U3', '★★ 把归属表改小 → tampered=true（文件不存在，无法测）', false, '归属表没落盘')
    }
  }

  // ★★ 配置变更留痕（configDrift）：字段存在 + 没有改动时不误报
  {
    const s1 = await callRoute(statusRoute)
    let p1 = null
    try { p1 = JSON.parse(s1.body) } catch { }
    check('U3', '★★ /status 带出 configDrift 字段（配置变更留痕）',
      p1 !== null && Object.prototype.hasOwnProperty.call(p1, 'configDrift'))
    check('U3', '★★ 配置没改动 → configDrift 为 null（不误报）', p1?.configDrift === null)
    const s2 = await callRoute(statusRoute)
    let p2 = null
    try { p2 = JSON.parse(s2.body) } catch { }
    check('U3', '★★ 连续两次 /status 不会凭空产生 warn（warns 仍为 0）', p2?.ledger?.warns === 0)
  }

  // ───────────────────────────────────── U4 沙箱真启动
  console.log('\n── U4 沙箱真启动（临时 DSH_HOME）')
  if (!DSH_BIN) { check('U4', '找到 dsh CLI', false, '未找到') }
  else {
    const home = join(sandbox, 'home')
    mkdirSync(home, { recursive: true })
    const env = { ...process.env, DSH_HOME: home }
    const sc = spawnSync(NODE_EXE, [DSH_BIN, 'testweb', '--from-default-profile', 'web', '--dump-config'], { env, encoding: 'utf8', timeout: 120000 })
    const prof = join(home, 'profiles', 'testweb')
    check('U4', '沙箱脚手架出 profile', sc.status === 0 && existsSync(join(prof, 'package.json')), `exit=${sc.status}`)
    const fb = join(home, 'profiles', 'node_modules')
    if (existsSync(checkout)) spawnSync('cmd', ['/c', 'mklink', '/J', fb, join(checkout, 'node_modules')], { stdio: 'ignore' })
    spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, join(prof, 'node_modules', 'dsh-subagent-shield'), '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
    writeFileSync(join(prof, 'cordis.patch.yml'),
      '# ui test patch\n- insert:\n    - id: dsh-subagent-shield\n      name: dsh-subagent-shield\n', 'utf8')

    const outPath = join(sandbox, 'boot.out.log'), errPath = join(sandbox, 'boot.err.log')
    const outFd = openSync(outPath, 'w'), errFd = openSync(errPath, 'w')
    child = spawn(NODE_EXE, [DSH_BIN, 'testweb', '--port', '3099', '--no-open'],
      { cwd: prof, env, stdio: ['ignore', outFd, errFd], windowsHide: true })
    const up = await new Promise((resolve) => {
      const deadline = Date.now() + 90000
      const tick = () => { const s = net.connect(3099, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => { s.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tick, 400) }) }
      tick()
    })
    closeSync(outFd); closeSync(errFd)
    const out = readFileSync(outPath, 'utf8'), err = readFileSync(errPath, 'utf8')
    check('U4', '带客户端半区的插件树能启动', up, `listening=${up}`)
    check('U4', '宿主半区挂载（v4）', out.includes('[subagent-shield] 已挂载 v4'), out.split('\n').find((l) => l.includes('subagent-shield')) ?? '(未见)')
    check('U4', '状态接口/小窗装配成功', out.includes('接口就绪'), out.split('\n').find((l) => l.includes('接口就绪')) ?? '(未见)')
    check('U4', 'stderr 干净', err.trim() === '', err.trim().slice(0, 200))

    // ★ 等启动令牌落盘再取：**端口可连 ≠ 令牌那行已经写进日志**。
    //   原来这里只读一次日志快照，于是偶尔拿不到令牌 → 静默降级成 2 条弱检查，
    //   而套件**仍然全绿** —— 最强的端到端断言被悄悄跳过（实测项数在 102/100 之间飘）。
    //   现在：轮询等待；真等不到就**报红**，不允许静默降级。
    let tokenLine = null
    {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const snap = readFileSync(outPath, 'utf8') + readFileSync(errPath, 'utf8')
        tokenLine = snap.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s"']+/)
        if (tokenLine) break
        await new Promise((r) => setTimeout(r, 250))
      }
    }
    check('U4', '★ 拿到启动令牌（端到端强检查的前提）', Boolean(tokenLine),
      tokenLine ? tokenLine[0].replace(/token=[^\s"']+/, 'token=<略>') : '20 秒内日志里始终没有 ?token= 链接')
    const probe = async (p, cookie) => {
      try {
        const r = await fetch(`http://127.0.0.1:3099${p}`, { headers: cookie ? { cookie } : {} })
        return { code: r.status, body: await r.text(), setCookie: r.headers.get('set-cookie') }
      } catch (e) { return { code: 0, body: String(e.message) } }
    }
    const bogus = await probe('/definitely-not-a-route-xyz')
    const statusNoAuth = await probe('/dsh-subagent-shield/status')
    if (tokenLine) {
      const r0 = await fetch(tokenLine[0], { redirect: 'manual' })
      const cookie = (r0.headers.get('set-cookie') || '').split(';')[0]
      const page = await probe('/', cookie)
      const st2 = await probe('/dsh-subagent-shield/status', cookie)
      check('U4', '带令牌拿到首页', page.code === 200, `code=${page.code}`)
      check('U4', '首页被注入了小窗脚本', page.body.includes('/dsh-subagent-shield/widget.js'))
      check('U4', '小窗脚本能被取到（200 + JS）', (await probe('/dsh-subagent-shield/widget.js', cookie)).code === 200)
      let ok = false
      try { const j = JSON.parse(st2.body); ok = j.plugin === 'dsh-subagent-shield' } catch { }
      check('U4', '认证后 /status 返回正确 JSON', st2.code === 200 && ok, `code=${st2.code}`)
    } else {
      // 真降级了就把"没测到"记成**失败**，别让一次全绿掩盖掉最强的断言
      check('U4', '（降级）端到端强检查没跑成', false, '未在日志里找到 ?token= 链接')
      check('U4', '/status 路由已被认证层接管（非 404，弱检查）', statusNoAuth.code !== 404, `status=${statusNoAuth.code} bogus=${bogus.code}`)
    }
    try { child.kill() } catch { }
    spawnSync('cmd', ['/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    child = null
    await new Promise((r) => setTimeout(r, 700))
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
