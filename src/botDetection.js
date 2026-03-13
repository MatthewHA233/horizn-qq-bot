/**
 * 脚本号检测算法
 * 移植自 member-viewer-electron/src/utils/botDetection.ts
 *
 * 核心逻辑：
 * - botScore = effScore×0.6 + timeScore×0.4
 *   效率贡献：效率>=25→0分，效率<=10→满分（线性）
 *   时间贡献：活跃0分→0，活跃>=210分钟→满分（线性）
 * - unusualTimeScore：分段加权（冷门时段权重高）
 * - 可疑条件：(botScore>=0.6 && unusualTime>=0.4 && activeTime>=30) || botScore>=0.8
 */

/**
 * 计算每个时间戳的全局活跃人数（activity increased）
 */
function calculateTimestampActivity(members, timestamps) {
  const activityMap = new Map()
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i]
    const prevTs = i > 0 ? timestamps[i - 1] : null
    let activeCount = 0
    for (const member of members) {
      const entry = member.timeseries[ts]
      const prevEntry = prevTs ? member.timeseries[prevTs] : null
      if (entry && prevEntry && entry.value != null && prevEntry.value != null) {
        if (entry.value > prevEntry.value) activeCount++
      }
    }
    activityMap.set(ts, activeCount)
  }
  return activityMap
}

/**
 * 计算不寻常时间游戏指数（分段加权，冷门时段权重高）
 */
function calculateUnusualTimeScore(timeseries, timestamps, timestampActivity) {
  if (timestamps.length < 2) return 0
  const activityCounts = Array.from(timestampActivity.values())
  if (activityCounts.length === 0) return 0

  const sortedCounts = [...activityCounts].sort((a, b) => a - b)
  const p25 = sortedCounts[Math.floor(sortedCounts.length / 4)]
  const p50 = sortedCounts[Math.floor(sortedCounts.length / 2)]
  const p75 = sortedCounts[Math.floor(sortedCounts.length * 3 / 4)]

  let totalWeightedScore = 0
  let increaseCount = 0

  for (let i = 1; i < timestamps.length; i++) {
    const ts = timestamps[i]
    const prevTs = timestamps[i - 1]
    const entry = timeseries[ts]
    const prevEntry = timeseries[prevTs]

    if (entry && prevEntry && entry.value != null && prevEntry.value != null && entry.value > prevEntry.value) {
      increaseCount++
      const cnt = timestampActivity.get(ts) || 0
      if (cnt > 0) {
        let weight
        if (cnt <= p25) {
          weight = (p25 / cnt) * 0.6
        } else if (cnt <= p50) {
          weight = (p50 / cnt) * 0.4
        } else if (cnt <= p75) {
          weight = 0.15
        } else {
          weight = 0.02
        }
        totalWeightedScore += weight
      }
    }
  }

  if (increaseCount === 0) return 0
  return Math.min(1.0, totalWeightedScore / increaseCount)
}

/**
 * 计算脚本可疑指数（线性公式）
 */
function calculateBotScores(results) {
  if (results.length <= 1) {
    for (const r of results) r.botScore = 0.5
    return
  }
  const EFF_GREEN = 25   // 效率 >= 25 → 0分
  const EFF_RED = 10     // 效率 <= 10 → 满分
  const TIME_MAX = 210   // 活跃时长 >= 210分钟 → 满分

  for (const r of results) {
    const effScore = Math.max(0, Math.min(1, (EFF_GREEN - r.avgIncreasePerInterval) / (EFF_GREEN - EFF_RED)))
    const timeScore = Math.max(0, Math.min(1, r.activeTime / TIME_MAX))
    r.botScore = Math.max(0, Math.min(1, effScore * 0.6 + timeScore * 0.4))
  }
}

/**
 * 分析所有成员的脚本可疑度
 * @param {Array<{playerId, name, memberNumber, timeseries}>} members
 * @param {string[]} timestamps - 'HH:MM' 格式，已排序
 * @returns {Array<BotDetectionResult>} 按 botScore 降序
 */
export function analyzeBotDetection(members, timestamps) {
  if (members.length === 0 || timestamps.length === 0) return []

  const timestampActivity = calculateTimestampActivity(members, timestamps)
  const results = []

  for (const member of members) {
    let onlineCount = 0
    let activeCount = 0
    let totalIncrease = 0

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i]
      const entry = member.timeseries[ts]
      if (!entry) continue

      if (entry.status === 'online') onlineCount++

      if (i > 0) {
        const prevEntry = member.timeseries[timestamps[i - 1]]
        if (entry.value != null && prevEntry?.value != null && entry.value > prevEntry.value) {
          activeCount++
          totalIncrease += entry.value - prevEntry.value
        }
      }
    }

    const onlineTime = onlineCount * 5
    const activeTime = activeCount * 5
    const avgIncreasePerInterval = activeCount > 0 ? totalIncrease / activeCount : 0
    const unusualTimeScore = calculateUnusualTimeScore(member.timeseries, timestamps, timestampActivity)

    results.push({
      playerId: member.playerId,
      name: member.name,
      memberNumber: member.memberNumber,
      onlineTime,
      activeTime,
      totalIncrease,
      avgIncreasePerInterval,
      botScore: 0,
      unusualTimeScore
    })
  }

  // 数据清洗1：活跃时长不可能 > 在线时长；活跃时长为0无意义
  let valid = results.filter(r => r.activeTime <= r.onlineTime && r.activeTime > 0)

  // 数据清洗2：排除效率异常高（> 中位数×3）
  if (valid.length > 0) {
    const sorted = [...valid].sort((a, b) => a.avgIncreasePerInterval - b.avgIncreasePerInterval)
    const median = sorted[Math.floor(sorted.length / 2)].avgIncreasePerInterval
    const threshold = median * 3
    valid = valid.filter(r => r.avgIncreasePerInterval <= threshold)
  }

  calculateBotScores(valid)
  valid.sort((a, b) => b.botScore - a.botScore)
  return valid
}

/**
 * 筛选可疑成员
 * 条件1：可疑度>=0.6 && 异常时间>=0.4 && 活跃>=30分钟
 * 条件2：可疑度>=0.8
 */
export function filterSuspiciousMembers(results) {
  return results.filter(r =>
    (r.botScore >= 0.6 && r.unusualTimeScore >= 0.4 && r.activeTime >= 30) ||
    r.botScore >= 0.8
  )
}

/**
 * 格式化时长
 */
export function formatDuration(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h > 0 && m > 0) return `${h}h${m}m`
  if (h > 0) return `${h}h`
  return `${m}m`
}
