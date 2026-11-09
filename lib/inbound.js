/**
 * 入站：手机 → 会话。
 *
 * 每个绑定的飞书聊天挂一个常驻 `lark-inbox.py wait` 子进程（IN-1）。它把新消息
 * 打成一行 JSON 就退出，我们立刻接下一轮（IN-2/IN-3）；收到的每条消息按
 * message_id 去重后注入绑定会话（IN-4/IN-6），失败重试一次并回执手机（IN-7）。
 *
 * 这里也是唯一改动绑定/连接状态的地方（bind/unbind/connect/disconnect），
 * http.js 只是转调。
 */
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bareId, canonicalSessionId, ensureCursor, trace } from './config.js'
import { runInbox, sleep, spawnPoller } from './proc.js'

/** 手机上认得的命令；其它 `/` 开头的内容当普通消息投递，不吞（IN-9）。 */
const COMMANDS = new Set(['/ping', '/help', '/status', '/use'])

/** 轮询进程活得比这个久之后 exit 0/3 才算「正常换班」，否则按启动失败退避。 */
const MIN_POLLER_LIFETIME_MS = 1000

export class Inbound {
  constructor(core) {
    this.core = core
    this.logger = core.logger
    this.pollers = new Map()
    this.failures = new Map()
    this.timers = new Set()
    /** 每次 stop() 自增：旧进程的 exit 回调据它判断自己是不是已经被换掉的一代。 */
    this.generation = 0
    /** 正在注入中的 message id，防止 poller 与 /flush 同时投同一条。 */
    this.inflight = new Set()
    /** `agents.resume()` 出来的 handle，按 sessionId 缓存，省掉每条消息都复活一次。 */
    this.handles = new Map()
  }

  schedule(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }

  /** 停掉所有轮询进程与待执行的重连定时器。不改 enabled —— 那是用户的选择。 */
  stop() {
    this.generation += 1
    for (const child of this.pollers.values()) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    this.pollers.clear()
    this.failures.clear()
    this.inflight.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.core.pollerCount = 0
  }

  /** 插件卸载/重载时调用：只停子进程，下次启动仍按 enabled 自动接通。 */
  dispose() {
    this.stop()
    // 只丢缓存，不 dispose handle：resume 出来的 agent 归宿主所有，
    // 插件重载时把它关掉会打断用户正在看的那一轮。
    this.handles.clear()
  }

  async start() {
    this.core.config.enabled = true
    this.core.save()
    if (this.core.bindings.length === 0) {
      this.stop()
      this.core.state = 'idle'
      this.core.lastError = '还没有绑定飞书聊天到会话'
      return this.core.status()
    }
    // 先干净换一代：旧版 connect() 里 stopPollers 之后旧进程的 exit 回调还会
    // 各自拉一个新的，点两次「接通」就变成两个 poller 抢同一个游标。
    this.stop()
    // 标题只是显示用：先异步拉一次，面板和 /use 才有中文名字可显示
    void this.refreshTitles(8)
    this.core.state = 'connecting'
    this.core.clearError()
    for (const binding of this.core.bindings) this.spawn(binding)
    // 子进程稳稳活着 1 秒就算接通：spawn 失败是异步 'error'/'exit'，会自己把 state 打回 error
    this.schedule(() => {
      if (this.pollers.size > 0 && this.core.state === 'connecting') this.core.state = 'connected'
    }, 1000)
    return this.core.status()
  }

  disconnect() {
    this.core.config.enabled = false
    this.core.save()
    this.stop()
    this.core.state = 'idle'
    return this.core.status()
  }

  bind(chatId, sessionId, chatName) {
    const chat = String(chatId || this.core.config.defaultChat || '').trim()
    const session = canonicalSessionId(sessionId)
    if (!chat.startsWith('oc_')) throw new Error('chat id must look like oc_xxx')
    if (!/^session-/.test(session) && !/^lark-link:/.test(session)) throw new Error('session id must look like session-xxx')
    const existing = this.core.bindings.find((item) => item.chatId === chat)
    if (existing) {
      existing.sessionId = session
      if (chatName) existing.chatName = chatName
    } else {
      this.core.bindings.push({
        id: `bind-${Date.now().toString(36)}`,
        chatId: chat,
        chatName: chatName || (chat === this.core.config.defaultChat ? '飞书私聊' : chat),
        sessionId: session,
      })
    }
    this.core.save()
    if (this.core.config.enabled) void this.start().catch((error) => this.core.fail(error, 'bind'))
    return this.core.status()
  }

