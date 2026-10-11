#!/usr/bin/env node
/**
 * 打印一个会话记录的**头部字段**（id / origin / parentSession / delegationDepth / cwd）。
 *
 * 用途：审计时判断"这到底是哪个臂的会话、它的父窗口是谁"。
 * 特别是判断"一臂一窗口"还是"一窗口两子代理" —— 后者两个子代理的 parentSession 相同，
 * 于是基于窗口的归属隔离**无法区分它们**。
 *
 * 用法: node dump-header.mjs <session.v4.jsonl.zstd>
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const f = process.argv[2]
if (!f) { console.error('用法: node dump-header.mjs <session.v4.jsonl.zstd>'); process.exit(2) }

const raw = readFileSync(f)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offs = []
let i = raw.indexOf(MAGIC, 0)
while (i !== -1) { offs.push(i); i = raw.indexOf(MAGIC, i + 4) }

// 只需要第一条记录（会话头），但个别文件第一帧可能是空的 → 多解几帧再看
let out = ''
for (let k = 0; k < Math.min(offs.length, 4); k++) {
  const end = k + 1 < offs.length ? offs[k + 1] : raw.length
  try { out += zlib.zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8') } catch { }
}

const lines = out.split('\n').filter(Boolean)
for (const l of lines) {
  let j = null
  try { j = JSON.parse(l) } catch { continue }
  if (j?.type !== 'session') continue
  const pick = {}
  for (const k of ['id', 'origin', 'parentSession', 'delegationDepth', 'cwd', 'createdAt']) {
    if (j[k] !== undefined) pick[k] = j[k]
  }
  console.log(JSON.stringify(pick, null, 1))
  process.exit(0)
}
console.log('（前 4 帧里没有 type=session 的记录）')
console.log('第一条原始内容：' + String(lines[0] ?? '').slice(0, 300))
