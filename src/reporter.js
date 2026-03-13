/**
 * 每日入离队播报
 * 每天北京时间 01:00 播报前一天的入离队情况
 */
import { getDailyEvents } from './supabase.js'

/**
 * 获取昨天（北京时间）的 UTC 时间范围和日期标签
 */
function getYesterdayBeijingRange() {
  const now = new Date()
  const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const bjTodayStr = bjNow.toISOString().slice(0, 10)
  const bjYesterdayStr = new Date(bjNow.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  // 北京时间日期字符串 + 时区 → 正确的 UTC 时间戳
  const startUTC = new Date(`${bjYesterdayStr}T00:00:00+08:00`).toISOString()
  const endUTC = new Date(`${bjTodayStr}T00:00:00+08:00`).toISOString()

  const d = new Date(`${bjYesterdayStr}T00:00:00Z`)
  const dateLabel = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`

  return { startUTC, endUTC, dateLabel }
}

/**
 * 计算距下次北京时间 01:00 的毫秒数，并用 setTimeout 调度
 */
function scheduleNextReport(callback) {
  const now = new Date()
  const bjNow = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const bjTodayStr = bjNow.toISOString().slice(0, 10)

  let next1AM = new Date(`${bjTodayStr}T01:00:00+08:00`)
  if (now >= next1AM) {
    next1AM = new Date(next1AM.getTime() + 24 * 60 * 60 * 1000)
  }

  const delay = next1AM.getTime() - now.getTime()
  const bjLabel = new Date(next1AM.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
  console.log(`[播报] 下次播报：${bjLabel} 北京时间（${Math.round(delay / 60000)} 分钟后）`)

  setTimeout(() => {
    callback().catch(err => console.error('[播报] 执行失败:', err))
    scheduleNextReport(callback)
  }, delay)
}

/**
 * 执行一次播报
 */
async function runDailyReport(client, groupId) {
  const { startUTC, endUTC, dateLabel } = getYesterdayBeijingRange()
  console.log(`[播报] 生成 ${dateLabel} 入离队播报...`)

  const { joins, leaves } = await getDailyEvents(startUTC, endUTC)

  if (joins.length === 0 && leaves.length === 0) {
    console.log(`[播报] ${dateLabel} 无入离队记录，跳过`)
    return
  }

  const lines = [`📋 ${dateLabel} 入离队播报`]

  if (joins.length > 0) {
    lines.push(`\n入队（${joins.length} 人）：`)
    joins.forEach(j => {
      const nameStr = j.name ? `${j.name}  ` : ''
      lines.push(`  ${nameStr}${j.player_id}`)
    })
  }

  if (leaves.length > 0) {
    lines.push(`\n离队（${leaves.length} 人）：`)
    leaves.forEach(l => {
      const nameStr = l.name ? `${l.name}  ` : ''
      const kickStr = l.is_kicked ? '（被踢）' : ''
      lines.push(`  ${nameStr}${l.player_id}${kickStr}`)
    })
  }

  await client.sendGroupMessage(groupId, lines.join('\n'))
  console.log(`[播报] ${dateLabel} 播报已发送`)
}

/**
 * 启动每日播报调度
 */
export function startDailyReport(client, groupId) {
  console.log(`[播报] 启动每日播报，群 ${groupId}，北京时间 01:00`)
  scheduleNextReport(() => runDailyReport(client, groupId))
}
