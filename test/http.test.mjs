/**
 * http.js：免栅栏的 /status 不许带消息原文；写路由必须过栅栏；错误码齐全。
 */
import './sandbox.mjs'   // 必须第一行：先把数据目录挪到临时目录
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHandler } from '../lib/http.js'

function makeReq(method, url, body) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:7882' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
    resume() {},
  }
}

function fakeCore({ trusted = true, connection = true, status = {}, inspect = {} } = {}) {
  const core = {
    config: {},
    warnedNoFence: false,
    warnedFenceError: false,
    warnedLegacyGet: false,
    warns: [],
    warn(message) {
      core.warns.push(String(message))
    },
    status: () => ({ ok: true, state: 'connected', injectedCount: 1, bindings: [], ...status }),
    inspect: () => ({ ok: true, state: 'connected', injected: [{ id: 'm1', text: '你好' }], ...inspect }),
    ctx: {
      get: (name) => {
        if (name !== 'connection') return undefined
        if (!connection) return undefined
        if (trusted === null) return {}
        return { requestRejection: () => (trusted ? undefined : 403) }
      },
    },
  }
  return core
}

function fakeInbound(calls = []) {
  return {
    start: async () => ({ ok: true, action: 'connect' }),
    disconnect: () => ({ ok: true, action: 'disconnect' }),
    bind: (chatId, sessionId, chatName) => {
      calls.push({ chatId, sessionId, chatName })
      return { ok: true, action: 'bind' }
    },
    unbind: () => ({ ok: true, action: 'unbind' }),
    flush: async () => ({ ok: true, action: 'flush' }),
    probe: async () => ({ ok: true, action: 'probe' }),
  }
}

function call(handle, req) {
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(code, headers) {
      res.status = code
      res.headers = headers
    },
    end(text) {
      res.body = text || ''
    },
  }
  return new Promise((resolve) => {
    const end = res.end.bind(res)
    res.end = (text) => {
      end(text)
      resolve(res)
    }
    handle(req, res)
  })
}

const statusPath = '/plugins/phone-link/status'
const post = (handle, path, body) => call(handle, makeReq('POST', path, typeof body === 'string' ? body : JSON.stringify(body ?? {})))

test('GET /status 免栅栏，且不带手机消息原文', async () => {
  const handle = createHandler({ core: fakeCore(), inbound: fakeInbound() })
  const res = await call(handle, makeReq('GET', statusPath))
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.state, 'connected')
  assert.equal('injected' in body, false, '/status 免栅栏，本机任意进程都读得到，不能有原文')
  assert.match(res.headers['cache-control'], /no-store/)
})

test('GET / 也能探活（重启脚本靠它）', async () => {
  const handle = createHandler({ core: fakeCore(), inbound: fakeInbound() })
  const res = await call(handle, makeReq('GET', '/plugins/phone-link/'))
  assert.equal(res.status, 200)
})

test('/inspect 过栅栏：不可信 403，可信才给原文', async () => {
  const path = '/plugins/phone-link/inspect'
  const denied = await call(createHandler({ core: fakeCore({ trusted: false }), inbound: fakeInbound() }), makeReq('GET', path))
  assert.equal(denied.status, 403)
  assert.equal(JSON.parse(denied.body).ok, false)
  const ok = await call(createHandler({ core: fakeCore(), inbound: fakeInbound() }), makeReq('GET', path))
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).injected[0].text, '你好')
})

test('拿不到 connection 服务时 fail-closed（403 + 只 warn 一次）', async () => {
  const core = fakeCore({ connection: false })
  const handle = createHandler({ core, inbound: fakeInbound() })
  const first = await post(handle, '/plugins/phone-link/probe')
  const second = await post(handle, '/plugins/phone-link/probe')
  assert.equal(first.status, 403)
  assert.equal(second.status, 403)
  assert.equal(core.warns.filter((line) => /栅栏/.test(line)).length, 1, '别刷屏')
})

test('写路由不可信时直接拒绝，且不执行动作', async () => {
  const calls = []
  const handle = createHandler({ core: fakeCore({ trusted: false }), inbound: fakeInbound(calls) })
  const res = await post(handle, '/plugins/phone-link/bind', { chatId: 'oc_x', sessionId: 'session-a' })
  assert.equal(res.status, 403)
  assert.deepEqual(calls, [])
})

test('可信的 POST /bind 会带着参数打到 inbound', async () => {
  const calls = []
  const handle = createHandler({ core: fakeCore(), inbound: fakeInbound(calls) })
  const res = await post(handle, '/plugins/phone-link/bind', { chatId: 'oc_x', sessionId: '2e306081', chatName: '群' })
  assert.equal(res.status, 200)
  assert.deepEqual(calls, [{ chatId: 'oc_x', sessionId: '2e306081', chatName: '群' }])
})

test('六个写路由都通', async () => {
  const handle = createHandler({ core: fakeCore(), inbound: fakeInbound() })
  for (const route of ['connect', 'disconnect', 'unbind', 'flush', 'probe']) {
    const res = await post(handle, `/plugins/phone-link/${route}`, { chatId: 'oc_x' })
    assert.equal(res.status, 200, `${route} 应当 200`)
  }
})

test('错误码：未知路由 404、方法不对 405、body 过大 413、坏 JSON 400', async () => {
  const handle = createHandler({ core: fakeCore(), inbound: fakeInbound() })
  assert.equal((await call(handle, makeReq('GET', '/plugins/phone-link/nope'))).status, 404)
  assert.equal((await call(handle, makeReq('DELETE', '/plugins/phone-link/probe'))).status, 405)
  assert.equal((await post(handle, '/plugins/phone-link/probe', 'x'.repeat(65 * 1024))).status, 413)
  assert.equal((await post(handle, '/plugins/phone-link/probe', '{oops')).status, 400)
})

test('旧 bundle 用 GET 打写路由：仍然放行但留痕', async () => {
  const core = fakeCore()
  const handle = createHandler({ core, inbound: fakeInbound() })
  const res = await call(handle, makeReq('GET', '/plugins/phone-link/probe'))
  assert.equal(res.status, 200)
  assert.equal(core.warnedLegacyGet, true)
  assert.match(core.warns.join('\n'), /旧面板 bundle/)
})

test('strictPost 打开后 GET 打写路由 → 405', async () => {
  const core = fakeCore()
  core.config = { strictPost: true }
  const handle = createHandler({ core, inbound: fakeInbound() })
  const res = await call(handle, makeReq('GET', '/plugins/phone-link/probe'))
  assert.equal(res.status, 405)
})

test('bind 参数不合法 → 400 而不是 500', async () => {
  const inbound = fakeInbound()
  inbound.bind = () => {
    throw new Error('chat id must look like oc_xxx')
  }
  const handle = createHandler({ core: fakeCore(), inbound })
  const res = await post(handle, '/plugins/phone-link/bind', { chatId: 'bad', sessionId: 'session-a' })
  assert.equal(res.status, 400)
  assert.match(JSON.parse(res.body).message, /oc_/)
})

test('动作内部抛错 → 500，不让请求挂着', async () => {
  const inbound = fakeInbound()
  inbound.flush = async () => {
    throw new Error('python missing')
  }
  const handle = createHandler({ core: fakeCore(), inbound })
  const res = await post(handle, '/plugins/phone-link/flush')
  assert.equal(res.status, 500)
})
