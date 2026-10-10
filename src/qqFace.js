/**
 * QQ 内置小黄脸（OneBot v11 face 消息段）
 *
 * 业务文本里用标准 CQ 码 `[CQ:face,id=N]` 标记小黄脸，发送层再用 textToSegments 拆成
 * text / face 消息段；包进 text 段的 CQ 码不会被 NapCat 解析，只会原样显示。
 */

const FACE_CQ = /\[CQ:face,id=(\d+)\]/g
const FACE_CQ_WITH_SPACE = /\[CQ:face,id=\d+\] ?/g

/** 生成小黄脸标记 */
export function qqFace(id) {
  return `[CQ:face,id=${id}]`
}

/** 文本 → OneBot 消息段数组：只识别小黄脸 CQ 码，其余一律按纯文本发送 */
export function textToSegments(text) {
  const source = String(text ?? '')
  const segments = []
  let last = 0
  for (const match of source.matchAll(FACE_CQ)) {
    if (match.index > last) segments.push({ type: 'text', data: { text: source.slice(last, match.index) } })
    segments.push({ type: 'face', data: { id: match[1] } })
    last = match.index + match[0].length
  }
  if (last < source.length || segments.length === 0) {
    segments.push({ type: 'text', data: { text: source.slice(last) } })
  }
  return segments
}

/** 去掉小黄脸标记（连同其后的一个空格），用于喂给 LLM 的上下文 */
export function stripQQFaces(text) {
  return String(text ?? '').replace(FACE_CQ_WITH_SPACE, '')
}
