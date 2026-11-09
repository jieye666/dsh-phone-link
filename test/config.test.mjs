/**
 * config.js 的纯函数 + 落盘行为单测。
 * 先把 USERPROFILE 指到临时目录再 import —— 否则会读写真实的 ~/.dsh/phone-link。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'phone-link-config-'))
process.env.USERPROFILE = home
process.env.HOME = home

const { CONFIG, DEFAULTS, DIR, bareId, canonicalSessionId, readConfig, trace, writeConfig } = await import('../lib/config.js')

test('canonicalSessionId：裸 id 补 session- 前缀，已规范的保持不变', () => {
  assert.equal(canonicalSessionId('2e306081-f24f-467c'), 'session-2e306081-f24f-467c')
  assert.equal(canonicalSessionId('session-2e306081'), 'session-2e306081')
  assert.equal(canonicalSessionId('lark-link:abc'), 'lark-link:abc')
  assert.equal(canonicalSessionId('  '), '')
  assert.equal(canonicalSessionId(undefined), '')
})

test('bareId：去掉 session- 前缀', () => {
  assert.equal(bareId('session-abc'), 'abc')
  assert.equal(bareId('abc'), 'abc')
  assert.equal(bareId(null), '')
})

test('配置不存在时给默认值（含 defaultChat，enabled=false）', () => {
  const { config, error } = readConfig()
  assert.equal(error, null)
  assert.equal(config.enabled, false)
  assert.equal(config.pollSeconds, DEFAULTS.pollSeconds)
  // 仓库里不写死真实 chat id：默认空字符串，用户自己在 config.json 填 oc_ 开头的
  assert.equal(typeof config.defaultChat, 'string')
  assert.deepEqual(config.bindings, [])
})

test('坏 JSON：备份成 .bad 并退回默认值，不抛', () => {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(CONFIG, '{ 这不是 json', 'utf8')
  const { config, error } = readConfig()
  assert.ok(error, '必须把原因带出来，面板要显示')
  assert.equal(config.enabled, false)
  assert.ok(existsSync(`${CONFIG}.bad`), '原件要留证据')
  writeFileSync(CONFIG, JSON.stringify({ enabled: true, bindings: [] }), 'utf8')
})

test('bindings 不是数组时兜底成空数组（配置被手改坏也不崩）', () => {
  writeFileSync(CONFIG, JSON.stringify({ enabled: true, bindings: 'oops' }), 'utf8')
  const { config } = readConfig()
  assert.deepEqual(config.bindings, [])
})

test('写盘是原子的：不留 .tmp，内容可解析', () => {
  writeConfig({ enabled: true, bindings: [{ chatId: 'oc_a', sessionId: 'session-a' }] })
  const parsed = JSON.parse(readFileSync(CONFIG, 'utf8'))
  assert.equal(parsed.bindings[0].sessionId, 'session-a')
  const leftovers = readdirSync(DIR).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('trace 追加一行到 boot.log', () => {
  trace('unit-test-marker')
  const text = readFileSync(join(DIR, 'boot.log'), 'utf8')
  assert.match(text, /unit-test-marker/)
})

test('cursorFile：一个聊天一个文件，chatId 里的怪字符被替换掉', async () => {
  const { cursorFile, CURSOR_DIR } = await import('../lib/config.js')
  assert.ok(cursorFile('oc_abc').startsWith(CURSOR_DIR))
  assert.match(cursorFile('oc_abc'), /oc_abc\.json$/)
  const weird = cursorFile('oc/../x')
  assert.ok(!weird.includes('..') && !weird.includes('/'), '不能带出路径穿越')
})

test('ensureCursor：首次创建时从旧版单一游标文件迁移位置', async () => {
  const { ensureCursor, cursorFile, LEGACY_CURSOR } = await import('../lib/config.js')
  mkdirSync(join(home, '.dsh'), { recursive: true })
  writeFileSync(LEGACY_CURSOR, JSON.stringify({ chats: { oc_old: { last_id: 'om_1' } } }), 'utf8')
  const file = ensureCursor('oc_old')
  assert.equal(file, cursorFile('oc_old'))
  assert.match(readFileSync(file, 'utf8'), /om_1/)
})

test('ensureCursor：文件已在就不动它（不覆盖已经推进的游标）', async () => {
  const { ensureCursor, cursorFile } = await import('../lib/config.js')
  const file = cursorFile('oc_keep')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ chats: { oc_keep: { last_id: 'om_new' } } }), 'utf8')
  ensureCursor('oc_keep')
  assert.match(readFileSync(file, 'utf8'), /om_new/)
})
