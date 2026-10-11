/**
 * 审计「子代理有没有读过被禁的东西」——靠**会话记录**，不靠自述。
 *
 * 为什么需要：实验自己的"与参考解相似度"只是**间接代理**；
 * 会话记录是**直接证据**（它读了哪个路径，会留在工具调用里）。
 *
 * 用法:
 *   node tools/audit-contamination.mjs <DSH_HOME> <实验根关键字> <起始ISO> <结束ISO>
 *
 * ★ 标记的选择（关键，否则全是假阳性）：实现单元的提示词里通常**只有目录名**
 *   （`tests` / `ref` / `work`）而**没有具体文件名**。所以下面这些只在"真读过"时才命中：
 *     taskId（若只在测试文件内容里出现）、ref_t0（若只在参考解文件名里出现）、
 *     具体产物文件名（自己的那个合法，对方的那个就是越界）。
 *   ⚠️ 判据是「这个串在**给它的指令里**出现过没有」——出现过就不能当标记。
 *   ⚠️ 换实验布局时，这三个默认标记要按同样思路换掉。
 *
 * 为什么不在 PowerShell 里做：PS 5.1 会把 node 的 UTF-8 输出按 GBK 解码，
 * 中文正则永远匹配不上（实测踩过，得到一堆假的 0）。**全程在 node 里解码+判定**最稳。
 *
 * 分类靠提示词签名（各角色的提示词开头是固定的）：
 *   实现工程师 / 隐藏测试作者 / 测试套件审计员 / 其它（宿主侧助手、父会话）
 *
 * ★ 越界标记的选择（关键，否则全是假阳性）：
 *   实现单元的提示词里**只有目录名**（`{根}/tests`、`{根}/ref`、`{根}/work`），
 *   没有任何具体文件名。所以下面这些只在"真读过"时才会出现：
 *     taskId    ← 只存在于 tests/test_tXX.js 的内容里
 *     ref_t0    ← 只存在于 ref/ref_tXX.js 的文件名里
 *     对方臂的产物名  ← 自己的那个合法，对方的那个就是越界
 *
 * 用法: node tools/audit-contamination.mjs <DSH_HOME> <实验根关键字> <起始ISO> <结束ISO>
 * 例:   node tools/audit-contamination.mjs "$env:DSH_HOME" "my-experiment" 2026-10-11T14:50:00Z 2026-10-11T15:20:00Z
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const [HOME, ROOT_KEY, FROM_S, TO_S] = process.argv.slice(2)
const FROM = Date.parse(FROM_S), TO = Date.parse(TO_S)
if (!HOME || !ROOT_KEY || !FROM_S || !TO_S) {
  console.error('用法: node tools/audit-contamination.mjs <DSH_HOME> <实验根关键字> <起始ISO> <结束ISO>')
  process.exit(2)
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const decode = (f) => {
  const raw = readFileSync(f)
  const offs = []
  let i = raw.indexOf(MAGIC, 0)
  while (i !== -1) { offs.push(i); i = raw.indexOf(MAGIC, i + 4) }
  let out = ''
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : raw.length
    try { out += zlib.zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8') } catch { }
  }
  return out
}
const count = (t, re) => (t.match(re) ?? []).length

const sessRoot = join(HOME, 'sessions')
const found = []
for (const cwdDir of readdirSync(sessRoot)) {
  let subs = []
  try { subs = readdirSync(join(sessRoot, cwdDir)) } catch { continue }
  for (const sid of subs) {
    const f = join(sessRoot, cwdDir, sid, 'session.v4.jsonl.zstd')
    let st = null
    try { st = statSync(f) } catch { continue }
    if (st.mtimeMs < FROM || st.mtimeMs > TO) continue
    let t = ''
    try { t = decode(f) } catch { continue }
    const head = (t.match(/\{"type":"session"[^\n]*/) ?? [''])[0]
    const isSub = head.includes('"origin":"subagent"')
    const role = t.includes('你是一名实现工程师') ? '实现工程师'
      : /你是「隐藏测试」作者/.test(t) ? '隐藏测试作者'
        : t.includes('测试套件审计员') ? '审计员'
          : isSub ? '其它子代理' : '父会话'
    found.push({
      sid: sid.slice(0, 8), role, isSub,
      time: new Date(st.mtimeMs).toISOString().slice(11, 19),
      taskId: count(t, /taskId/g), refFile: count(t, /ref_t0/g),
      a: count(t, /_A_r\d/g), b: count(t, /_B_r\d/g),
      impl: t.includes('你是一名实现工程师'),
      exp: t.includes(ROOT_KEY),
    })
  }
}

const exp = found.filter((r) => r.exp)
console.log(`\n  与「${ROOT_KEY}」相关的会话：${exp.length} 个`)
const byRole = {}
for (const r of exp) byRole[r.role] = (byRole[r.role] ?? 0) + 1
console.log('  角色分布：' + Object.entries(byRole).map(([k, v]) => `${k} ${v}`).join(' · '))

const impls = exp.filter((r) => r.impl)
console.log(`\n  ── 实现单元（${impls.length} 个）逐个体检 ──`)
console.log('  会话      时间      自己臂A 自己臂B 对方臂  taskId  ref_t0   判定')
let bad = 0
for (const r of impls.sort((x, y) => x.time.localeCompare(y.time))) {
  const otherArm = (r.a > 0 && r.b > 0) ? '有越界' : '—'
  const flags = []
  if (r.a > 0 && r.b > 0) flags.push('读了对方臂产物')
  if (r.taskId > 0) flags.push('读了测试文件')
  if (r.refFile > 0) flags.push('读了参考实现')
  if (flags.length) bad++
  console.log(`  ${r.sid}  ${r.time}  ${String(r.a).padStart(6)}  ${String(r.b).padStart(6)}  ${otherArm.padStart(6)}  ${String(r.taskId).padStart(6)}  ${String(r.refFile).padStart(6)}   ${flags.length ? '⚠ ' + flags.join(' / ') : '✅ 干净'}`)
}
console.log(`\n  ★ 实现单元里有越界迹象的：${bad} / ${impls.length}`)

console.log('\n  ── 非实现单元（合法接触 tests/ref/work 的角色）──')
for (const r of exp.filter((x) => !x.impl).sort((x, y) => x.time.localeCompare(y.time))) {
  console.log(`  ${r.sid}  ${r.time}  ${r.role.padEnd(12)} taskId=${r.taskId} ref=${r.refFile} A=${r.a} B=${r.b}`)
}
