# dsh-phone-link

把飞书私聊接到**指定的 DSH 会话**：右侧栏「手机」tab 上一个按钮直连，不看模型脸色。

- 不上模型、不烧 token：按钮直接 `fetch('/plugins/phone-link/...')`，宿主半边自己起轮询子进程。
- 消息真的会唤醒会话：`ctx.agents.get(id)` 取活着的 agent（没有就 `ctx.agents.resume({ resumeSessionId })` 复活），
  再 `agent.followup(createUserMessage(...))` 投进它的收件箱（`agent.inject` 只排队、不唤醒，这里不用），
  最后 `ctx.sessions.flush(...)` 确认写入。
- 旧版走的 `ctx.get('sessionController')` 在本 Host **根本不存在**，这是 0.3.x「出站通、入站从没跑通」的根因。

## 组成

| 文件 | 作用 |
| --- | --- |
宿主半边拆成 8 个小文件（0.4.0，原来是 806 行一个 `index.js`）：

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 组装层：`name` / `inject` / `apply(ctx)`，只接线不干活 |
| `lib/config.js` | 路径、默认值、`config.json` 读写、`delivered.json`、按聊天的游标文件 |
| `lib/proc.js` | python 子进程封装（`wait` / `drain` / `send` / `table-png`），超时与编码只写一遍 |
| `lib/message.js` | 唯一静态 `import` `@deepseek-ai/dsh-llm` 的地方（`createUserMessage`） |
| `lib/core.js` | 共享状态 + 出站发送原语（`sendText` / `sendImage` / `notify`） |
| `lib/inbound.js` | 轮询子进程、去重、注入、手机命令（`/status` `/use` `/ping` `/help`） |
| `lib/outbound.js` | `session/event` → 一轮合并成一条 → 降级 → 推送 |
| `lib/http.js` | `/plugins/phone-link/*` 路由与浏览器栅栏 |
| `lib/client.js` | 浏览器半边：注册 `sidebarRightTabs` 的「手机」tab + 面板体；可见时 2 秒轮询，后台 15 秒 |
| `lib/render.js` | 手机侧渲染降级：`dsh-ui` 围栏 → 文本行，表格单独出图；`chunk()` 分段 |
| `test/*.test.mjs` | `node --test` 单测：配置、渲染、入站、出站、HTTP、冒烟（82 例） |
| `cordis.patch.yml` | 让宿主 `insert` 这个插件 |
| `~/.dsh/bin/lark-inbox.py` | 传输层：`wait` / `drain` / `send` / `init`，按 `--chat-id` 记账 |
| `~/.dsh/phone-link/config.json` | `{enabled, pollMinutes, bindings[{id, chatId, chatName, sessionId}]}` |

## 装 / 改 / 卸

```bash
dsh plugin --profile desktop add file:C:/Users/LENOVO/.dsh/src/dsh-phone-link
# 改完必须重装：pnpm 把 file: 依赖拷进 node_modules，不会跟着源码变
dsh plugin --profile desktop remove dsh-phone-link
dsh plugin --profile desktop add file:C:/Users/LENOVO/.dsh/src/dsh-phone-link
```

装完 **必须重启 DSH**（宿主注册路由 + 浏览器重拉 client bundle）。

## HTTP 面

| 路由 | 方法 | 栅栏 | 说明 |
| --- | --- | --- | --- |
| `/plugins/phone-link` `/status` | GET | **不设** | 只读状态，**不含**手机消息原文。`~/.dsh/bin/restart-dsh.ps1` 靠它探活用，别加栅栏 |
| `/inspect` | GET/POST | **要** | 状态 + 最近 10 条注入原文 + 去重表大小，只给本机 GUI 面板用 |
| `/connect` `/disconnect` `/bind` `/unbind` `/flush` `/probe` | POST | **要** | 过 `ctx.connection.requestRejection({ headers: req.headers })`，不是本机 GUI 发起的请求一律 403 |

错误码：未知路由 404、非 GET/POST 405、body 超 64KB 413、坏 JSON 400、动作抛错 500。

- 栅栏存在的理由：GUI 根路径有 401 鉴权，插件路由没有。localhost 上任何进程、或任意网页用
  `content-type: text/plain` 的 simple request（不触发 preflight）都能 POST 过来 ——
  `/probe` 会真的发飞书消息，`/unbind` 能直接把桥拆掉。
- 拿不到 `connection` 服务时**按不可信处理**（写路由全部 403），只留 `GET /status`，fail-closed。

## 手动调试（不点按钮）

```bash
curl -s http://127.0.0.1:<GUI端口>/plugins/phone-link/status   # 唯一能用 curl 打的路由
```

写路由要过浏览器栅栏，`curl` 打过去是 403 —— 这不是 bug，是设计。要手工改绑定就点面板按钮，
或者改完 `~/.dsh/phone-link/config.json` 再点一次「断开 → 接通」。

