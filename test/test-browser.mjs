#!/usr/bin/env node
/**
 * dsh-subagent-shield —— 真浏览器验证（第三个从未被自动验证过的面）
 *
 * 为什么需要它：客户端半区至今只被"假 DOM + 假 React"和无头字符串检查验证过，
 * 设置页与浮动小窗**只有人眼看过**。而这个项目最惨的两次故障（GUI 报
 * "Failed to load plugins"、缺 client.js 导致冷启动失败）全在客户端半区。
 *
 * 做法（零依赖）：
 *   · 用 Edge/Chrome 的 CDP（DevTools 协议）驱动真浏览器 —— Node 24 自带
 *     `WebSocket` 与 `fetch`，不需要 Playwright/Puppeteer。
 *   · 全程在**沙箱实例**上跑（临时 DSH_HOME + 端口 3099），不碰正在用的 DSH。
 *   · 装的是**完整版**（含 dsh.client），因为要验的正是客户端半区。
 *
 * 断言：页面能加载、**没有** Failed to load plugins、小窗真的挂上并显示状态、
 *       设置页里能找到「信息隔断」分区、页面无未捕获异常、拖动/收起真的生效。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { findCheckout, findDshBin, nodeExe, sampleHome } from './_env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 插件根自动识别，兼容两种布局：
//   ① 作者测试台：<台>\独立测试台\ + <台>\隔离插件\  ② git 仓库：<仓库>\test\ + <仓库>\lib\
const PLUGIN_SRC = existsSync(join(HERE, '..', '隔离插件', 'lib', 'index.js')) ? join(HERE, '..', '隔离插件') : join(HERE, '..')
const CHECKOUT = findCheckout()
const DSH_BIN = findDshBin()
const NODE_EXE = nodeExe()
const CDP_PORT = 9222
const APP_PORT = 3099

const BROWSERS = [
  process.env.DSH_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)
const BROWSER = BROWSERS.find((p) => existsSync(p))

const results = []
const check = (title, ok, detail = '') => {
  results.push({ title, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${title}${detail ? '  —— ' + detail : ''}`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const sandbox = join(tmpdir(), 'dsh-isolated-tests', 'browser-' + stamp)
const userData = join(sandbox, 'edge-profile')
let dsh = null, edge = null

const cleanup = () => {
  // ⚠ 只杀我们自己启动的进程树。**绝不要** `taskkill /IM msedge.exe` ——
  //   那会把使用者自己开着的浏览器窗口一起关掉（这条注释就是为此存在的，已改掉）。
  for (const p of [edge, dsh]) { try { if (p) spawnSync('cmd', ['/c', 'taskkill', '/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { } }
  for (const j of [join(sandbox, 'home', 'profiles', 'node_modules')]) {
    try { if (existsSync(j)) spawnSync('cmd', ['/c', 'rmdir', j], { stdio: 'ignore' }) } catch { }
  }
  for (let i = 0; i < 5; i++) {
    try { rmSync(sandbox, { recursive: true, force: true }) } catch { }
    if (!existsSync(sandbox)) break
    spawnSync('cmd', ['/c', 'ping', '-n', '2', '127.0.0.1'], { stdio: 'ignore' })
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const waitHttp = (url, ms) => new Promise((resolve) => {
  const deadline = Date.now() + ms
  const tick = async () => {
    try { const r = await fetch(url); if (r.ok) return resolve(true) } catch { }
    if (Date.now() > deadline) return resolve(false)
    setTimeout(tick, 400)
  }
  tick()
})

const waitPort = (port, ms) => new Promise((resolve) => {
  const deadline = Date.now() + ms
  const tick = () => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => { s.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tick, 400) })
  }
  tick()
})

// ── CDP 极简客户端 ────────────────────────────────────────────────────────
let ws = null, nextId = 1
const pending = new Map()
const pageErrors = []
const consoleErrors = []

const cdp = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})

async function evalJs(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text ?? 'exception' }
  return r?.result?.result?.value
}

console.log('🐋 dsh-subagent-shield —— 真浏览器验证（沙箱实例 + CDP）')
console.log(`   浏览器: ${BROWSER ?? '(未找到)'}`)
console.log(`   dsh   : ${DSH_BIN}`)
console.log(`   沙箱  : ${sandbox}\n`)

try {
  if (!BROWSER) { check('找到浏览器', false, 'msedge.exe / chrome.exe 都没找到'); throw new Error('no-browser') }
  if (!existsSync(DSH_BIN)) { check('找到 dsh CLI', false, DSH_BIN); throw new Error('no-dsh') }

  // ── 1. 沙箱实例（装完整版，因为要验客户端半区）
  mkdirSync(join(sandbox, 'home'), { recursive: true })
  const env = { ...process.env, DSH_HOME: join(sandbox, 'home') }
  const sc = spawnSync(NODE_EXE, [DSH_BIN, 'testweb', '--from-default-profile', 'web', '--dump-config'], { env, encoding: 'utf8', timeout: 120000 })
  const prof = join(sandbox, 'home', 'profiles', 'testweb')
  check('沙箱脚手架出 profile', sc.status === 0 && existsSync(join(prof, 'package.json')), `exit=${sc.status}`)
  spawnSync('cmd', ['/c', 'mklink', '/J', join(sandbox, 'home', 'profiles', 'node_modules'), join(CHECKOUT, 'node_modules')], { stdio: 'ignore' })
  spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, join(prof, 'node_modules', 'dsh-subagent-shield'), '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
  writeFileSync(join(prof, 'cordis.patch.yml'),
    '# browser test patch\n- insert:\n    - id: dsh-subagent-shield\n      name: dsh-subagent-shield\n', 'utf8')

  const outPath = join(sandbox, 'boot.out.log'), errPath = join(sandbox, 'boot.err.log')
  const outFd = openSync(outPath, 'w'), errFd = openSync(errPath, 'w')
  dsh = spawn(NODE_EXE, [DSH_BIN, 'testweb', '--port', String(APP_PORT), '--no-open'],
    { cwd: prof, env, stdio: ['ignore', outFd, errFd], windowsHide: true })
  const up = await waitPort(APP_PORT, 90000)
  check('沙箱实例起来了', up, up ? '' : `stderr: ${readFileSync(errPath, 'utf8').slice(0, 160)}`)
  // 令牌行是在端口通了**之后**才打印的 → 要轮询日志，不能读一次就算
  let token = null, bootOut = '', bootErr = ''
  for (let i = 0; i < 25 && !token; i++) {
    bootOut = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
    bootErr = existsSync(errPath) ? readFileSync(errPath, 'utf8') : ''
    token = (bootOut + bootErr).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=(\S+)/)?.[1] ?? null
    if (!token) await new Promise((r) => setTimeout(r, 800))
  }
  closeSync(outFd); closeSync(errFd)
  check('宿主半区挂载（含完整客户端半区）', bootOut.includes('[subagent-shield] 已挂载'), bootOut.split('\n').find((l) => l.includes('subagent-shield')) ?? '(未见)')
  check('拿到带令牌的入口 URL', Boolean(token), token ? '(已取得，不打印)' : `日志尾部: ${bootOut.split('\n').slice(-3).join(' | ').slice(0, 160)}`)

  // ── 2. 启动真浏览器（headless + CDP）
  mkdirSync(userData, { recursive: true })
  edge = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--window-size=1400,900', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  const cdpUp = await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 60000)
  check('浏览器起来了（CDP 可连）', cdpUp)

  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  check('拿到页面 target', Boolean(page?.webSocketDebuggerUrl))
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')) })
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return }
    if (d.method === 'Runtime.exceptionThrown') pageErrors.push(d.params?.exceptionDetails?.text ?? 'exception')
    if (d.method === 'Runtime.consoleAPICalled' && d.params?.type === 'error') {
      consoleErrors.push((d.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
    }
  }
  await cdp('Page.enable')
  await cdp('Runtime.enable')

  // ── 3. 先进带令牌的入口（种 cookie），再进首页
  await cdp('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/?token=${token}` })
  await new Promise((r) => setTimeout(r, 4000))
  await cdp('Page.navigate', { url: `http://127.0.0.1:${APP_PORT}/` })
  // 等 SPA 起来
  let ready = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const s = await evalJs(`(() => { const r = document.getElementById('root'); return { rs: document.readyState, len: (document.body?.innerText||'').length, root: r ? r.children.length : -1 } })()`)
    if (s && s.rs === 'complete' && s.len > 0 && s.root !== 0) { ready = true; break }
  }
  check('页面加载完成且渲染出内容', ready)

  const state = await evalJs(`(() => ({
    text: (document.body.innerText || ''),
    widget: !!document.getElementById('dsh-subagent-shield-widget'),
    dot: [...document.body.children].some(n => n !== document.getElementById('dsh-subagent-shield-widget') && n.style && n.style.display === 'none' && (n.textContent||'').includes('🛡')),
    title: document.title,
    scripts: [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')).filter(Boolean),
    htmlLen: (document.documentElement.outerHTML || '').length,
  }))()`)
  const bodyText = String(state?.text ?? '')

  // 先确认"注入"这一环：宿主有没有把脚本标签塞进页面
  const scripts = Array.isArray(state?.scripts) ? state.scripts : []
  check('宿主把 widget.js 注入了页面', scripts.some((s) => s.includes('/dsh-subagent-shield/widget.js')),
    `script[src] = ${scripts.map((s) => s.replace(/&rev=.*$/, '')).join(', ').slice(0, 220)}`)

  // ── 4. 最要紧的一条：没有 Failed to load plugins
  check('★ 页面**没有** "Failed to load plugins"', !/Failed to load plugins|did not activate/i.test(bodyText),
    /Failed to load plugins|did not activate/i.test(bodyText)
      ? bodyText.split('\n').filter((l) => /Failed|activate/i.test(l)).join(' / ').slice(0, 160)
      : '未出现插件加载失败提示')

  // ── 5. 浮动小窗
  check('★ 浮动小窗真的挂上了 DOM', state?.widget === true)
  check('小窗显示状态摘要（真实 /status 数据）',
    /总开关|信息隔断|已拒绝|范围/.test(bodyText),
    bodyText.split('\n').filter((l) => /总开关|已拒绝|范围|信息隔断/.test(l)).slice(0, 3).join(' | ').slice(0, 160))

  // ── 6. 页面里 fetch 我们的接口
  const apiOk = await evalJs(`fetch('/dsh-subagent-shield/status',{credentials:'same-origin'}).then(r=>r.ok?r.json():{bad:r.status}).then(j=>({ok:!!j.plugin, plugin:j.plugin, active:(j.effective||{}).active})).catch(e=>({err:String(e)}))`)
  check('页面上下文能取到 /status（小窗的数据源）', apiOk?.ok === true, JSON.stringify(apiOk))

  // ── 7. 真实拖动 + 收起
  const dragOk = await evalJs(`(() => {
    const root = document.getElementById('dsh-subagent-shield-widget')
    if (!root) return { err: 'no-widget' }
    const header = root.children[0]
    const before = root.style.left
    const r = header.getBoundingClientRect()
    const mk = (t, x, y) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, pointerId: 1, isPrimary: true })
    header.dispatchEvent(mk('pointerdown', r.left + 30, r.top + 10))
    header.dispatchEvent(mk('pointermove', r.left + 90, r.top + 50))
    header.dispatchEvent(mk('pointerup', r.left + 90, r.top + 50))
    const after = root.style.left
    const stored = localStorage.getItem('dsh-subagent-shield:widget:pos')
    return { before, after, stored: !!stored, moved: before !== after }
  })()`)
  check('★ 真浏览器里拖动真的生效并落盘', dragOk?.moved === true && dragOk?.stored === true, JSON.stringify(dragOk))

  const minOk = await evalJs(`(() => {
    const root = document.getElementById('dsh-subagent-shield-widget')
    if (!root) return { err: 'no-widget' }
    const header = root.children[0]
    // ⚠ 按**文字**找折叠箭头（雪佛龙），不要用 header.children[2] 下标 ——
    //   标题行里插一个状态块，下标就指到空白占位上了（踩过两次）。
    const btn = [...header.children].find((c) => /^[⌃⌄−▸]$/.test(String(c.textContent || '').trim()))
    if (!btn) return { err: 'no-collapse-button', kids: [...header.children].map((c) => String(c.textContent || '').trim()) }
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return {
      bodyHidden: root.children[1].style.display === 'none',
      remembered: localStorage.getItem('dsh-subagent-shield:widget:min'),
      arrowAfter: String(btn.textContent || '').trim(),
      chip: [...header.children].map((c) => String(c.textContent || '').trim()).filter((t) => /本次|已关闭/.test(t)).join(''),
    }
  })()`)
  check('★ 点折叠箭头真的收起并记住状态', minOk?.bodyHidden === true && minOk?.remembered === '1', JSON.stringify(minOk))
  check('★ 收起后箭头变 ⌄ 且标题栏显示状态（真浏览器）',
    minOk?.arrowAfter === '⌄' && /本次|已关闭/.test(String(minOk?.chip ?? '')), JSON.stringify(minOk))

  // ── 8. 设置页里的独立分区（只有完整版才有）
  //    两个坑，都踩过：
  //    ① 浮窗标题本身就是「🛡 信息隔断」→ 不摘掉它，任何"设置页里有信息隔断"的检索
  //       都是假阳性（display:none 不够，那种元素 innerText 会回落成 textContent）。
  //    ② 那个「设置」按钮**没有文字**，只有 aria-label="设置" → 按文字找永远找不到。
  const removed = await evalJs(`(() => { const w = document.getElementById('dsh-subagent-shield-widget'); if (w) { w.remove(); return true } return false })()`)
  check('设置页检查前已把浮窗节点摘掉（防文本检索假阳性）', removed === true)
  const clicked = await evalJs(`(() => {
    const el = [...document.querySelectorAll('[aria-label],[title]')]
      .find(n => /^\\s*设置\\s*$|^\\s*Settings\\s*$/i.test((n.getAttribute('aria-label')||n.getAttribute('title')||'').trim()))
    if (!el) return 'no-settings-button'
    el.click(); return el.tagName
  })()`)
  await new Promise((r) => setTimeout(r, 6000))
  const navText = String(await evalJs(`document.body.innerText || ''`))
  check('设置面板打开了', /通用设置|皮肤市场|内置插件/.test(navText),
    clicked === 'no-settings-button' ? '按 aria-label=设置 找不到按钮' : `点击了 <${clicked}>，正文 ${navText.length} 字符`)
  // 注意：沙箱 profile 是 DSH 出厂模板，**不含皮肤市场**（那是使用者的插件）。
  // 所以这里只验"信息隔断 出现在真正的设置导航里"（用 通用设置 证明这是设置导航），
  // "与皮肤市场同级"那条断言归「验收-只读.mjs」——它跑在真机上。
  check('★ 设置导航里有「信息隔断」独立分区（与「通用设置」同列）',
    /信息隔断/.test(navText) && /通用设置/.test(navText),
    navText.split('\n').map((s) => s.trim()).filter((l) => /通用设置|模型|内置插件|信息隔断/.test(l)).join(' | ').slice(0, 190))

  if (/信息隔断/.test(navText)) {
    const go = await evalJs(`(() => {
      const leaf = [...document.querySelectorAll('*')].filter(n => (n.innerText || '').trim() === '信息隔断' && n.children.length === 0)
      const el = leaf[0]
      if (!el) return 'no-section-entry'
      ;(el.closest('button,[role=button],a,li,[tabindex]') ?? el).click()
      return 'clicked'
    })()`)
    await new Promise((r) => setTimeout(r, 5000))
    const secText = String(await evalJs(`document.body.innerText || ''`))
    check('★ 分区页面能打开并渲染出控件', /总开关|按工作区|拦住|放行/.test(secText) && go === 'clicked',
      `正文 ${secText.length} 字符；样例：${secText.replace(/\n+/g, ' | ').slice(0, 200)}`)
    check('用词是「拦住 / 放行」', /拦住/.test(secText) && /放行/.test(secText))
  }

  // ── 9. 页面无未捕获异常
  const realErrors = pageErrors.filter((t) => !/favicon|ResizeObserver/i.test(t))
  check('页面无未捕获 JS 异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | ').slice(0, 200))
  check('无 console.error 输出', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ').slice(0, 200))
} catch (e) {
  if (String(e?.message) !== 'no-browser' && String(e?.message) !== 'no-dsh') check('测试本身出错', false, String(e?.stack ?? e).slice(0, 300))
} finally {
  try { if (ws) ws.close() } catch { }
  cleanup()
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + '─'.repeat(64))
console.log(`  共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
failed.forEach((f) => console.log(`    · ${f.title}  ${f.detail}`))
console.log(`  沙箱已清理: ${!existsSync(sandbox)}`)
console.log('='.repeat(64))
process.exit(failed.length ? 1 : 0)
