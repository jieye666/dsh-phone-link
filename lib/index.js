/**
 * dsh-phone-link host half —— 组装层。
 *
 * 一个绑定的飞书聊天 ↔ 一个 DSH 会话。手机上说的话直接进会话（inbound.js），
 * 会话里的回复再推回手机（outbound.js），中间的状态只有一份（core.js）。
 *
 * 状态文件：`~/.dsh/phone-link/{config.json, delivered.json, boot.log}`
 *
 * 拆分（0.4.0）：
 *   config.js   路径/默认值/配置读写/启动痕迹
 *   proc.js     python 子进程封装
 *   message.js  createUserMessage（唯一静态 import @deepseek-ai/dsh-llm 的地方）
 *   core.js     共享状态 + 出站发送原语
 *   inbound.js  轮询进程、注入、手机命令
 *   outbound.js turn/end 之后的镜像
 *   http.js     /plugins/phone-link 路由与栅栏
 */
import { trace } from './config.js'
import { Core } from './core.js'
import { Inbound } from './inbound.js'
import { Outbound } from './outbound.js'
import { createHandler } from './http.js'
import { buildUserMessage } from './message.js'

export const name = 'dsh-phone-link'

// `logger` 不是可注入服务名（cordis 基础上下文自带 ctx.logger），列进 inject 会让插件永远 pending。
// `connection` 只用来给写路由加浏览器栅栏（见 http.js）。
// `agents` 是入站把消息送进会话的唯一公开入口（get 取活 agent / resume 复活会话）。
// 注意：旧版软取的 `sessionController` 在本 Host 里**不存在**，那是入站一直没跑通的原因；
// 现在改用 `agents`，并仍然走 ctx.get() 软取，缺了就在手机上明确报错而不是静默丢消息。
export const inject = ['webServer', 'sessions', 'connection', 'agents']

trace('import')

/**
 * apply 自己吞异常：抛出去会让整个插件停在 pending，而 pending 在面板上没有任何提示，
 * 只有 boot.log 里那一行 `apply failed:` 能说明问题。
 */
export function apply(ctx) {
  trace('apply')
  try {
    const core = new Core(ctx, { buildUserMessage })
    const inbound = new Inbound(core)
    const outbound = new Outbound(core)
    const handle = createHandler({ core, inbound })

    ctx.effect(() => {
      const stopRoute = ctx.webServer.register({
        kind: 'prefix',
        path: '/plugins/phone-link',
        handler: handle,
      })
      return () => {
        // 卸载/重载只停子进程，不改用户选的 enabled —— 下次启动仍应自动接通
        inbound.dispose()
        stopRoute?.()
      }
    }, 'phone-link.routes')

    ctx.effect(
      () => ctx.on('session/event', (session, event) => outbound.handle(session, event)),
      'phone-link.outbound',
    )

    ctx.logger?.info?.(
      `[phone-link] mounted /plugins/phone-link (enabled=${core.config.enabled}, bindings=${core.bindings.length})`,
    )
    if (core.config.enabled) void inbound.start().catch((error) => core.fail(error, 'autostart'))
  } catch (error) {
    const detail = String(error?.stack || error?.message || error).slice(0, 500)
    trace(`apply failed: ${detail}`)
    ctx.logger?.warn?.(`[phone-link] apply failed: ${String(error?.message || error)}`)
  }
}
