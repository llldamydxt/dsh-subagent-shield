/**
 * 测试台共用：可移植的环境探测。
 *
 * 为什么需要：这些测试原本写死在作者机器上（npx 缓存路径、node.exe 路径、
 * 某个具体的 DSH_HOME），换台机器就跑不起来。这个模块把它们变成"自动探测 +
 * 环境变量覆盖"。想固定指定时用：
 *
 *   DSH_CHECKOUT   一个含 node_modules/@deepseek-ai/{dsh,schemastery} 的目录
 *   DSH_BIN        dsh 的 lib/bin.js 绝对路径
 *   DSH_NODE       用来跑子进程的 node.exe
 *   DSH_HOME       单元测试里当"受保护根"的字符串样例（只做字符串，不读写）
 *   DSH_NPX_CACHE  额外的 npx 缓存根目录
 *   DSH_BROWSER    Edge/Chrome 可执行文件（真浏览器测试用）
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 跑子进程用的 node：默认就用当前这个，避免"机器上装了另一个 node 才能跑"这种依赖。 */
export function nodeExe() {
  return process.env.DSH_NODE || process.execPath
}

/** 可能的 npm / npx 缓存根目录（含 npx 的 `_npx` 子目录）。 */
function cacheRoots() {
  const out = []
  if (process.env.DSH_NPX_CACHE) out.push(process.env.DSH_NPX_CACHE)
  if (process.env.npm_config_cache) out.push(process.env.npm_config_cache)
  if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'npm-cache'))
  if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'npm-cache'))
  const home = process.env.HOME || process.env.USERPROFILE
  if (home) out.push(join(home, '.npm'))
  return out
}

const hasSchemastery = (root) => Boolean(root) && existsSync(join(root, 'node_modules', '@deepseek-ai', 'schemastery'))
const hasDsh = (root) => Boolean(root) && existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))

/** `_npx` 下每一个包缓存目录（npx 每次调用会新建一个哈希目录）。 */
function npxEntries() {
  const out = []
  for (const cache of cacheRoots()) {
    const npx = join(cache, '_npx')
    if (!existsSync(npx)) continue
    let names = []
    try { names = readdirSync(npx) } catch { continue }
    for (const name of names) out.push(join(npx, name))
  }
  return out
}

/**
 * 找一个"根目录"，其 `node_modules/@deepseek-ai` 下同时有 dsh 与 schemastery。
 * 找不到就返回空串 —— 调用方应当**明确报出来**，而不是猜一个不存在的路径。
 */
export function findCheckout() {
  if (hasSchemastery(process.env.DSH_CHECKOUT)) return process.env.DSH_CHECKOUT
  const cands = [...npxEntries()]
  // 全局安装前缀：<prefix>/npm 里是 node_modules
  if (process.env.APPDATA) cands.push(join(process.env.APPDATA, 'npm'))
  if (process.env.npm_config_prefix) cands.push(process.env.npm_config_prefix)
  return cands.find(hasSchemastery) || ''
}

/** dsh CLI 的 bin.js 绝对路径。 */
export function findDshBin() {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN
  const roots = []
  const c = findCheckout()
  if (c) roots.push(c)
  roots.push(...npxEntries())
  if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm'))
  if (process.env.npm_config_prefix) roots.push(process.env.npm_config_prefix)
  for (const r of roots) {
    const bin = join(r, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(bin)) return bin
  }
  return ''
}

/** 从 bin.js 反推 checkout 根（bin 在 <root>/node_modules/@deepseek-ai/dsh/lib/bin.js）。 */
export function checkoutOfBin(bin) {
  if (!bin) return ''
  const parts = bin.replace(/\\/g, '/').split('/')
  const i = parts.lastIndexOf('node_modules')
  return i > 0 ? parts.slice(0, i).join('\\') : ''
}

/**
 * 单元测试里当"受保护根"用的样例路径 —— **只作为字符串**参与路径解析，不读写。
 * 优先取真实的 DSH_HOME（更贴近实际），否则用一个中性的示例路径。
 */
export function sampleHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const home = process.env.USERPROFILE || process.env.HOME
  return home ? join(home, '.dsh') : 'C:\\Users\\example\\.dsh'
}
