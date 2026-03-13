/**
 * 消息处理模块
 * 识别 player_id 并查询成员完整档案
 * 支持群消息和私聊消息
 */
import { getPlayerFullInfo } from './supabase.js'
import { getPlayerActivity } from './duckdb.js'

/**
 * player_id 正则表达式
 * 规则：大写字母和数字混杂，6-16位，必须同时包含两者
 */
const PLAYER_ID_PATTERN = /\b(?=[A-Z0-9]{6,16}\b)(?=[A-Z]*[0-9])(?=[0-9]*[A-Z])[A-Z0-9]{6,16}\b/g

/**
 * 从消息文本中提取 player_id
 */
export function extractPlayerIds(text) {
  if (!text || typeof text !== 'string') return []
  const matches = text.match(PLAYER_ID_PATTERN)
  if (!matches) return []
  return [...new Set(matches)]
}

/**
 * 从 OneBot 消息段中提取纯文本
 */
export function extractTextFromMessage(message) {
  if (typeof message === 'string') {
    return message.replace(/\[CQ:[^\]]+\]/g, '').trim()
  }
  if (Array.isArray(message)) {
    return message
      .filter(seg => seg.type === 'text')
      .map(seg => seg.data?.text || '')
      .join('')
      .trim()
  }
  return ''
}

/**
 * 格式化日期为 YYYY.M.D
 */
