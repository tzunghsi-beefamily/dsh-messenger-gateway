/**
 * Read a DSH session log (zstd JSONL). The file is a concatenation of zstd
 * frames, so scan for each frame's magic and decode them individually.
 *   node gw-test/read-session.mjs <session.v4.jsonl.zstd> [tailLines]
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const file = process.argv[2]
const tail = Number(process.argv[3] || 18)
if (!file) {
  console.log('usage: node read-session.mjs <session log> [tailLines]')
  process.exit(2)
}
const buf = readFileSync(file)
console.log('檔案大小:', buf.length, 'bytes')

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
let at = buf.indexOf(MAGIC)
while (at !== -1) {
  starts.push(at)
  at = buf.indexOf(MAGIC, at + 4)
}
console.log('偵測到 zstd frame 數:', starts.length)

const parts = []
let failed = 0
for (let i = 0; i < starts.length; i++) {
  const slice = buf.subarray(starts[i], starts[i + 1] ?? buf.length)
  try {
    parts.push(zlib.zstdDecompressSync(slice).toString('utf8'))
  } catch (err) {
    failed++
    if (failed <= 3) console.log(`  frame ${i} 解壓失敗: ${err.message}`)
  }
}
const text = parts.join('')
console.log('解出字元數:', text.length, failed ? `(失敗 frame: ${failed})` : '')

const lines = text.split('\n').filter((l) => l.trim())
console.log('事件行數:', lines.length)
console.log(`--- 最後 ${tail} 筆 ---`)
for (const line of lines.slice(-tail)) {
  let out = line
  try {
    const ev = JSON.parse(line)
    const type = ev.type ?? ev.event ?? Object.keys(ev).slice(0, 3).join('/')
    const s = JSON.stringify(ev)
    out = `${type}  ::  ${s.length > 420 ? `${s.slice(0, 420)}…` : s}`
  } catch {
    out = line.length > 420 ? `${line.slice(0, 420)}…` : line
  }
  console.log('-', out)
}

const errLines = lines.filter((l) => /"error"|failed|exception|refused|quota|unauthor|429|invalid_request|no model/i.test(l))
console.log(`--- 疑似錯誤的事件(${errLines.length})---`)
for (const line of errLines.slice(-8)) {
  console.log('!', line.length > 420 ? `${line.slice(0, 420)}…` : line)
}
