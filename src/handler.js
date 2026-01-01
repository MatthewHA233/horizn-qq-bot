/**
 * 消息处理模块
 * 识别 player_id 并查询状态
 * 支持群消息和私聊消息
 */
import { checkPlayerStatus } from './supabase.js'

/**
 * player_id 正则表达式
 * 规则：大写字母和数字混杂，6-16位
 * 必须同时包含大写字母和数字
 */
const PLAYER_ID_PATTERN = /\b(?=[A-Z0-9]{6,16}\b)(?=[A-Z]*[0-9])(?=[0-9]*[A-Z])[A-Z0-9]{6,16}\b/g

/**
 * 从消息文本中提取 player_id
 * @param {string} text - 消息文本
 * @returns {string[]} - 匹配到的 player_id 列表
 */
export function extractPlayerIds(text) {
  if (!text || typeof text !== 'string') return []

  const matches = text.match(PLAYER_ID_PATTERN)
  if (!matches) return []

  // 去重
  return [...new Set(matches)]
}

/**
 * 从 OneBot 消息段中提取纯文本
 * @param {Array|string} message - OneBot 消息格式
 * @returns {string} - 纯文本内容
 */
export function extractTextFromMessage(message) {
  if (typeof message === 'string') {
    // CQ 码格式，移除 CQ 码只保留文本
    return message.replace(/\[CQ:[^\]]+\]/g, '').trim()
  }

  if (Array.isArray(message)) {
    // 消息段格式
    return message
      .filter(seg => seg.type === 'text')
      .map(seg => seg.data?.text || '')
      .join('')
      .trim()
  }

  return ''
}

/**
 * 查询并构建回复消息
 * @param {string[]} playerIds - 要查询的 player_id 列表
 * @param {boolean} includeId - 是否在结果中包含 ID（私聊需要，群消息不需要）
 * @returns {Promise<{results: Array, text: string}>} - 查询结果和回复文本
 */
async function queryAndBuildReply(playerIds, includeId = true) {
  const results = []
  for (const playerId of playerIds) {
    const result = await checkPlayerStatus(playerId)
    results.push({ playerId, ...result })
  }

  // 构建回复消息
  const replyLines = results.map(r => {
    let statusText
    if (r.status === 'pass') {
      statusText = '通过'
    } else if (r.status === 'cooling') {
      statusText = r.message
    } else if (r.status === 'early_rejoin') {
      statusText = r.message
    } else if (r.status === 'blacklist') {
      statusText = '属于黑名单'
    } else {
      statusText = '查询失败'
    }

    return includeId ? `${r.playerId}: ${statusText}` : statusText
  })

  return {
    results,
    text: replyLines.join('\n')
  }
}

/**
 * 处理群消息
 * @param {object} event - OneBot 群消息事件
 * @param {object} client - NapCat 客户端实例
 * @param {Set<number>} listenGroups - 监听的群号集合
 */
async function handleGroupMessage(event, client, listenGroups) {
  const groupId = event.group_id
  const messageId = event.message_id
  const senderId = event.sender?.user_id
  const senderName = event.sender?.nickname || event.sender?.card || '未知'

  // 检查是否在监听列表中（空集合表示不监听群消息）
  if (listenGroups.size === 0 || !listenGroups.has(groupId)) {
    return
  }

  // 提取文本内容
  const text = extractTextFromMessage(event.message)
  if (!text) return

  // 提取 player_id
  const playerIds = extractPlayerIds(text)
  if (playerIds.length === 0) return

  console.log(`[群消息] 群${groupId} ${senderName}: 检测到 ${playerIds.length} 个 ID: ${playerIds.join(', ')}`)

  // 查询并构建回复（群消息不带 ID 前缀，因为会引用原消息）
  const { text: replyText } = await queryAndBuildReply(playerIds, false)

  // 发送回复（引用 + @发送者 + 结果）
  try {
    await client.replyGroupMessageWithAt(groupId, messageId, senderId, replyText)
    console.log(`[群回复] 群${groupId}: ${replyText.replace(/\n/g, ' | ')}`)
  } catch (err) {
    console.error(`[群回复失败] 群${groupId}:`, err.message)
  }
}

/**
 * 处理私聊消息
 * @param {object} event - OneBot 私聊消息事件
 * @param {object} client - NapCat 客户端实例
 * @param {Set<number>} allowPrivateUsers - 允许私聊的 QQ 号集合
 */
async function handlePrivateMessage(event, client, allowPrivateUsers) {
  const userId = event.user_id
  const messageId = event.message_id
  const senderName = event.sender?.nickname || '未知'

  // 检查是否在白名单中（空集合表示不允许私聊）
  if (allowPrivateUsers.size === 0 || !allowPrivateUsers.has(userId)) {
    return
  }

  // 提取文本内容
  const text = extractTextFromMessage(event.message)
  if (!text) return

  // 提取 player_id
  const playerIds = extractPlayerIds(text)
  if (playerIds.length === 0) return

  console.log(`[私聊] ${senderName}(${userId}): 检测到 ${playerIds.length} 个 ID: ${playerIds.join(', ')}`)

  // 查询并构建回复（私聊引用原消息，不需要 ID 前缀）
  const { text: replyText } = await queryAndBuildReply(playerIds, false)

  // 发送私聊回复（引用原消息）
  try {
    await client.replyPrivateMessage(userId, messageId, replyText)
    console.log(`[私聊回复] ${senderName}(${userId}): ${replyText.replace(/\n/g, ' | ')}`)
  } catch (err) {
    console.error(`[私聊回复失败] ${userId}:`, err.message)
  }
}

/**
 * 处理消息事件
 * @param {object} event - OneBot 消息事件
 * @param {object} client - NapCat 客户端实例
 * @param {object} config - 配置
 */
export async function handleMessage(event, client, config) {
  // 仅处理消息事件
  if (event.post_type !== 'message') {
    return
  }

  if (event.message_type === 'group') {
    await handleGroupMessage(event, client, config.listenGroups)
  } else if (event.message_type === 'private') {
    await handlePrivateMessage(event, client, config.allowPrivateUsers)
  }
}

/**
 * 创建消息处理器
 * @param {object} client - NapCat 客户端实例
 * @param {object} config - 配置对象
 *   - listenGroups: Set<number> 监听的群号
 *   - allowPrivateUsers: Set<number> 允许私聊的 QQ 号
 */
export function createMessageHandler(client, config) {
  return (event) => {
    handleMessage(event, client, config).catch(err => {
      console.error('[消息处理异常]:', err)
    })
  }
}
