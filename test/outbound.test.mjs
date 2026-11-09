/**
 * outbound.js：一轮回复只推一次、开关生效、表格出图失败要兜底。
 */
import './sandbox.mjs'   // 必须第一行：先把数据目录挪到临时目录
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Outbound, textOf } from '../lib/outbound.js'

function fakeCore(overrides = {}) {
  const core = {
    config: { mirrorReplies: true, mirrorScheduled: false },
    bindings: [{ chatId: 'oc_x', sessionId: 'session-a' }],
    sent: [],
    notified: [],
    warns: [],
    sendText: async (chatId, body) => {
      core.sent.push(body)
      return true
    },
    sendImage: async () => true,
    notify: (chatId, text) => core.notified.push(text),
    warn: (message) => core.warns.push(String(message)),
  }
  return Object.assign(core, overrides)
}

const session = { id: 'session-a' }
const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const userTurn = (kind) => ({ type: 'user/message', data: { source: { kind } } })
const turnEnd = { type: 'turn/end', data: { reason: { kind: 'completed' } } }

test('textOf 只取 text 块，跳过 reasoning', () => {
  const data = { message: { content: [{ type: 'reasoning', text: '想想' }, { type: 'text', text: '答案' }] } }
  assert.equal(textOf(data), '答案')
  assert.equal(textOf({}), '')
})

test('多段助手消息合并成一条推出去，turn/end 之后清空', async () => {
  const core = fakeCore()
  const outbound = new Outbound(core)
  const pushed = []
  outbound.mirror = async (binding, text) => pushed.push(text)
  outbound.handle(session, assistant('第一段'))
  outbound.handle(session, assistant('第二段'))
  assert.deepEqual(pushed, [], 'turn/end 之前不能推')
  outbound.handle(session, turnEnd)
  assert.deepEqual(pushed, ['第一段\n\n第二段'])
  outbound.handle(session, turnEnd)
  assert.equal(pushed.length, 1, '同一轮不会推第二次')
})

test('未绑定的会话事件直接忽略', () => {
  const core = fakeCore()
  const outbound = new Outbound(core)
  let pushed = 0
  outbound.mirror = async () => {
    pushed += 1
  }
  outbound.handle({ id: 'session-other' }, assistant('x'))
  outbound.handle({ id: 'session-other' }, turnEnd)
  assert.equal(pushed, 0)
})

test('mirrorReplies=false 时不推', () => {
  const core = fakeCore({ config: { mirrorReplies: false, mirrorScheduled: true } })
  const outbound = new Outbound(core)
  let pushed = 0
  outbound.mirror = async () => {
    pushed += 1
  }
  outbound.handle(session, assistant('x'))
  outbound.handle(session, turnEnd)
  assert.equal(pushed, 0)
})

test('定时任务触发的轮次默认不推，mirrorScheduled=true 才推', () => {
  for (const allow of [false, true]) {
    const core = fakeCore({ config: { mirrorReplies: true, mirrorScheduled: allow } })
    const outbound = new Outbound(core)
    let pushed = 0
    outbound.mirror = async () => {
      pushed += 1
    }
    outbound.handle(session, userTurn('schedule'))
    outbound.handle(session, assistant('晨报'))
    outbound.handle(session, turnEnd)
    assert.equal(pushed, allow ? 1 : 0)
  }
})

test('手机发起的轮次一定推（phone 来源）', () => {
  const core = fakeCore()
  const outbound = new Outbound(core)
  let pushed = 0
  outbound.mirror = async () => {
    pushed += 1
  }
  outbound.handle(session, userTurn('phone'))
  outbound.handle(session, assistant('好'))
  outbound.handle(session, turnEnd)
  assert.equal(pushed, 1)
})

test('镜像失败必须自己吞掉 rejection，并且告诉手机', async () => {
  const core = fakeCore()
  const outbound = new Outbound(core)
  outbound.mirror = async () => {
    throw new Error('network down')
  }
  outbound.handle(session, assistant('x'))
  outbound.handle(session, turnEnd)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(core.warns.length, 1)
  assert.match(core.notified[0], /没推到手机/)
})

test('handle 内部抛错不外泄（观察者异常会让 host 退出）', () => {
  const core = fakeCore()
  Object.defineProperty(core, 'bindings', {
    get() {
      throw new Error('broken')
    },
  })
  const outbound = new Outbound(core)
  assert.doesNotThrow(() => outbound.handle(session, assistant('x')))
  assert.match(core.warns.at(-1), /出站处理失败/)
})

test('30 分钟前的残留回复被丢掉，不拼进下一轮', () => {
  const core = fakeCore()
  const outbound = new Outbound(core)
  outbound.pendingReply.set('session-a', { text: '很久以前', at: Date.now() - 31 * 60 * 1000 })
  outbound.turnTrigger.set('session-a', { kind: 'schedule', at: Date.now() - 31 * 60 * 1000 })
  const pushed = []
  outbound.mirror = async (binding, text) => pushed.push(text)
  outbound.handle(session, assistant('新的一轮'))
  outbound.handle(session, turnEnd)
  assert.deepEqual(pushed, ['新的一轮'], '残留不能拼进新一轮，也不该把新一轮判成定时任务')
})

test('超长回复分条并带 (1/2) 前缀', async () => {
  const core = fakeCore()
  const outbound = new Outbound(core)
  const long = Array.from({ length: 40 }, (_, index) => `第${index}段：${'凑够长度来触发分条逻辑，'.repeat(10)}`).join('\n\n')
  await outbound.mirror(core.bindings[0], long)
  assert.ok(core.sent.length >= 2, `应当分条，实际 ${core.sent.length} 条`)
  assert.match(core.sent[0], /^\(1\/\d\)\n/)
})

test('表格出图失败：退回纯文本行，不留「见下图」空等', async () => {
  const core = fakeCore()
  const outbound = new Outbound(core)
  outbound.sendTable = async () => false
  const spec = { items: [{ type: 'table', columns: ['项目', '金额'], rows: [['吃饭', 120]] }] }
  const text = '这周开销如下：\n\n```dsh-ui\n' + JSON.stringify(spec) + '\n```'
  await outbound.mirror(core.bindings[0], text)
  assert.ok(core.sent.some((body) => /这周开销如下/.test(body)), '正文先到')
  assert.ok(core.sent.some((body) => /· 项目 ｜ 金额/.test(body)), '图失败要改发文本行')
  assert.match(core.warns.at(-1), /表格出图失败/)
})

test('表格出图成功：正文先到、图后到', async () => {
  const core = fakeCore()
  const outbound = new Outbound(core)
  const sent = []
  outbound.sendTable = async (binding, table) => {
    sent.push(`IMG:${table.columns.join('|')}`)
    return true
  }
  const spec = { items: [{ type: 'table', columns: ['a'], rows: [['1']] }] }
  await outbound.mirror(core.bindings[0], '说明\n\n```dsh-ui\n' + JSON.stringify(spec) + '\n```')
  assert.equal(core.sent.length, 1)
  assert.deepEqual(sent, ['IMG:a'])
})