  unbind(chatId) {
    this.core.config.bindings = this.core.bindings.filter((item) => item.chatId !== chatId)
    this.core.save()
    this.stop()
    if (this.core.config.enabled) void this.start().catch((error) => this.core.fail(error, 'unbind'))
    return this.core.status()
  }

  spawn(binding) {
    const gen = this.generation
    // 轮询间隔走 config，改 config + 重新连接即可生效，不必重启 DSH。
    const args = [
      'wait',
      '--minutes',
      String(this.core.config.pollMinutes || 20),
      '--interval',
      String(this.core.config.pollSeconds || 5),
      '--chat-id',
      binding.chatId,
    ]
    let child
    try {
      // 游标按聊天隔离（见 config.js 的 CURSOR_DIR）：这一路的 wait 和 drain 共用一个文件。
      // 路径同时用 --state 写在命令行上：环境变量在子进程里看不见，出问题查不动
      // （2026-11-09 就是卡在这 —— poller 一直写旧路径，日志里毫无线索）。
      const state = ensureCursor(binding.chatId)
      args.push('--state', state)
      child = spawnPoller(args, { DSH_LARK_INBOX_STATE: state })
    } catch (error) {
      this.core.fail(error, 'spawn poller')
      return
    }
    const startedAt = Date.now()
    this.pollers.set(binding.chatId, child)
    this.core.pollerCount = this.pollers.size

    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) this.onLine(binding, line)
        index = buffer.indexOf('\n')
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) this.logger?.warn(`[phone-link] poller stderr: ${text.slice(0, 400)}`)
    })
    child.on('error', (error) => {
      if (gen === this.generation) this.core.fail(error, 'poller')
    })
    child.on('exit', (code) => this.onExit(binding, child, code, gen, startedAt))
  }

  onExit(binding, child, code, gen, startedAt) {
    if (this.pollers.get(binding.chatId) === child) {
      this.pollers.delete(binding.chatId)
      this.core.pollerCount = this.pollers.size
    }
    // 被 stop()/start() 主动换掉的老一代：exit 只是收尸，不许再拉新进程
    if (gen !== this.generation) return
    if (!this.core.config.enabled) return
    const lived = Date.now() - startedAt
    // 正常换班：wait 到期(3) 或本轮已经投递完(0)。立刻接下一轮，不算故障。
    if ((code === 0 || code === 3) && lived >= MIN_POLLER_LIFETIME_MS) {
      this.failures.delete(binding.chatId)
      this.spawn(binding)
      return
    }
    // 异常退出才退避：连不上飞书时别每秒重开一个 python 进程（1s → 30s 封顶）
    const failures = (this.failures.get(binding.chatId) || 0) + 1
    this.failures.set(binding.chatId, failures)
    const delay = Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5))
    this.core.warn(
      lived < MIN_POLLER_LIFETIME_MS
        ? `轮询进程 ${binding.chatId} 起来 ${lived}ms 就退出了（exit ${code}），${Math.round(delay / 1000)}s 后重试`
        : `轮询进程退出 ${code}（第 ${failures} 次），${Math.round(delay / 1000)}s 后重试`,
    )
    this.schedule(() => this.spawn(binding), delay)
  }

  onLine(binding, line) {
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      return
    }
    // 轮询进程活着并且在新数据 = 链路是通的
    this.failures.delete(binding.chatId)
    if (this.core.state !== 'connected') this.core.state = 'connected'
    if (this.core.lastError) this.core.clearError()
    // 新协议是 { items: [...], truncated }，旧协议是裸数组
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
    if (payload?.truncated) this.core.warn('积压消息超过上限，最早的一批被跳过了')
    for (const item of items) {
      const head = String(item?.text || '').trim().split(/\s+/)[0].toLowerCase()
      const run = COMMANDS.has(head) ? this.handleCommand(binding, item) : this.deliver(binding, item)
      void run.catch((error) => this.core.fail(error, 'inbound'))
    }
  }

  async deliver(binding, item) {
    const id = item?.id
    const text = String(item?.text || '').trim()
    if (!text && !item?.path) return
    if (this.core.seen(id)) {
      this.logger?.info(`[phone-link] skipped already-delivered message ${id}`)
      return
    }
    if (id && this.inflight.has(id)) return
    // 图片/文件已经在 lark-inbox.py 里下载好了，注入的是本地路径
    const body = item?.path ? `📱 [${item.kind === 'image' ? '图片' : '文件'}] ${item.path}` : `📱 ${text}`
    if (id) this.inflight.add(id)
    let lastError = null
    try {
      for (const attempt of [1, 2]) {
        try {
          await this.inject(binding, body, id)
          // 只有投进去了才记账：失败的消息留着，下一次 /flush 还能重试
          this.core.remember(id)
          return
        } catch (error) {
          lastError = error
          this.logger?.warn(`[phone-link] deliver attempt ${attempt} failed: ${String(error?.message || error)}`)
          if (attempt === 1) await sleep(800)
        }
      }
      this.core.fail(lastError, `deliver to ${binding.sessionId}`)
      // logger 在桌面版只有控制台，用户看不到；失败原因落到 boot.log，事后能查
      trace(`deliver failed id=${id || '?'} err=${String(lastError?.message || lastError).slice(0, 300)}`)
      // 不静默失败：告诉手机端这条没送进去
      this.core.notify(binding.chatId, `⚠️ 这条没送进会话：${String(lastError?.message || lastError).slice(0, 120)}`)
    } finally {
      if (id) this.inflight.delete(id)
    }
  }

  /**
   * 拿到目标会话的 agent。
   *
   * 走的是宿主公开的 `ctx.agents`（`get()` 取已活的，没有就 `resume()` 复活），
   * **不是** `sessionController` —— 那个服务在本 Host 里根本不存在，旧版每次都抛
   * 「不能打开会话」，这就是「出站通、入站从未跑通」的根因。
   *
   * resume 出来的 handle 归宿主所有，插件卸载时不 dispose 它（会打断正在进行的一轮），
   * 只把缓存丢掉，代际交给宿主进程自己收拾。
   */
  async resolveAgent(target) {
    const ctx = this.core.ctx
    const agents = (typeof ctx.get === 'function' ? ctx.get('agents') : undefined) ?? ctx.agents
    if (!agents || typeof agents.get !== 'function') {
      throw new Error('这台 Host 没有 agents 服务，手机消息没法送进会话')
    }
    const live = agents.get(target)
    if (live) return live
    const cached = this.handles.get(target)
    if (cached?.agent) return cached.agent
    if (typeof agents.resume !== 'function') {
      throw new Error(`会话 ${target} 没开着，且这台 Host 不支持 resume`)
    }
    const handle = await agents.resume({ resumeSessionId: target })
    if (!handle?.agent) throw new Error(`resume 没有返回 agent（${target}）`)
    this.handles.set(target, handle)
    return handle.agent
  }

  async inject(binding, body, messageId) {
    const ctx = this.core.ctx
    if (typeof this.core.buildUserMessage !== 'function') throw new Error('缺少 createUserMessage 构造器')
    const target = canonicalSessionId(binding.sessionId)
    const agent = await this.resolveAgent(target)
    if (typeof agent.followup !== 'function') throw new Error(`这个 agent 不能接收消息（${target}）`)
    try {
      agent.followup(this.core.buildUserMessage(body))
    } catch (error) {
      // agent 可能已经被宿主回收，下次重新 resume。
      this.handles.delete(target)
      throw error
    }
    // flush 的返回值只表示「有没有 durability listener 参与」；false 不代表没投进去，
    // 这时候重投反而会让会话里出现两条一样的消息，所以只记一笔，不当失败处理。
    if (agent.session && typeof ctx.sessions?.flush === 'function' && !(await ctx.sessions.flush(agent.session))) {
      trace(`flush unconfirmed id=${messageId || '?'} into ${binding.sessionId}`)
    }
    this.failures.delete(binding.chatId)
    const at = new Date().toISOString()
    this.core.noteInbound({ id: messageId, at, text: body.slice(0, 120), sessionId: binding.sessionId })
    trace(`delivered id=${messageId || '?'} into ${binding.sessionId}`)
    this.logger?.info(`[phone-link] delivered ${messageId || '?'} into ${binding.sessionId}`)
  }

  /**
   * 手机发来的斜杠命令：本地处理，不注入会话（否则每条 /status 都要烧一轮 token）。
   */
  /** core 由外部注入：标题是装饰功能，取不到不该让命令失败（单测里的假 core 就没有）。 */
  async refreshTitles(count = 8) {
    try {
      await this.core.refreshTitles?.(count)
    } catch {
      /* 标题只是显示 */
    }
  }

  label(sessionId) {
    try {
      return this.core.labelOf?.(sessionId) || String(sessionId || '')
    } catch {
      return String(sessionId || '')
    }
  }

  async handleCommand(binding, item) {
    const text = String(item?.text || '').trim()
    const [raw, ...rest] = text.split(/\s+/)
    const command = String(raw || '').toLowerCase()
    const argument = rest.join(' ').trim()
    const say = (message) => this.core.notify(binding.chatId, message)
    try {
      if (command === '/ping') return say('🏓 pong')
      if (command === '/help') {
        return say(
          [
            '📱 手机端命令',
            '/status 连接状态',
            '/use 看当前投递目标（显示会话标题）',
            '/use <会话id前缀> 切到别的会话',
            '/ping 探活',
            '/help 这条命令',
            '',
            '其它任何内容都会送进当前会话，作为你的发言。',
          ].join('\n'),
        )
      }
      if (command === '/status') {
        const poller = this.pollers.get(binding.chatId)
        await this.refreshTitles(8)
        return say(
          [
            '📱 状态',
            `连接：${this.core.state}`,
            `投递到：${this.label(binding.sessionId)}`,
            `轮询：每 ${this.core.config.pollSeconds || 5} 秒（进程 ${poller ? '在跑' : '已停'}）`,
            `最近收到：${this.core.lastInboundAt || '—'}`,
            `最近发出：${this.core.lastOutboundAt || '—'}`,
            `本次已注入：${this.core.injected.length} 条`,
            this.core.lastWarn ? `最近告警：${this.core.lastWarn}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      }
      if (command === '/use') {
        if (!argument) {
          await this.refreshTitles(8)
          const recent = (this.core.recentSessions || [])
            .filter((row) => row.session !== binding.sessionId && row.title)
            .slice(0, 5)
            .map((row) => `· ${row.title}（${bareId(row.session).slice(0, 8)}）`)
          return say(
            [
              '📱 当前投递到：',
              `· ${this.label(binding.sessionId)}`,
              '',
              recent.length ? '最近其它会话：' : '',
              ...recent,
              '',
              '切换：/use <会话id前 8 位>（面板上也能点）',
            ]
              .filter(Boolean)
              .join('\n'),
          )
        }
        if (!/^[0-9a-zA-Z-]{8,}$/.test(argument)) return say('⚠️ 会话 id 至少要 8 个字符，例：/use 2e306081')
        // 只认能真正打开（或恢复）的会话 id，免得切到一个死目标再也收不到回执
        const found = await this.findSession(argument)
        if (found.ambiguous?.length) {
          return say(`⚠️ 以 ${argument} 开头的会话不止一个，多给几位：\n${found.ambiguous.slice(0, 5).join('\n')}`)
        }
        if (found.error) return say(`⚠️ 找会话时出错（不是没找到）：${String(found.error).slice(0, 200)}`)
        if (!found.id) return say(`⚠️ 找不到以 ${argument} 开头的会话`)
        try {
          await this.resolveAgent(found.id)
        } catch (error) {
          return say(`⚠️ 打不开这个会话：${String(error?.message || error).slice(0, 200)}`)
        }
        binding.sessionId = found.id
        this.core.save()
        this.logger?.info(`[phone-link] chat ${binding.chatId} now targets ${found.id}`)
        await this.refreshTitles(8)
        return say(`✅ 已切换到「${this.core.titleOf?.(found.id) || bareId(found.id).slice(0, 8)}」\n下一条消息会送进这个会话`)
      }
      return say(`⚠️ 不认识的命令 ${command}，发 /help 看用法`)
    } catch (error) {
      this.core.fail(error, 'command')
      return say(`⚠️ 命令处理失败：${String(error?.message || error).slice(0, 120)}`)
    }
  }

  /**
   * 按 id 前缀找唯一一个会话。
   * 返回 { id, error, ambiguous }：**扫描失败和找不到必须分开**
   * （旧版两者都返回 null，手机上永远只看到「找不到」，真因是目录读不出来）。
   */
  async findSession(prefix) {
    const needle = bareId(prefix)
    if (!needle) return { id: null, error: null, ambiguous: [] }
    const known = new Set(this.core.bindings.map((item) => item.sessionId).filter(Boolean))
    let scanError = null
    try {
      const agents = this.core.ctx.agents
      const live = typeof agents?.list === 'function' ? agents.list() : [...(agents?.values?.() || [])]
      for (const agent of live) {
        const id = agent?.session?.id
        if (id) known.add(canonicalSessionId(id))
      }
    } catch (error) {
      scanError = `读取已打开会话失败：${String(error?.message || error)}`
    }
    const hit = [...known].find((id) => bareId(id).startsWith(needle))
    if (hit) return { id: canonicalSessionId(hit), error: null, ambiguous: [] }

    const root = join(homedir(), '.dsh', 'sessions')
    let projects
    try {
      projects = await readdir(root)
    } catch (error) {
      return { id: null, error: scanError || `读不到会话目录 ${root}：${String(error?.message || error)}`, ambiguous: [] }
    }
    const matches = new Set()
    for (const project of projects) {
      let entries
      try {
        entries = await readdir(join(root, project))
      } catch (error) {
        scanError ||= `扫描 ${project} 失败：${String(error?.message || error)}`
        continue
      }
      for (const name of entries) {
        if (name.startsWith('session-') && bareId(name).startsWith(needle)) matches.add(canonicalSessionId(name))
      }
    }
    const list = [...matches]
    if (list.length === 1) return { id: list[0], error: null, ambiguous: [] }
    if (list.length > 1) return { id: null, error: null, ambiguous: list }
    return { id: null, error: scanError, ambiguous: [] }
  }

  /** 立即拉一次：把轮询进程还没取走的积压拉出来并投递（与 poller 共用游标，靠去重兜底）。 */
  async flush() {
    const results = []
    for (const binding of this.core.bindings) {
      const state = ensureCursor(binding.chatId)
      const { code, out, err } = await runInbox(['drain', '--chat-id', binding.chatId, '--state', state], {
        timeoutMs: 60000,
        env: { DSH_LARK_INBOX_STATE: state },
      })
      if (code !== 0) {
        this.core.warn(`立即拉一次失败（drain exit ${code}）：${String(err).slice(0, 200)}`)
        continue
      }
      for (const line of out.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'NOOP') continue
        let payload
        try {
          payload = JSON.parse(trimmed)
        } catch {
          continue /* 非 JSON 输出（例如 initialized at ...） */
        }
        const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
        if (payload?.truncated) this.core.warn('积压消息超过上限，最早的一批被跳过了')
        for (const item of items) await this.deliver(binding, item)
        if (items.length) results.push({ chatId: binding.chatId, count: items.length })
      }
    }
    return { ...this.core.status(), flushed: results }
  }

  /** 给每个绑定踢一条探针，用来验证出站链路。 */
  async probe() {
    const sent = []
    for (const binding of this.core.bindings) {
      const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      const ok = await this.core.sendText(binding.chatId, `📶 探针：链接正常（${stamp}）`)
      sent.push({ chatId: binding.chatId, ok })
    }
    if (sent.length === 0) sent.push({ ok: false, reason: 'no_binding' })
    return { ...this.core.status(), probe: sent }
  }
}
