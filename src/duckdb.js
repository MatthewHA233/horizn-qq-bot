/**
 * DuckDB 活跃度查询
 * horizn_activity_records 存储北京时间（无时区）
 */

const DUCKDB_URL = process.env.DUCKDB_URL

async function queryDuckDB(sql, args = [], timeoutMs = 8000) {
  const response = await fetch(`${DUCKDB_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, args }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`DuckDB 查询失败: ${response.status} ${text}`)
  }
  return response.json()
}

/**
 * 查询玩家最新帧的活跃度
 * @param {string} playerId
 * @returns {Promise<{weekly: number, season: number, sessionTime: string} | null>}
 */
export async function getPlayerActivity(playerId) {
  if (!DUCKDB_URL) return null

  try {
    const result = await queryDuckDB(`
      SELECT weekly_activity, season_activity, session_time
      FROM horizn_activity_records
      WHERE player_id = ?
      ORDER BY session_time DESC
      LIMIT 1
    `, [playerId])

    if (!result.rows || result.rows.length === 0) return null

    const [weekly, season, sessionTime] = result.rows[0]
    return { weekly, season, sessionTime }
  } catch (err) {
    console.error(`[DuckDB] 查询活跃度失败 ${playerId}:`, err.message)
    return null
  }
}

/**
 * 查询某天（北京时间日期字符串）全体成员活跃度时序数据
 * 返回值供脚本号检测算法使用
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @returns {Promise<{timestamps: string[], players: Array<{playerId, timeseries}>} | null>}
 */
export async function getFullDayActivity(dateStr) {
  if (!DUCKDB_URL) return null

  try {
    const result = await queryDuckDB(`
      SELECT player_id, session_time, weekly_activity, status
      FROM horizn_activity_records
      WHERE session_time >= ? AND session_time <= ?
      ORDER BY player_id, session_time
    `, [`${dateStr}T00:00:00`, `${dateStr}T23:59:59.999999`], 30000)

    if (!result.rows || result.rows.length === 0) {
      console.log(`[DuckDB] ${dateStr} 无全天数据`)
      return null
    }

    const timestampSet = new Set()
    const playerMap = new Map()

    for (const [player_id, session_time, weekly, status] of result.rows) {
      // session_time 格式 "YYYY-MM-DD HH:MM:SS" 或 "YYYY-MM-DDTHH:MM:SS"，取第11-15位即 HH:MM
      const timeStr = session_time.substring(11, 16)

      timestampSet.add(timeStr)
      if (!playerMap.has(player_id)) playerMap.set(player_id, {})
      // DuckDB 存储中文状态：'在线' → 'online'，'离线' → 'offline'
      const normalStatus = status === '在线' ? 'online' : status === '离线' ? 'offline' : 'unknown'
      playerMap.get(player_id)[timeStr] = { value: weekly, status: normalStatus }
    }

    const timestamps = Array.from(timestampSet).sort()
    const players = Array.from(playerMap.entries()).map(([playerId, timeseries]) => ({
      playerId,
      timeseries
    }))

    console.log(`[DuckDB] ${dateStr} 全天数据: ${result.rows.length} 条记录, ${players.length} 名玩家, ${timestamps.length} 个时间点`)
    return { timestamps, players }
  } catch (err) {
    console.error(`[DuckDB] 全天数据查询失败 ${dateStr}:`, err.message)
    return null
  }
}
