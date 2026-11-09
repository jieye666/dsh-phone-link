/**
 * 出站：会话 → 手机。
 *
 * 一轮回复在 `turn/end` 时一次性推给绑定的飞书聊天（OUT-1）：Markdown 降级成
 * 富文本能吃的样子、表格画成 PNG、超长按段落分条。`turn/end` 之后这个观察者
 * 已经不在同步调用链上，任何 rejection 漏出去都会被宿主当成致命错误
 * （2026-11-08 就是这样整个 host 退出的），所以这里的异步一律自己吞。
 */
import { canonicalSessionId } from './config.js'
import { runTablePng } from './proc.js'
import { chunk, phoneParts, tableText } from './render.js'

/** 启动一轮对话的用户消息来源；time-context / runtime-context 这类轮内注入不算。 */
const TRIGGER_KINDS = new Set(['user', 'schedule', 'phone', 'agent-message'])

/** 中断/崩溃的轮次不会发 turn/end，残留超过这个时间就丢掉，避免拼进下一轮（OUT-7）。 */
const PENDING_TTL_MS = 30 * 60 * 1000

/** 只取助手消息里的 text 块，跳过 reasoning / tool 等。 */
export function textOf(data) {
  const content = data?.message?.content ?? data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

export class Outbound {
  constructor(core) {
    this.core = core
    /** sessionId -> { text, at } */
    this.pendingReply = new Map()
    /** sessionId -> { kind, at }：这一轮是谁触发的（user / schedule / phone / agent-message） */
    this.turnTrigger = new Map()
  }

  /** 会话事件入口。**永不抛**：观察者异常会顺着宿主的事件分发冒到进程顶层。 */
  handle(session, event) {
    try {
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || !event?.type) return
      const binding = this.core.bindings.find(
        (item) => item.sessionId === sessionId || canonicalSessionId(item.sessionId) === sessionId,
      )
      if (!binding) return
      this.purgeStale()
      if (event.type === 'user/message') {
        const kind = event.data?.source?.kind
        if (TRIGGER_KINDS.has(kind)) this.turnTrigger.set(sessionId, { kind, at: Date.now() })
        return
      }
      if (event.type === 'assistant/message') {
        const text = textOf(event.data)
        if (text) {
          const previous = this.pendingReply.get(sessionId)
          this.pendingReply.set(sessionId, {
            text: previous ? `${previous.text}\n\n${text}` : text,
            at: Date.now(),
          })
        }
        return
      }
      if (event.type !== 'turn/end') return
      const reply = (this.pendingReply.get(sessionId)?.text || '').trim()
      this.pendingReply.delete(sessionId)
      const trigger = this.turnTrigger.get(sessionId)?.kind || 'user'
      this.turnTrigger.delete(sessionId)
      if (!reply) return
      if (this.core.config.mirrorReplies === false) return
      // 定时任务自己已经推过一次（晨报 / 晚间日志），别让镜像再推一遍。
      if (trigger === 'schedule' && this.core.config.mirrorScheduled !== true) return
      // 必须自己吞掉 rejection —— 见文件头。
      void this.mirror(binding, reply).catch((error) => {
        const message = String(error?.message || error)
        this.core.warn(`镜像失败：${message}`)
        this.core.notify(binding.chatId, `⚠️ 这条回复没推到手机：${message.slice(0, 120)}`)
      })
    } catch (error) {
      this.core.warn(`出站处理失败：${String(error?.message || error)}`)
    }
  }

  purgeStale() {
    const cutoff = Date.now() - PENDING_TTL_MS
    for (const [sessionId, entry] of this.pendingReply) if (!entry || entry.at < cutoff) this.pendingReply.delete(sessionId)
    for (const [sessionId, entry] of this.turnTrigger) if (!entry || entry.at < cutoff) this.turnTrigger.delete(sessionId)
  }

  /**
   * 把一轮助手回复推回飞书：先正文（正文里写着"表格见下图"），再补表格图；超长分段发。
   * 表格出图/发送任何一步失败 → 退回纯文本行，别让手机上只剩一句"见下图"（需求表 P1-4）。
   */
  async mirror(binding, text) {
    const { text: rendered, tables } = phoneParts(text)
    const cleaned = String(rendered || '').trim()
    let sent = 0
    if (cleaned) {
      const parts = chunk(cleaned)
      for (let index = 0; index < parts.length; index += 1) {
        const prefix = parts.length > 1 ? `(${index + 1}/${parts.length})\n` : ''
        if (!(await this.core.sendText(binding.chatId, prefix + parts[index]))) return sent
        sent += 1
      }
    }
    for (const table of tables) {
      if (await this.sendTable(binding, table)) continue
      const fallback = tableText(table)
      if (fallback && (await this.core.sendText(binding.chatId, fallback))) {
        this.core.warn('表格出图失败，已改发纯文本行')
      }
    }
    return sent
  }

  /** 一张表 → PNG → 飞书图片消息。任一环节失败返回 false（由 mirror 兜底）。 */
  async sendTable(binding, table) {
    const rendered = await runTablePng({
      title: table?.title || '',
      columns: Array.isArray(table?.columns) ? table.columns : [],
      rows: Array.isArray(table?.rows) ? table.rows : [],
    })
    const png = String(rendered.out || '').trim().split('\n').pop()?.trim()
    if (rendered.code !== 0 || !png) {
      this.core.warn(`表格出图失败（exit ${rendered.code}）：${String(rendered.err || '').slice(0, 160)}`)
      return false
    }
    return this.core.sendImage(binding.chatId, png)
  }
}
