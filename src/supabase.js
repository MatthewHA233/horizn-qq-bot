/**
 * Supabase 成员档案查询 + QQ群同步服务
 */
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { parse as parseDotenv } from 'dotenv'

let supabase = null

/**
 * 判断 Supabase API Key 的数据库角色，不输出密钥本身。
 */
export function getSupabaseKeyRole(key) {
  if (!key) return 'missing'
  if (key.startsWith('sb_secret_')) return 'secret_key'
  if (key.startsWith('sb_publishable_')) return 'publishable_key'

  const parts = key.split('.')
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      return payload.role || 'jwt_without_role'
    } catch {
      return 'invalid_jwt'
    }
  }
  return 'unknown'
}

function isAdminKey(key) {
  const role = getSupabaseKeyRole(key)
  return role === 'service_role' || role === 'secret_key'
}

/**
 * 解析机器人服务端使用的 Supabase 管理密钥。
 * 支持直接配置，也支持从另一个未入库的 env 文件安全复用密钥。
 */
export function resolveSupabaseServiceKey(env = process.env) {
  const directCandidates = [
    env.SUPABASE_SECRET_KEY,
    env.SUPABASE_SERVICE_ROLE_KEY,
    env.SUPABASE_SERVICE_KEY
  ].filter(Boolean)

  const directAdminKey = directCandidates.find(isAdminKey)
  if (directAdminKey) return directAdminKey

  if (env.SUPABASE_SERVICE_KEY_FILE) {
    const keyFile = path.resolve(env.SUPABASE_SERVICE_KEY_FILE)
    let parsed
    try {
      parsed = parseDotenv(fs.readFileSync(keyFile, 'utf8'))
    } catch (err) {
      throw new Error(`无法读取 SUPABASE_SERVICE_KEY_FILE：${keyFile}（${err.message}）`)
    }

    const fileCandidates = [
      parsed.SUPABASE_SECRET_KEY,
      parsed.SUPABASE_SERVICE_ROLE_KEY,
      parsed.SUPABASE_SERVICE_KEY
    ].filter(Boolean)
    const fileAdminKey = fileCandidates.find(isAdminKey)
    if (fileAdminKey) return fileAdminKey

    const fileRoles = fileCandidates.map(getSupabaseKeyRole).join(', ') || '未找到密钥'
    throw new Error(`SUPABASE_SERVICE_KEY_FILE 中没有 service_role/secret key（检测到：${fileRoles}）`)
  }

  const configuredRoles = directCandidates.map(getSupabaseKeyRole).join(', ') || '未配置'
  throw new Error(
    `机器人必须使用 service_role/secret key，当前检测到：${configuredRoles}。` +
    '请配置 SUPABASE_SERVICE_ROLE_KEY、SUPABASE_SECRET_KEY，或 SUPABASE_SERVICE_KEY_FILE。'
  )
}

/**
 * 初始化 Supabase 客户端
 */
export function initSupabase(url, serviceKey) {
  if (!isAdminKey(serviceKey)) {
    throw new Error(`拒绝使用 ${getSupabaseKeyRole(serviceKey)} 初始化管理机器人`)
  }

  supabase = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  })
  console.log(`[Supabase] 客户端已初始化（${getSupabaseKeyRole(serviceKey)}）`)
}

function nameVariantPriority(a, b) {
  const aCurrent = a.group_index === 0 ? 1 : 0
  const bCurrent = b.group_index === 0 ? 1 : 0
  if (aCurrent !== bCurrent) return bCurrent - aCurrent

  const aHttp = a.source === 'http' ? 1 : 0
  const bHttp = b.source === 'http' ? 1 : 0
  if (aHttp !== bHttp) return bHttp - aHttp

  const aSeen = a.last_seen ? new Date(a.last_seen).getTime() : 0
  const bSeen = b.last_seen ? new Date(b.last_seen).getTime() : 0
  if (aSeen !== bSeen) return bSeen - aSeen

  return Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary))
}

/**
 * HTTP 可信名字优先，其次按当前组和最近出现时间选择展示名。
 */
export function sortNameVariants(nameVariants = []) {
  return [...nameVariants].sort(nameVariantPriority)
}

/**
 * 获取 Supabase 客户端实例（供内部模块使用）
 */
