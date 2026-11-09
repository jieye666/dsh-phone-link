/**
 * 手机侧（飞书 post）渲染。
 *
 * 飞书富文本不认 dsh-ui 围栏，也渲染不了 Markdown 表格。直接把围栏原样发过去
 * 只会变成一大坨 JSON；直接删掉又会让手机上"看不到表格"。所以这里把围栏里的
 * 结构**翻译成纯文本**：表格逐行、列表逐条、指标逐项。
 */

const PLACEHOLDER = '（这里是一张图表，手机上不显示，请在电脑上看）'

/** 把一个 dsh-ui 节点摊平成若干行文本。 */
function renderNode(node, out, tables) {
  if (!node || typeof node !== 'object') return
  const push = (value) => {
    const text = value === undefined || value === null ? '' : String(value).trim()
    if (text) out.push(text)
  }
  const children = node.children || node.items
  switch (node.type) {
    case 'text':
    case 'callout':
      push(node.content)
      break
    case 'list':
      for (const item of node.items || []) {
        if (item?.desc) push(`· ${item.title}：${item.desc}`)
        else push(`· ${item?.title || item?.content || ''}`)
      }
      break
    case 'table':
      // 表格单独出图（飞书富文本不支持表格），正文里只留一句指路
      tables?.push({ title: node.title || '', columns: node.columns || [], rows: node.rows || [] })
      push('（表格见下图）')
      break
    case 'keyvalue':
      for (const pair of node.pairs || []) push(`· ${pair.key}：${pair.value}`)
      break
    case 'stat':
      push(`· ${node.label}：${node.value}`)
      break
    case 'steps':
      ;(node.steps || []).forEach((step, i) => push(`${i + 1}. ${step.title || step.content || ''}`))
      break
    case 'progress':
      push(`· 进度 ${node.value}%`)
      break
    case 'divider':
      break
    case 'json':
    case 'code':
      push('（代码或数据块，请在电脑上看）')
      break
    case 'chart':
    case 'echart':
    case 'mermaid':
    case 'diagram':
    case 'plot':
    case 'svg':
    case 'scene3d':
      push(PLACEHOLDER)
      break
    case 'stack':
    case 'row':
    case 'col':
    case 'card':
    case 'grid':
    case 'carousel':
      for (const child of children || []) renderNode(child, out, tables)
      break
    default:
      if (children) for (const child of children) renderNode(child, out, tables)
      else if (node.content) push(node.content)
  }
}

/** 围栏 JSON → 纯文本；解析失败时退回一句人话。 */
function renderSpec(raw, tables) {
  let spec
  try {
    spec = JSON.parse(raw)
  } catch {
    return PLACEHOLDER
  }
  const out = []
  if (spec.title) out.push(`【${spec.title}】`)
  for (const node of spec.items || []) renderNode(node, out, tables)
  const title = spec.title || ''
  // 顶层表格没有自己的标题时，借用卡片标题当图的标题
  for (const table of tables) if (!table.title) table.title = title
  return out.length ? out.join('\n') : PLACEHOLDER
}

/** Markdown 表格（纯文本行）→「· a ｜ b ｜ c」；分隔行丢掉。 */
function mdTableToLines(block) {
  const rows = block
    .trim()
    .split('\n')
    .map((line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.some((cell) => cell && !/^:?-{2,}:?$/.test(cell)))
  return rows.map((cells) => `· ${cells.join(' ｜ ')}`).join('\n')
}

/**
 * 助手回复 → { text, tables }：text 给飞书当正文，tables 交给 table-png.py 出图。
 */
export function phoneParts(text) {
  const tables = []
  const rendered = text
    .replace(/```dsh-ui\s*\n([\s\S]*?)```/g, (_match, body) => renderSpec(body, tables))
    .replace(/(^\|.*\|\s*$\n?)+/gm, (block) => mdTableToLines(block))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: rendered, tables }
}

/** 只要文本时的便捷包装。 */
export function forPhone(text) {
  return phoneParts(text).text
}

/**
 * 按段落边界切成 limit 以内，避免把一句话切成两半。
 * 切点优先级：换行 → 句号 → 硬切 limit。
 */
export function chunk(text, limit = 3500) {
  const parts = []
  let rest = String(text ?? '')
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) {
      // 句号本身要留在上一段里，否则手机上看到半句话
      const stop = rest.lastIndexOf('。', limit - 1)
      cut = stop >= limit * 0.5 ? stop + 1 : limit
    }
    const head = rest.slice(0, cut).trim()
    if (head) parts.push(head)
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/**
 * 一张表 → 纯文本行。
 * 出图链路（table-png.py + 飞书图片消息）任何一步失败时的兜底：
 * 手机上至少能看到数据，而不是只收到一句「（表格见下图）」然后干等。
 */
export function tableText(table) {
  const columns = Array.isArray(table?.columns) ? table.columns : []
  const rows = Array.isArray(table?.rows) ? table.rows : []
  const lines = []
  if (table?.title) lines.push(`【${table.title}】`)
  if (columns.length) lines.push(`· ${columns.join(' ｜ ')}`)
  for (const row of rows) lines.push(`· ${(Array.isArray(row) ? row : [row]).map((cell) => String(cell ?? '')).join(' ｜ ')}`)
  return lines.join('\n')
}
