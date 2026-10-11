#!/usr/bin/env node
/**
 * 揪出**不稳定的检查**：把同一个测试文件跑 N 次，做**多重集**比较，
 * 报出「哪些 check 不是每次都跑 / 每次都过」。
 *
 * 为什么需要它：一个测试套件"全绿"可能有两种含义 ——
 *   ① 所有断言都跑了并且都过；
 *   ② 某些断言因为环境/时序**根本没跑**，而总数悄悄变少，套件依然全绿。
 * 只看最后那行"共 N 项"是分辨不出来的 —— 得比较**两次运行之间的项数是否固定**。
 * 本工具就是干这个的（它当初抓出了 test-ui 的"令牌抢跑 → 静默降级成弱检查"
 * 和 test-browser 的"固定 sleep → 偶发假红"）。
 *
 * 用法:
 *   node tools/diag-count.mjs test/test-ui.mjs [次数=4]
 *
 * 判读:
 *   · 每次总数不一致        → 有检查被静默跳过（最危险）
 *   · 某条标题重复次数不一致 → 循环里的检查跑的次数在变
 *   · 出现 ❌ 而其他次没有   → 偶发假红（时序问题）
 */
import { execFileSync } from 'node:child_process'

const file = process.argv[2]
const times = Number(process.argv[3] ?? 4)
if (!file) {
  console.error('用法: node tools/diag-count.mjs <测试文件.mjs> [次数=4]')
  process.exit(2)
}

const runs = []
for (let i = 0; i < times; i++) {
  let out = ''
  try {
    out = execFileSync(process.execPath, [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')   // 失败的那次也要看
  }
  const total = Number((out.match(/共 (\d+) 项/) ?? [])[1])
  const failed = Number((out.match(/失败 (\d+)/) ?? [])[1] ?? 0)
  const titles = [...out.matchAll(/^\s+[✅❌]\s+(?:\[[A-Z]\d\]\s+)?(.*?)(?:\s+——|$)/gm)].map((m) => m[1].trim())
  runs.push({ total, failed, titles })
  console.log(`  第 ${i + 1} 次: 共 ${total} 项，失败 ${failed}，抓到 ${titles.length} 条标题`)
}

const multiset = (a) => {
  const m = new Map()
  for (const t of a) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}
const counts = runs.map((r) => multiset(r.titles))
const all = new Set(runs.flatMap((r) => r.titles))

console.log('')
const totals = runs.map((r) => r.total)
if (new Set(totals).size > 1) {
  console.log(`  ❌ 项数不稳定：${totals.join(' / ')} —— 有检查被静默跳过`)
} else {
  console.log(`  ✅ 项数稳定：${totals[0]} 项 × ${runs.length} 次`)
}

const varies = []
for (const t of all) {
  const cs = counts.map((m) => m.get(t) ?? 0)
  if (new Set(cs).size > 1) varies.push([cs, t])
}
if (varies.length) {
  console.log('\n  重复次数不一致的检查：')
  for (const [cs, t] of varies) console.log(`    ${cs.join(' / ')}   ${t}`)
}
if (runs.some((r) => r.failed > 0)) {
  console.log('\n  有失败的运行 —— 若其他次通过，就是**偶发假红**（时序问题，别当功能坏了）')
}
if (!varies.length && new Set(totals).size === 1 && !runs.some((r) => r.failed > 0)) {
  console.log('\n  ✅ 未发现不稳定迹象')
}
