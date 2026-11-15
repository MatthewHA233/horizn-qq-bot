/**
 * 游戏 player_id 识别规则（全机器人唯一来源）
 * 实测 ID 为 13-16 位大写十六进制（前导 0 省略后变短），下限取 12 位，
 * 避免把「地平线『No.130』STS1508」里的 STS1508 这类游戏名片段误判成 ID。
 * 必须含数字，排除纯 a-f 字母组成的英文单词；大小写不敏感，统一转大写。
 */
const PLAYER_ID_PATTERN = /\b(?=[0-9A-Fa-f]*[0-9])[0-9A-Fa-f]{12,16}\b/g

/**
 * 判断整串是否为 player_id
 */
export function isPlayerId(value) {
  const text = String(value ?? '').trim()
  return /^[0-9A-Fa-f]{12,16}$/.test(text) && /[0-9]/.test(text)
}

/**
 * 从消息文本中提取 player_id（去重、转大写）
 */
export function extractPlayerIds(text) {
  if (!text || typeof text !== 'string') return []
  const matches = text.match(PLAYER_ID_PATTERN)
  if (!matches) return []
  return [...new Set(matches.map(id => id.toUpperCase()))]
}