## 出站（回复自动镜像）

- 订阅宿主事件 `ctx.on('session/event', …)`：`assistant/message` 累积文本块，`turn/end` 时
  把整轮文本一次性 `lark-inbox.py send --chat-id <chat> --text` 推给绑定的飞书聊天。
- 只取 `type === 'text'` 的 content 块，跳过 reasoning / tool；超长按段落切成 ≤3500 字符分条发。
- 表格先在正文里留一句「（表格见下图）」，**正文发完之后**才补表格 PNG，顺序不会反。
- `config.json` 的 `mirrorReplies: false` 可关掉；状态里 `lastOutboundAt` 是最后推送时间。
- 推送失败不会静默：日志记一条，同时回手机一句「⚠️ 这条回复没推到手机」。
- **不要再用 `lark-cli` / `lark-inbox.py send` 手工回话**，会和镜像重复。

## 可调参数（`~/.dsh/phone-link/config.json`）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `pollSeconds` | 5 | 轮询间隔；改完点「断开→接通」即生效，不用重启 DSH |
| `pollMinutes` | 20 | 单个 Python 轮询进程的寿命，到点会自动换新进程（1 秒空档，靠游标补回） |
| `mirrorReplies` | true | 是否把每轮回复推回飞书 |
| `mirrorScheduled` | false | 定时任务触发的轮次要不要也推（默认不推，晨报自己已经发过一次） |
| `defaultChat` | `oc_71649c…8e7f` | 面板「绑定到这个会话」按钮用的飞书 chat；`status` 会带出来给浏览器半边 |

配置写盘是原子的（临时文件 + rename）。真读不出来时原文件会备份成 `config.json.bad` 并在状态里报错，
不会再出现「绑定悄悄全没了」。

## 入站幂等

0.4.0 把游标按聊天拆开了：`~/.dsh/phone-link/cursor/<chatId>.json`，通过 `DSH_LARK_INBOX_STATE`
传给 `lark-inbox.py`（手敲命令时仍用旧的 `~/.dsh/lark-inbox.json`）。第一次运行会把旧文件里的
`last_id` 迁移过来，积压消息不会被当成历史吞掉。

为什么必须拆：`wait` 把启动时的整份状态**一直放在内存里**、每次整文件回写，多绑定时会把另一路聊天
的游标覆盖掉；被覆盖的那一路下次启动会当成「第一次跑」直接跳过积压 —— 消息静默丢失。

同一条消息重复到达仍有三道闸：投递前查 `delivered.json`（落盘，重启后依然有效，保最近 200 条）、
同一条正在投递中（内存 `inflight`）、查完立刻占位。投递**失败不记账**，所以失败的消息下次还能补投。

## 手机侧渲染规则

- 发送走 `lark-inbox.py send` → `lark-cli im +messages-send --markdown -`（内容走 **stdin**）。
  **不能用 `--text`**：命令行参数里带换行时只会发出第一行（2026-11-08 实测，手机上只收到第一段）。
- `forPhone()` 做降级：`dsh-ui` 围栏整段换成「这里是一张图表/表格」，去掉 md 标题井号。
- 入站消息注入时加 `📱 ` 前缀，GUI 里能一眼分出哪条来自手机。

## 已知限制

- 轮询间隔 `pollSeconds`（默认 5 秒），所以手机上发完最多等这么多才进会话；不是秒级。
- 收文本 / 富文本(post) / 图片 / 文件；表情、卡片、系统消息不注入。
- 同一 chat 只能由一处轮询：别同时挂着手工 `lark-inbox.py wait` 后台任务，会抢游标。
- 定时任务仍按 `target.sessionId` 固定投递，与本插件无关；插件的绑定表只管「手机消息进哪个会话」。

## 手机侧渲染（lib/render.js）

飞书消息体（post）**不支持表格**。所以不能把 dsh-ui 围栏原样发过去（一堆 JSON），
也不能整段替换成一句话（手机上就"看不到表格"）。`lib/render.js` 把围栏结构翻译成纯文本：

- `table` → `【列1 ｜ 列2】`，每行 `· a ｜ b`
- `list` → `· 标题：说明`
- `keyvalue` / `stat` / `steps` → 逐条一行
- `chart` / `mermaid` / `diagram` / `code` → 一句「请在电脑上看」
- 正文里手写的 Markdown 表格 → 同样转成 `· a ｜ b`

改完要重装 + 重启 DSH 才生效。注意：pnpm 对同一版本号不会重新拷贝文件，
**新增文件**（如 render.js）可能仍缺失，此时手工
`cp lib/render.js ~/.dsh/profiles/desktop/node_modules/dsh-phone-link/lib/`，或先 bump version。

## 无人值守重启

`~/.dsh/bin/restart-dsh-quiet.cmd [秒数]`：把 `restart-dsh-core.cmd` 交给计划任务执行，
默认等 60 秒（让当前这一轮回复先镜像到手机）再 taskkill + 重新拉起。

