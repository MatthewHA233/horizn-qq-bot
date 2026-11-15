/**
 * 审核群：新人入群登记 + 游戏 ID 初绑定
 * - 新人进群 → @他请发游戏 ID
 * - 新人发出含 ID 的消息 → 记为初绑定；已在内群则立即按 QQ 号转入内群自动绑定
 * - 进群 5 小时内还没登记 ID 的新人，每次发言不带 ID 都提示格式不对、请重发
 * - 退群 → 直接删行（不像内群那样保留退群时间）
 * - 每 20 分钟对账一次，补上漏收的进退群事件
 */
import { extractPlayerIds } from './playerId.js'
import {
  deleteReviewQQMember,
  getMemberDisplayName,
  getReviewQQMember,
  isBoundInInnerGroup,
  recordReviewPlayerId,
  syncReviewQQMembers,
  transferReviewBindings,
  upsertReviewQQMember
} from './supabase.js'

const REVIEW_SYNC_INTERVAL_MS = 20 * 60 * 1000 // 20 分钟
const ID_REMINDER_WINDOW_MS = 5 * 60 * 60 * 1000 // 进群 5 小时内催报 ID

// 群主/管理员在审核群贴别人的 ID 是在审人，不能记到自己 QQ 上
const ADMIN_ROLES = new Set(['owner', 'admin'])

export const REVIEW_WELCOME_TEXT = '欢迎来到HORIZON地平线！请发一下你的游戏ID（12~16位字母数字组合）'

// 新人第一次没发对就给示例：七宝队长（地平线『No.000』柒宝）的 ID
export const REVIEW_EXAMPLE_PLAYER_ID = '4AA67B15FC3585E7'

export const REVIEW_ID_RETRY_TEXT =
  `ID格式不对，请重新发一下。游戏ID是12~16位字母数字组合，例如七宝队长的ID：${REVIEW_EXAMPLE_PLAYER_ID}`

const defaultDeps = {
  deleteReviewQQMember,
  getMemberDisplayName,
  getReviewQQMember,
  isBoundInInnerGroup,
  recordReviewPlayerId,
  transferReviewBindings,
  upsertReviewQQMember
}

/**
 * 登记成功后的回复文案（不提内群绑定，绑定在后台静默完成）
 */
export function buildReviewIdReply({ playerId, previousId, displayName }) {
  const head = previousId && previousId !== playerId ? `已更新游戏ID：${playerId}` : `已登记游戏ID：${playerId}`
  return displayName ? `${head}（识别为「${displayName}」）` : head
}

/**
 * 是否还要催这个人报 ID：有记录、尚未登记、进群不满 5 小时
 */
export function needsIdReminder(row, now = Date.now()) {
  if (!row || row.player_id || !row.join_time) return false
  const joinedAt = Date.parse(row.join_time)
  return Number.isFinite(joinedAt) && now - joinedAt < ID_REMINDER_WINDOW_MS
}

/**
 * 审核群进退群通知
 */
export async function handleReviewGroupNotice(event, client, config, deps = defaultDeps) {
  const qqId = event.user_id
  if (!qqId || qqId === config.botQQId) return

  if (event.notice_type === 'group_increase') {
    console.log(`[审核群] 新人进群: ${qqId}`)
    try {
      const joinTime = event.time ? new Date(event.time * 1000).toISOString() : null
      await deps.upsertReviewQQMember({ qqId, joinTime })
    } catch (err) {
      console.error(`[审核群] 登记新人失败 (${qqId}):`, err.message)
    }
    try {
      await client.sendGroupMessageWithAt(event.group_id, qqId, REVIEW_WELCOME_TEXT)
    } catch (err) {
      console.error(`[审核群] 欢迎消息发送失败 (${qqId}):`, err.message)
    }
    return
  }

  if (event.notice_type === 'group_decrease') {
    try {
      await deps.deleteReviewQQMember(qqId)
      console.log(`[审核群] 退群删除: ${qqId}`)
    } catch (err) {
      console.error(`[审核群] 退群删除失败 (${qqId}):`, err.message)
    }
  }
}

