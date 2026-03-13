/**
 * Supabase 成员档案查询 + QQ群同步服务
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
 * 同步 QQ 群成员到数据库
 * @param {Array} members - NapCat 返回的成员列表
 * @returns {Promise<{success, inserted, updated, left, total}>}
 */
export async function syncQQMembers(members) {
  if (!supabase) throw new Error('数据库未初始化')

  const { data, error } = await supabase.rpc('horizn_sync_qq_members', {
    p_members: members
  })

  if (error) throw new Error(`同步失败: ${error.message}`)
  return data
}

/**
 * 查询指定 UTC 时间范围内的入离队事件（附带成员主名字）
 * @param {string} startUTC - ISO 字符串
 * @param {string} endUTC   - ISO 字符串
 */
export async function getDailyEvents(startUTC, endUTC) {
  if (!supabase) throw new Error('数据库未初始化')

  const { data: events, error } = await supabase
    .from('horizn_membership_events')
    .select('player_id, member_id, event_type, is_kicked')
    .gte('event_time', startUTC)
    .lt('event_time', endUTC)
    .order('event_time', { ascending: true })

  if (error) throw new Error(`事件查询失败: ${error.message}`)
  if (!events || events.length === 0) return { joins: [], leaves: [] }

  // 批量查主名字
  const memberIds = [...new Set(events.filter(e => e.member_id).map(e => e.member_id))]
  const nameMap = new Map()

  if (memberIds.length > 0) {
    const { data: names } = await supabase
      .from('horizn_name_variants')
      .select('member_id, name, is_primary, group_index, last_seen')
      .in('member_id', memberIds)
      .order('is_primary', { ascending: false })
      .order('group_index', { ascending: true })
      .order('last_seen', { ascending: false })

    if (names) {
      // 每个成员只取排序最靠前的一条
      names.forEach(n => {
        if (!nameMap.has(n.member_id)) nameMap.set(n.member_id, n.name)
      })
    }
  }

  const joins = events
    .filter(e => e.event_type === 'join')
    .map(e => ({ player_id: e.player_id, name: nameMap.get(e.member_id) || null }))

  const leaves = events
    .filter(e => e.event_type === 'leave')
    .map(e => ({ player_id: e.player_id, name: nameMap.get(e.member_id) || null, is_kicked: e.is_kicked }))

  return { joins, leaves }
}

/**
 * 查询玩家完整档案
 * @param {string} playerId
 * @returns {Promise<{
 *   found: 'member' | 'external_blacklist' | 'none',
 *   member?: object,
 *   events?: Array,
 *   qqAccounts?: Array,
 *   externalBlacklist?: object
 * }>}
 */
export async function getPlayerFullInfo(playerId) {
  if (!supabase) throw new Error('数据库未初始化')

  console.log(`[Supabase] 查询 player_id: ${playerId}`)

  // 1. 查询成员主表
  const { data: members, error: memberError } = await supabase
    .from('horizn_members')
    .select('id, player_id, member_number, hull_number, hull_date, active, is_second_team, is_blacklisted, blacklist_date, blacklist_note')
    .eq('player_id', playerId)
    .limit(1)

  if (memberError) throw new Error(`成员查询失败: ${memberError.message}`)

  if (members && members.length > 0) {
    const member = members[0]

    // 并行查询入离队历史 + QQ账号 + 主名字
    const [eventsResult, qqResult, nameResult] = await Promise.all([
      supabase
        .from('horizn_membership_events')
        .select('event_type, event_time, is_kicked')
        .eq('player_id', playerId)
        .order('event_time', { ascending: true }),
      supabase
        .from('horizn_qq_accounts')
        .select('qq_id, nickname, card, join_time, left_at')
        .eq('member_id', member.id)
        .eq('is_ignored', false)
        .order('join_time', { ascending: true }),
      supabase
        .from('horizn_name_variants')
        .select('name')
        .eq('member_id', member.id)
        .order('is_primary', { ascending: false })
        .order('group_index', { ascending: true })
        .order('last_seen', { ascending: false })
        .limit(1)
    ])

    if (eventsResult.error) console.error('[Supabase] 事件查询失败:', eventsResult.error)
    if (qqResult.error) console.error('[Supabase] QQ账号查询失败:', qqResult.error)
    if (nameResult.error) console.error('[Supabase] 名字查询失败:', nameResult.error)

    return {
      found: 'member',
      member,
      primaryName: nameResult.data?.[0]?.name || null,
      events: eventsResult.data || [],
      qqAccounts: qqResult.data || []
    }
  }

  // 2. 不在成员表，查询外部黑名单
  const { data: blacklist, error: blacklistError } = await supabase
    .from('horizn_blacklist_else')
    .select('name, player_id, qq_number, note, blacklist_date')
    .eq('player_id', playerId)
    .limit(1)

  if (blacklistError) console.error('[Supabase] 外部黑名单查询失败:', blacklistError)

  if (blacklist && blacklist.length > 0) {
    return {
      found: 'external_blacklist',
      externalBlacklist: blacklist[0]
    }
  }

  return { found: 'none' }
}
