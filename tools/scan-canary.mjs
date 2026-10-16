#!/usr/bin/env node
/**
 * 扫标记：在所有会话记录里搜一个标记（或任意字符串），报出「谁提到过」。
 *
 * 会话记录是多帧 zstd，必须逐帧解码。
 *
 * 用法：node tools/scan-canary.mjs <标记> [DSH_HOME]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const mark = process.argv[2];
if (!mark) { console.error('用法：node tools/scan-canary.mjs <标记> [DSH_HOME]'); process.exit(2); }
const home = process.argv[3] || process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
const root = join(home, 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const decode = (p) => {
  const raw = readFileSync(p);
  const offs = []; let i = raw.indexOf(MAGIC, 0);
  while (i !== -1) { offs.push(i); i = raw.indexOf(MAGIC, i + 4); }
  let out = '';
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : raw.length;
    try { out += zlib.zstdDecompressSync(raw.subarray(offs[k], end)).toString('utf8'); } catch { }
  }
  return out;
};

let hitN = 0, scanned = 0;
if (!existsSync(root)) { console.error('找不到目录：' + root); process.exit(2); }
for (const cwdDir of readdirSync(root)) {
  let subs = []; try { subs = readdirSync(join(root, cwdDir)); } catch { continue; }
  for (const sid of subs) {
    const p = join(root, cwdDir, sid, 'session.v4.jsonl.zstd');
    if (!existsSync(p)) continue;
    scanned++;
    let t = ''; try { t = decode(p); } catch { continue; }
    if (!t.includes(mark)) continue;
    hitN++;
    const head = (t.match(/\{\"type\":\"session\"[^\n]*/) ?? [''])[0];
    const isSub = head.includes('subagent');
    const n = t.split(mark).length - 1;
    console.log('★ 命中 ' + sid.slice(0, 12) + '  ' + (isSub ? '子代理' : '父会话') + '  ' + n + ' 次');
  }
}
console.log('');
console.log('扫了 ' + scanned + ' 个会话，命中 ' + hitN + ' 个。');
if (hitN) {
  console.log('⚠ 命中只说明「这个字符串出现在这些会话里」，**不等于**它们读了诱饵文件 ——');
  console.log('  如果这个标记本来就写在你的任务提示词里，所有收到提示词的会话都会命中。');
  console.log('  请确认：该标记只在诱饵文件里出现过一次，且未进入任何 prompt/文件名。');
} else {
  console.log('⇒ 没人在记录里出现过这个标记。');
}
process.exit(hitN ? 1 : 0);
