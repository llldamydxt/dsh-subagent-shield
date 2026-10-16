#!/usr/bin/env node
/**
 * dsh-subagent-shield —— 爆炸半径测试（blast radius）
 *
 * 之前两套测试都是「正常路径」：确认功能对不对。这一套专门测**坏路径**：
 * 客户端半区出问题时，会不会把**整个 DSH** 拖垮？
 *
 *   B1 基线          完好的插件 → 宿主应当能启动
 *   B2 客户端语法错   lib/client.js 写坏 → 期望宿主仍能启动（客户端坏不该拖垮宿主）
 *   B3 客户端文件缺失 dsh.client 仍声明但文件没了 → 期望宿主仍能启动
 *   B4 注入不存在的模块 dsh.client.inject 指向不存在的包 → 期望宿主仍能启动
 *   B5 HTML 注入健壮性 多个/缺失/大小写不同的 </body> → 注入结果正确且不重复
 *   B6 小窗抗打击     localStorage 抛异常 / fetch 失败 → 不崩，仍挂载并显示错误
 *
 * 每个"启动"变体都在**独立沙箱 DSH_HOME** 里跑，绝不碰正在用的 DSH。
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, readdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
// 插件根自动识别，兼容两种布局：
//   ① 作者测试台：<台>\独立测试台\ + <台>\隔离插件\  ② git 仓库：<仓库>\test\ + <仓库>\lib\
const PLUGIN_SRC = existsSync(join(HERE, '..', '隔离插件', 'lib', 'index.js')) ? join(HERE, '..', '隔离插件') : join(HERE, '..')

function findDshBin() {
  const cands = []
  if (process.env.DSH_CHECKOUT) cands.push(join(process.env.DSH_CHECKOUT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const root of [process.env.DSH_NPX_CACHE, 'D:\\DSH\\npm-cache\\_npx', join(process.env.LOCALAPPDATA ?? '', 'npm-cache', '_npx')]) {
    if (!root || !existsSync(root)) continue
    for (const d of readdirSync(root)) cands.push(join(root, d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  cands.push(join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  return cands.find((p) => existsSync(p))
}
const DSH_BIN = process.env.DSH_BIN || findDshBin() || ''
const CHECKOUT = DSH_BIN ? dirname(dirname(dirname(dirname(dirname(DSH_BIN))))) : ''
const NODE_EXE = process.env.DSH_NODE || process.execPath

const results = []
const check = (layer, title, ok, detail = '') => {
  results.push({ layer, title, ok, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} [${layer}] ${title}${detail ? '  —— ' + detail : ''}`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const sandbox = join(tmpdir(), 'dsh-isolated-tests', 'blast-' + stamp)
const running = new Set()
const cleanup = () => {
  for (const pid of running) { try { spawnSync('cmd', ['/c', 'taskkill', '/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { } }
  // ⚠ 先拆 junction 再删树，否则递归删除会跟着删掉安装目录
  for (const j of [join(sandbox, 'home', 'profiles', 'node_modules')]) {
    try { if (existsSync(j)) spawnSync('cmd', ['/c', 'rmdir', j], { stdio: 'ignore' }) } catch { }
  }
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { }
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const waitPort = (port, ms) => new Promise((resolve) => {
  const deadline = Date.now() + ms
  const tick = () => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => { s.destroy(); Date.now() > deadline ? resolve(false) : setTimeout(tick, 400) })
  }
  tick()
})

/**
 * 用给定的一份「被改造过的插件目录」起一次沙箱实例，返回 {up, exited, err, out, firstErrLine}
 * @param {string} variantDir 已经准备好的插件目录
 * @param {number} port
 * @param {number} [waitMs] 等端口的最长时间（默认 60 秒；连跑多次启动时要留足）
 */
/**
 * 现取一个空闲的临时端口。
 *
 * 为什么不能用固定端口：上一次启动的实例若还占着那个端口，`waitPort()` 会**立刻**
 * 报告"端口通了"，而我们自己的子进程其实还没退出 —— 于是"起不来"的用例（B3）会假红。
 * 连跑多套测试时踩过一次，detail 还是空的，红得莫名其妙。
 */
function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(0))
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address()?.port ?? 0
      srv.close(() => resolve(p))
    })
  })
}

