/**
 * 路径、默认值、配置读写、启动痕迹。
 *
 * 这一层只碰文件系统，不认识 ctx、不 spawn 子进程，所以可以脱离宿主单测
 * （见 test/config.test.mjs）。
 *
 * 写盘纪律：
 *   - config.json 走 tmp + rename，写一半被杀也不会留下半个文件；
 *   - 坏 JSON 先备份成 config.json.bad，再退回默认值，绝不静默丢绑定；
 *   - delivered.json 只在投递成功后追加（见 core.js），重启后不会重复投递。
 */
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 数据目录。`DSH_PHONE_LINK_DIR` 可以把它挪走 —— 单测就靠这个把 trace()
 * 的写入挡在临时目录里，否则会把 `delivered id=… into session-a` 这类测试
 * 痕迹写进真正的 boot.log（2026-11-09 真的发生过一次）。
 */
export const DIR = process.env.DSH_PHONE_LINK_DIR || join(homedir(), '.dsh', 'phone-link')
export const CONFIG = join(DIR, 'config.json')
export const BOOT_LOG = join(DIR, 'boot.log')
export const DELIVERED = join(DIR, 'delivered.json')
export const INBOX_SCRIPT = join(homedir(), '.dsh', 'bin', 'lark-inbox.py')
export const TABLE_PNG_SCRIPT = join(homedir(), '.dsh', 'bin', 'table-png.py')

/**
 * 每个聊天一个游标文件。
 *
 * 旧版让 `wait`（常驻轮询）和 `drain`（立即拉一次）共写 `~/.dsh/lark-inbox.json`：
 * 而 `wait` 是**把启动时的整份快照一直放在内存里**、每次整文件回写，于是多绑定时
 * 另一路聊天的游标会被覆盖，被覆盖的那一路下次启动会当成「第一次跑」直接跳过积压
 * ——消息静默丢失（P0-1）。按聊天隔离之后，每个文件的写者只剩同一路的两个进程，
 * 写的是同一个值，最坏情况只是重复取一次（再由 delivered.json 去重）。
 */
export const CURSOR_DIR = join(DIR, 'cursor')
/** 旧版的单一游标文件，只用来给新文件做一次位置迁移。 */
export const LEGACY_CURSOR = join(homedir(), '.dsh', 'lark-inbox.json')

export function cursorFile(chatId) {
  const safe = String(chatId || 'default').replace(/[^0-9A-Za-z_-]/g, '_')
  return join(CURSOR_DIR, `${safe}.json`)
}

/** 新建游标文件时把旧文件的 last_id 搬过来，免得第一次 wait 把积压当历史吞掉。 */
export function ensureCursor(chatId) {
  const file = cursorFile(chatId)
  try {
    statSync(file)
    return file
  } catch {
    /* 还没有，继续往下建 */
  }
  let lastId = null
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_CURSOR, 'utf8'))
    lastId = legacy?.chats?.[chatId]?.last_id ?? legacy?.last_id ?? null
  } catch {
    /* 没有旧文件或者坏了，就当第一次跑 */
  }
  try {
    mkdirSync(CURSOR_DIR, { recursive: true })
    writeFileSync(file, JSON.stringify({ chats: { [chatId]: { last_id: lastId } } }), 'utf8')
  } catch {
    /* 写不了就让 python 自己建，它用的是同一个路径 */
  }
  return file
}

export const BOOT_LOG_LIMIT = 100 * 1024
export const BODY_LIMIT = 64 * 1024
/** 去重表长度：手机上连发几十条也够用，文件也只有几 KB。 */
export const RECENT_IDS = 200

/**
 * 默认配置。`defaultChat` 只在这里出现一次 —— 面板通过 `/status` 读它，
 * 不再各处硬编码 chatId（旧版 index.js 和 client.js 各写了一份）。
 * 换机器 / 换群时改 `~/.dsh/phone-link/config.json` 即可，不用动代码。
 */
export const DEFAULTS = Object.freeze({
  enabled: false,
  pollSeconds: 5,
  pollMinutes: 20,
  mirrorReplies: true,
  mirrorScheduled: false,
  defaultChat: '',
  bindings: [],
})

/** `session-xxx` 是规范形态；绑定、/use、resolveAgent 全走这一个函数，别让裸 id 漏进来。 */
export function canonicalSessionId(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.startsWith('lark-link:')) return text
  return text.startsWith('session-') ? text : `session-${text}`
}

export const bareId = (id) => String(id || '').trim().replace(/^session-/, '')

/**
 * 启动痕迹：模块被 import、apply 被调用、投递成功/失败各写一行。
 * 用来区分「没挂载」/「挂了但 pending」/「已激活」，也是事后唯一能查的现场。
 * 同步写 + 超 100KB 收敛到末 200 行：投递频率很低，阻塞可以忽略。
 */
export function trace(step) {
  try {
    mkdirSync(DIR, { recursive: true })
    try {
      if (statSync(BOOT_LOG).size > BOOT_LOG_LIMIT) {
        const kept = readFileSync(BOOT_LOG, 'utf8').split('\n').slice(-200).join('\n')
        writeFileSync(BOOT_LOG, kept, 'utf8')
      }
    } catch {
      /* first run: nothing to rotate */
    }
    appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${step}\n`, 'utf8')
  } catch {
    /* tracing must never break the plugin */
  }
}

const withDefaults = (parsed) => ({ ...DEFAULTS, ...parsed, bindings: Array.isArray(parsed?.bindings) ? parsed.bindings : [] })

/** 读配置。返回 { config, error }；error 非空表示用了默认值并写下了原因。 */
export function readConfig() {
  let raw
  try {
    raw = readFileSync(CONFIG, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: withDefaults({}), error: null }
    return { config: withDefaults({}), error: String(error?.message || error) }
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.json 不是对象')
    return { config: withDefaults(parsed), error: null }
  } catch (error) {
    try {
      copyFileSync(CONFIG, `${CONFIG}.bad`)
    } catch {
      /* best effort */
    }
    return { config: withDefaults({}), error: String(error?.message || error) }
  }
}

/**
 * 原子写：先写 .tmp 再 rename。
 * Windows 上 rename 偶发 EPERM（杀毒/搜索索引占着目标文件），再试一次；
 * 还不行就直接覆盖写 —— 宁可失去原子性，也不能让「改配置」这个动作静默失败。
 */
export function writeConfig(config) {
  mkdirSync(DIR, { recursive: true })
  const tmp = `${CONFIG}.tmp`
  const payload = `${JSON.stringify(config, null, 2)}\n`
  writeFileSync(tmp, payload, 'utf8')
  try {
    renameSync(tmp, CONFIG)
  } catch {
    try {
      renameSync(tmp, CONFIG)
    } catch {
      writeFileSync(CONFIG, payload, 'utf8')
    }
  }
}

/** 已投递消息 id 的持久化环形表：poller 与 drain 会抢同一条，重启后也不能重投。 */
export function loadDelivered() {
  try {
    const parsed = JSON.parse(readFileSync(DELIVERED, 'utf8'))
    const ids = Array.isArray(parsed?.ids) ? parsed.ids.filter((id) => typeof id === 'string') : []
    return ids.slice(-RECENT_IDS)
  } catch {
    return []
  }
}

export function saveDelivered(ids) {
  try {
    mkdirSync(DIR, { recursive: true })
    const tmp = `${DELIVERED}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ ids: ids.slice(-RECENT_IDS) }, null, 0)}\n`, 'utf8')
    renameSync(tmp, DELIVERED)
  } catch {
    /* 去重表写不进去不影响投递，重启后最坏重投一次 */
  }
}
