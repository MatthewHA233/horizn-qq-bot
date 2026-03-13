/**
 * DuckDB 活跃度查询
 * horizn_activity_records 存储北京时间（无时区）
 */

const DUCKDB_URL = process.env.DUCKDB_URL

async function queryDuckDB(sql, args = []) {
  const response = await fetch(`${DUCKDB_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, args }),
    signal: AbortSignal.timeout(8000)
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
