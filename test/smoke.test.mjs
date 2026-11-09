/**
 * 端到端冒烟：把 lib/ 原样复制到临时目录，配一个假的 @deepseek-ai/dsh-llm，
 * 再用一个假 ctx 真跑一遍 apply()。
 *
 * 为了不碰真实配置：USERPROFILE/HOME 指向临时目录（config.js 在 import 时按 homedir 算路径），
 * 所以要在 import 之前设好。真起 python 的动作一律不打（enabled 默认 false）。
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const libDir = fileURLToPath(new URL('../lib/', import.meta.url))
const sandbox = mkdtempSync(join(tmpdir(), 'phone-link-smoke-'))
const home = join(sandbox, 'home')
mkdirSync(home, { recursive: true })
cpSync(libDir, join(sandbox, 'lib'), { recursive: true })
writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }))
const stubDir = join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-llm')
mkdirSync(stubDir, { recursive: true })
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.0.0-smoke', type: 'module', main: 'index.js' }))
writeFileSync(
  join(stubDir, 'index.js'),
  'export function createUserMessage(text, source) {\n' +
    '  return { role: "user", content: [{ type: "text", text }], source: source || { kind: "phone" } }\n' +
    '}\n',
)
// config.js 在模块加载时按 homedir() 算 ~/.dsh/phone-link，所以必须抢在 import 之前改环境变量
process.env.USERPROFILE = home
process.env.HOME = home

const plugin = await import(pathToFileURL(join(sandbox, 'lib', 'index.js')).href)
const stateDir = join(home, '.dsh', 'phone-link')

function fakeCtx({ withWebServer = true } = {}) {
  const registered = []
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    on: (name, handler) => {
      registered.push({ kind: 'event', name, handler })
      return () => {}
    },
    effect: (fn, label) => {
      const dispose = fn()
      disposers.push({ label, dispose })
      return () => dispose?.()
    },
    sessions: { flush: async () => true },
    agents: { list: () => [] },
  }
  if (withWebServer) {
    ctx.webServer = {
      register: (route) => {
        registered.push({ kind: 'route', route })
        return () => {}
      },
    }
  }
  return { ctx, registered, disposers }
}

function call(handler, method, url, body) {
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:7882' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
    resume() {},
  }
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
    handler(req, res)
  })
}

test('1. import 侧：名字与 inject 列表（logger 不在里面，否则永远 pending）', () => {
  assert.equal(plugin.name, 'dsh-phone-link')
  // agents 是入站投递的唯一入口；sessionController 在本 Host 不存在，不能列进来。
  assert.deepEqual(plugin.inject, ['webServer', 'sessions', 'connection', 'agents'])
  assert.equal(typeof plugin.apply, 'function')
})

test('2. apply 注册一条路由和两个 effect', () => {
  const { ctx, registered } = fakeCtx()
  assert.doesNotThrow(() => plugin.apply(ctx))
  const routes = registered.filter((item) => item.kind === 'route')
  const events = registered.filter((item) => item.kind === 'event')
  assert.equal(routes.length, 1)
  assert.equal(routes[0].route.path, '/plugins/phone-link')
  assert.deepEqual(events.map((item) => item.name), ['session/event'])
})

test('3. GET /status：200、无原文、未启用时 state=idle', async () => {
  const { ctx, registered } = fakeCtx()
  plugin.apply(ctx)
  const route = registered.find((item) => item.kind === 'route').route
  const res = await call(route.handler, 'GET', '/plugins/phone-link/status')
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.state, 'idle')
  assert.equal(body.enabled, false)
  assert.equal('injected' in body, false)
  // 默认 chat id 不写死进仓库（私人值），这里只要求字段存在且是字符串
  assert.equal(typeof body.defaultChat, 'string')
})

test('4. POST /bind 落盘 config.json，且 sessionId 补成 session- 前缀', async () => {
  const { ctx, registered } = fakeCtx()
  plugin.apply(ctx)
  const route = registered.find((item) => item.kind === 'route').route
  const res = await call(route.handler, 'POST', '/plugins/phone-link/bind', JSON.stringify({ chatId: 'oc_smoke', sessionId: '2e306081-f24f', chatName: '冒烟' }))
  assert.equal(res.status, 200)
  const config = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))
  assert.equal(config.bindings.at(-1).sessionId, 'session-2e306081-f24f')
  assert.equal(config.bindings.at(-1).chatId, 'oc_smoke')
})

test('5. 绑定后 status 能看到它，pollers=0（enabled 还是 false）', async () => {
  const { ctx, registered } = fakeCtx()
  plugin.apply(ctx)
  const route = registered.find((item) => item.kind === 'route').route
  const res = await call(route.handler, 'GET', '/plugins/phone-link/status')
  const body = JSON.parse(res.body)
  assert.ok(body.bindings.some((item) => item.chatId === 'oc_smoke'))
  assert.equal(body.pollers, 0)
})

test('6. /inspect 不可信 → 403；可信 → 200', async () => {
  const trusted = fakeCtx()
  plugin.apply(trusted.ctx)
  const handler = trusted.registered.find((item) => item.kind === 'route').route.handler
  assert.equal((await call(handler, 'GET', '/plugins/phone-link/inspect')).status, 200)
  const untrusted = fakeCtx()
  untrusted.ctx.get = () => ({ requestRejection: () => 403 })
  plugin.apply(untrusted.ctx)
  const denied = untrusted.registered.find((item) => item.kind === 'route').route.handler
  assert.equal((await call(denied, 'GET', '/plugins/phone-link/inspect')).status, 403)
})

test('7. 未知路由 404、body 过大 413', async () => {
  const { ctx, registered } = fakeCtx()
  plugin.apply(ctx)
  const handler = registered.find((item) => item.kind === 'route').route.handler
  assert.equal((await call(handler, 'GET', '/plugins/phone-link/nope')).status, 404)
  assert.equal((await call(handler, 'POST', '/plugins/phone-link/probe', 'x'.repeat(65 * 1024))).status, 413)
})

test('8. POST /unbind 清掉绑定', async () => {
  const { ctx, registered } = fakeCtx()
  plugin.apply(ctx)
  const handler = registered.find((item) => item.kind === 'route').route.handler
  const res = await call(handler, 'POST', '/plugins/phone-link/unbind', JSON.stringify({ chatId: 'oc_smoke' }))
  assert.equal(res.status, 200)
  const config = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'))
  assert.deepEqual(config.bindings, [])
})

test('9. boot.log 里 import / apply 分得清', () => {
  const log = readFileSync(join(stateDir, 'boot.log'), 'utf8')
  assert.match(log, /^\S+ import$/m)
  assert.match(log, /^\S+ apply$/m)
})

test('10. 重复 apply（面板热重载）不抛', () => {
  const { ctx } = fakeCtx()
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.doesNotThrow(() => plugin.apply(ctx))
})

test('11. 缺 webServer（服务没就绪）时不抛，只留一行 apply failed', () => {
  const { ctx } = fakeCtx({ withWebServer: false })
  assert.doesNotThrow(() => plugin.apply(ctx))
  const log = readFileSync(join(stateDir, 'boot.log'), 'utf8')
  assert.match(log, /apply failed:/)
})

test('12. 卸载：清理函数可调用，且不留下轮询进程', async () => {
  const { ctx, registered, disposers } = fakeCtx()
  plugin.apply(ctx)
  for (const { dispose } of disposers) assert.doesNotThrow(() => dispose?.())
  const handler = registered.find((item) => item.kind === 'route').route.handler
  const body = JSON.parse((await call(handler, 'GET', '/plugins/phone-link/status')).body)
  assert.equal(body.pollers, 0)
})

test('目录侧效果：状态文件都落在 ~/.dsh/phone-link 下', () => {
  for (const name of ['config.json', 'boot.log']) assert.ok(existsSync(join(stateDir, name)), `${name} 缺失`)
})
