/**
 * Supabase 踢出记录查询服务
 */
import { createClient } from '@supabase/supabase-js'

let supabase = null

/**
 * 初始化 Supabase 客户端
 */
export function initSupabase(url, serviceKey) {
  supabase = createClient(url, serviceKey)
  console.log('[Supabase] 客户端已初始化')
}

/**
 * 查询玩家的踢出状态
 * @param {string} playerId - 玩家 ID（大写字母+数字，6-16位）
 * @returns {Promise<{status: string, message: string, data?: object}>}
 *
 * 返回状态：
 * - 'pass': 通过（无踢出记录或已过冷却期）
 * - 'cooling': 冷却期中
 * - 'blacklist': 黑名单（预留）
 * - 'error': 查询错误
 */
export async function checkPlayerStatus(playerId) {
  if (!supabase) {
    return { status: 'error', message: '数据库未初始化' }
  }

  try {
    console.log(`[Supabase] 查询 player_id: ${playerId}`)

    // 1. 查询该玩家的踢出事件（离队 + is_kicked = true）
    const { data: kickedEvents, error: kickedError } = await supabase
      .from('horizn_membership_events')
      .select('id, player_id, event_time, is_kicked')
      .eq('player_id', playerId)
      .eq('event_type', 'leave')
      .eq('is_kicked', true)
      .order('event_time', { ascending: false })
      .limit(1)

    console.log(`[Supabase] 踢出记录查询结果:`, kickedEvents, kickedError)

    if (kickedError) {
      console.error('[Supabase] 查询踢出事件失败:', kickedError)
      return { status: 'error', message: '查询失败' }
    }

    // 没有踢出记录
    if (!kickedEvents || kickedEvents.length === 0) {
      return {
        status: 'pass',
        message: '通过',
        data: { playerId, hasKickRecord: false }
      }
    }

    const latestKick = kickedEvents[0]
    const kickedAt = new Date(latestKick.event_time)
    const rejoinAllowedAt = new Date(kickedAt.getTime() + 30 * 24 * 60 * 60 * 1000) // 30天后
    const now = new Date()

    console.log(`[Supabase] 踢出时间: ${kickedAt.toISOString()}`)
    console.log(`[Supabase] 可归队时间: ${rejoinAllowedAt.toISOString()}`)
    console.log(`[Supabase] 当前时间: ${now.toISOString()}`)

    // 2. 检查是否已有踢出后的归队记录
    const { data: joinEvents, error: joinError } = await supabase
      .from('horizn_membership_events')
      .select('id, event_time')
      .eq('player_id', playerId)
      .eq('event_type', 'join')
      .gt('event_time', latestKick.event_time)
      .order('event_time', { ascending: false })
      .limit(1)

    console.log(`[Supabase] 归队记录查询结果:`, joinEvents, joinError)

    if (joinError) {
      console.error('[Supabase] 查询归队事件失败:', joinError)
    }

    // 如果已经归队
    if (joinEvents && joinEvents.length > 0) {
      const rejoinedAt = new Date(joinEvents[0].event_time)
      const daysAfterKick = Math.ceil((rejoinedAt.getTime() - kickedAt.getTime()) / (1000 * 60 * 60 * 24))
      const earlyDays = Math.ceil((rejoinAllowedAt.getTime() - rejoinedAt.getTime()) / (1000 * 60 * 60 * 24))

      const kickDateStr = `${kickedAt.getMonth() + 1}.${kickedAt.getDate()}`
      const rejoinDateStr = `${rejoinedAt.getMonth() + 1}.${rejoinedAt.getDate()}`

      console.log(`[Supabase] 判断: 已归队，提前${earlyDays}天`)
      return {
        status: 'early_rejoin',
        message: `${kickDateStr}被踢，踢后${daysAfterKick}天归队，于${rejoinDateStr}提前${earlyDays}天归队`,
        data: {
          playerId,
          hasKickRecord: true,
          hasRejoined: true,
          kickedAt: latestKick.event_time,
          rejoinedAt: joinEvents[0].event_time,
          daysAfterKick,
          earlyDays
        }
      }
    }

    // 3. 判断是否还在冷却期
    console.log(`[Supabase] 冷却期判断: now(${now.getTime()}) < rejoinAllowedAt(${rejoinAllowedAt.getTime()}) = ${now < rejoinAllowedAt}`)
    if (now < rejoinAllowedAt) {
      const daysUntil = Math.ceil((rejoinAllowedAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      const endDateStr = `${rejoinAllowedAt.getMonth() + 1}.${rejoinAllowedAt.getDate()}`

      return {
        status: 'cooling',
        message: `属于被踢冷却期，距离${endDateStr}结束还有${daysUntil}天`,
        data: {
          playerId,
          hasKickRecord: true,
          kickedAt: latestKick.event_time,
          rejoinAllowedAt: rejoinAllowedAt.toISOString(),
          daysUntilRejoin: daysUntil
        }
      }
    }

    // 冷却期已过
    return {
      status: 'pass',
      message: '通过（冷却期已结束）',
      data: {
        playerId,
        hasKickRecord: true,
        kickedAt: latestKick.event_time,
        rejoinAllowedAt: rejoinAllowedAt.toISOString(),
        coolingEnded: true
      }
    }

  } catch (err) {
    console.error('[Supabase] 查询异常:', err)
    return { status: 'error', message: '查询异常' }
  }
}

/**
 * 批量查询多个玩家状态
 */
export async function checkMultiplePlayersStatus(playerIds) {
  const results = []
  for (const playerId of playerIds) {
    const result = await checkPlayerStatus(playerId)
    results.push({ playerId, ...result })
  }
  return results
}
