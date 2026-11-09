/**
 * 共享状态与出站原语。
 *
 * 这里持有整个插件唯一的一份状态：配置、连接状态、最近收发时间、注入历史、
 * 已投递 id 环形表。inbound / outbound / http 都拿到同一个 Core 实例，
 * 谁也不在自己那里再存一份（旧版把 15 个方法塞进一个 class 就是为了这个，
 * 拆开之后用「一个状态对象 + 三个行为模块」保持同样的单一真相）。
 *
 * 约定：这一层的方法**不抛**。发消息失败只影响返回值与 lastWarn。
 */
import { loadDelivered, readConfig, saveDelivered, trace, writeConfig } from './config.js'
import { runInbox } from './proc.js'

const MAX_INJECTED = 50

export class Core {
  constructor(ctx, { buildUserMessage } = {}) {
    this.ctx = ctx
    this.logger = ctx.logger
    this.buildUserMessage = buildUserMessage
    const { config, error } = readConfig()
    this.config = config
    this.state = 'idle'
    this.lastError = null
    /** 非致命问题（回执发不出去、表格出图失败…）：面板显示、boot.log 留痕，不把 state 打成 error。 */
    this.lastWarn = null
    this.lastInboundAt = null
    this.lastOutboundAt = null
    /** 最近注入的手机消息（含原文前 120 字）——只经栅栏后的 /inspect 暴露，见 http.js。 */
    this.injected = []
    /** 已投递 message id 的环形表，落盘到 delivered.json，重启后不重投。 */
    this.deliveredOrder = loadDelivered()
    this.delivered = new Set(this.deliveredOrder)
    /** 当前活着的轮询进程数（Inbound 维护，面板显示用）。 */
    this.pollerCount = 0
    /** sessionId → 会话标题。用户要求手机上看到标题，而不是一串 id。 */
    this.titles = new Map()
    /** 最近动过的会话 [{session, title}]，/use 列表用。 */
    this.recentSessions = []
    /** 只 warn 一次的那些开关（栅栏缺失、旧 bundle 用 GET…），见 http.js。 */
    this.warnedNoFence = false
    this.warnedFenceError = false
    this.warnedLegacyGet = false
    if (error) {
      this.lastError = `config.json 读不出来，已退回默认值（原件备份为 config.json.bad）：${error}`
      this.warn(this.lastError)
    }
  }

  get bindings() {
    return this.config.bindings
  }

  save() {
    writeConfig(this.config)
  }

  /** 会话标题（没有就空串）。 */
  titleOf(sessionId) {
    return this.titles.get(sessionId) || ''
  }

  /** 给人看的名字：优先标题，标题还没读到就退回 id 前 8 位。 */
  labelOf(sessionId) {
    const short = String(sessionId || '').replace(/^session-/, '').slice(0, 8)
    const title = this.titleOf(sessionId)
    return title ? `${title}（${short}）` : short || '未设置'
  }

  /**
   * 从会话日志里取标题（python 侧解 zstd，带 mtime 缓存）。
   * 这一层不抛：取不到标题只是手机上少一行字，不该影响收发。
   */
  async refreshTitles(count = 8) {
    const { code, out } = await runInbox(['title', '--list', String(count)], { timeoutMs: 60000 })
    if (code !== 0) return this.titles
    const line = String(out || '').trim().split('\n').pop()
    if (!line) return this.titles
    try {
      const rows = JSON.parse(line)
      if (!Array.isArray(rows)) return this.titles
      for (const row of rows) {
        if (row?.session && row.title) this.titles.set(row.session, row.title)
      }
      this.recentSessions = rows.filter((row) => row?.session)
    } catch {
      /* 标题是装饰，解析失败就算了 */
    }
    return this.titles
  }

