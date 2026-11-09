/**
 * HTTP 面：面板和本机脚本都通过 `/plugins/phone-link/...` 进来。
 *
 * 鉴权分两档：
 *   - 免栅栏：`GET /`、`GET /status`。重启脚本的端口探活只读它，所以不能加栅栏；
 *     因此这两个响应里**不含**手机消息原文（P0-2，原文走 /inspect）。
 *   - 过栅栏：所有写路由 + `/inspect`。判定只看 `connection.requestRejection`：
 *     本机任意进程、任意网页都能 localhost POST，只有浏览器同源请求才该被放行。
 *     拿不到 connection 服务时 **fail-closed**（403 + 只 warn 一次）。
 *
 * 写路由同时接受 POST 和 GET：浏览器可能缓存着旧面板 bundle（旧版用 GET 打动作），
 * 收紧成 POST-only 会让按钮变哑。老 bundle 还在用 GET 时会写一行 boot.log，
 * 等确认没人再用就能把它关掉（`config.strictPost = true`）。
 */
import { BODY_LIMIT } from './config.js'

const WRITE_ROUTES = new Set(['/connect', '/disconnect', '/bind', '/unbind', '/flush', '/probe'])

export function createHandler({ core, inbound }) {
  const warnOnce = (flag, message) => {
    if (core[flag]) return
    core[flag] = true
    core.warn(message)
  }

  const admitted = (req) => {
    const ctx = core.ctx
    const connection = typeof ctx.get === 'function' ? (ctx.get('connection') ?? ctx.connection) : ctx.connection
    if (typeof connection?.requestRejection !== 'function') {
      warnOnce('warnedNoFence', '拿不到 connection.requestRejection，所有需要栅栏的路由一律拒绝（403）')
      return false
    }
    try {
      return connection.requestRejection({ headers: req.headers }) === undefined
    } catch (error) {
      warnOnce('warnedFenceError', `栅栏判断抛错，按不可信处理：${String(error?.message || error)}`)
      return false
    }
  }

  const routeOf = (req) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.replace(/^.*\/plugins\/phone-link/, '')
    return path || '/'
  }

  return function handle(req, res) {
    const route = routeOf(req)
    const send = (code, body) => {
      const text = JSON.stringify(body)
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
    }
    const readBody = async () => {
      const chunks = []
      let size = 0
      for await (const part of req) {
        size += part.length
        if (size > BODY_LIMIT) {
          try {
            req.resume?.()
          } catch {
            /* 已经读完 */
          }
          return { error: 'too_large' }
        }
        chunks.push(part)
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return { value: {} }
      try {
        return { value: JSON.parse(raw) }
      } catch {
        return { error: 'bad_json' }
      }
    }

    const run = async () => {
      // —— 免栅栏：只读概览（不含消息原文）——
      if (route === '/' || route === '/status') return send(200, core.status())

      // —— 栅栏后：手机消息原文 ——
      if (route === '/inspect') {
        if (req.method !== 'GET' && req.method !== 'POST') return send(405, { ok: false, code: 'method_not_allowed' })
        if (!admitted(req)) return send(403, { ok: false, code: 'forbidden' })
        return send(200, { ok: true, ...core.inspect() })
      }

      if (!WRITE_ROUTES.has(route)) return send(404, { ok: false, code: 'not_found', route })
      if (req.method !== 'POST' && req.method !== 'GET') return send(405, { ok: false, code: 'method_not_allowed' })
      if (!admitted(req)) return send(403, { ok: false, code: 'forbidden' })
      if (req.method === 'GET') warnOnce('warnedLegacyGet', `写路由收到 GET（${route}）：还有旧面板 bundle 在跑，确认后可以把 config.strictPost 打开`)
      if (req.method === 'GET' && core.config.strictPost === true) return send(405, { ok: false, code: 'method_not_allowed' })

      const parsed = await readBody()
      if (parsed.error === 'too_large') return send(413, { ok: false, code: 'payload_too_large' })
      if (parsed.error === 'bad_json') return send(400, { ok: false, code: 'bad_json' })
      const body = parsed.value || {}

      if (route === '/connect') return send(200, await inbound.start())
      if (route === '/disconnect') return send(200, inbound.disconnect())
      if (route === '/bind') {
        try {
          return send(200, inbound.bind(body.chatId, body.sessionId, body.chatName))
        } catch (error) {
          return send(400, { ok: false, code: 'bad_bind', message: String(error?.message || error) })
        }
      }
      if (route === '/unbind') return send(200, inbound.unbind(body.chatId))
      if (route === '/flush') return send(200, await inbound.flush())
      if (route === '/probe') return send(200, await inbound.probe())
      return send(404, { ok: false, code: 'not_found', route })
    }

    run().catch((error) => {
      core.warn(`HTTP ${route} 处理失败：${String(error?.message || error)}`)
      send(500, { ok: false, code: 'internal', message: String(error?.message || error) })
    })
  }
}