/**
 * 新人发言不带 ID：进群 5 小时内且未登记的，提示格式不对请重发
 */
async function remindIdFormat(event, client, senderId, deps) {
  try {
    if (!needsIdReminder(await deps.getReviewQQMember(senderId))) return false
    if (await deps.isBoundInInnerGroup(senderId)) return false
    await client.replyGroupMessageWithAt(event.group_id, event.message_id, senderId, REVIEW_ID_RETRY_TEXT)
    console.log(`[审核群] 提示重发 ID: ${senderId}`)
    return true
  } catch (err) {
    console.error(`[审核群] 提示重发 ID 失败 (${senderId}):`, err.message)
    return false
  }
}

/**
 * 审核群消息：识别新人自报的游戏 ID 并登记初绑定；未带 ID 的新人发言提示重发
 * @returns {Promise<boolean>} 是否回复了
 */
export async function handleReviewGroupMessage(event, client, text, deps = defaultDeps) {
  const groupId = event.group_id
  const senderId = event.sender?.user_id ?? event.user_id
  const senderCard = event.sender?.card || ''
  const senderNickname = event.sender?.nickname || ''
  if (ADMIN_ROLES.has(event.sender?.role)) return false

  // 照抄示例 ID 不算登记，按没发对处理
  const playerIds = extractPlayerIds(text).filter(id => id !== REVIEW_EXAMPLE_PLAYER_ID)
  if (playerIds.length === 0) return remindIdFormat(event, client, senderId, deps)

  try {
    // 内群已绑定的老成员在审核群贴 ID 多半是帮别人问，不登记
    if (await deps.isBoundInInnerGroup(senderId)) return false

    const playerId = playerIds[0]
    const previousId = await deps.recordReviewPlayerId({
      qqId: senderId,
      nickname: senderNickname,
      card: senderCard,
      playerId
    })
    const displayName = await deps.getMemberDisplayName(playerId)
    const { bound, conflicts } = await deps.transferReviewBindings()
    if (bound.length) console.log(`[审核群] 初绑定转入内群: ${bound.map(b => `${b.qq_id}→${b.player_id}`).join(', ')}`)
    if (conflicts.length) console.warn(`[审核群] 内群已有不同绑定，未覆盖: ${conflicts.map(c => `${c.qq_id}→${c.player_id}`).join(', ')}`)

    console.log(`[审核群] ${senderCard || senderNickname}(${senderId}) 登记 ID ${playerId}${previousId && previousId !== playerId ? `（原 ${previousId}）` : ''}`)
    await client.replyGroupMessageWithAt(groupId, event.message_id, senderId,
      buildReviewIdReply({ playerId, previousId, displayName }))
    return true
  } catch (err) {
    console.error(`[审核群] 登记 ID 失败 (${senderId}):`, err.message)
    await client.replyGroupMessageWithAt(groupId, event.message_id, senderId, '游戏ID登记失败，请稍后重发或联系管理员。')
      .catch(replyErr => console.error('[审核群] 失败提示发送失败:', replyErr.message))
    return false
  }
}

async function syncReviewOnce(client, groupId) {
  try {
    // 小群直接绕过缓存：缓存缺人会被当成退群删掉自报 ID
    const members = await client.getGroupMemberList(groupId, { noCache: true })
    const result = await syncReviewQQMembers(members)
    console.log(`[审核群同步] 在群 ${result.upserted} 人，删除已退群 ${result.removed} 行`)
  } catch (err) {
    console.error('[审核群同步] 失败:', err.message)
  }
}

export function startReviewSyncLoop(client, groupId) {
  console.log(`[审核群同步] 启动定时对账，群 ${groupId}，间隔 20 分钟`)
  syncReviewOnce(client, groupId)
  setInterval(() => syncReviewOnce(client, groupId), REVIEW_SYNC_INTERVAL_MS)
}