async function bootWith(variantDir, _preferredPort, waitMs = 60000) {
  const port = await freePort()
  if (!port) throw new Error('拿不到空闲端口')
  const prof = join(sandbox, 'home', 'profiles', 'testweb')
  const dest = join(prof, 'node_modules', 'dsh-subagent-shield')
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(join(prof, 'node_modules'), { recursive: true })
  spawnSync('cmd', ['/c', 'xcopy', variantDir, dest, '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })

  const outPath = join(sandbox, `out-${port}.log`)
  const errPath = join(sandbox, `err-${port}.log`)
  const outFd = openSync(outPath, 'w'), errFd = openSync(errPath, 'w')
  const env = { ...process.env, DSH_HOME: join(sandbox, 'home') }
  const child = spawn(NODE_EXE, [DSH_BIN, 'testweb', '--port', String(port), '--no-open'],
    { cwd: prof, env, stdio: ['ignore', outFd, errFd], windowsHide: true })
  running.add(child.pid)

  // "起来了"的判据不是"端口通"，而是**我们的子进程自己打印了带该端口的入口 URL** ——
  // 只有那一条能证明是这个子进程绑上的端口。
  const up = await (async () => {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return false
      try {
        if (existsSync(outPath) && readFileSync(outPath, 'utf8').includes(`:${port}/?token=`)) return true
      } catch { }
      await new Promise((r) => setTimeout(r, 400))
    }
    return false
  })()
  const exited = child.exitCode !== null
  closeSync(outFd); closeSync(errFd)
  try { child.kill() } catch { }
  spawnSync('cmd', ['/c', 'taskkill', '/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  running.delete(child.pid)
  await new Promise((r) => setTimeout(r, 500))
  const err = existsSync(errPath) ? readFileSync(errPath, 'utf8') : ''
  const out = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
  return {
    up: up && !exited,
    port,
    exited,
    err,
    out,
    firstErrLine: (err.split('\n').find((l) => /error|Cannot|disabling|invalid/i.test(l)) ?? '').trim().slice(0, 190),
  }
}

console.log('🐋 dsh-subagent-shield —— 爆炸半径测试')
console.log(`   插件: ${PLUGIN_SRC}`)
console.log(`   dsh : ${DSH_BIN}`)
console.log(`   沙箱: ${sandbox}\n`)

try {
  // ── 仅无头的两项先跑（不需要 DSH）
  console.log('── B5 HTML 注入健壮性（无头）')
  const hostSrc = readFileSync(join(PLUGIN_SRC, 'lib', 'index.js'), 'utf8')
  const unitDir = join(sandbox, 'unit')
  mkdirSync(join(unitDir, 'node_modules', '@deepseek-ai'), { recursive: true })
  spawnSync('cmd', ['/c', 'mklink', '/J', join(unitDir, 'node_modules', '@deepseek-ai', 'schemastery'),
    join(CHECKOUT, 'node_modules', '@deepseek-ai', 'schemastery')], { stdio: 'ignore' })
  spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, join(unitDir, 'node_modules', 'dsh-subagent-shield'), '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
  const hostMod = await import(`file:///${join(unitDir, 'node_modules', 'dsh-subagent-shield', 'lib', 'index.js').replace(/\\/g, '/')}`)
  const taps = []
  const childCtx = { webServer: { register: () => () => { }, tapIndex: (fn) => { taps.push(fn); return () => { } } }, on: () => () => { }, effect: (fn) => { fn(); return () => { } } }
  const hostCtx = { on: () => () => { }, commands: { register: () => () => { } }, inject: (d, cb) => { cb(childCtx); return () => { } } }
  const cfg = (o = {}) => ({ enabled: { get: () => true }, scope: { get: () => 'subagents' }, mode: { get: () => 'all' },
    dshHome: { get: () => join(sandbox, 'unit-home') }, auditFile: { get: () => '' }, protectSessions: { get: () => true },
    protectProjcache: { get: () => true }, protectCredentials: { get: () => true }, guardShellText: { get: () => true }, auditEnabled: { get: () => true } })
  hostMod.apply(hostCtx, cfg())
  const tap = taps[0]
  const SRC = '/dsh-subagent-shield/widget.js'
  const h1 = tap('<html><body>hi</body></html>')
  check('B5', '正常 HTML：注入一次且在 </body> 前', (String(h1).match(/widget\.js/g) || []).length === 1 && String(h1).indexOf(SRC) < String(h1).indexOf('</body>'))
  const h2 = tap(h1)
  check('B5', '重复注入是幂等的', h1 === h2)
  const h3 = tap('<html><body>x</body><div></body></html>')
  check('B5', '多个 </body>：仍只注入一次', (String(h3).match(/widget\.js/g) || []).length === 1)
  const h4 = tap('<html><body>no close tag')
  check('B5', '没有 </body>：退化为追加到末尾', String(h4).includes(SRC) && String(h4).endsWith('</script>'))
  const h5 = tap('<HTML><BODY>upper</BODY></HTML>')
  check('B5', '大写 </BODY>：不会重复注入也不会崩', (String(h5).match(/widget\.js/g) || []).length === 1, '追加到末尾属预期')
  check('B5', '非字符串输入原样返回（不崩）', tap(null) === null && tap(undefined) === undefined)

  console.log('\n── B6 小窗抗打击（无头）')
  const widgetSrc = readFileSync(join(PLUGIN_SRC, 'lib', 'widget.js'), 'utf8')
  const runWidget = (opts) => {
    const store = new Map()
    const byId = new Map()
    let body = null
    const mk = (tag) => {
      const n = { tagName: String(tag).toUpperCase(), id: '', textContent: '', children: [], style: {}, _ev: {},
        appendChild(c) { n.children.push(c); if (c.id) byId.set(c.id, c); return c },
        removeChild(c) { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); return c },
        get firstChild() { return n.children[0] ?? null },
        addEventListener(t, f) { (n._ev[t] = n._ev[t] || []).push(f) },
        setPointerCapture() { }, offsetWidth: 320, offsetHeight: 140 }
      return n
    }
    body = opts.bodyLater ? null : mk('body')
    const document = {
      readyState: 'complete', visibilityState: 'visible',
      // 用 getter：这样 bodyLater 模式下"稍后才有 body"能被脚本看到
      get body() { return body },
      createElement: (t) => mk(t), getElementById: (id) => byId.get(id) ?? null, addEventListener() { },
    }
    const localStorage = opts.throwOnLocalStorage
      ? { getItem() { throw new Error('quota') }, setItem() { throw new Error('quota') } }
      : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }
    const win = { innerWidth: 1280, innerHeight: 800, localStorage, addEventListener() { } }
    let threw = null
    try {
      new Function('window', 'document', 'localStorage', 'fetch', 'requestAnimationFrame', 'setInterval', 'clearInterval', 'console', widgetSrc)(
        win, document, localStorage, opts.fetch, (fn) => { fn() }, () => 1, () => { }, { warn() { } })
    } catch (e) { threw = e }
    return { threw, byId, document, get body() { return body }, lateBody() { body = mk('body'); return body } }
  }
  const okFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ config: { enabled: true, scope: 'subagents', mode: 'all' }, denied: { total: 0, windows: 0 }, recent: [] }) })
  const badFetch = () => Promise.reject(new Error('offline'))

  const r1 = runWidget({ fetch: okFetch, throwOnLocalStorage: false })
  check('B6', '正常情况：不抛错且挂载', r1.threw === null && r1.body.children.length === 2, `children=${r1.body.children.length}`)

  const r2 = runWidget({ fetch: okFetch, throwOnLocalStorage: true })
  check('B6', 'localStorage 抛异常：仍不崩且挂载', r2.threw === null && r2.body.children.length === 2)

  const r3 = runWidget({ fetch: badFetch, throwOnLocalStorage: false })
  await new Promise((r) => setTimeout(r, 30))
  const line3 = r3.body.children[0]?.children?.[1]?.children?.[1]?.textContent ?? ''
  check('B6', 'fetch 失败：不崩，并显示失败提示', r3.threw === null && String(line3).includes('失败'), String(line3).slice(0, 40))

  // ★ 回归：脚本跑时 body 还没就绪 → 必须重试，不能直接放弃（v3 的 bug）
  const r4 = runWidget({ fetch: okFetch, throwOnLocalStorage: false, bodyLater: true })
  check('B6', '★ body 未就绪：先不挂载，但也不崩', r4.threw === null && r4.document.getElementById('dsh-subagent-shield-widget') === null)
  r4.lateBody()
  await new Promise((r) => setTimeout(r, 700))
  check('B6', '★ body 就绪后会自动重试挂载', Boolean(r4.document.getElementById('dsh-subagent-shield-widget')), '最多等 15 秒')

  // ── 需要 DSH 的启动变体
  if (!DSH_BIN) {
    check('B1', '找到 dsh CLI', false, '未找到')
  } else {
    console.log('\n── B1 基线：完好插件（沙箱真启动）')
    const home = join(sandbox, 'home')
    mkdirSync(home, { recursive: true })
    const env = { ...process.env, DSH_HOME: home }
    const sc = spawnSync(NODE_EXE, [DSH_BIN, 'testweb', '--from-default-profile', 'web', '--dump-config'], { env, encoding: 'utf8', timeout: 120000 })
    check('B1', '沙箱脚手架出 profile', sc.status === 0, `exit=${sc.status}`)
    const fb = join(home, 'profiles', 'node_modules')
    spawnSync('cmd', ['/c', 'mklink', '/J', fb, join(CHECKOUT, 'node_modules')], { stdio: 'ignore' })
    writeFileSync(join(home, 'profiles', 'testweb', 'cordis.patch.yml'),
      '# blast test patch\n- insert:\n    - id: dsh-subagent-shield\n      name: dsh-subagent-shield\n', 'utf8')

    const r = await bootWith(PLUGIN_SRC, 3099)
    check('B1', '完好插件：宿主能启动', r.up, r.firstErrLine)

    // B2：客户端语法错
    console.log('\n── B2 lib/client.js 写坏（语法错）')
    const v2 = join(sandbox, 'v2')
    spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, v2, '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
    writeFileSync(join(v2, 'lib', 'client.js'), readFileSync(join(v2, 'lib', 'client.js'), 'utf8') + '\nthis is not valid javascript !!!\n', 'utf8')
    const r2b = await bootWith(v2, 3098)
    check('B2', '客户端语法错：宿主仍能启动（客户端坏不该拖垮宿主）', r2b.up, r2b.firstErrLine)

    // B3：客户端文件缺失
    console.log('\n── B3 lib/client.js 缺失（dsh.client 仍声明）')
    const v3 = join(sandbox, 'v3')
    spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, v3, '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
    rmSync(join(v3, 'lib', 'client.js'), { force: true })
    const r3b = await bootWith(v3, 3097)
    // 这是「特征化测试」：把 DSH 的既有行为钉下来 —— 声明了 dsh.client 却缺文件时，
    // 宿主会在客户端合成阶段失败、直接起不来。所以安装器必须拦（见 B7）。
    check('B3', '【已知风险已确认】缺客户端文件会让宿主合成失败 → 必须由安装器兜底拦截', !r3b.up,
      r3b.up
        ? `意外启动了（port=${r3b.port}）out尾=${r3b.out.trim().split('\n').slice(-2).join(' | ').slice(0, 140)}`
        : r3b.firstErrLine)

    // B4：注入不存在的模块
    console.log('\n── B4 dsh.client.inject 指向不存在的模块')
    const v4 = join(sandbox, 'v4')
    spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, v4, '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
    const pj = JSON.parse(readFileSync(join(v4, 'package.json'), 'utf8'))
    pj.dsh.client.inject = ['@deepseek-ai/definitely-not-installed']
    writeFileSync(join(v4, 'package.json'), JSON.stringify(pj, null, 2), 'utf8')
    const r4b = await bootWith(v4, 3096)
    check('B4', '注入不存在的模块：宿主仍能启动', r4b.up, r4b.firstErrLine)

    // ── B7/B8：安装器的 fail-closed 与正向路径
    console.log('\n── B7 安装器对「缺客户端文件」的包必须 fail closed')
    // 安装器目录**自动识别两种布局**：<台>\安装隔离插件\ 或 <仓库>\tools\。
    // 为什么要这样：同一份测试文件要在两处都能跑。写死任一种，另一边就要手工改，
    // 而"手工改过的那份被覆盖"已经漂移过三次了（PLUGIN_SRC / installerSrc / B7 沙箱）。
    const installerSrc = existsSync(join(HERE, '..', '安装隔离插件', 'install-shield.ps1'))
      ? join(HERE, '..', '安装隔离插件')
      : join(HERE, '..', 'tools')
    const instSandbox = join(sandbox, 'inst-bad')
    // 自己造一个「分发包布局」的沙箱：<沙箱>\install-shield.ps1 + <沙箱>\plugin\…
    // 这样无论安装器脚本来自哪种布局，它都能用同一套自动判断找到插件源。
    mkdirSync(instSandbox, { recursive: true })
    copyFileSync(join(installerSrc, 'install-shield.ps1'), join(instSandbox, 'install-shield.ps1'))
    spawnSync('cmd', ['/c', 'xcopy', PLUGIN_SRC, join(instSandbox, 'plugin'), '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
    rmSync(join(instSandbox, 'plugin', 'lib', 'client.js'), { force: true })
    const patchPath = join(home, 'profiles', 'testweb', 'cordis.patch.yml')
    // 先清场：把前面启动测试留下的插件目录删掉，这样"是否被坏安装器新建"才测得准
    const victimDir = join(home, 'profiles', 'testweb', 'node_modules', 'dsh-subagent-shield')
    rmSync(victimDir, { recursive: true, force: true })
    writeFileSync(patchPath, '# untouched-by-test\n[]\n', 'utf8')
    const before = readFileSync(patchPath, 'utf8')
    const badRun = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(instSandbox, 'install-shield.ps1'), '-DshHome', home, '-Profile', 'testweb'], { encoding: 'utf8', timeout: 120000 })
    const after = readFileSync(patchPath, 'utf8')
    check('B7', '安装器拒绝安装（exit ≠ 0）', badRun.status !== 0, `exit=${badRun.status}`)
    check('B7', '拒绝后 profile 补丁一个字节没动', before === after)
    check('B7', '拒绝理由点明是客户端文件缺失', /dsh\.client[\s\S]{0,80}不存在|客户端半区[\s\S]{0,80}不存在/.test(String(badRun.stdout ?? '')),
      (String(badRun.stdout ?? '').split('\n').find((l) => /不存在|dsh\.client/.test(l)) ?? '').trim().slice(0, 120))
    check('B7', '没有把残缺的插件留在 profile 里', !existsSync(join(home, 'profiles', 'testweb', 'node_modules', 'dsh-subagent-shield')))

    console.log('\n── B8 安装器对完好包正常安装（顺带测 [] 模板分支）')
    const goodRun = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(installerSrc, 'install-shield.ps1'), '-DshHome', home, '-Profile', 'testweb'], { encoding: 'utf8', timeout: 180000 })
    check('B8', '安装成功（exit 0）', goodRun.status === 0, `exit=${goodRun.status}`)
    check('B8', '自验两项都过', /✅ 包解析通过/.test(String(goodRun.stdout)) && /✅ 配置合成通过/.test(String(goodRun.stdout)))
    check('B8', '客户端文件确实落地', existsSync(join(home, 'profiles', 'testweb', 'node_modules', 'dsh-subagent-shield', 'lib', 'client.js')))
    check('B8', '补丁从 [] 被正确改写成 insert', /- insert:/.test(readFileSync(patchPath, 'utf8')) && !/^\[\]$/m.test(readFileSync(patchPath, 'utf8')))

    // ── B9：-NoUI 模式。这是"消灭灾难类故障"的验证：
    //    剥掉客户端半区之后，仍然必须能启动、小窗仍在。
    console.log('\n── B9 安装器 -NoUI：剥掉客户端半区后仍能启动、小窗仍在')
    const noUiRun = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(installerSrc, 'install-shield.ps1'), '-DshHome', home, '-Profile', 'testweb', '-NoUI'], { encoding: 'utf8', timeout: 180000 })
    check('B9', '安装成功（exit 0）', noUiRun.status === 0, `exit=${noUiRun.status}`)
    const instDir = join(home, 'profiles', 'testweb', 'node_modules', 'dsh-subagent-shield')
    let pj2 = null
    try { pj2 = JSON.parse(readFileSync(join(instDir, 'package.json'), 'utf8')) } catch { }
    check('B9', '装机后的 package.json 不再声明 dsh.client', Boolean(pj2) && !(pj2.dsh && pj2.dsh.client),
      JSON.stringify(pj2 && pj2.dsh))
    check('B9', 'exports 里不再有 ./client', Boolean(pj2) && !(pj2.exports && pj2.exports['./client']))
    check('B9', 'lib/client.js 已删除', !existsSync(join(instDir, 'lib', 'client.js')))
    check('B9', '宿主半区与小窗都保留', existsSync(join(instDir, 'lib', 'index.js')) && existsSync(join(instDir, 'lib', 'widget.js')))
    check('B9', '安装器自验报了 NoUI 剥离通过', /NoUI 剥离通过/.test(String(noUiRun.stdout ?? '')))
    const v9 = join(sandbox, 'v9-noUi')
    spawnSync('cmd', ['/c', 'xcopy', instDir, v9, '/E', '/I', '/Q', '/Y'], { stdio: 'ignore' })
    // 这一跳前面已经连跑 8 次启动，给足等待时间（90 秒），否则会偶发假失败
    const r9 = await bootWith(v9, 3095, 90000)
    check('B9', '★ 剥掉客户端半区后仍能启动（这正是要消灭的灾难类）', r9.up,
      r9.up ? '' : `exited=${r9.exited} err=${r9.firstErrLine} out尾=${r9.out.trim().split('\n').slice(-2).join(' | ').slice(0, 150)}`)
    check('B9', '★ 宿主半区挂载 + 接口就绪（小窗仍可用）',
      r9.out.includes('[subagent-shield] 已挂载') && r9.out.includes('接口就绪'),
      r9.out.split('\n').filter((l) => l.includes('subagent-shield')).join(' | ').slice(0, 200))
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
