/**
 * 每日入离队播报 + 脚本号预警检测
 * 每天北京时间 01:00 执行：
 *   1. 播报前一天的入离队情况
 *   2. 对前一天的活跃度数据运行脚本号检测，若有可疑成员则发送预警
 */
import { getDailyEvents, getActiveMembersMap } from './supabase.js'
import { getFullDayActivity } from './duckdb.js'
import { analyzeBotDetection, filterSuspiciousMembers, formatDuration } from './botDetection.js'

/**
 * 获取昨天（北京时间）的 UTC 时间范围、日期标签和北京日期字符串
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

  return { startUTC, endUTC, dateLabel, dateStr: bjYesterdayStr }
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
 * 执行入离队播报
 */
async function runJoinLeaveReport(client, groupId, dateLabel, startUTC, endUTC) {
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
  console.log(`[播报] ${dateLabel} 入离队播报已发送`)
}

/**
 * 执行脚本号检测播报
 */
async function runBotDetectionReport(client, groupId, dateLabel, dateStr) {
  console.log(`[播报] 开始 ${dateLabel} 脚本号检测...`)

  // 并行获取：全天活跃度数据 + 成员名字映射
  const [activityData, memberMap] = await Promise.all([
    getFullDayActivity(dateStr),
    getActiveMembersMap().catch(err => {
      console.error('[播报] 成员名字获取失败:', err.message)
      return new Map()
    })
  ])

  if (!activityData) {
    console.log(`[播报] ${dateLabel} 无活跃度数据，跳过脚本号检测`)
    return
  }

  const { timestamps, players } = activityData

  // 给每个玩家附上名字和编号
  const members = players.map(p => {
    const info = memberMap.get(p.playerId)
    return {
      playerId: p.playerId,
      name: info?.name || p.playerId,
      memberNumber: info?.memberNumber || '?',
      timeseries: p.timeseries
    }
  })

  console.log(`[播报] 脚本号检测：${members.length} 名成员，${timestamps.length} 个时间点`)

  const results = analyzeBotDetection(members, timestamps)
  const suspects = filterSuspiciousMembers(results)

  if (suspects.length === 0) {
    console.log(`[播报] ${dateLabel} 未检测到可疑脚本号`)
    return
  }

  console.log(`[播报] ${dateLabel} 检测到 ${suspects.length} 名可疑成员`)

  const lines = [`🤖 ${dateLabel} 脚本号预警`, `检测到 ${suspects.length} 名可疑成员：`]

  const display = suspects.slice(0, 8)
  display.forEach((s, idx) => {
    const nameStr = s.name !== s.playerId ? `${s.name}` : s.playerId
    const numStr = s.memberNumber !== '?' ? `（${s.memberNumber}）` : ''
    lines.push(``)
    lines.push(`#${idx + 1} ${nameStr}${numStr}`)
    lines.push(`  可疑度 ${s.botScore.toFixed(2)}  异常时间 ${s.unusualTimeScore.toFixed(2)}`)
    lines.push(`  在线 ${formatDuration(s.onlineTime)}  活跃 ${formatDuration(s.activeTime)}  效率 ${s.avgIncreasePerInterval.toFixed(1)}/帧`)
  })

  if (suspects.length > 8) {
    lines.push(``)
    lines.push(`…还有 ${suspects.length - 8} 人`)
  }

  await client.sendGroupMessage(groupId, lines.join('\n'))
  console.log(`[播报] ${dateLabel} 脚本号预警已发送`)
}

/**
 * 从 YYYY-MM-DD 字符串计算播报所需的时间范围和标签
 */
function buildDateRange(dateStr) {
  const next = new Date(new Date(`${dateStr}T00:00:00+08:00`).getTime() + 24 * 60 * 60 * 1000)
  const nextStr = next.toISOString().slice(0, 10)
  const startUTC = new Date(`${dateStr}T00:00:00+08:00`).toISOString()
  const endUTC = new Date(`${nextStr}T00:00:00+08:00`).toISOString()
  const d = new Date(`${dateStr}T00:00:00+08:00`)
  const dateLabel = `${d.getMonth() + 1}月${d.getDate()}日`
  return { startUTC, endUTC, dateLabel }
}

/**
 * 对指定北京日期执行完整播报（入离队 + 脚本号检测）
 * @param {object} client
 * @param {number} groupId
 * @param {string} dateStr - 'YYYY-MM-DD' 北京时间日期
 */
export async function runReportForDate(client, groupId, dateStr) {
  const { startUTC, endUTC, dateLabel } = buildDateRange(dateStr)
  console.log(`[播报] 开始 ${dateLabel}（${dateStr}）播报...`)

  await runJoinLeaveReport(client, groupId, dateLabel, startUTC, endUTC).catch(err =>
    console.error('[播报] 入离队播报失败:', err.message)
  )

  await runBotDetectionReport(client, groupId, dateLabel, dateStr).catch(err =>
    console.error('[播报] 脚本号检测失败:', err.message)
  )
}

/**
 * 执行完整每日播报（入离队 + 脚本号检测）
 */
async function runDailyReport(client, groupId) {
  const { dateStr } = getYesterdayBeijingRange()
  await runReportForDate(client, groupId, dateStr)
}

/**
 * 启动每日播报调度
 */
export function startDailyReport(client, groupId) {
  console.log(`[播报] 启动每日播报，群 ${groupId}，北京时间 01:00`)
  scheduleNextReport(() => runDailyReport(client, groupId))
}
