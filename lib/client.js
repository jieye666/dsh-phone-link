window.__ModuleLoader__.load({
  id: 'dsh-phone-link',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement
    const useState = react.useState
    const useEffect = react.useEffect

    const TAB_ID = 'phone-link'
    const API = '/plugins/phone-link'
    // 面板版本：主机端 boot.log 会记下还在用旧 bundle 的客户端。改面板行为时一起加。
    const CLIENT_VERSION = '0.4.0'

    /**
     * 打一个动作。
     * 除 status / inspect 之外一律 POST（主机端写路由只收 POST，GET 只剩兼容旧 bundle 的作用）；
     * 万一服务端比我们还新、已经把 GET 关掉，退回 GET 再试一次，别让按钮变哑。
     */
    async function call(action, body) {
      const write = action !== 'status' && action !== 'inspect'
      const fire = (method) =>
        fetch(`${API}/${action}`, {
          method,
          headers: {
            'x-phone-link-client': CLIENT_VERSION,
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
          },
          body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
          cache: 'no-store',
        })
      let response = await fire(write ? 'POST' : 'GET')
      if (write && response.status === 405) response = await fire('GET')
      return await response.json()
    }

    function useStatus(active, intervalMs) {
      const [status, setStatus] = useState(null)
      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const tick = async () => {
          try {
            const next = await call('status')
            if (alive) setStatus(next)
          } catch {
            /* host not ready */
          }
        }
        void tick()
        const timer = setInterval(tick, intervalMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [active, intervalMs])
      return [status, setStatus]
    }

    /**
     * 手机消息原文只走栅栏后的 /inspect（免栅栏的 /status 不带它，本机任意进程都能读）。
     * 取不到就整块隐藏 —— 面板该能用，原文看不到不影响按钮。
     */
    function useInspect(active) {
      const [data, setData] = useState(null)
      useEffect(() => {
        if (!active) return undefined
        let alive = true
        const tick = async () => {
          try {
            const next = await call('inspect')
            if (!alive) return
            setData(next && next.ok !== false ? next : null)
          } catch {
            if (alive) setData(null)
          }
        }
        void tick()
        const timer = setInterval(tick, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [active])
      return data
    }

    /** 窗口/标签页在后台时别每 2 秒问一次宿主。 */
    function useDocVisible() {
      const [visible, setVisible] = useState(() =>
        typeof document === 'undefined' ? true : document.visibilityState !== 'hidden')
      useEffect(() => {
        const onChange = () => setVisible(document.visibilityState !== 'hidden')
        document.addEventListener('visibilitychange', onChange)
        return () => document.removeEventListener('visibilitychange', onChange)
      }, [])
      return visible
    }

    const box = { padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' }
    const card = { border: '1px solid var(--dsh-border, rgba(128,128,128,.3))', borderRadius: '8px', padding: '10px' }
    const label = { opacity: 0.65, fontSize: '12px' }
    const row = { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }

    function dot(color) {
      return h('span', {
        style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: color },
      })
    }

    function stateColor(state) {
      if (state === 'connected') return '#2eb872'
      if (state === 'error') return '#e0533d'
      if (state === 'connecting') return '#e0a13d'
      return 'var(--dsh-text-tertiary, #999)'
    }

    function ago(iso) {
      if (!iso) return '—'
      const ms = Date.now() - new Date(iso).getTime()
      if (!Number.isFinite(ms) || ms < 0) return iso.slice(11, 19)
      if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} 秒前`
      if (ms < 3600000) return `${Math.round(ms / 60000)} 分钟前`
      if (ms < 86400000) return `${Math.round(ms / 3600000)} 小时前`
      return `${Math.round(ms / 86400000)} 天前`
    }

    function PhonePane(props) {
      const sessionId = props.sessionId
      const visible = useDocVisible()
      const active = props.active ?? visible
      const [status, setStatus] = useStatus(active, visible ? 2000 : 15000)
      const inspect = useInspect(active)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)

      const enabled = status?.enabled === true
      const bound = (status?.bindings ?? []).some((item) => item.sessionId === sessionId)
      const state = status?.state ?? 'idle'
      const chatId = status?.defaultChat || ''
      const injected = inspect?.injected ?? []

      const act = async (action, body) => {
        setBusy(true)
        setError(null)
        try {
          const next = await call(action, body)
          setStatus(next)
          if (next && next.ok === false) setError(next.message || next.code || '失败')
        } catch (cause) {
          setError(String(cause?.message || cause))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: box },
        h(
          'div',
          { style: row },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, dot(stateColor(state)), h('strong', null, '手机连接')),
          h('span', { style: label },
            state === 'connected' ? '已连接' : state === 'error' ? '错误' : state === 'connecting' ? '连接中' : '未连接'),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: row },
            h('span', { style: label }, '当前会话'),
            h('code', { style: { fontSize: '11px', opacity: 0.8 } }, sessionId || '未知'),
          ),
          h('div', { style: { height: '6px' } }),
          h('button', {
            disabled: busy || !sessionId || !chatId,
            onClick: () => act('bind', { sessionId, chatId }),
            style: { width: '100%', padding: '6px', cursor: busy || !chatId ? 'not-allowed' : 'pointer' },
          }, bound ? '重设绑定（本会话 ↔ 飞书聊天）' : '把飞书聊天绑定到这个会话'),
          chatId
            ? null
            : h('div', { style: { ...label, marginTop: '6px' } }, '配置里没有 defaultChat，先在 ~/.dsh/phone-link/config.json 里填 oc_ 开头的 chat id'),
        ),
        h(
          'button',
          {
            disabled: busy || !status,
            onClick: () => act(enabled ? 'disconnect' : 'connect'),
            style: { padding: '8px', fontSize: '14px', cursor: 'pointer', fontWeight: 600 },
          },
          busy ? '处理中…' : enabled ? '断开手机' : '接通手机',
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '6px' } },
          h('button', {
            disabled: busy || !status,
            onClick: () => act('probe'),
            style: { flex: 1, padding: '6px', cursor: 'pointer', fontSize: '12px' },
          }, '发探针到手机'),
          h('button', {
            disabled: busy || !status,
            onClick: () => act('flush'),
            style: { flex: 1, padding: '6px', cursor: 'pointer', fontSize: '12px' },
          }, '立即拉一次'),
        ),
        error || status?.lastError
          ? h('div', { style: { color: '#e0533d', fontSize: '12px', whiteSpace: 'pre-wrap' } }, error || status.lastError)
          : null,
        status?.lastWarn
          ? h('div', { style: { color: '#e0a13d', fontSize: '12px', whiteSpace: 'pre-wrap' } }, `⚠️ ${status.lastWarn}`)
          : null,
        h(
          'div',
          { style: card },
          h('div', { style: label }, '绑定'),
          ...(status?.bindings ?? []).length === 0
            ? [h('div', { key: 'empty', style: label }, '还没有绑定')]
            : (status.bindings ?? []).map((binding) =>
                h(
                  'div',
                  { key: binding.chatId, style: { ...row, marginTop: '6px' } },
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden' } },
                    h('span', null, binding.chatName || binding.chatId),
                    h('span', { style: { fontSize: '12px', opacity: 0.85 } },
                      (status?.titles && status.titles[binding.sessionId]) || String(binding.sessionId).replace(/^session-/, '').slice(0, 8)),
                  ),
                  h('button', {
                    disabled: busy,
                    onClick: () => act('unbind', { chatId: binding.chatId }),
                    style: { cursor: 'pointer', fontSize: '12px' },
                  }, '解绑'),
                ),
              ),
        ),
        injected.length === 0
          ? null
          : h(
              'div',
              { style: card },
              h('div', { style: label }, '最近注入'),
              ...injected.slice(-3).reverse().map((item) =>
                h('div', { key: item.id, style: { marginTop: '4px', fontSize: '12px', opacity: 0.85 } },
                  `${(item.at || '').slice(11, 16)} ${item.text}`),
              ),
            ),
        h(
          'div',
          { style: card },
          h('div', { style: label }, '收发'),
          h('div', { style: { marginTop: '4px', fontSize: '12px' } }, `手机 → 电脑：${ago(status?.lastInboundAt)}`),
          h('div', { style: { marginTop: '2px', fontSize: '12px' } }, `电脑 → 手机：${ago(status?.lastOutboundAt)}`),
          h('div', { style: { marginTop: '6px', fontSize: '11px', opacity: 0.65 } },
            `每 ${status?.pollSeconds ?? 5} 秒查一次 · 轮询进程 ${status?.pollers ?? 0} 个 · 回推 ${status?.mirrorReplies === false ? '关' : '开'}`),
          h('div', { style: { marginTop: '2px', fontSize: '11px', opacity: 0.65 } },
            `定时任务轮次${status?.mirrorScheduled ? '也' : '不'}推手机`),
          h('div', { style: { marginTop: '2px', fontSize: '11px', opacity: 0.5 } }, `面板 v${CLIENT_VERSION}`),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: label }, '手机上可以直接发'),
          ...['/status 看这条链路的状态', '/use 看绑定；/use 会话id前几位 切会话', '/ping 探活', '/help 用法'].map((line, index) =>
            h('div', { key: `cmd-${index}`, style: { marginTop: '3px', fontSize: '12px', opacity: 0.8 } }, line)),
          h('div', { style: { marginTop: '6px', fontSize: '11px', opacity: 0.6 } }, '命令在插件里处理，不进会话、不烧 token。'),
        ),
      )
    }

    function PhoneTitle() {
      return h('span', null, '手机')
    }

    const injectServices = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      // 参考 dsh-client-ui-sidebar-terminal / dsh-better-sidebar 的写法：服务经 ctx.inject 取用
      ctx.inject(['sidebarRightTabs'], (injected) => {
        const tabs = injected.get('sidebarRightTabs')
        if (tabs === undefined) return
        return tabs.register({
          id: TAB_ID,
          kind: TAB_ID,
          multiple: false,
          keepMounted: true,
          priority: 'extension',
          title: () => '手机',
          guide: [{
            id: 'phone-link-open',
            order: 20,
            title: () => '手机连接',
            description: () => '把飞书聊天接到这个会话，按钮直连、不经过模型',
          }],
        })
      })

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        inject: (sessionId) => ({ sessionId }),
      }, PhonePane)), 'phone-link.body')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
        inject: () => ({}),
      }, PhoneTitle)), 'phone-link.title')
    }

    exports.inject = injectServices
    exports.apply = apply
    return module.exports
  },
})
