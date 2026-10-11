/**
 * 诊断 test-ui 项数不稳定：跑 N 次，做**多重集**比较，找出哪条 check 的重复次数在变。
 * 用法: node _diag-count.mjs <test-ui.mjs 路径> [次数=4]
 */
import { execFileSync } from 'node:child_process'

const file = process.argv[2]
const times = Number(process.argv[3] ?? 4)
if (!file) { console.error('用法: node _diag-count.mjs <test-ui.mjs> [次数]'); process.exit(2) }

const runs = []
for (let i = 0; i < times; i++) {
  const out = execFileSync(process.execPath, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const total = Number((out.match(/共 (\d+) 项/) ?? [])[1])
  const titles = [...out.matchAll(/^\s+[✅❌]\s+\[U\d\]\s+(.*?)(?:\s+——|$)/gm)].map((m) => m[1].trim())
  runs.push({ total, titles })
  console.log(`  第 ${i + 1} 次: 共 ${total} 项，抓到 ${titles.length} 条标题`)
}

const key = (a) => {
  const m = new Map()
  for (const t of a) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}
const counts = runs.map((r) => key(r.titles))
const all = new Set(runs.flatMap((r) => r.titles))
console.log('\n  标题重复次数不一致的（这就是飘的来源）：')
let found = 0
for (const t of all) {
  const cs = counts.map((m) => m.get(t) ?? 0)
  if (new Set(cs).size > 1) { console.log(`    ${cs.join(' / ')}   ${t}`); found++ }
}
if (!found) {
  console.log('    （没有重复次数不一致的标题 —— 说明差异在标题抓取之外，看下面的总数）')
  console.log('    各次总数：' + runs.map((r) => r.total).join(' / '))
}

// 顺便看看是不是"标题重复出现"本身就存在
const dup = [...key(runs[0].titles)].filter(([, n]) => n > 1)
console.log(`\n  第 1 次里重复出现的标题（${dup.length} 条）：`)
for (const [t, n] of dup.slice(0, 12)) console.log(`    ×${n}  ${t}`)
