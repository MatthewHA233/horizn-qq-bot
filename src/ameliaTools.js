/**
 * 艾米莉亚 AI 工具集
 * 工具定义（function calling）+ 执行逻辑 + 格式化输出
 */
import { getSupabaseClient, sortNameVariants } from './supabase.js'
import { generateHullSeatmapImage } from './hullSeatmap.js'
import { formatMemberLookup, lookupMember } from './memberLookup.js'

// ============================================================
// 工具定义（OpenAI function calling 格式）
// ============================================================

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_member',
      description: '查询成员完整档案。支持玩家ID、QQ号、QQ群名片/昵称，以及当前或任意历史游戏名；唯一匹配时返回与直接输入ID完全相同的完整信息。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '玩家ID、QQ号、QQ群名片/昵称、当前游戏名或任意历史游戏名关键词'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_hull_roster',
      description: '返回“舷号成员名单”：当前拥有舷号且在队（现役）的成员，每行一个当前游戏名，按舷号升序，纯名字、不含舷号/编号/统计/任何多余文字。默认只含在队成员，不含历史上曾有舷号但已离队的人。用户说“名单”“舷号名单”“舷号成员名单”“给我名单”等时调用。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_member_blacklist',
      description: '设置或解除已有成员的黑名单状态。player_id 必须来自用户输入的真实玩家ID或 search_member 的唯一命中结果；只有名字/QQ时必须先搜索，禁止把名字或QQ当作 player_id。此操作需要管理员明确确认后才能执行。',
      parameters: {
        type: 'object',
        properties: {
          player_id: { type: 'string', description: '成员 player_id' },
          blacklisted: { type: 'boolean', description: 'true=加入黑名单，false=解除黑名单' },
          note: { type: 'string', description: '黑名单原因备注（可选）' }
        },
        required: ['player_id', 'blacklisted']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_hull_number',
      description: '设置成员舷号及授予日期',
      parameters: {
        type: 'object',
        properties: {
          player_id: { type: 'string' },
          hull_number: { type: 'string', description: '舷号数字字符串，如 "1"、"42"、"101"' },
          hull_date: { type: 'string', description: '授予日期 YYYY-MM-DD，不填则用今天' }
        },
        required: ['player_id', 'hull_number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_member_guarantee',
      description: '标记或取消已有成员的“担保进队”状态。player_id 必须来自用户输入的真实玩家ID或 search_member 的唯一命中结果；guarantor_name 可以填写担保人的称呼，也可以留空表示只标记该成员是担保进队。此操作需要管理员明确确认后才能执行。',
      parameters: {
        type: 'object',
        properties: {
          player_id: { type: 'string', description: '被担保成员的 player_id' },
          guaranteed: { type: 'boolean', description: 'true=标记为担保进队，false=取消担保进队标记' },
          guarantor_name: { type: 'string', description: '担保人的称呼（可选；不知道或不需要记录时留空）' },
          note: { type: 'string', description: '担保备注（可选）' }
        },
        required: ['player_id', 'guaranteed']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_guaranteed_members',
      description: '查询所有被标记为担保进队的成员，完整返回当前游戏名、玩家ID、QQ、担保人、设定日期、备注和在队状态。用户问“有哪些人被担保”“所有担保进队成员”等问题时调用。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_external_blacklist',
      description: '将查不到成员档案的非成员玩家加入外部黑名单。若 search_member 已唯一命中已有成员，必须改用 set_member_blacklist；若已查到非成员的 player_id，必须一并传入。此操作需要管理员明确确认。blacklist_date 默认今天，可手动指定。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '玩家游戏名（必填）' },
          player_id: { type: 'string', description: '游戏ID，从 search_member 结果中获取' },
          qq_number: { type: 'string', description: 'QQ号（可选）' },
          note: { type: 'string', description: '拉黑原因（可选）' },
          blacklist_date: { type: 'string', description: '拉黑日期 YYYY-MM-DD，默认今天' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_hull_stats',
      description: '查询舷号统计：已分配数量、黑名单数量、空位区间分布。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_hull_seatmap',
      description: '生成舷号座位图（网格视图）图片发送到群聊，按 COMMAND/ELITE/HONOR 分区展示占位状态。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_hull_list',
      description: '生成舷号列表图片发送到群聊，按舷号排序展示所有成员的舷号、授予日期和状态。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_blacklist_image',
      description: '生成黑名单图片发送到群聊，包括成员黑名单和外部黑名单，显示拉黑日期和原因。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_hull_owner',
      description: '查询指定舷号的主人是谁',
      parameters: {
        type: 'object',
        properties: {
          hull_number: { type: 'string', description: '舷号，如 "42"' }
        },
        required: ['hull_number']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_hull_wear_status',
      description: '清点所有在队且已分配舷号的成员，检查其游戏名中是否佩戴了舷号（即名字含 No.XXX 字样）。返回完整列表，含佩戴状态。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_hull_assignments',
      description: '查询指定时间范围内被授予舷号的成员列表。可按月份查询或查最近N天。',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: '月份，格式 YYYY-MM，如 "2026-03"。与 recent_days 二选一' },
          recent_days: { type: 'integer', description: '最近N天，默认30。与 month 二选一' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_qq_joins',
      description: '查询指定时间范围内入群（QQ群）的成员列表，包含QQ号、入群时间、关联的游戏名和舷号。',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'string', description: '月份，格式 YYYY-MM。与 recent_days 二选一' },
          recent_days: { type: 'integer', description: '最近N天，默认30。与 month 二选一' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'end_session',
      description: '当用户明确表示想结束对话（如"退下""不用了""结束""拜拜"等）时调用此工具，结束本次会话。注意：仅在用户明确表达结束意图时才调用，不要因为话题中偶然出现"退出""结束"等词就调用。',
      parameters: {
        type: 'object',
        properties: {
          farewell: { type: 'string', description: '向用户说的告别语，简短自然' }
        },
        required: ['farewell']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_external_blacklist',
      description: '从外部黑名单删除指定记录（按记录 id 删除）。此操作需要管理员确认。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记录的 UUID，从 search_member 查询结果中获取' }
        },
        required: ['id']
      }
    }
  }
]

// 需要二次确认的工具
export const CONFIRM_REQUIRED_TOOLS = new Set([
  'set_member_blacklist',
  'set_member_guarantee',
  'add_external_blacklist',
  'delete_external_blacklist'
])

// ============================================================
// 工具执行
// ============================================================

function todayInChina(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function normalizeOptionalText(value) {
  const normalized = String(value ?? '').trim()
  return normalized || null
}

/**
 * 管理操作统一从数据库解析成员和当前可信游戏名，避免 AI 根据输入自行猜名字。
 */
export async function resolveMemberOperationTarget(playerId, options = {}) {
  const sb = options.supabase || getSupabaseClient()
  const normalizedId = String(playerId ?? '').trim()
  if (!normalizedId) throw new Error('缺少成员 player_id')

  const { data: member, error: memberError } = await sb
    .from('horizn_members')
    .select('id, player_id')
    .eq('player_id', normalizedId)
    .maybeSingle()
  if (memberError) throw new Error(memberError.message)
  if (!member) throw new Error(`成员 ${normalizedId} 不存在`)

  const { data: variants, error: nameError } = await sb
    .from('horizn_name_variants')
    .select('name, is_primary, group_index, last_seen, source')
    .eq('member_id', member.id)
  if (nameError) throw new Error(nameError.message)

  return {
    id: member.id,
    player_id: member.player_id,
    current_name: sortNameVariants(variants || [])[0]?.name || null
  }
}

export async function executeAmeliaTool(toolName, args, options = {}) {
  const sb = options.supabase || getSupabaseClient()

  switch (toolName) {
    case 'search_member':
      return await lookupMember(args.query)

    case 'get_hull_roster': {
      // 舷号成员名单：当前拥有舷号且在队 → 当前游戏名，按舷号升序；逐字直发，其它什么都不加
      const rows = (await _getHullRows(sb)).filter(r => r.active)
      const names = rows.map(r => r.current_name)
      return { _directText: names.join('\n'), count: names.length }
    }

    case 'set_member_blacklist': {
      const target = await resolveMemberOperationTarget(args.player_id, { supabase: sb })

      const today = todayInChina(options.now)
      const { data: updated, error } = await sb
        .from('horizn_members')
        .update({
          is_blacklisted: args.blacklisted,
          blacklist_date: args.blacklisted ? today : null,
          blacklist_note: args.blacklisted ? (args.note || null) : null
        })
        .eq('player_id', args.player_id)
        .select('player_id, is_blacklisted, blacklist_date, blacklist_note')
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!updated) throw new Error(`成员 ${args.player_id} 未被更新`)
      return {
        success: true,
        player_id: updated.player_id,
        current_name: target.current_name,
        blacklisted: updated.is_blacklisted
      }
    }

    case 'set_hull_number': {
      const target = await resolveMemberOperationTarget(args.player_id, { supabase: sb })
      const digits = String(args.hull_number).replace(/\D/g, '')
      const formatted = 'No.' + digits.padStart(3, '0')
      const { data, error } = await sb.rpc('horizn_assign_hull', {
        p_player_id: args.player_id,
        p_hull_number: formatted,
        p_notes: args.hull_date ? `授舷日期：${args.hull_date}` : null
      })
      if (error) throw new Error(error.message)
      if (data && !data.success) throw new Error(data.error || '分配失败')
      return {
        success: true,
        player_id: target.player_id,
        current_name: target.current_name,
        hull_number: formatted
      }
    }

    case 'set_member_guarantee': {
      if (typeof args.guaranteed !== 'boolean') {
        throw new Error('guaranteed 必须是 true 或 false')
      }

      const target = await resolveMemberOperationTarget(args.player_id, { supabase: sb })

      if (!args.guaranteed) {
        const { error } = await sb
          .from('horizn_member_guarantees')
          .delete()
          .eq('member_id', target.id)
        if (error) throw new Error(error.message)
        return {
          success: true,
          player_id: target.player_id,
          current_name: target.current_name,
          guaranteed: false
        }
      }

      const payload = {
        member_id: target.id,
        guarantor_name: normalizeOptionalText(args.guarantor_name),
        // 担保日期只能是实际确认写入当天，不接受 AI 或用户指定历史日期。
        guaranteed_at: todayInChina(options.now),
        note: normalizeOptionalText(args.note)
      }
      const { data: guarantee, error } = await sb
        .from('horizn_member_guarantees')
        .upsert(payload, { onConflict: 'member_id' })
        .select('member_id, guarantor_name, guaranteed_at, note')
        .maybeSingle()
      if (error) throw new Error(error.message)
      if (!guarantee) throw new Error(`成员 ${args.player_id} 的担保标注未被保存`)

      return {
        success: true,
        player_id: target.player_id,
        current_name: target.current_name,
        guaranteed: true,
        guarantor_name: guarantee.guarantor_name,
        guaranteed_at: guarantee.guaranteed_at,
        note: guarantee.note
      }
    }

    case 'query_guaranteed_members':
      return await _queryGuaranteedMembers(sb)

    case 'get_hull_stats':
      return await _getHullStats(sb)

    case 'get_hull_seatmap': {
      const imgPath = await generateHullSeatmapImage('grid')
      return { _imageFile: imgPath, view: 'grid' }
    }

    case 'get_hull_list': {
      try {
        const imgPath = await generateHullSeatmapImage('list')
        return { _imageFile: imgPath, view: 'list' }
      } catch (err) {
        // 外部出图服务不可用（认证/网络异常）→ 回退纯文本舷号列表，保证可用
        console.error('[Amelia] 舷号列表出图失败，回退文本:', err.message)
        const rows = await _getHullRows(sb)
        return { _directText: _formatHullListText(rows) }
      }
    }

    case 'get_blacklist_image': {
      const imgPath = await generateHullSeatmapImage('blacklist')
      return { _imageFile: imgPath, view: 'blacklist' }
    }

    case 'end_session':
      return { _endSession: true, farewell: args.farewell }

    case 'check_hull_wear_status':
      return await _checkHullWearStatus(sb)

    case 'query_hull_owner':
      return await _queryHullOwner(sb, args.hull_number)

    case 'query_hull_assignments':
      return await _queryHullAssignments(sb, args.month, args.recent_days)

    case 'query_qq_joins':
      return await _queryQQJoins(sb, args.month, args.recent_days)

    case 'add_external_blacklist': {
      const today = todayInChina(options.now)
      const { error } = await sb
        .from('horizn_blacklist_else')
        .insert({
          name: args.name,
          player_id: args.player_id || null,
          qq_number: args.qq_number || null,
          note: args.note || null,
          blacklist_date: args.blacklist_date || today
        })
      if (error) throw new Error(error.message)
      return { success: true, name: args.name, player_id: args.player_id || null }
    }

    case 'delete_external_blacklist': {
      const { error } = await sb
        .from('horizn_blacklist_else')
        .delete()
        .eq('id', args.id)
      if (error) throw new Error(error.message)
      return { success: true, id: args.id }
    }

    default:
      throw new Error(`未知工具: ${toolName}`)
  }
}

async function _queryGuaranteedMembers(sb) {
  const { data: guarantees, error } = await sb
    .from('horizn_member_guarantees')
    .select('member_id, guarantor_name, guaranteed_at, note, created_at')
    .order('guaranteed_at', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  if (!guarantees?.length) return { count: 0, members: [] }

  const memberIds = [...new Set(guarantees.map(item => item.member_id))]
  const [membersResult, namesResult, qqResult] = await Promise.all([
    sb.from('horizn_members')
      .select('id, player_id, member_number, active, is_blacklisted')
      .in('id', memberIds),
    sb.from('horizn_name_variants')
      .select('member_id, name, is_primary, group_index, last_seen, source')
      .in('member_id', memberIds),
    sb.from('horizn_qq_accounts')
      .select('member_id, qq_id, card, nickname, join_time')
      .in('member_id', memberIds)
      .eq('is_ignored', false)
      .is('left_at', null)
      .order('join_time', { ascending: false })
  ])

  const detailErrors = [
    ['成员', membersResult.error],
    ['游戏名', namesResult.error],
    ['QQ账号', qqResult.error]
  ].filter(([, detailError]) => detailError)
  if (detailErrors.length) {
    throw new Error(detailErrors.map(([label, detailError]) => `${label}：${detailError.message}`).join('；'))
  }

  const memberMap = new Map((membersResult.data || []).map(member => [member.id, member]))
  const namesByMember = new Map()
  for (const variant of (namesResult.data || [])) {
    if (!namesByMember.has(variant.member_id)) namesByMember.set(variant.member_id, [])
    namesByMember.get(variant.member_id).push(variant)
  }
  const qqByMember = new Map()
  for (const account of (qqResult.data || [])) {
    if (!qqByMember.has(account.member_id)) qqByMember.set(account.member_id, account)
  }

  const members = guarantees.map(guarantee => {
    const member = memberMap.get(guarantee.member_id)
    if (!member) return null
    const currentName = sortNameVariants(namesByMember.get(guarantee.member_id) || [])[0]?.name || null
    const qq = qqByMember.get(guarantee.member_id) || null
    return {
      player_id: member.player_id,
      member_number: member.member_number,
      current_name: currentName,
      active: member.active,
      is_blacklisted: member.is_blacklisted,
      guarantor_name: guarantee.guarantor_name,
      guaranteed_at: guarantee.guaranteed_at,
      note: guarantee.note,
      qq_id: qq?.qq_id ? String(qq.qq_id) : null,
      qq_name: qq?.card || qq?.nickname || null
    }
  }).filter(Boolean)

  return { count: members.length, members }
}

// 舷号数字（"No.042" → 42），用于排序
function _hullNum(hull) {
  const n = parseInt(String(hull || '').replace(/\D/g, ''), 10)
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

/**
 * 按 member_id 批量拉取全部名字变体，并分页突破 PostgREST 默认 1000 行上限。
 * 必须拿全量再交给 sortNameVariants，否则历史名多的成员会因截断丢失当前可信名。
 * 返回 Map<member_id, variants[]>。
 */
async function _fetchNameVariantsByMembers(sb, memberIds) {
  const cols = 'member_id, name, is_primary, group_index, last_seen, source'
  const PAGE = 1000
  const byMember = new Map()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('horizn_name_variants')
      .select(cols)
      .in('member_id', memberIds)
      .order('member_id', { ascending: true })
      .order('last_seen', { ascending: false, nullsFirst: false })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    for (const v of data) {
      if (!byMember.has(v.member_id)) byMember.set(v.member_id, [])
      byMember.get(v.member_id).push(v)
    }
    if (data.length < PAGE) break
  }
  return byMember
}

/**
 * 拉取全部未撤销的舷号分配，联表补齐 当前可信游戏名 / 在队状态 / 黑名单 / QQ。
 * horizn_hull_assignments 无反规范化字段，必须 JOIN horizn_members / horizn_name_variants / horizn_qq_accounts。
 */
async function _getHullRows(sb) {
  const { data: assignments, error } = await sb
    .from('horizn_hull_assignments')
    .select('hull_number, player_id, member_id, assigned_at, notes')
    .is('revoked_at', null)
  if (error) throw new Error(error.message)
  if (!assignments?.length) return []

  const memberIds = [...new Set(assignments.map(a => a.member_id).filter(Boolean))]
  const [membersRes, namesByMember, qqRes] = await Promise.all([
    sb.from('horizn_members').select('id, player_id, active, is_blacklisted').in('id', memberIds),
    _fetchNameVariantsByMembers(sb, memberIds),
    sb.from('horizn_qq_accounts').select('member_id, qq_id, join_time').in('member_id', memberIds).eq('is_ignored', false).is('left_at', null)
  ])
  const detailErr = [membersRes.error, qqRes.error].find(Boolean)
  if (detailErr) throw new Error(detailErr.message)

  const memberMap = new Map((membersRes.data || []).map(m => [m.id, m]))
  const qqByMember = new Map()
  for (const q of (qqRes.data || [])) {
    if (!qqByMember.has(q.member_id)) qqByMember.set(q.member_id, q)
  }

  return assignments.map(a => {
    const m = memberMap.get(a.member_id)
    const qq = qqByMember.get(a.member_id) || null
    return {
      hull_number: a.hull_number,
      player_id: a.player_id,
      current_name: sortNameVariants(namesByMember.get(a.member_id) || [])[0]?.name || a.player_id,
      hull_date: a.assigned_at ? String(a.assigned_at).slice(0, 10) : null,
      active: m?.active ?? false,
      is_blacklisted: m?.is_blacklisted ?? false,
      qq_id: qq?.qq_id ? String(qq.qq_id) : null,
      qq_join_time: qq?.join_time ? String(qq.join_time).slice(0, 10) : null
    }
  }).sort((a, b) => _hullNum(a.hull_number) - _hullNum(b.hull_number))
}

/** 纯文本舷号列表（出图服务不可用时的回退） */
function _formatHullListText(rows) {
  const active = rows.filter(r => r.active)
  if (!active.length) return '当前没有在队的舷号成员。'
  const lines = [`在队舷号成员（共 ${active.length} 人）：`]
  for (const r of active) {
    lines.push(`${r.hull_number}  ${r.current_name}${r.is_blacklisted ? ' ⚠️黑名单' : ''}`)
  }
  return lines.join('\n')
}

async function _checkHullWearStatus(sb) {
  const rows = (await _getHullRows(sb)).filter(r => r.active)
  if (!rows.length) return { total: 0, list: [] }
  return {
    total: rows.length,
    list: rows.map(r => ({ hull_number: r.hull_number, current_name: r.current_name }))
  }
}

async function _queryHullOwner(sb, hullNumber) {
  // 归一化：将 "102"、"No.102"、"no.102" 统一为 "No.102"
  let normalized
  if (/^No\./i.test(hullNumber)) {
    normalized = 'No.' + hullNumber.replace(/^[Nn][Oo]\./, '').padStart(3, '0')
  } else {
    const digits = hullNumber.replace(/\D/g, '')
    normalized = 'No.' + digits.padStart(3, '0')
  }

  const { data, error } = await sb
    .from('horizn_hull_assignments')
    .select('player_id, member_id, hull_number, assigned_at, notes')
    .eq('hull_number', normalized)
    .is('revoked_at', null)
    .limit(1)
  if (error) throw new Error(error.message)
  if (!data?.length) return { found: false, hull_number: normalized }

  const a = data[0]
  const [memberRes, namesRes, qqRes] = await Promise.all([
    sb.from('horizn_members').select('active, is_blacklisted').eq('id', a.member_id).maybeSingle(),
    sb.from('horizn_name_variants').select('name, is_primary, group_index, last_seen, source').eq('member_id', a.member_id),
    sb.from('horizn_qq_accounts').select('qq_id, join_time').eq('member_id', a.member_id).eq('is_ignored', false).is('left_at', null).order('join_time', { ascending: false }).limit(1)
  ])

  const current = sortNameVariants(namesRes.data || [])[0]?.name || null
  const qq = qqRes.data?.[0] || null

  return {
    found: true,
    hull_number: normalized,
    player_id: a.player_id,
    primary_name: current,
    hull_date: a.assigned_at ? String(a.assigned_at).slice(0, 10) : null,
    active: memberRes.data?.active ?? null,
    is_blacklisted: memberRes.data?.is_blacklisted || false,
    qq_id: qq?.qq_id ? String(qq.qq_id) : null,
    qq_join_time: qq?.join_time ? String(qq.join_time).slice(0, 10) : null
  }
}

async function _queryHullAssignments(sb, month, recentDays) {
  let dateFrom, dateTo, label

  if (month) {
    // YYYY-MM format
    const [y, m] = month.split('-').map(Number)
    dateFrom = `${y}-${String(m).padStart(2, '0')}-01`
    // last day of month
    const lastDay = new Date(y, m, 0).getDate()
    dateTo = `${y}-${String(m).padStart(2, '0')}-${lastDay}`
    label = `${y}年${m}月`
  } else {
    const days = recentDays || 30
    const now = new Date()
    dateTo = now.toISOString().slice(0, 10)
    const from = new Date(now.getTime() - days * 86400000)
    dateFrom = from.toISOString().slice(0, 10)
    label = `最近${days}天`
  }

  const { data, error } = await sb
    .from('horizn_hull_assignments')
    .select('player_id, member_id, hull_number, assigned_at')
    .gte('assigned_at', dateFrom)
    .lte('assigned_at', dateTo + 'T23:59:59Z')
    .order('assigned_at', { ascending: true })

  if (error) throw new Error(error.message)
  if (!data?.length) return { label, dateFrom, dateTo, count: 0, members: [] }

  // 联表补齐 当前游戏名 / 在队状态 / QQ（horizn_hull_assignments 无这些反规范化字段）
  const memberIds = [...new Set(data.map(a => a.member_id).filter(Boolean))]
  const [membersRes, namesByMember, qqRes] = await Promise.all([
    sb.from('horizn_members').select('id, active').in('id', memberIds),
    _fetchNameVariantsByMembers(sb, memberIds),
    sb.from('horizn_qq_accounts').select('member_id, qq_id, join_time').in('member_id', memberIds).eq('is_ignored', false).is('left_at', null)
  ])
  const detailErr = [membersRes.error, qqRes.error].find(Boolean)
  if (detailErr) throw new Error(detailErr.message)

  const activeMap = new Map((membersRes.data || []).map(m => [m.id, m.active]))
  const qqByMember = new Map()
  for (const q of (qqRes.data || [])) {
    if (!qqByMember.has(q.member_id)) qqByMember.set(q.member_id, q)
  }

  return {
    label,
    dateFrom,
    dateTo,
    count: data.length,
    members: data.map(a => {
      const qq = qqByMember.get(a.member_id) || null
      return {
        player_id: a.player_id,
        primary_name: sortNameVariants(namesByMember.get(a.member_id) || [])[0]?.name || null,
        hull_number: a.hull_number,
        hull_date: a.assigned_at ? String(a.assigned_at).slice(0, 10) : null,
        active: activeMap.get(a.member_id) ?? null,
        qq_id: qq?.qq_id ? String(qq.qq_id) : null,
        qq_join_time: qq?.join_time ? String(qq.join_time).slice(0, 10) : null
      }
    })
  }
}

async function _queryQQJoins(sb, month, recentDays) {
  let dateFrom, dateTo, label

  if (month) {
    const [y, m] = month.split('-').map(Number)
    dateFrom = `${y}-${String(m).padStart(2, '0')}-01T00:00:00Z`
    const lastDay = new Date(y, m, 0).getDate()
    dateTo = `${y}-${String(m).padStart(2, '0')}-${lastDay}T23:59:59Z`
    label = `${y}年${m}月`
  } else {
    const days = recentDays || 30
    const now = new Date()
    dateTo = now.toISOString()
    const from = new Date(now.getTime() - days * 86400000)
    dateFrom = from.toISOString()
    label = `最近${days}天`
  }

  const { data, error } = await sb
    .from('horizn_qq_accounts')
    .select('qq_id, nickname, card, join_time, member_id')
    .eq('is_ignored', false)
    .gte('join_time', dateFrom)
    .lte('join_time', dateTo)
    .order('join_time', { ascending: true })

  if (error) throw new Error(error.message)

  // batch fetch member info (name, active) + hull assignments
  const memberIds = [...new Set((data || []).filter(q => q.member_id).map(q => q.member_id))]
  let memberMap = {}
  let hullMap = {}
  if (memberIds.length) {
    const [membersRes, namesRes, hullRes] = await Promise.all([
      sb.from('horizn_members').select('id, player_id, active').in('id', memberIds),
      sb.from('horizn_name_variants').select('member_id, name, is_primary').in('member_id', memberIds).order('is_primary', { ascending: false }),
      sb.from('horizn_hull_assignments').select('player_id, hull_number').is('revoked_at', null).in('member_id', memberIds)
    ])
    const nameMap = {}
    for (const n of (namesRes.data || [])) {
      if (!nameMap[n.member_id]) nameMap[n.member_id] = n.name
    }
    for (const m of (membersRes.data || [])) {
      memberMap[m.id] = { ...m, primary_name: nameMap[m.id] || null }
    }
    for (const h of (hullRes.data || [])) {
      hullMap[h.player_id] = h.hull_number
    }
  }

  return {
    label,
    dateFrom: dateFrom.slice(0, 10),
    dateTo: dateTo.slice(0, 10),
    count: (data || []).length,
    members: (data || []).map(q => {
      const m = memberMap[q.member_id]
      return {
        qq_id: q.qq_id,
        qq_nickname: q.card || q.nickname || null,
        qq_join_time: q.join_time ? String(q.join_time).slice(0, 10) : null,
        player_id: m?.player_id || null,
        primary_name: m?.primary_name || null,
        hull_number: m?.player_id ? (hullMap[m.player_id] || null) : null,
        active: m?.active ?? null
      }
    })
  }
}

async function _getHullStats(sb) {
  const [hullRes, memberBlRes, extBlRes] = await Promise.all([
    sb.from('horizn_hull_assignments').select('hull_number').is('revoked_at', null),
    sb.from('horizn_members').select('id', { count: 'exact', head: true }).eq('is_blacklisted', true),
    sb.from('horizn_blacklist_else').select('id', { count: 'exact', head: true })
  ])

  const nums = (hullRes.data || [])
    .map(m => parseInt(m.hull_number.replace('No.', ''))).filter(n => !isNaN(n)).sort((a, b) => a - b)
  const occupied = new Set(nums)
  const maxHull = nums.length ? Math.max(...nums) : 0

  // Find gap clusters within [0, maxHull]
  const gaps = []
  for (let i = 0; i <= maxHull; i++) { if (!occupied.has(i)) gaps.push(i) }
  const clusters = []
  let cur = null
  for (const g of gaps) {
    if (!cur) { cur = { start: g, end: g }; continue }
    if (g === cur.end + 1) cur.end = g
    else { clusters.push(cur); cur = { start: g, end: g } }
  }
  if (cur) clusters.push(cur)

  return {
    totalAssigned: nums.length,
    memberBlacklisted: memberBlRes.count || 0,
    externalBlacklisted: extBlRes.count || 0,
    blacklistTotal: (memberBlRes.count || 0) + (extBlRes.count || 0),
    maxHull,
    gapCount: gaps.length,
    gapClusters: clusters
  }
}

// ============================================================
// 格式化 + 辅助
// ============================================================

export function formatToolResult(toolName, result) {
  switch (toolName) {
    case 'search_member': {
      return formatMemberLookup(result)
    }
    case 'get_hull_stats': {
      const r = result
      const lines = [
        `舷号统计（最高 No.${r.maxHull}）：`,
        `  已分配：${r.totalAssigned} 个`,
        `  成员黑名单：${r.memberBlacklisted} 人，外部黑名单：${r.externalBlacklisted} 人`,
        `  空位数：${r.gapCount} 个`,
      ]
      if (r.gapClusters.length) {
        lines.push(`\n空位区间（共 ${r.gapClusters.length} 段）：`)
        for (const c of r.gapClusters.slice(0, 12)) {
          if (c.start === c.end) lines.push(`  No.${String(c.start).padStart(3,'0')}`)
          else lines.push(`  No.${String(c.start).padStart(3,'0')}–${String(c.end).padStart(3,'0')}（${c.end - c.start + 1}个连续）`)
        }
        if (r.gapClusters.length > 12) lines.push(`  …共 ${r.gapClusters.length} 段空位`)
      }
      return lines.join('\n')
    }

    case 'get_hull_roster':
      return result._directText ?? ''

    case 'get_hull_seatmap':
      return '已生成舷号座位图（网格视图），图片已发送到群聊。'
    case 'get_hull_list':
      // 出图成功走图片；出图失败已回退纯文本，直发该文本
      return result._directText ?? '已生成舷号列表图片，已发送到群聊。'
    case 'get_blacklist_image':
      return '已生成黑名单图片（含成员黑名单 + 外部黑名单），已发送到群聊。'

    case 'check_hull_wear_status': {
      if (!result.total) return '当前没有在队且已分配舷号的成员。'
      const lines = [`在队舷号成员共 ${result.total} 人，舷号 → 当前游戏名列表如下（请逐一判断游戏名中是否包含该舷号标识）：`]
      for (const m of result.list) {
        lines.push(`${m.hull_number}  ${m.current_name}`)
      }
      return lines.join('\n')
    }

    case 'query_hull_owner': {
      if (!result.found) return `舷号 No.${result.hull_number} 目前无人使用。`
      const lines = [
        `舷号 No.${result.hull_number} 的主人：`,
        `  ${result.primary_name || result.player_id}（${result.player_id}）`,
        `  授予日期：${result.hull_date || '未知'}`,
        `  状态：${result.active ? '现役' : '已离队'}${result.is_blacklisted ? ' ⚠️黑名单' : ''}`
      ]
      if (result.qq_id) lines.push(`  QQ：${result.qq_id}，入群：${result.qq_join_time || '未知'}`)
      return lines.join('\n')
    }
    case 'query_hull_assignments': {
      if (!result.count) return `${result.label}（${result.dateFrom} ~ ${result.dateTo}）没有新授予舷号的记录。`
      const lines = [`${result.label} 共授予 ${result.count} 个舷号：`]
      for (const m of result.members) {
        let line = `  No.${m.hull_number} → ${m.primary_name || m.player_id}（${m.hull_date}）`
        if (m.qq_id) line += ` QQ:${m.qq_id}`
        if (m.qq_join_time) line += ` 入群:${m.qq_join_time}`
        if (!m.active) line += ' [离队]'
        lines.push(line)
      }
      return lines.join('\n')
    }
    case 'query_qq_joins': {
      if (!result.count) return `${result.label}（${result.dateFrom} ~ ${result.dateTo}）没有新入群记录。`
      const lines = [`${result.label} 共 ${result.count} 人入群：`]
      for (const m of result.members) {
        let line = `  ${m.qq_join_time} ${m.qq_nickname || 'QQ:' + m.qq_id}`
        if (m.primary_name) line += `（游戏名: ${m.primary_name}）`
        if (m.hull_number) line += ` 舷号No.${m.hull_number}`
        if (m.active === false) line += ' [离队]'
        if (!m.player_id) line += ' [未关联成员]'
        lines.push(line)
      }
      return lines.join('\n')
    }

    case 'set_member_blacklist':
      return result.blacklisted
        ? `已将 ${formatOperationTarget(result)} 加入黑名单。`
        : `已解除 ${formatOperationTarget(result)} 的黑名单。`
    case 'set_hull_number':
      return `已为 ${formatOperationTarget(result)}设置舷号 ${result.hull_number}。`
    case 'set_member_guarantee':
      if (!result.guaranteed) return `已取消 ${formatOperationTarget(result)} 的担保进队标记。`
      return result.guarantor_name
        ? `已标记 ${formatOperationTarget(result)} 由 ${result.guarantor_name} 担保进队。`
        : `已标记 ${formatOperationTarget(result)} 为担保进队（未填写担保人）。`
    case 'query_guaranteed_members': {
      if (!result.count) return '当前没有被标记为担保进队的成员。'
      const lines = [`担保进队成员共 ${result.count} 人：`]
      result.members.forEach((member, index) => {
        const number = member.member_number ? ` [编号 ${member.member_number}]` : ''
        const state = [member.active ? '现役' : '已离队']
        if (member.is_blacklisted) state.push('黑名单')
        lines.push(`${index + 1}. ${member.current_name || member.player_id}${number}`)
        lines.push(`   ID：${member.player_id} · ${state.join(' · ')}`)
        if (member.qq_id) {
          lines.push(`   QQ：${member.qq_name ? `${member.qq_name}（${member.qq_id}）` : member.qq_id}`)
        }
        lines.push(`   担保人：${member.guarantor_name || '未填写'} · 设定日期：${member.guaranteed_at || '未知'}`)
        if (member.note) lines.push(`   备注：${member.note}`)
      })
      return lines.join('\n')
    }
    case 'add_external_blacklist':
      return `已将 ${result.name}${result.player_id ? `（${result.player_id}）` : ''} 加入外部黑名单。`
    case 'delete_external_blacklist':
      return `已从外部黑名单删除该记录（id: ${result.id}）。`
    default:
      return JSON.stringify(result)
  }
}

function formatOperationTarget(value) {
  return value.current_name
    ? `${value.current_name}（${value.player_id}）`
    : value.player_id
}

export function getToolLabel(toolName) {
  return {
    search_member: '查询成员档案',
    get_hull_roster: '获取舷号成员名单',
    set_member_blacklist: '操作成员黑名单',
    set_hull_number: '设置舷号',
    set_member_guarantee: '设置担保进队标记',
    query_guaranteed_members: '查询所有担保进队成员',
    add_external_blacklist: '添加外部黑名单',
    delete_external_blacklist: '删除外部黑名单记录',
    check_hull_wear_status: '清点舷号佩戴情况',
    query_hull_owner: '查询舷号归属',
    query_hull_assignments: '查询舷号授予记录',
    query_qq_joins: '查询QQ入群记录',
    get_hull_stats: '查询舷号 & 黑名单统计数据',
    get_hull_seatmap: '生成舷号座位图（截图，约需10秒）',
    get_hull_list: '生成舷号列表图（截图，约需10秒）',
    get_blacklist_image: '生成黑名单图片（截图，约需10秒）'
  }[toolName] || toolName
}

export function buildConfirmMessage(toolName, args) {
  const target = formatOperationTarget(args)
  switch (toolName) {
    case 'set_member_blacklist':
      return args.blacklisted
        ? `⚠️ 确认将 ${target} 加入黑名单${args.note ? `（原因：${args.note}）` : ''}？\n回复「确认」执行，其他内容取消。`
        : `确认解除 ${target} 的黑名单？\n回复「确认」执行，其他内容取消。`
    case 'add_external_blacklist':
      return `⚠️ 确认将非成员 ${args.name}${args.player_id ? `（${args.player_id}）` : ''} 加入外部黑名单${args.note ? `（原因：${args.note}）` : ''}？\n回复「确认」执行，其他内容取消。`
    case 'set_member_guarantee':
      if (!args.guaranteed) {
        return `确认取消 ${target} 的担保进队标记？\n回复「确认」执行，其他内容取消。`
      }
      return `确认将 ${target} 标记为担保进队${args.guarantor_name ? `（担保人：${args.guarantor_name}）` : '（未填写担保人）'}${args.note ? `，备注：${args.note}` : ''}？\n回复「确认」执行，其他内容取消。`
    case 'delete_external_blacklist':
      return `⚠️ 确认从外部黑名单删除记录 ${args.id}？\n回复「确认」执行，其他内容取消。`
    default:
      return `确认执行 ${getToolLabel(toolName)}？\n回复「确认」执行，其他内容取消。`
  }
}
