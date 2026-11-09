/**
 * 子进程封装。所有 spawn 都走这一层：超时、编码、错误收集只写一遍。
 *
 * 契约见需求表 §5，别改参数形状（python 侧同步改）：
 *   lark-inbox.py wait --minutes N --interval S --chat-id X
 *   lark-inbox.py drain --chat-id X            → 每行一个 JSON，无消息 NOOP
 *   lark-inbox.py send --chat-id X --text T    → exit 0 = 成功
 *   lark-inbox.py send-image --path P --chat-id X
 *   table-png.py                               → stdin {title,columns,rows}，stdout 末行 = PNG 路径
 */
import { spawn } from 'node:child_process'
import { INBOX_SCRIPT, TABLE_PNG_SCRIPT } from './config.js'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 解释器可被环境变量覆盖：自检脚本靠这个注入一个假 python。 */
export const PYTHON = () => process.env.DSH_PHONE_LINK_PYTHON || 'python'

export const childEnv = (extra) => ({ ...process.env, PYTHONIOENCODING: 'utf-8', ...extra })

/**
 * 跑一个 python 脚本并收齐结果。
 * 返回 { code, out, err }；超时、spawn 失败、'error' 事件时 code 为 -1。
 */
export function runScript(script, args, { input, timeoutMs = 60000, env } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(PYTHON(), [script, ...args], { windowsHide: true, env: childEnv(env) })
    } catch (error) {
      return resolve({ code: -1, out: '', err: String(error?.message || error) })
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out, err })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish(-1)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (part) => {
      out += part
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (part) => {
      err += part
    })
    child.on('error', (error) => {
      err += String(error?.message || error)
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
}

export const runInbox = (args, options) => runScript(INBOX_SCRIPT, args, options)

export const runTablePng = (spec) =>
  runScript(TABLE_PNG_SCRIPT, [], { input: JSON.stringify(spec), timeoutMs: 60000 })

/** 长驻轮询子进程：调用方负责 attach 事件、超时和换班，这里只管 spawn。 */
export function spawnPoller(args, env) {
  return spawn(PYTHON(), [INBOX_SCRIPT, ...args], { windowsHide: true, env: childEnv(env) })
}