两个 .cmd 必须 **CRLF + 纯 ASCII**：LF-only 时 cmd 会把注释行拼在一起当命令执行，
表现为「计划任务没建成、日志里出现莫名报错」。

## 表格出图（~/.dsh/bin/table-png.py）

飞书富文本不支持表格，所以 `dsh-ui` 里的 `table` 节点会被摘出来单独画成 PNG 再当图片发：
`lib/render.js` 的 `phoneParts(text)` 返回 `{ text, tables }`，正文里只留「（表格见下图）」，
`outbound.js` 的 `sendTable()` 逐张 spawn `table-png.py`（stdin 收 JSON、stdout 回 PNG 路径）
再调 `lark-inbox.py send-image`；出图失败就退回 `tableText()` 发纯文本行，
手机上不会只留一句「（表格见下图）」等不到图。

参数都在 `table-png.py` 顶部：`BODY_PX`（30，1x 字号）、`PAD_X/PAD_Y`、`MAX_COL_W`（380，单列上限）、
`SCALE`（2 倍超采样）。emoji 会被剥掉——微软雅黑没有 emoji 字形，画出来是豆腐块。

已知：`lib/` 在 DSH 运行时被锁，改完要靠 `restart-dsh-core.cmd` 里的 `[src-sync]`
（kill 之后、start 之前 copy 源码到 profile node_modules）才能生效。

## 收发能力

**收到手机来的什么**

| 类型 | 处理 |
| --- | --- |
| 文本 / 富文本(post) | post 会摊平成多行纯文本 |
| 图片 / 文件 | `lark-inbox.py` 先下到 `~/.dsh/phone-link/inbox/`，注入的是 `📱 [图片] <本地路径>` |
| 表情 / 卡片 / 其它 | 不注入（以前会把 `{"image_key":...}` 当消息塞进会话） |

离线很久也不会丢：`new_items()` 从最新往回翻页，最多 `MAX_PAGES=10`（10×20 条），
仍然超过 `MAX_MESSAGES=200` 才截断，并且会告诉你有截断。

**命令**（在飞书里直接发，本地处理，不烧 token、不进会话）

- `/status` 连接状态、投递目标、最近收发时间、本次注入条数
- `/use` 看当前投递目标；`/use <会话id前 8 位以上>` 切到别的会话（会先试着打开它，打不开就不切）
- `/ping` 探活；`/help` 用法

**发回手机的回复**

- 表格转成 PNG 图片发（飞书消息体不支持表格），正文只留「（表格见下图）」
- 长回复按段落切成 ≤3500 字符，分条发，标 `(1/3)`；单条失败重试一次
- 定时任务的轮次默认不镜像（`mirrorScheduled: false`），避免晨报双份
- 投递失败会回一条「⚠️ 这条没送进会话」，不静默吞掉

## 自检

```bash
cd ~/.dsh/src/dsh-phone-link && node --test          # 82 例，不碰宿主、不碰飞书
python ~/.dsh/bin/phone-link-selftest.py             # 本地逻辑，不发消息
python ~/.dsh/bin/phone-link-selftest.py --live      # 再跑真实收发 + status 端点
```

- **Node 24 上必须裸跑 `node --test`**：`node --test test` 会报 `Cannot find module`。
- `node --test` 覆盖：配置读写与游标迁移（`config.test`）、渲染降级与分段（`render`/`table`）、
  去重/重试/换班/`/use`（`inbound`）、一轮合并与镜像开关（`outbound`）、栅栏与错误码（`http`），
  以及把 `lib/` 拷到临时目录 + 假 `@deepseek-ai/dsh-llm` 后真 import 的冒烟（`smoke`）。
- python 版覆盖：文本/post/图片提取、跨页补发不丢不重、原子写状态、表格出图。

## 已知取舍

- 入站走 REST 轮询（默认 5 秒）而不是 `lark-cli event consume`：事件总线同一时刻只能挂一个消费者，
  而 CLI 的 bus daemon 会被其它命令抢占；`event consume im.message.receive_v1 --as bot --dry-run`
  实测是 `ready`（凭据/权限/订阅都齐），将来要做实时推送可以从这里接。
- 没有 `/stop`：宿主的会话中断 API 在插件侧不可用。

## 面板上有什么

右侧栏「手机」tab：

- 顶部状态点 + 「接通手机 / 断开手机」大按钮
- 「把飞书私聊绑定到这个会话」/「重设绑定」
- **发探针到手机**：真发一条 `📶 探针` 到飞书，用来确认整条链路是通的
- **立即拉一次**：不等轮询，马上把手机上的新消息收进来
- 收发两个时间（「12 秒前」这种）+ 轮询间隔、轮询进程数、回推是否开、定时任务轮次推不推
- 绑定列表（可解绑）、最近 3 条注入
- 手机端可用命令提示：`/status` `/use` `/ping` `/help`