  /**
   * 面板/探活用的状态。
   * `injected` 故意不在这里：它含手机消息原文，而 GET /status 免栅栏，
   * 本机任意进程都能读（需求表 P0-2）。要原文请走栅栏后的 GET /inspect。
   */
  status() {
    return {
      ok: true,
      state: this.state,
      enabled: this.config.enabled,
      lastError: this.lastError,
      lastWarn: this.lastWarn,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
      mirrorReplies: this.config.mirrorReplies !== false,
      mirrorScheduled: this.config.mirrorScheduled === true,
      pollSeconds: this.config.pollSeconds ?? 5,
      pollMinutes: this.config.pollMinutes ?? 20,
      defaultChat: this.config.defaultChat || '',
      bindings: this.config.bindings,
      pollers: this.pollerCount,
      injectedCount: this.injected.length,
      titles: Object.fromEntries(this.titles),
      recent: this.recentSessions,
    }
  }

  /** 关栅栏后的完整状态：只给过了浏览器栅栏的调用方（面板自己）。 */
  inspect() {
    return { ...this.status(), injected: this.injected.slice(-10), delivered: this.deliveredOrder.length }
  }

  fail(error, where) {
    this.state = 'error'
    this.lastError = `${where ? `${where}: ` : ''}${String(error?.message || error)}`
    this.logger?.warn(`[phone-link] ${this.lastError}`)
    trace(`error ${where || '-'} ${String(error?.message || error).slice(0, 300)}`)
  }

  warn(message) {
    this.lastWarn = String(message)
    this.logger?.warn(`[phone-link] ${this.lastWarn}`)
  }

  clearError() {
    this.lastError = null
  }

  noteInbound(entry) {
    this.lastInboundAt = entry.at
    this.injected.push(entry)
    if (this.injected.length > MAX_INJECTED) this.injected.splice(0, this.injected.length - MAX_INJECTED)
    this.lastError = null
    if (this.state !== 'connected') this.state = 'connected'
  }

  /** 这条手机消息投过了吗？（poller 与 /flush 的 drain 会抢同一条，重启后也不能重投） */
  seen(id) {
    return Boolean(id) && this.delivered.has(id)
  }

  /** 只有真正注入成功之后才记账，失败的消息留着下次重试。 */
  remember(id) {
    if (!id || this.delivered.has(id)) return
    this.delivered.add(id)
    this.deliveredOrder.push(id)
    while (this.deliveredOrder.length > 200) this.delivered.delete(this.deliveredOrder.shift())
    saveDelivered(this.deliveredOrder)
  }

  /** 发一条纯文本，失败重试一次。返回 true = 送达。 */
  async sendText(chatId, body, { retry = 1 } = {}) {
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      const { code, err } = await runInbox(['send', '--chat-id', chatId, '--text', body], { timeoutMs: 90000 })
      if (code === 0) {
        this.lastOutboundAt = new Date().toISOString()
        return true
      }
      this.logger?.warn(`[phone-link] outbound send exited ${code}: ${String(err).slice(0, 300)}`)
      if (attempt < retry) await new Promise((resolve) => setTimeout(resolve, 1200))
    }
    return false
  }

  /** 发一张图片（表格出图）。返回 true = 送达。 */
  async sendImage(chatId, path) {
    const { code, err } = await runInbox(['send-image', '--path', path, '--chat-id', chatId], { timeoutMs: 90000 })
    if (code === 0) {
      this.lastOutboundAt = new Date().toISOString()
      return true
    }
    this.logger?.warn(`[phone-link] send-image exited ${code}: ${String(err).slice(0, 200)}`)
    return false
  }

  /**
   * 回执/告警类消息：不重试、不抛、失败也要留痕。
   * 旧版只 logger.warn，桌面版的 logger 只有控制台，用户永远看不到（需求表 P1-6）。
   */
  notify(chatId, text) {
    void runInbox(['send', '--chat-id', chatId, '--text', text], { timeoutMs: 90000 })
      .then(({ code, err }) => {
        if (code === 0) return
        const reason = `回执发不出去 (exit ${code}): ${String(err || '').slice(0, 160)}`
        this.warn(reason)
        trace(`notify failed chat=${chatId} err=${String(err || '').slice(0, 200)}`)
      })
      .catch((error) => {
        this.warn(`回执发不出去: ${String(error?.message || error).slice(0, 160)}`)
      })
  }
}
