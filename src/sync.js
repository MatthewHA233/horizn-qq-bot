/**
 * QQ 群成员同步模块
 * 每 20 分钟从 NapCat 拉取群成员列表，同步到 Supabase
 * 自动标记退群成员（left_at）
 */
import { syncQQMembers } from './supabase.js'

const SYNC_INTERVAL_MS = 20 * 60 * 1000 // 20 分钟

async function syncOnce(client, groupId) {
  console.log(`[同步] 开始同步群 ${groupId} 成员...`)
  try {
    const members = await client.getGroupMemberList(groupId)
    const result = await syncQQMembers(members)
    console.log(`[同步] 完成：新增 ${result.inserted}，更新 ${result.updated}，退群标记 ${result.left}，共 ${result.total} 人`)
  } catch (err) {
    console.error('[同步] 失败:', err.message)
  }
}

export function startSyncLoop(client, groupId) {
  console.log(`[同步] 启动定时同步，群 ${groupId}，间隔 20 分钟`)
  syncOnce(client, groupId)
  setInterval(() => syncOnce(client, groupId), SYNC_INTERVAL_MS)
}
