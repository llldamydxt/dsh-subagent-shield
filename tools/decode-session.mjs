#!/usr/bin/env node
/**
 * 解出 DSH 会话记录（多帧 zstd）并按关键词检索。
 *
 * 为什么需要：会话记录是 `session.v4.jsonl.zstd`，**多帧**追加写 —— 一次工具调用一帧。
 * 用普通解压只出第一帧，会漏掉后面所有内容（我第一版就踩了这个坑：
 * 20.6 KB 的文件只解出 47 字符，还以为是"令牌没写进去"）。
 *
 * 用法：
 *   node decode-session.mjs <session.v4.jsonl.zstd>                 # 概览：帧数、行数、最后几条
 *   node decode-session.mjs <file> <关键词>                          # 检索关键词，只打印命中行
 *
 * 只读，不写任何东西。
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const [file, needle] = process.argv.slice(2)
if (!file) { console.error('用法: node decode-session.mjs <file.zstd> [关键词]'); process.exit(2) }

const raw = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 用 zstd 帧魔数切帧（比猜"消费了多少字节"可靠）。 */
function frames(buf) {
  const offs = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { offs.push(i); i = buf.indexOf(MAGIC, i + 4) }
  if (offs.length === 0) return [buf]
  const out = []
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    out.push(buf.subarray(offs[k], end))
  }
  return out
}

const decodeOne = (buf) => {
  try {
    return zlib.zstdDecompressSync(buf).toString('utf8')
  } catch (e) {
    // 有些帧可能带尾随字节，退一步用流式
    try {
      const s = zlib.createZstdDecompress()
      const chunks = []
      s.on('data', (d) => chunks.push(d))
      s.end(buf)
      return Buffer.concat(chunks).toString('utf8')
    } catch { return '' }
  }
}

let text = ''
const fr = frames(raw)
let okFrames = 0
for (const f of fr) {
  const t = decodeOne(f)
  if (t) okFrames++
  text += t
}

const lines = text.split('\n').filter(Boolean)
console.log(`文件: ${file}`)
console.log(`压缩 ${raw.length} 字节 → ${fr.length} 帧（解出 ${okFrames} 帧 / ${text.length} 字符 / ${lines.length} 条记录`)

if (needle) {
  const hits = lines.filter((l) => l.includes(needle))
  console.log(`检索 "${needle}"：命中 ${hits.length} 行`)
  for (const h of hits.slice(0, 10)) console.log('  ' + h.slice(0, 300))
} else {
  console.log('最后 3 条记录（截断到 240 字符）：')
  for (const l of lines.slice(-3)) console.log('  ' + l.slice(0, 240))
}
