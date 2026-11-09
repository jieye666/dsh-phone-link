/**
 * 单测用的沙箱：把插件的数据目录挪到临时目录。
 *
 * 为什么需要它：trace() / config 落盘都按真实 `~/.dsh/phone-link` 走，测试一旦
 * 触发投递就会往**生产** boot.log 里写 `delivered id=… into session-a`
 * （2026-11-09 真事）。config.js 支持 `DSH_PHONE_LINK_DIR` 覆盖，这里在模块
 * 顶层把它设好。
 *
 * 用法：必须是文件里的**第一个** import —— ESM 的 import 会被提升，只有排在前
 * 面的模块才会先求值，排在 'node:test' 或 ../lib/*.js 后面就来不及了。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.DSH_PHONE_LINK_DIR) {
  process.env.DSH_PHONE_LINK_DIR = mkdtempSync(join(tmpdir(), 'phone-link-test-'))
}

export const SANDBOX_DIR = process.env.DSH_PHONE_LINK_DIR
