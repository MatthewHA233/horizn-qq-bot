/**
 * 艾米莉亚 AI 工具集
 * 工具定义（function calling）+ 执行逻辑 + 格式化输出
 */
import { getSupabaseClient } from './supabase.js'
import { generateHullSeatmapImage } from './hullSeatmap.js'

// ============================================================
// 工具定义（OpenAI function calling 格式）
// ============================================================

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_member',
      description: '查询成员档案。支持 player_id 精确查询（如 ABC123），或游戏名模糊搜索。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'player_id（大写字母+数字混合，6-16位）或游戏名关键词'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_member_blacklist',
      description: '设置或解除成员黑名单状态。此操作需要管理员明确确认后才能执行。',
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
      name: 'add_external_blacklist',
      description: '将非成员玩家加入外部黑名单（horizn_blacklist_else 表）',
      parameters: {
        type: 'object',
        properties: {
          player_id: { type: 'string' },
          name: { type: 'string', description: '玩家游戏名' },
          qq_number: { type: 'string', description: 'QQ号（可选）' },
          note: { type: 'string', description: '拉黑原因（可选）' }
        },
        required: ['player_id', 'name']
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
      name: 'delete_external_blacklist',
      description: '从外部黑名单删除指定记录。此操作需要管理员确认。',
      parameters: {
        type: 'object',
        properties: {
          player_id: { type: 'string' }
        },
        required: ['player_id']
      }
    }
  }
]

// 需要二次确认的工具
export const CONFIRM_REQUIRED_TOOLS = new Set([
  'set_member_blacklist',
  'delete_external_blacklist'
])

// ============================================================
// 工具执行
// ============================================================

export async function executeAmeliaTool(toolName, args) {
  const sb = getSupabaseClient()

  switch (toolName) {
    case 'search_member':
      return await _searchMember(sb, args.query)

    case 'set_member_blacklist': {
      const today = new Date().toISOString().slice(0, 10)
      const { error } = await sb
        .from('horizn_members')
        .update({
          is_blacklisted: args.blacklisted,
          blacklist_date: args.blacklisted ? today : null,
          blacklist_note: args.blacklisted ? (args.note || null) : null
        })
        .eq('player_id', args.player_id)
      if (error) throw new Error(error.message)
      return { success: true, player_id: args.player_id, blacklisted: args.blacklisted }
    }

    case 'set_hull_number': {
      const date = args.hull_date || new Date().toISOString().slice(0, 10)
      const { error } = await sb
        .from('horizn_members')
        .update({ hull_number: args.hull_number, hull_date: date })
        .eq('player_id', args.player_id)
      if (error) throw new Error(error.message)
      return { success: true, player_id: args.player_id, hull_number: args.hull_number, hull_date: date }
    }

    case 'get_hull_stats':
      return await _getHullStats(sb)

    case 'get_hull_seatmap': {
      const imgPath = await generateHullSeatmapImage('grid')
      return { _imageFile: imgPath, view: 'grid' }
    }

    case 'get_hull_list': {
      const imgPath = await generateHullSeatmapImage('list')
      return { _imageFile: imgPath, view: 'list' }
    }

    case 'get_blacklist_image': {
      const imgPath = await generateHullSeatmapImage('blacklist')
      return { _imageFile: imgPath, view: 'blacklist' }
    }

    case 'check_hull_wear_status':
      return await _checkHullWearStatus(sb)

    case 'query_hull_owner':
      return await _queryHullOwner(sb, args.hull_number)

    case 'query_hull_assignments':
      return await _queryHullAssignments(sb, args.month, args.recent_days)

    case 'query_qq_joins':
      return await _queryQQJoins(sb, args.month, args.recent_days)

    case 'add_external_blacklist': {
      const today = new Date().toISOString().slice(0, 10)
      const { error } = await sb
        .from('horizn_blacklist_else')
        .upsert({
          player_id: args.player_id,
          name: args.name,
          qq_number: args.qq_number || null,
          note: args.note || null,
          blacklist_date: today
        }, { onConflict: 'player_id' })
      if (error) throw new Error(error.message)
      return { success: true, player_id: args.player_id, name: args.name }
    }

    case 'delete_external_blacklist': {
      const { error } = await sb
        .from('horizn_blacklist_else')
        .delete()
        .eq('player_id', args.player_id)
      if (error) throw new Error(error.message)
      return { success: true, player_id: args.player_id }
    }

    default:
      throw new Error(`未知工具: ${toolName}`)
  }
}

