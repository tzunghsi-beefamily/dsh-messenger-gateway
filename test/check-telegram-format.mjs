/**
 * Offline checks for outgoing text preparation.
 *
 * The plugin's own replies are written in Telegram HTML while LLM replies are
 * Markdown; `prepareTelegramText` must pass the former through untouched and
 * convert only the latter.
 *
 *   node test/check-telegram-format.mjs
 */
import assert from 'node:assert/strict'
import { markdownToTelegramHtml, prepareTelegramText } from '../lib/telegram-format.js'
import { HELP_TEXT } from '../lib/commands.js'

let pass = 0
const ok = (label, condition) => {
  if (condition) {
    pass += 1
    console.log(`  ✅ ${label}`)
  } else {
    console.error(`  ❌ ${label}`)
    process.exitCode = 1
  }
}

/* our own HTML must survive ------------------------------------------------ */
const sessions = ['📋 最近的 2 條 session', '<b>1.</b> 我的對話', '    <code>msgw-abc</code> · Telegram'].join('\n')
const prepared = prepareTelegramText(sessions, 'html')
ok('HTML 回覆直送(不轉義)', prepared.text === sessions && prepared.parseMode === 'HTML')
ok('HTML 回覆不會出現 &lt;b&gt;', !prepared.text.includes('&lt;b&gt;'))

const help = typeof HELP_TEXT === 'string' ? HELP_TEXT : HELP_TEXT.join('\n')
ok('/help 的 HTML 直送', prepareTelegramText(help, 'html').text === help)

/* Markdown from the model is still converted ------------------------------ */
const md = prepareTelegramText('**bold** and `code` and *italic*', 'html')
ok('Markdown 粗體轉為 <b>', md.text.includes('<b>bold</b>'))
ok('Markdown 行內程式碼轉為 <code>', md.text.includes('<code>code</code>'))
ok('Markdown 斜體轉為 <i>', md.text.includes('<i>italic</i>'))
ok('Markdown 仍帶 parseMode', md.parseMode === 'HTML')
ok('Markdown 管線仍會轉義 HTML', markdownToTelegramHtml('a <b> b').includes('&lt;b&gt;'))

/* plain mode --------------------------------------------------------------- */
const plain = prepareTelegramText('<b>x</b>', 'plain')
ok('plain 模式不加 parseMode', plain.parseMode === undefined && plain.text === '<b>x</b>')

/* entities the plugin writes on purpose ----------------------------------- */
const entity = prepareTelegramText('<code>&lt;編號&gt;</code>', 'html')
ok('刻意寫的 &lt; 不會被二次轉義', entity.text === '<code>&lt;編號&gt;</code>')

/* empty ------------------------------------------------------------------- */
ok('空字串不加 parseMode', prepareTelegramText('', 'html').parseMode === undefined)

/* unknown tags are still escaped (not sent as markup) --------------------- */
const unknown = prepareTelegramText('see <div>hello</div>', 'html')
ok('不認識的標籤仍會被轉義', unknown.text.includes('&lt;div&gt;'))

console.log(`\n${pass} 項通過${process.exitCode ? '(有失敗)' : ''}`)
assert.ok(pass >= 12, 'expected at least 12 checks')
