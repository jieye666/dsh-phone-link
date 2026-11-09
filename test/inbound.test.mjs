/**
 * inbound.js 的去重 / 重试 / 正常换班逻辑。
 * 轮询进程本身不在这里起（那需要真 python）：onExit 用打桩的 spawn 观察调度决定。
 */
import './sandbox.mjs'   // 必须第一行：先把数据目录挪到临时目录
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Inbound } from '../lib/inbound.js'

function fakeCore(overrides = {}) {
  const delivered = new Set()
  // 宿主 agents 服务的替身：默认没有活着的 agent，resume 回来一个能接消息的。
  const agents = {
    get: () => core.liveAgent,
    resume: async (options) => ({
      agent: {
        session: { id: options.resumeSessionId },
        followup: (message) => core.injected.push({ followup: message }),
      },
      dispose: async () => {},
    }),
  }
  const core = {
    logger: { info() {}, warn() {} },
    config: { enabled: true, pollSeconds: 5, pollMinutes: 20, defaultChat: 'oc_default', bindings: [] },
    bindings: [{ id: 'bind-1', chatId: 'oc_x', sessionId: 'session-a' }],
    state: 'connected',
    lastError: null,
    lastWarn: null,
    injected: [],
    pollerCount: 0,
    delivered,
    ctx: {
      get: (name) => (name === 'agents' ? agents : undefined),
      sessions: { flush: async () => true },
    },
    buildUserMessage: (text) => ({ role: 'user', content: text }),
    clearError() {
      core.lastError = null
    },
    fail(error, where) {
      core.state = 'error'
      core.lastError = `${where}: ${String(error?.message || error)}`
    },
    warn(message) {
      core.lastWarn = String(message)
    },
    noteInbound(entry) {
      core.injected.push(entry)
    },
    seen: (id) => delivered.has(id),
    remember: (id) => delivered.add(id),
    notify: (chatId, text) => {
      core.notified = core.notified || []
      core.notified.push({ chatId, text })
    },
    save() {},
    status: () => ({ ok: true, state: core.state }),
  }
  return Object.assign(core, overrides)
}

test('新消息注入一次并记账', async () => {
  const core = fakeCore()
  const inbound = new Inbound(core)
  await inbound.deliver(core.bindings[0], { id: 'm1', text: 'hello' })
  assert.equal(core.injected.filter((entry) => entry.followup).length, 1)
  assert.ok(core.delivered.has('m1'))
  assert.equal(core.notified, undefined)
})

test('投过的 id 不再投（重启后也一样，靠 delivered.json）', async () => {
  const core = fakeCore()
  core.delivered.add('m1')
  const inbound = new Inbound(core)
  await inbound.deliver(core.bindings[0], { id: 'm1', text: 'hello' })
  assert.equal(core.injected.filter((entry) => entry.followup).length, 0)
})

test('注入失败：重试一次、不记账、回手机告警', async () => {
  const core = fakeCore()
  let attempts = 0
  core.ctx.get = () => ({
    get: () => undefined,
    resume: async () => {
      attempts += 1
      throw new Error('boom')
    },
  })
  const inbound = new Inbound(core)
  await inbound.deliver(core.bindings[0], { id: 'm2', text: 'hello' })
  assert.equal(attempts, 2, '必须重试一次')
  assert.ok(!core.delivered.has('m2'), '失败了不能记账，否则这条消息永久丢失')
  assert.equal(core.state, 'error')
  assert.match(core.notified[0].text, /没送进会话/)
})

test('图片消息注入本地路径而不是 base64', async () => {
  const core = fakeCore()
  const inbound = new Inbound(core)
  await inbound.deliver(core.bindings[0], { id: 'm3', kind: 'image', path: 'C:\\tmp\\a.png' })
  const body = core.injected.find((entry) => entry.followup).followup.content
  assert.match(body, /📱 \[图片\] C:\\tmp\\a\.png/)
})

test('同一条消息并发进来只投一次', async () => {
  const core = fakeCore()
  let calls = 0
  core.ctx.get = () => ({
    get: () => undefined,
    resume: async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { agent: { session: {}, followup() {} } }
    },
  })
  const inbound = new Inbound(core)
  await Promise.all([
    inbound.deliver(core.bindings[0], { id: 'm4', text: 'x' }),
    inbound.deliver(core.bindings[0], { id: 'm4', text: 'x' }),
  ])
  assert.equal(calls, 1)
})

test('exit 3 且活够了 = 正常换班：立刻接下一轮', () => {
  const core = fakeCore()
  const inbound = new Inbound(core)
  const spawned = []
  inbound.spawn = (binding) => spawned.push(binding.chatId)
  const child = { kill() {} }
  inbound.pollers.set('oc_x', child)
  inbound.onExit(core.bindings[0], child, 3, inbound.generation, Date.now() - 5000)
  assert.deepEqual(spawned, ['oc_x'])
  assert.equal(inbound.pollers.size, 0)
  assert.equal(inbound.timers.size, 0, '正常换班不该走定时器')
})

