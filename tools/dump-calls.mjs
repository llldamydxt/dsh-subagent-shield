/**
 * 抽出一个会话里**每一次工具调用**的名称与关键参数（路径/命令），用于污染取证。
 * 用法: node dump-calls.mjs <DSH_HOME> <会话id前缀>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const [HOME, pre] = process.argv.slice(2)
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

const sessRoot = join(HOME, 'sessions')
let hit = null
for (const cwdDir of readdirSync(sessRoot)) {
  let subs = []
  try { subs = readdirSync(join(sessRoot, cwdDir)) } catch { continue }
  const s = subs.find((x) => x.startsWith(pre))
  if (s) { hit = join(sessRoot, cwdDir, s, 'session.v4.jsonl.zstd'); break }
}
if (!hit) { console.log('  没找到'); process.exit(0) }
const t = decode(hit)

// 工具调用一般形如 {"type":"tool/call",...,"name":"read","arguments":{...}}
const seen = new Map()
for (const line of t.split('\n')) {
  if (!/"type":"tool\//.test(line)) continue
  let j = null
  try { j = JSON.parse(line) } catch { continue }
  const name = j.name ?? j.data?.name ?? j.tool ?? '(?)'
  const args = j.arguments ?? j.data?.arguments ?? j.input ?? {}
  const key = JSON.stringify(args).slice(0, 300)
  const k = `${name} ${key}`
  seen.set(k, (seen.get(k) ?? 0) + 1)
}
console.log(`\n  会话 ${pre} 的工具调用（去重后 ${seen.size} 类）:`)
for (const [k, n] of seen) console.log(`    ×${n}  ${k}`)

// 命中"别的单元产物名"的上下文行
const lines = t.split('\n').filter((l) => /_A_r\d|_B_r\d/.test(l))
console.log(`\n  含产物文件名的记录 ${lines.length} 条，前 6 条的类型与片段：`)
for (const l of lines.slice(0, 6)) {
  const type = (l.match(/"type":"([^"]+)"/) ?? [])[1] ?? '?'
  const names = [...new Set((l.match(/t0\d_[AB]_r\d\.js/g) ?? []))]
  console.log(`    [${type}] 文件名 ${names.length} 个: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ' …' : ''}`)
}
