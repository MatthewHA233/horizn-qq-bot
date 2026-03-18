/**
 * 艾米莉亚 AI 工具集
 * 工具定义（function calling）+ 执行逻辑 + 格式化输出
 */
import { getSupabaseClient } from './supabase.js'

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
    search_member: '查询成员',
    set_member_blacklist: '黑名单操作',
    set_hull_number: '设置舷号',
    add_external_blacklist: '添加外部黑名单',
    delete_external_blacklist: '删除外部黑名单记录'
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
