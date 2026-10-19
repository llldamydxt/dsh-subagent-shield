#!/usr/bin/env node
/**
 * serve-to-vm.mjs —— 把宿主的一个目录挂成**只读** HTTP，供虚拟机通过 NAT 取文件。
 *
 * 为什么需要它（见 docs/绝对隔离验收单.md）：
 *   绝对隔离的前提是"宿主与客体之间没有文件通道"（不开共享文件夹）。
 *   但实验的**输入**还是要送进去 —— 就用这一条单向通道：
 *   宿主 `127.0.0.1:<port>`  ← VirtualBox NAT →  客体 `10.0.2.2:<port>`
 *
 * 安全性：
 *   · 只监听 **127.0.0.1**（外面和局域网都访问不到；只有 NAT 的 10.0.2.2 能映射进来）
 *   · **只读**：只实现 GET/HEAD，没有任何写入/上传端点
 *   · 只服务 -Dir 这一层（不做目录穿越）
 *
 * 用法：
 *   node tools/serve-to-vm.mjs -Dir "C:\path\to\input" [-Port 8899]
 *   客体里取：  wget -O input.zip http://10.0.2.2:8899/input.zip
 */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  const alt = argv.find((a) => a.startsWith(name + '='))
  if (alt) return alt.slice(name.length + 1)
  return dflt
}

const dir = argOf('-Dir', '')
const port = Number(argOf('-Port', '8899'))

if (!dir) {
  console.error('用法: node tools/serve-to-vm.mjs -Dir <目录> [-Port 8899]')
  process.exit(2)
}
let rootDir = ''
try { rootDir = statSync(dir).isDirectory() ? normalize(dir) : '' } catch { }
if (!rootDir) { console.error('不是目录: ' + dir); process.exit(2) }

const TYPES = {
  '.zip': 'application/zip', '.tgz': 'application/gzip', '.gz': 'application/gzip',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.sh': 'text/x-shellscript; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.iso': 'application/octet-stream',
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' })
    return res.end('只读\n')
  }
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  const target = normalize(join(rootDir, url === '/' ? '' : url))
  // 目录穿越防护
  if (!(target === rootDir || target.startsWith(rootDir + sep))) {
    res.writeHead(403); return res.end('不在服务目录内\n')
  }
  let st = null
  try { st = statSync(target) } catch { }
  if (!st || !st.isFile()) { res.writeHead(404); return res.end('没有这个文件\n') }
  const ext = (target.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase()
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') return res.end()
  const body = readFileSync(target)
  console.log('  GET ' + url + '  (' + Math.round(body.length / 1024) + ' KB)')
  res.end(body)
})

server.listen(port, '127.0.0.1', () => {
  console.log('只读文件服务已启动')
  console.log('  宿主:      http://127.0.0.1:' + port + '/')
  console.log('  客体里用:  http://10.0.2.2:' + port + '/<文件名>   （VirtualBox NAT）')
  console.log('  服务目录:  ' + rootDir)
  console.log('  只读：只有 GET/HEAD；Ctrl+C 关闭')
})