export function getSupabaseClient() {
  if (!supabase) throw new Error('Supabase 未初始化')
  return supabase
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

// ── 审核群（新人登记 + 游戏 ID 初绑定）────────────────────────

/**
 * 审核群成员对账：upsert 在群成员（清空退群时间），不在名单的标记退群时间
 * @returns {Promise<{success, upserted, left}>}
 */
export async function syncReviewQQMembers(members) {
  if (!supabase) throw new Error('数据库未初始化')
  const { data, error } = await supabase.rpc('horizn_sync_review_qq_members', { p_members: members })
  if (error) throw new Error(`审核群同步失败: ${error.message}`)
  return data
}

/**
 * 新人进审核群：登记一行；退群后再进群则刷新入群时间并清空退群时间（保留之前自报的 ID）
 */
export async function upsertReviewQQMember({ qqId, nickname, card, joinTime }) {
  if (!supabase) throw new Error('数据库未初始化')
  const { error } = await supabase
    .from('horizn_review_qq_accounts')
    .upsert({
      qq_id: qqId,
      nickname: nickname || null,
      card: card || null,
      join_time: joinTime || new Date().toISOString(),
      left_at: null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'qq_id' })
  if (error) throw new Error(`审核群登记失败: ${error.message}`)
}

/**
 * 读取审核群成员的登记状态（入群时间 + 自报 ID）；无记录返回 null
 */
export async function getReviewQQMember(qqId) {
  if (!supabase) throw new Error('数据库未初始化')
  const { data, error } = await supabase
    .from('horizn_review_qq_accounts')
    .select('join_time, player_id')
    .eq('qq_id', qqId)
    .maybeSingle()
  if (error) throw new Error(`审核群记录读取失败: ${error.message}`)
  return data
}

/**
 * 退审核群：只标记退群时间，保留行（自报 ID 等）供历史查询
 */
export async function markReviewQQMemberLeft(qqId, leftAt = new Date().toISOString()) {
  if (!supabase) throw new Error('数据库未初始化')
  const { error } = await supabase
    .from('horizn_review_qq_accounts')
    .update({ left_at: leftAt, updated_at: new Date().toISOString() })
    .eq('qq_id', qqId)
  if (error) throw new Error(`审核群退群标记失败: ${error.message}`)
}

/**
 * 记录新人自报的游戏 ID（初绑定）；改报时清空转入标记以便重新转入内群
 * @returns {Promise<string|null>} 之前登记的 ID（无则 null）
 */
export async function recordReviewPlayerId({ qqId, nickname, card, playerId }) {
  if (!supabase) throw new Error('数据库未初始化')
  const { data: existing, error: readError } = await supabase
    .from('horizn_review_qq_accounts')
    .select('player_id')
    .eq('qq_id', qqId)
    .maybeSingle()
  if (readError) throw new Error(`读取初绑定失败: ${readError.message}`)

  const now = new Date().toISOString()
  const { error } = await supabase
    .from('horizn_review_qq_accounts')
    .upsert({
      qq_id: qqId,
      nickname: nickname || null,
      card: card || null,
      player_id: playerId,
      player_id_at: now,
      transferred_at: null,
      left_at: null,
      updated_at: now
    }, { onConflict: 'qq_id' })
  if (error) throw new Error(`初绑定写入失败: ${error.message}`)
  return existing?.player_id || null
}

/**
 * 把审核群初绑定按 QQ 号转入内群自动绑定
 * @returns {Promise<{bound: Array<{qq_id, player_id}>, conflicts: Array<{qq_id, player_id}>}>}
 */
export async function transferReviewBindings() {
  if (!supabase) throw new Error('数据库未初始化')
  const { data, error } = await supabase.rpc('horizn_transfer_review_bindings')
  if (error) throw new Error(`初绑定转入内群失败: ${error.message}`)
  return { bound: data?.bound || [], conflicts: data?.conflicts || [] }
}

/**
 * 成员的审核群记录：自报 ID 为该成员，或 QQ 号与其内群 QQ（含已离群）相同
 * @param {string} playerId
 * @param {Array<{qq_id: number}>} innerAccounts
 * @returns {Promise<Array<{qq_id, nickname, card, join_time, left_at}>>}
 */
export async function getMemberReviewAccounts(playerId, innerAccounts = []) {
  if (!supabase) throw new Error('数据库未初始化')
  const qqIds = innerAccounts.map(account => Number(account.qq_id)).filter(Number.isSafeInteger)
  const filters = [`player_id.eq.${playerId}`]
  if (qqIds.length) filters.push(`qq_id.in.(${qqIds.join(',')})`)
  const { data, error } = await supabase
    .from('horizn_review_qq_accounts')
    .select('qq_id, nickname, card, join_time, left_at')
    .or(filters.join(','))
    .order('join_time', { ascending: true })
  if (error) throw new Error(`审核群记录查询失败: ${error.message}`)
  return data || []
}

/**
 * QQ 是否已在内群绑定游戏成员（在群且 member_id 非空）
 */
export async function isBoundInInnerGroup(qqId) {
  if (!supabase) throw new Error('数据库未初始化')
  const { data, error } = await supabase
    .from('horizn_qq_accounts')
    .select('member_id')
    .eq('qq_id', qqId)
    .is('left_at', null)
    .not('member_id', 'is', null)
    .limit(1)
  if (error) throw new Error(`内群绑定查询失败: ${error.message}`)
  return (data || []).length > 0
}

/**
 * 按 player_id 取成员当前展示名（HTTP 可信名优先）；不在成员库返回 null
 */
export async function getMemberDisplayName(playerId) {
  if (!supabase) throw new Error('数据库未初始化')
  const { data: members, error } = await supabase
    .from('horizn_members')
    .select('id')
    .eq('player_id', playerId)
    .limit(1)
  if (error) throw new Error(`成员查询失败: ${error.message}`)
  if (!members?.length) return null

  const { data: names, error: nameError } = await supabase
    .from('horizn_name_variants')
    .select('name, is_primary, group_index, last_seen, source')
    .eq('member_id', members[0].id)
  if (nameError) throw new Error(`名字查询失败: ${nameError.message}`)
  return sortNameVariants(names || [])[0]?.name || playerId
}

/**
 * 获取全体现役成员的名字和编号映射表
 * 用于脚本号检测时附加成员信息
 * @returns {Promise<Map<string, {name: string, memberNumber: string}>>}
 */
export async function getActiveMembersMap() {
  if (!supabase) throw new Error('数据库未初始化')

  const { data, error } = await supabase.rpc('horizn_get_members')
  if (error) throw new Error(`成员列表查询失败: ${error.message}`)

  const map = new Map()
  if (data) {
    data.forEach(m => {
      map.set(m.player_id, {
        name: m.primary_name || m.player_id,
        memberNumber: m.member_number || '?'
      })
    })
  }
  return map
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
 * 查询在群但未绑定游戏号的QQ成员
 */
export async function getUnlinkedQQMembers() {
  if (!supabase) throw new Error('数据库未初始化')

  const { data, error } = await supabase
    .from('horizn_qq_accounts')
    .select('qq_id, nickname, card, join_time')
    .is('member_id', null)
    .is('left_at', null)
    .eq('is_ignored', false)
    .order('join_time', { ascending: true })

  if (error) throw new Error(`未绑定成员查询失败: ${error.message}`)
  return data || []
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
    .select('id, player_id, member_number, active, is_second_team, is_blacklisted, blacklist_date, blacklist_note')
    .eq('player_id', playerId)
    .limit(1)

  if (memberError) throw new Error(`成员查询失败: ${memberError.message}`)

  if (members && members.length > 0) {
    const member = members[0]

    // 并行查询入离队历史 + QQ账号 + 全部名字历史 + 当前舷号 + 担保标注
    const [eventsResult, qqResult, nameResult, hullResult, guaranteeResult] = await Promise.all([
      supabase
        .from('horizn_membership_events')
        .select('event_type, event_time, is_kicked')
        .eq('player_id', playerId)
        .order('event_time', { ascending: true }),
      supabase
        .from('horizn_qq_accounts')
        .select('qq_id, nickname, card, role, join_time, left_at')
        .eq('member_id', member.id)
        .eq('is_ignored', false)
        .order('join_time', { ascending: true }),
      supabase
        .from('horizn_name_variants')
        .select('name, is_primary, group_index, last_seen, source, representative')
        .eq('member_id', member.id)
        .order('last_seen', { ascending: false }),
      supabase
        .from('horizn_hull_assignments')
        .select('hull_number, assigned_at, notes')
        .eq('player_id', playerId)
        .is('revoked_at', null)
        .limit(1),
      supabase
        .from('horizn_member_guarantees')
        .select('guarantor_name, guaranteed_at, note')
        .eq('member_id', member.id)
        .limit(1)
    ])

    const detailErrors = [
      ['入离队历史', eventsResult.error],
      ['QQ账号', qqResult.error],
      ['名字历史', nameResult.error],
      ['舷号', hullResult.error],
      ['担保标注', guaranteeResult.error]
    ].filter(([, error]) => error)
    if (detailErrors.length) {
      throw new Error(detailErrors.map(([label, error]) => `${label}：${error.message}`).join('；'))
    }

    const nameVariants = sortNameVariants(nameResult.data || [])
    const reviewAccounts = await getMemberReviewAccounts(member.player_id, qqResult.data || [])

    return {
      found: 'member',
      member,
      primaryName: nameVariants[0]?.name || null,
      nameVariants,
      hullAssignment: hullResult.data?.[0] || null,
      guarantee: guaranteeResult.data?.[0] || null,
      events: eventsResult.data || [],
      qqAccounts: qqResult.data || [],
      reviewAccounts
    }
  }

  // 2. 不在成员表，查询外部黑名单
  const { data: blacklist, error: blacklistError } = await supabase
    .from('horizn_blacklist_else')
    .select('name, player_id, qq_number, note, blacklist_date')
    .eq('player_id', playerId)
    .limit(1)

  if (blacklistError) throw new Error(`外部黑名单查询失败: ${blacklistError.message}`)

  if (blacklist && blacklist.length > 0) {
    return {
      found: 'external_blacklist',
      externalBlacklist: blacklist[0]
    }
  }

  return { found: 'none' }
}