test('exit 1：走退避定时器，不立刻重开', () => {
  const core = fakeCore()
  const inbound = new Inbound(core)
  const spawned = []
  inbound.spawn = (binding) => spawned.push(binding.chatId)
  inbound.onExit(core.bindings[0], { kill() {} }, 1, inbound.generation, Date.now() - 5000)
  assert.deepEqual(spawned, [])
  assert.equal(inbound.timers.size, 1)
  assert.match(core.lastWarn, /重试/)
  inbound.stop()
})

test('上一代进程的 exit 不再拉新进程（修「点两次接通变两个 poller」）', () => {
  const core = fakeCore()
  const inbound = new Inbound(core)
  const spawned = []
  inbound.spawn = (binding) => spawned.push(binding.chatId)
  const stale = inbound.generation
  inbound.stop() // generation + 1
  inbound.onExit(core.bindings[0], { kill() {} }, 3, stale, Date.now() - 5000)
  assert.deepEqual(spawned, [])
  assert.equal(inbound.timers.size, 0)
})

test('start 没有绑定时直接报错状态，不起进程', async () => {
  const core = fakeCore({ bindings: [] })
  core.config.bindings = []
  const inbound = new Inbound(core)
  const status = await inbound.start()
  assert.equal(core.state, 'idle')
  assert.match(core.lastError, /还没有绑定/)
  assert.equal(status.ok, true)
})

test('bind：裸 uuid 自动补 session-，非 oc_ 开头拒绝', () => {
  // enabled 保持 false：否则 bind() 会真的去起 python 轮询进程
  const core = fakeCore({ config: { enabled: false, pollSeconds: 5, pollMinutes: 20, defaultChat: 'oc_default', bindings: [] } })
  const inbound = new Inbound(core)
  inbound.bind('oc_new', '2e306081-f24f', '群')
  assert.equal(core.bindings.at(-1).sessionId, 'session-2e306081-f24f')
  assert.throws(() => inbound.bind('bad', 'session-a'), /oc_/)
})

test('手机端 /status 不注入会话', async () => {
  const core = fakeCore()
  const inbound = new Inbound(core)
  await inbound.handleCommand(core.bindings[0], { id: 'm5', text: '/status' })
  assert.equal(core.injected.filter((entry) => entry.followup).length, 0, '命令不能进会话、不能烧 token')
  assert.match(core.notified[0].text, /状态/)
})

test('/use 找不到会话时区分「扫描失败」和「没找到」', async () => {
  const core = fakeCore()
  const inbound = new Inbound(core)
  inbound.findSession = async () => ({ id: null, error: '读不到会话目录 C:\\nope' })
  await inbound.handleCommand(core.bindings[0], { id: 'm6', text: '/use 12345678' })
  assert.match(core.notified[0].text, /找会话时出错/)
})

test('/use 命中后改绑并落盘', async () => {
  const core = fakeCore()
  let saved = 0
  core.save = () => {
    saved += 1
  }
  const inbound = new Inbound(core)
  inbound.findSession = async () => ({ id: 'session-abcdef12', error: null })
  await inbound.handleCommand(core.bindings[0], { id: 'm7', text: '/use abcdef12' })
  assert.equal(core.bindings[0].sessionId, 'session-abcdef12')
  assert.equal(saved, 1)
  assert.match(core.notified[0].text, /已切换/)
})

test('会话已经活着就直接用，不 resume（不打断用户正在看的那一轮）', async () => {
  const core = fakeCore()
  let resumes = 0
  core.liveAgent = { session: {}, followup: (message) => core.injected.push({ followup: message }) }
  core.ctx.get = () => ({
    get: (id) => (id === 'session-a' ? core.liveAgent : undefined),
    resume: async () => {
      resumes += 1
      return { agent: { session: {}, followup() {} } }
    },
  })
  const inbound = new Inbound(core)
  await inbound.deliver(core.bindings[0], { id: 'm8', text: 'hello' })
  assert.equal(resumes, 0)
  assert.equal(core.injected.filter((entry) => entry.followup).length, 1)
})

test('resume 出来的 handle 缓存下来，第二条消息不再 resume 一次', async () => {
  const core = fakeCore()
  let resumes = 0
  core.ctx.get = () => ({
    get: () => undefined,
    resume: async (options) => {
      resumes += 1
      return {
        agent: {
          session: { id: options.resumeSessionId },
          followup: (message) => core.injected.push({ followup: message }),
        },
        dispose: async () => {},
      }
    },
  })
  const inbound = new Inbound(core)
  await inbound.deliver(core.bindings[0], { id: 'm9', text: 'one' })
  await inbound.deliver(core.bindings[0], { id: 'm10', text: 'two' })
  assert.equal(resumes, 1)
  assert.equal(core.injected.filter((entry) => entry.followup).length, 2)
})

test('Host 没有 agents 服务时给出能看懂的错，而不是笼统失败', async () => {
  const core = fakeCore()
  core.ctx.get = () => undefined
  const inbound = new Inbound(core)
  await assert.rejects(() => inbound.inject(core.bindings[0], 'x', 'm11'), /agents 服务/)
})
