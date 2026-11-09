/**
 * render.js 的表格兜底渲染：出图链路失败时手机上还能看到数据。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forPhone, phoneParts, tableText } from '../lib/render.js'

test('tableText：标题 + 表头 + 每行一条', () => {
  const text = tableText({ title: '本周开销', columns: ['项目', '金额'], rows: [['吃饭', 120], ['打车', '45']] })
  assert.equal(text, ['【本周开销】', '· 项目 ｜ 金额', '· 吃饭 ｜ 120', '· 打车 ｜ 45'].join('\n'))
})

test('tableText：没有标题就只出表', () => {
  assert.equal(tableText({ columns: ['a'], rows: [['1']] }), ['· a', '· 1'].join('\n'))
})

test('tableText：脏数据不抛（rows 不是数组 / 单元格是 null）', () => {
  assert.equal(tableText({ rows: 'oops' }), '')
  assert.equal(tableText({ columns: ['a'], rows: [[null, undefined]] }), ['· a', '·  ｜ '].join('\n'))
  assert.equal(tableText(null), '')
})

test('dsh-ui 表格节点仍然把表格抽出来给出图链路', () => {
  const spec = { title: 'T', items: [{ type: 'table', columns: ['a'], rows: [['1']] }] }
  const { text, tables } = phoneParts('```dsh-ui\n' + JSON.stringify(spec) + '\n```')
  assert.equal(tables.length, 1)
  assert.equal(tables[0].title, 'T')
  assert.match(text, /表格见下图/)
})

test('嵌套卡片里的表格也能被抽出来', () => {
  const spec = { items: [{ type: 'card', items: [{ type: 'table', columns: ['a'], rows: [['1']] }] }] }
  const { tables } = phoneParts('```dsh-ui\n' + JSON.stringify(spec) + '\n```')
  assert.equal(tables.length, 1)
  assert.equal(forPhone('纯文本'), '纯文本')
})
