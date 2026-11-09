/**
 * 宿主消息构造 —— 唯一一处静态 import `@deepseek-ai/dsh-llm` 的地方。
 *
 * **必须是静态 import**：`await import('@deepseek-ai/dsh-llm')` 走 Node 自己的
 * 解析链，在 profile 里找不到这个包（ERR_MODULE_NOT_FOUND），表现为「轮询活着、
 * 光标在动、消息全丢」。冒烟脚本要自己放一个同名 stub 包（见 test/smoke.mjs）。
 *
 * 单独成文件是为了让 inbound.js 能被单测直接 import（测试里注入假构造器）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 手机来的一条内容 → 用户发言。source.kind 让出站镜像能认出「这轮是手机触发的」。 */
export function buildUserMessage(text, source = { kind: 'phone' }) {
  return createUserMessage({ content: [{ type: 'text', text }], source })
}