function fmtDate(d) {
  const date = new Date(d)
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`
}

const SEP = '────────────────'

/**
 * 将查询结果格式化为回复文本
 */
function formatPlayerInfo(playerId, info, activity = null) {
  const lines = [`查询：${playerId}`, SEP]

  if (info.found === 'none') {
    lines.push('无记录')
    return lines.join('\n')
  }

  if (info.found === 'external_blacklist') {
    const bl = info.externalBlacklist
    lines.push('⚠️ 外部黑名单')
    const nameQQ = bl.qq_number ? `${bl.name}  QQ：${bl.qq_number}` : bl.name
    lines.push(`称呼：${nameQQ}`)
    lines.push(`拉黑日期：${fmtDate(bl.blacklist_date)}`)
    if (bl.note) lines.push(`原因：${bl.note}`)
    return lines.join('\n')
  }

  // found === 'member'
  const { member, primaryName, events, qqAccounts } = info

  // 黑名单警告（置顶）
  if (member.is_blacklisted) {
    const blNote = member.blacklist_note ? `  备注：${member.blacklist_note}` : ''
    lines.push(`⚠️ 黑名单（${fmtDate(member.blacklist_date)}）${blNote}`)
  }

  // 游戏名
  if (primaryName) lines.push(`游戏名：${primaryName}`)

  // 成员编号 + 舷号
  const hullStr = member.hull_number
    ? `${member.hull_number}（${member.hull_date ? fmtDate(member.hull_date) : '日期未知'}）`
    : '无'
  const numStr = member.member_number ? `成员编号：${member.member_number}  ` : ''
  lines.push(`${numStr}舷号：${hullStr}`)

  // 状态
  const statusParts = [member.active ? '现役' : '已离队']
  if (member.is_second_team) statusParts.push('二队')
  lines.push(`状态：${statusParts.join(' · ')}`)

  // 内群情况
  const activeQQs = qqAccounts.filter(q => !q.left_at)
  const leftQQs = qqAccounts.filter(q => q.left_at)

  if (activeQQs.length > 0) {
    for (const q of activeQQs) {
      const name = q.card || q.nickname || String(q.qq_id)
      const joinStr = q.join_time ? `，${fmtDate(q.join_time)}入群` : ''
      lines.push(`内群：${name}（${q.qq_id}${joinStr}）`)
    }
  } else if (leftQQs.length > 0) {
    const latest = leftQQs.sort((a, b) => new Date(b.left_at) - new Date(a.left_at))[0]
    const name = latest.card || latest.nickname || String(latest.qq_id)
    lines.push(`内群：不在内群（离群 ${fmtDate(latest.left_at)}，曾用 ${name}（${latest.qq_id}））`)
  } else {
    lines.push('内群：不在内群')
  }

  // 活跃度（DuckDB 最新帧）
  if (activity) {
    const t = activity.sessionTime
    const d = new Date(t.replace(' ', 'T'))
    const timeStr = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    lines.push(`最新活跃度（${timeStr}）：`)
    lines.push(`  周活跃度 ${activity.weekly} | 赛季活跃度 ${activity.season}`)
  }

  // 入离队历史
  if (events.length > 0) {
    lines.push(`历史（共 ${events.length} 次）：`)
    for (const ev of events) {
      const typeStr = ev.event_type === 'join' ? '入队' : '离队'
      const kickStr = ev.event_type === 'leave' && ev.is_kicked ? '（被踢）' : ''
      lines.push(`  ${fmtDate(ev.event_time)} ${typeStr}${kickStr}`)
    }
  } else {
    lines.push('历史：无入离队记录')
  }

  return lines.join('\n')
}

/**
 * 批量查询并拼接所有回复文本
 */
async function queryAndBuildReply(playerIds) {
  const blocks = []
  for (const playerId of playerIds) {
    try {
      const [info, activity] = await Promise.all([
        getPlayerFullInfo(playerId),
        getPlayerActivity(playerId)
      ])
      blocks.push(formatPlayerInfo(playerId, info, activity))
    } catch (err) {
      console.error(`[查询异常] ${playerId}:`, err.message)
      blocks.push(`查询：${playerId}\n${SEP}\n查询失败`)
    }
  }
  return blocks.join('\n\n')
}

/**
 * 处理群消息
 */
async function handleGroupMessage(event, client, listenGroups) {
  const groupId = event.group_id
  const messageId = event.message_id
  const senderId = event.sender?.user_id
  const senderName = event.sender?.nickname || event.sender?.card || '未知'

  if (listenGroups.size === 0 || !listenGroups.has(groupId)) return

  const text = extractTextFromMessage(event.message)
  if (!text) return

  const playerIds = extractPlayerIds(text)
  if (playerIds.length === 0) return

  console.log(`[群消息] 群${groupId} ${senderName}: 检测到 ${playerIds.length} 个 ID: ${playerIds.join(', ')}`)

  const replyText = await queryAndBuildReply(playerIds)

  try {
    await client.replyGroupMessageWithAt(groupId, messageId, senderId, replyText)
    console.log(`[群回复] 群${groupId}: ${replyText.replace(/\n/g, ' | ')}`)
  } catch (err) {
    console.error(`[群回复失败] 群${groupId}:`, err.message)
  }
}

/**
 * 处理私聊消息
 */
async function handlePrivateMessage(event, client, allowPrivateUsers) {
  const userId = event.user_id
  const messageId = event.message_id
  const senderName = event.sender?.nickname || '未知'

  if (allowPrivateUsers.size === 0 || !allowPrivateUsers.has(userId)) return

  const text = extractTextFromMessage(event.message)
  if (!text) return

  const playerIds = extractPlayerIds(text)
  if (playerIds.length === 0) return

  console.log(`[私聊] ${senderName}(${userId}): 检测到 ${playerIds.length} 个 ID: ${playerIds.join(', ')}`)

  const replyText = await queryAndBuildReply(playerIds)

  try {
    await client.replyPrivateMessage(userId, messageId, replyText)
    console.log(`[私聊回复] ${senderName}(${userId}): ${replyText.replace(/\n/g, ' | ')}`)
  } catch (err) {
    console.error(`[私聊回复失败] ${userId}:`, err.message)
  }
}

/**
 * 处理消息事件
 */
export async function handleMessage(event, client, config) {
  if (event.post_type !== 'message') return

  if (event.message_type === 'group') {
    await handleGroupMessage(event, client, config.listenGroups)
  } else if (event.message_type === 'private') {
    await handlePrivateMessage(event, client, config.allowPrivateUsers)
  }
}

/**
 * 创建消息处理器
 */
export function createMessageHandler(client, config) {
  return (event) => {
    handleMessage(event, client, config).catch(err => {
      console.error('[消息处理异常]:', err)
    })
  }
}