async function _checkHullWearStatus(sb) {
  // 1. 拉取所有在队且已分配舷号（No.xxx）的成员
  const { data: members, error } = await sb
    .from('horizn_members')
    .select('id, player_id, hull_number')
    .like('hull_number', 'No.%')
    .eq('active', true)
    .order('hull_number', { ascending: true })
  if (error) throw new Error(error.message)
  if (!members?.length) return { total: 0, list: [] }

  // 2. 批量拉取当前名称（group_index=0，按 is_primary DESC, last_seen DESC 取第一条）
  const ids = members.map(m => m.id)
  const { data: names } = await sb
    .from('horizn_name_variants')
    .select('member_id, name')
    .in('member_id', ids)
    .eq('group_index', 0)
    .order('is_primary', { ascending: false })
    .order('last_seen', { ascending: false })
  // 每个成员只取第一条
  const nameMap = {}
  for (const n of (names || [])) {
    if (!nameMap[n.member_id]) nameMap[n.member_id] = n.name
  }

  const list = members.map(m => ({
    hull_number: m.hull_number,
    current_name: nameMap[m.id] || m.player_id
  }))

  return { total: list.length, list }
}

async function _queryHullOwner(sb, hullNumber) {
  // 归一化：将 "102"、"No.102"、"no.102" 统一为 "No.102"
  let normalized
  if (/^No\./i.test(hullNumber)) {
    normalized = 'No.' + hullNumber.replace(/^[Nn][Oo]\./, '')
  } else {
    const digits = hullNumber.replace(/\D/g, '')
    normalized = 'No.' + digits.replace(/^0+/, '').padStart(3, '0')
  }

  const { data, error } = await sb
    .from('horizn_members')
    .select('id, player_id, hull_number, hull_date, active, is_blacklisted')
    .eq('hull_number', normalized)
    .limit(1)
  if (error) throw new Error(error.message)
  if (!data?.length) return { found: false, hull_number: normalized }

  const member = data[0]
  const [nameRes, qqRes] = await Promise.all([
    sb.from('horizn_name_variants')
      .select('name')
      .eq('member_id', member.id)
      .eq('group_index', 0)
      .order('is_primary', { ascending: false })
      .order('last_seen', { ascending: false })
      .limit(1),
    sb.from('horizn_qq_accounts')
      .select('qq_id, nickname, join_time')
      .eq('member_id', member.id)
      .eq('is_ignored', false)
      .order('join_time', { ascending: true })
      .limit(1)
  ])

  const qq = qqRes.data?.[0]
  return {
    found: true,
    hull_number: hullNumber,
    player_id: member.player_id,
    primary_name: nameRes.data?.[0]?.name || null,
    hull_date: member.hull_date,
    active: member.active,
    is_blacklisted: member.is_blacklisted,
    qq_id: qq?.qq_id || null,
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
    .from('horizn_members')
    .select('id, player_id, hull_number, hull_date, active')
    .like('hull_number', 'No.%')
    .gte('hull_date', dateFrom)
    .lte('hull_date', dateTo)
    .order('hull_date', { ascending: true })

  if (error) throw new Error(error.message)

  // batch fetch names + QQ accounts
  const memberIds = (data || []).map(m => m.id)
  let nameMap = {}
  let qqMap = {}
  if (memberIds.length) {
    const [namesRes, qqRes] = await Promise.all([
      sb.from('horizn_name_variants')
        .select('member_id, name')
        .in('member_id', memberIds)
        .eq('group_index', 0)
        .order('is_primary', { ascending: false })
        .order('last_seen', { ascending: false }),
      sb.from('horizn_qq_accounts')
        .select('member_id, qq_id, join_time')
        .in('member_id', memberIds)
        .eq('is_ignored', false)
        .order('join_time', { ascending: true })
    ])
    for (const n of (namesRes.data || [])) {
      if (!nameMap[n.member_id]) nameMap[n.member_id] = n.name
    }
    for (const q of (qqRes.data || [])) {
      if (!qqMap[q.member_id]) qqMap[q.member_id] = q
    }
  }

  return {
    label,
    dateFrom,
    dateTo,
    count: (data || []).length,
    members: (data || []).map(m => {
      const qq = qqMap[m.id]
      return {
        player_id: m.player_id,
        primary_name: nameMap[m.id] || null,
        hull_number: m.hull_number,
        hull_date: m.hull_date,
        active: m.active,
        qq_id: qq?.qq_id || null,
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

  // batch fetch member info (name, hull, active)
  const memberIds = [...new Set((data || []).filter(q => q.member_id).map(q => q.member_id))]
  let memberMap = {}
  if (memberIds.length) {
    const [membersRes, namesRes] = await Promise.all([
      sb.from('horizn_members')
        .select('id, player_id, hull_number, active')
        .in('id', memberIds),
      sb.from('horizn_name_variants')
        .select('member_id, name, is_primary')
        .in('member_id', memberIds)
        .order('is_primary', { ascending: false })
    ])
    const nameMap = {}
    for (const n of (namesRes.data || [])) {
      if (!nameMap[n.member_id]) nameMap[n.member_id] = n.name
    }
    for (const m of (membersRes.data || [])) {
      memberMap[m.id] = { ...m, primary_name: nameMap[m.id] || null }
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
        hull_number: m?.hull_number || null,
        active: m?.active ?? null
      }
    })
  }
}

async function _getHullStats(sb) {
  const [hullRes, memberBlRes, extBlRes] = await Promise.all([
    sb.from('horizn_members').select('hull_number').like('hull_number', 'No.%'),
    sb.from('horizn_members').select('id', { count: 'exact', head: true }).eq('is_blacklisted', true),
    sb.from('horizn_blacklist_else').select('id', { count: 'exact', head: true })
  ])

  const nums = (hullRes.data || [])
    .map(m => parseInt(m.hull_number)).filter(n => !isNaN(n)).sort((a, b) => a - b)
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

async function _searchMember(sb, query) {
  const isPlayerId = /^[A-Z0-9]{6,16}$/.test(query) && /[A-Z]/.test(query) && /[0-9]/.test(query)

  if (isPlayerId) {
    const { data: members, error } = await sb
      .from('horizn_members')
      .select('id, player_id, member_number, hull_number, hull_date, active, is_blacklisted, blacklist_date, blacklist_note')
      .eq('player_id', query)
      .limit(1)
    if (error) throw new Error(error.message)

    if (!members?.length) {
      const { data: bl } = await sb
        .from('horizn_blacklist_else')
        .select('name, player_id, qq_number, note, blacklist_date')
        .eq('player_id', query)
        .limit(1)
      if (bl?.length) return { type: 'external_blacklist', ...bl[0] }
      return { type: 'not_found', query }
    }

    const member = members[0]
    const [nameRes, eventsRes] = await Promise.all([
      sb.from('horizn_name_variants')
        .select('name')
        .eq('member_id', member.id)
        .order('is_primary', { ascending: false })
        .limit(1),
      sb.from('horizn_membership_events')
        .select('event_type, event_time, is_kicked')
        .eq('player_id', query)
        .order('event_time', { ascending: false })
        .limit(5)
    ])
    return {
      type: 'member',
      ...member,
      primary_name: nameRes.data?.[0]?.name || null,
      recent_events: eventsRes.data || []
    }
  } else {
    // 按游戏名模糊搜索
    const { data: names, error } = await sb
      .from('horizn_name_variants')
      .select('name, member_id')
      .ilike('name', `%${query}%`)
      .limit(5)
    if (error) throw new Error(error.message)
    if (!names?.length) return { type: 'not_found', query }

    const memberIds = [...new Set(names.map(n => n.member_id))]
    const { data: members } = await sb
      .from('horizn_members')
      .select('id, player_id, member_number, active, is_blacklisted')
      .in('id', memberIds)
    return {
      type: 'name_search',
      query,
      results: (members || []).map(m => ({
        ...m,
        matched_name: names.find(n => n.member_id === m.id)?.name
      }))
    }
  }
}

// ============================================================
// 格式化 + 辅助
// ============================================================

export function formatToolResult(toolName, result) {
  switch (toolName) {
    case 'search_member': {
      if (result.type === 'not_found') return `未找到 ${result.query} 相关记录。`
      if (result.type === 'external_blacklist') {
        return [
          `外部黑名单：${result.name}（${result.player_id}）`,
          `拉黑日期：${result.blacklist_date}`,
          result.note ? `原因：${result.note}` : null,
          result.qq_number ? `QQ：${result.qq_number}` : null
        ].filter(Boolean).join('\n')
      }
      if (result.type === 'member') {
        const fmtDate = s => s ? s.slice(0, 10) : '未知'
        return [
          `${result.primary_name || result.player_id}（${result.player_id}）`,
          `状态：${result.active ? '现役' : '已离队'}${result.is_blacklisted ? ' | ⚠️黑名单' : ''}`,
          `编号：${result.member_number || '无'}  舷号：${result.hull_number || '无'}`,
          result.recent_events?.length
            ? `最近事件：${result.recent_events[0].event_type === 'join' ? '入队' : '离队'} ${fmtDate(result.recent_events[0].event_time)}`
            : '暂无事件记录'
        ].join('\n')
      }
      if (result.type === 'name_search') {
        if (!result.results?.length) return `未找到名称含"${result.query}"的成员。`
        return `找到 ${result.results.length} 个：\n` +
          result.results.map(m =>
            `  ${m.matched_name || m.player_id}（${m.player_id}）${m.active ? '' : ' [离队]'}${m.is_blacklisted ? ' ⚠️' : ''}`
          ).join('\n')
      }
      return JSON.stringify(result)
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

    case 'get_hull_seatmap':
      return '已生成舷号座位图（网格视图），图片已发送到群聊。'
    case 'get_hull_list':
      return '已生成舷号列表图片，已发送到群聊。'
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
        ? `已将 ${result.player_id} 加入黑名单。`
        : `已解除 ${result.player_id} 的黑名单。`
    case 'set_hull_number':
      return `已为 ${result.player_id} 设置舷号 No.${result.hull_number}（${result.hull_date}）。`
    case 'add_external_blacklist':
      return `已将 ${result.name}（${result.player_id}）加入外部黑名单。`
    case 'delete_external_blacklist':
      return `已从外部黑名单删除 ${result.player_id}。`
    default:
      return JSON.stringify(result)
  }
}

export function getToolLabel(toolName) {
  return {
    search_member: '查询成员档案',
    set_member_blacklist: '操作成员黑名单',
    set_hull_number: '设置舷号',
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
  switch (toolName) {
    case 'set_member_blacklist':
      return args.blacklisted
        ? `⚠️ 确认将 ${args.player_id} 加入黑名单${args.note ? `（原因：${args.note}）` : ''}？\n回复「确认」执行，其他内容取消。`
        : `确认解除 ${args.player_id} 的黑名单？\n回复「确认」执行，其他内容取消。`
    case 'delete_external_blacklist':
      return `⚠️ 确认从外部黑名单删除 ${args.player_id}？\n回复「确认」执行，其他内容取消。`
    default:
      return `确认执行 ${getToolLabel(toolName)}？\n回复「确认」执行，其他内容取消。`
  }
}
