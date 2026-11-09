/**
 * render.js 的纯函数单测（不碰宿主、不碰飞书）。
 * 跑法：cd ~/.dsh/src/dsh-phone-link && node --test test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunk, forPhone, phoneParts } from '../lib/render.js'

const fence = (spec) => '```dsh-ui\n' + JSON.stringify(spec) + '\n```'

test('dsh-ui 表格 → 正文留指路语，表格被抽出来单独出图', () => {
  const text = fence({
    title: '本周开销',
    items: [{ type: 'table', columns: ['项目', '金额'], rows: [['吃饭', '120'], ['打车', '45']] }],
  })
  const { text: rendered, tables } = phoneParts(text)
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0].columns, ['项目', '金额'])
  assert.deepEqual(tables[0].rows[1], ['打车', '45'])
  // 顶层表格没有自己的标题 → 借用卡片标题
  assert.equal(tables[0].title, '本周开销')
  assert.match(rendered, /表格见下图/)
  assert.doesNotMatch(rendered, /dsh-ui/)
})

test('dsh-ui 列表 / 指标 / 步骤 / 键值 都摊平成文本行', () => {
  const text = fence({
    items: [
      { type: 'text', content: '开头' },
      { type: 'list', items: [{ title: '甲', desc: '说明甲' }, { title: '乙' }] },
      { type: 'stat', label: '成功率', value: '98%' },
      { type: 'steps', steps: [{ title: '第一步' }, { title: '第二步' }] },
      { type: 'keyvalue', pairs: [{ key: '端口', value: '5096' }] },
    ],
  })
  const { text: rendered, tables } = phoneParts(text)
  assert.equal(tables.length, 0)
  assert.match(rendered, /开头/)
  assert.match(rendered, /· 甲：说明甲/)
  assert.match(rendered, /· 乙/)
  assert.match(rendered, /· 成功率：98%/)
  assert.match(rendered, /1\. 第一步/)
  assert.match(rendered, /2\. 第二步/)
  assert.match(rendered, /· 端口：5096/)
})

test('图表类节点换成一句人话，不把 JSON 丢给手机', () => {
  const rendered = forPhone(fence({ items: [{ type: 'chart', data: [{ label: 'a', value: 1 }] }] }))
  assert.match(rendered, /手机上不显示/)
  assert.doesNotMatch(rendered, /label/)
})

test('坏掉的围栏 JSON 退回占位句，不抛异常', () => {
  const rendered = forPhone('```dsh-ui\n{ 这不是 json }\n```')
  assert.match(rendered, /手机上不显示/)
})

test('代码块只留一句提示', () => {
  const rendered = forPhone(fence({ items: [{ type: 'code', content: 'rm -rf /' }] }))
  assert.match(rendered, /请在电脑上看/)
  assert.doesNotMatch(rendered, /rm -rf/)
})

test('Markdown 表格转成「· a ｜ b」，分隔行丢掉，表头保留', () => {
  const rendered = forPhone(['| 项目 | 金额 |', '| --- | --- |', '| 吃饭 | 120 |', '| 打车 | 45 |'].join('\n'))
  const lines = rendered.split('\n').filter(Boolean)
  assert.equal(lines.length, 3)
  assert.equal(lines[0], '· 项目 ｜ 金额')
  assert.equal(lines[1], '· 吃饭 ｜ 120')
  assert.equal(lines[2], '· 打车 ｜ 45')
})

test('标题井号被去掉，连续空行折叠成一个', () => {
  const rendered = forPhone('## 小标题\n\n\n\n正文')
  assert.equal(rendered, '小标题\n\n正文')
})

test('纯文本原样返回', () => {
  assert.equal(forPhone('就这么一句话。'), '就这么一句话。')
})

test('chunk：短文本不切', () => {
  assert.deepEqual(chunk('短'), ['短'])
  assert.deepEqual(chunk(''), [])
})

test('chunk：优先在换行处切', () => {
  const text = 'a'.repeat(30) + '\n' + 'b'.repeat(30)
  const parts = chunk(text, 40)
  assert.equal(parts.length, 2)
  assert.equal(parts[0], 'a'.repeat(30))
  assert.equal(parts[1], 'b'.repeat(30))
})

test('chunk：没有换行时退到句号', () => {
  const text = '甲'.repeat(20) + '。' + '乙'.repeat(30)
  const parts = chunk(text, 40)
  assert.equal(parts.length, 2)
  assert.ok(parts[0].endsWith('。'))
})

test('chunk：超长单句硬切，切完每段都在 limit 内且不丢内容', () => {
  const text = '丙'.repeat(100)
  const parts = chunk(text, 40)
  assert.equal(parts.length, 3)
  for (const part of parts) assert.ok(part.length <= 40)
  assert.equal(parts.join(''), text)
})

test('chunk：长度正好等于 limit 时不切', () => {
  const text = '丁'.repeat(40)
  assert.deepEqual(chunk(text, 40), [text])
})

test('chunk：切完不会留下空段', () => {
  const text = '\n' + '戊'.repeat(100) + '\n'
  for (const part of chunk(text, 40)) assert.notEqual(part, '')
})
