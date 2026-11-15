/**
 * QQ 群成员同步模块
 * 每 20 分钟从 NapCat 拉取群成员列表，同步到 Supabase
 * 自动标记退群成员（left_at），并把审核群初绑定按 QQ 号转入内群
 */
import { syncQQMembers, transferReviewBindings } from './supabase.js'

const SYNC_INTERVAL_MS = 20 * 60 * 1000 // 20 分钟
const JOIN_SYNC_DELAY_MS = 15 * 1000 // 新人进内群后稍等再同步，合并连续进群

let loopClient = null
let loopGroupId = null
let joinSyncTimer = null

async function syncOnce(client, groupId, { noCache = false } = {}) {
  console.log(`[同步] 开始同步群 ${groupId} 成员...`)
  try {
    const members = await client.getGroupMemberList(groupId, { noCache })
    const result = await syncQQMembers(members)
    console.log(`[同步] 完成：新增 ${result.inserted}，更新 ${result.updated}，退群标记 ${result.left}，共 ${result.total} 人`)
  } catch (err) {
    console.error('[同步] 失败:', err.message)
    return
  }

  try {
    const { bound, conflicts } = await transferReviewBindings()
    if (bound.length) console.log(`[同步] 审核群初绑定转入内群: ${bound.map(b => `${b.qq_id}→${b.player_id}`).join(', ')}`)
    if (conflicts.length) console.warn(`[同步] 内群已有不同绑定，未覆盖: ${conflicts.map(c => `${c.qq_id}→${c.player_id}`).join(', ')}`)
  } catch (err) {
    console.error('[同步] 初绑定转入失败:', err.message)
  }
}

/**
 * 内群有人进群：稍后绕过缓存同步一次，让审核群初绑定尽快转入
 */
export function scheduleInnerSync() {
  if (!loopClient || joinSyncTimer) return
  joinSyncTimer = setTimeout(() => {
    joinSyncTimer = null
    syncOnce(loopClient, loopGroupId, { noCache: true })
  }, JOIN_SYNC_DELAY_MS)
}

export function startSyncLoop(client, groupId) {
  console.log(`[同步] 启动定时同步，群 ${groupId}，间隔 20 分钟`)
  loopClient = client
  loopGroupId = groupId
  syncOnce(client, groupId)
  setInterval(() => syncOnce(client, groupId), SYNC_INTERVAL_MS)
}
