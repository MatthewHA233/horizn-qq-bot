/**
 * 成员统一身份解析：玩家 ID、QQ 号、QQ群名片/昵称、全部游戏名历史。
 */
import { getPlayerActivity } from './duckdb.js'
import {
  getPlayerFullInfo,
  getSupabaseClient,
  sortNameVariants
} from './supabase.js'

const SEP = '────────────────'
const SEARCH_LIMIT = 8

function normalize(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
}

function isPlayerId(value) {
  return /^[a-z0-9]{6,16}$/i.test(value) && /[a-z]/i.test(value) && /\d/.test(value)
}

function isQQNumber(value) {
  return /^\d{5,12}$/.test(value)
}

function ensureQueryResult(label, result) {
  if (result.error) throw new Error(`${label}查询失败：${result.error.message}`)
  return result.data || []
}

function addMatch(matchMap, memberId, match) {
  if (!memberId) return
  if (!matchMap.has(memberId)) matchMap.set(memberId, [])
  const list = matchMap.get(memberId)
  const key = `${match.type}:${match.value}`
  if (!list.some(item => `${item.type}:${item.value}` === key)) list.push(match)
}

function dedupeExternal(rows) {
  const map = new Map()
  for (const row of rows) {
    const key = row.id || `${row.player_id || ''}:${row.qq_number || ''}:${row.name || ''}`
    if (!map.has(key)) map.set(key, row)
  }
  return [...map.values()]
}

function selectPreferredCandidates(candidates) {
  const exact = candidates.filter(candidate => candidate.matches.some(match => match.exact))
  return (exact.length ? exact : candidates)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.player_id.localeCompare(b.player_id))
}

function matchLabel(match) {
  const labels = {
    player_id: '玩家ID',
    qq_id: 'QQ号',
    qq_card: 'QQ群名片',
    qq_nickname: 'QQ昵称',
    current_name: '当前游戏名',
    historical_name: '历史游戏名'
  }
  return `${labels[match.type] || match.type}「${match.value}」`
}

async function resolveIdentity(query) {
  const sb = getSupabaseClient()
  const cleaned = String(query ?? '').normalize('NFKC').trim()
  if (!cleaned) throw new Error('查询内容不能为空')
  if (cleaned.length > 80) throw new Error('查询内容过长')

  const normalizedQuery = normalize(cleaned)
  const playerIdLike = isPlayerId(cleaned)
  const qqLike = isQQNumber(cleaned)
  const wildcard = `%${cleaned}%`

  const tasks = [
    ['游戏名', sb.from('horizn_name_variants')
      .select('member_id, name, is_primary, group_index, last_seen, source')
      .ilike('name', wildcard)
      .limit(40)],
    ['QQ群名片', sb.from('horizn_qq_accounts')
      .select('member_id, qq_id, card, nickname, left_at, is_ignored')
      .ilike('card', wildcard)
      .limit(40)],
    ['QQ昵称', sb.from('horizn_qq_accounts')
      .select('member_id, qq_id, card, nickname, left_at, is_ignored')
      .ilike('nickname', wildcard)
      .limit(40)],
    ['外部黑名单名称', sb.from('horizn_blacklist_else')
      .select('id, name, player_id, qq_number, note, blacklist_date')
      .ilike('name', wildcard)
      .limit(20)]
  ]

  if (playerIdLike) {
    tasks.push(
      ['玩家ID', sb.from('horizn_members')
        .select('id, player_id, member_number, active, is_blacklisted')
        .ilike('player_id', cleaned)
        .limit(5)],
      ['外部黑名单ID', sb.from('horizn_blacklist_else')
        .select('id, name, player_id, qq_number, note, blacklist_date')
        .ilike('player_id', cleaned)
        .limit(5)]
    )
  }

  if (qqLike) {
    tasks.push(
      ['QQ号', sb.from('horizn_qq_accounts')
        .select('member_id, qq_id, card, nickname, left_at, is_ignored')
        .eq('qq_id', cleaned)
        .limit(10)],
      ['外部黑名单QQ', sb.from('horizn_blacklist_else')
        .select('id, name, player_id, qq_number, note, blacklist_date')
        .eq('qq_number', cleaned)
        .limit(10)]
    )
  }

  const rawResults = await Promise.all(tasks.map(([, task]) => task))
  const results = Object.fromEntries(tasks.map(([label], index) => [
    label,
    ensureQueryResult(label, rawResults[index])
  ]))

  const matchMap = new Map()
  for (const member of results['玩家ID'] || []) {
    addMatch(matchMap, member.id, {
      type: 'player_id',
      value: member.player_id,
      exact: normalize(member.player_id) === normalizedQuery
    })
  }

  for (const variant of results['游戏名']) {
    addMatch(matchMap, variant.member_id, {
      type: 'game_name',
      value: variant.name,
      exact: normalize(variant.name) === normalizedQuery
    })
  }

  const qqRows = [
    ...(results['QQ群名片'] || []),
    ...(results['QQ昵称'] || []),
    ...(results['QQ号'] || [])
  ].filter(row => row.is_ignored !== true)

  for (const account of qqRows) {
    if (String(account.qq_id) === cleaned) {
      addMatch(matchMap, account.member_id, { type: 'qq_id', value: String(account.qq_id), exact: true })
    }
    if (account.card && normalize(account.card).includes(normalizedQuery)) {
      addMatch(matchMap, account.member_id, {
        type: 'qq_card', value: account.card, exact: normalize(account.card) === normalizedQuery
      })
    }
    if (account.nickname && normalize(account.nickname).includes(normalizedQuery)) {
      addMatch(matchMap, account.member_id, {
        type: 'qq_nickname', value: account.nickname, exact: normalize(account.nickname) === normalizedQuery
      })
    }
  }

  const memberIds = [...matchMap.keys()]
  let candidates = []
  if (memberIds.length) {
    const [membersResult, namesResult] = await Promise.all([
      sb.from('horizn_members')
        .select('id, player_id, member_number, active, is_blacklisted')
        .in('id', memberIds),
      sb.from('horizn_name_variants')
        .select('member_id, name, is_primary, group_index, last_seen, source')
        .in('member_id', memberIds)
        .limit(500)
    ])
    const members = ensureQueryResult('候选成员', membersResult)
    const names = ensureQueryResult('候选成员名字', namesResult)
    const namesByMember = new Map()
    for (const variant of names) {
      if (!namesByMember.has(variant.member_id)) namesByMember.set(variant.member_id, [])
      namesByMember.get(variant.member_id).push(variant)
    }

    candidates = members.map(member => {
      const sortedNames = sortNameVariants(namesByMember.get(member.id) || [])
      const currentName = sortedNames[0]?.name || null
      const allMatches = matchMap.get(member.id).map(match => {
        if (match.type !== 'game_name') return match
        return {
          ...match,
          type: normalize(match.value) === normalize(currentName) ? 'current_name' : 'historical_name'
        }
      })
      const exactMatches = allMatches.filter(match => match.exact)
      return {
        ...member,
        current_name: currentName,
        matches: exactMatches.length ? exactMatches : allMatches
      }
    })
  }

  const preferred = selectPreferredCandidates(candidates)
  if (preferred.length) {
    return {
      type: preferred.length === 1 ? 'resolved' : 'candidates',
      query: cleaned,
      candidate: preferred.length === 1 ? preferred[0] : null,
      candidates: preferred.slice(0, SEARCH_LIMIT),
      total: preferred.length,
      truncated: preferred.length > SEARCH_LIMIT
    }
  }

  const externalRows = dedupeExternal([
    ...(results['外部黑名单名称'] || []),
    ...(results['外部黑名单ID'] || []),
    ...(results['外部黑名单QQ'] || [])
  ])
  const exactExternal = externalRows.filter(row =>
    [row.name, row.player_id, row.qq_number].some(value => normalize(value) === normalizedQuery)
  )
  const preferredExternal = exactExternal.length ? exactExternal : externalRows
  if (preferredExternal.length === 1) {
    return { type: 'external_blacklist', query: cleaned, record: preferredExternal[0] }
  }
  if (preferredExternal.length > 1) {
    return {
      type: 'external_blacklist_candidates',
      query: cleaned,
      records: preferredExternal.slice(0, SEARCH_LIMIT),
      total: preferredExternal.length
    }
  }

  const unlinkedQQ = qqRows.find(row => !row.member_id)
  if (unlinkedQQ) return { type: 'unlinked_qq', query: cleaned, account: unlinkedQQ }
  return { type: 'not_found', query: cleaned }
}

/**
 * 将任意身份输入解析到 player_id，再复用完整 ID 档案查询。
 */
export async function lookupMember(query) {
  const resolution = await resolveIdentity(query)
  if (resolution.type !== 'resolved') return resolution

  const playerId = resolution.candidate.player_id
  const [info, activity] = await Promise.all([
    getPlayerFullInfo(playerId),
    getPlayerActivity(playerId)
  ])
  return {
    type: 'member',
    query: resolution.query,
    matched: resolution.candidate.matches,
    info,
    activity
  }
}

function fmtDate(value) {
  if (!value) return '未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10)
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`
}

function formatActivityTime(value) {
  if (!value) return null
  const date = new Date(String(value).replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatMemberLookup(result) {
  const lines = [`查询：${result.query}`, SEP]

  if (result.type === 'not_found') {
    lines.push('无记录')
    return lines.join('\n')
  }

  if (result.type === 'unlinked_qq') {
    const q = result.account
    lines.push('找到QQ群记录，但尚未绑定任何游戏成员ID')
    lines.push(`QQ：${q.qq_id}`)
    if (q.card || q.nickname) lines.push(`群名片：${q.card || q.nickname}`)
    return lines.join('\n')
  }

  if (result.type === 'candidates') {
    lines.push(`找到 ${result.total} 个可能成员，请指定玩家ID继续查询：`)
    for (const candidate of result.candidates) {
      const matched = candidate.matches.map(matchLabel).join('、')
      lines.push(`${candidate.current_name || candidate.player_id}（${candidate.player_id}）${candidate.active ? '' : ' [已离队]'}`)
      lines.push(`  匹配：${matched}`)
    }
    if (result.truncated) lines.push(`仅显示前 ${result.candidates.length} 项`)
    return lines.join('\n')
  }

  if (result.type === 'external_blacklist_candidates') {
    lines.push(`外部黑名单中找到 ${result.total} 条，请提供更精确的信息：`)
    for (const record of result.records) {
      lines.push(`${record.name}${record.player_id ? `（${record.player_id}）` : ''}${record.qq_number ? ` QQ:${record.qq_number}` : ''}`)
    }
    return lines.join('\n')
  }

  if (result.type === 'external_blacklist') {
    const bl = result.record
    lines.push('⚠️ 外部黑名单')
    lines.push(`称呼：${bl.name}${bl.qq_number ? `  QQ：${bl.qq_number}` : ''}`)
    if (bl.player_id) lines.push(`玩家ID：${bl.player_id}`)
    lines.push(`拉黑日期：${fmtDate(bl.blacklist_date)}`)
    if (bl.note) lines.push(`原因：${bl.note}`)
    return lines.join('\n')
  }

  if (result.type !== 'member' || result.info.found !== 'member') {
    lines.push('无记录')
    return lines.join('\n')
  }

  const { member, primaryName, nameVariants, hullAssignment, guarantee, events, qqAccounts } = result.info
  const meaningfulMatches = (result.matched || []).filter(match => match.type !== 'player_id')
  if (meaningfulMatches.length) {
    lines.push(`匹配：${meaningfulMatches.map(matchLabel).join('、')} → ${member.player_id}`)
  }

  if (member.is_blacklisted) {
    const note = member.blacklist_note ? `  备注：${member.blacklist_note}` : ''
    lines.push(`⚠️ 黑名单（${fmtDate(member.blacklist_date)}）${note}`)
  }

  if (primaryName) lines.push(`游戏名：${primaryName}`)
  lines.push(`玩家ID：${member.player_id}`)

  const historicalNames = [...new Set((nameVariants || []).map(item => item.name))]
    .filter(name => normalize(name) !== normalize(primaryName))
  if (historicalNames.length) lines.push(`历史游戏名：${historicalNames.join('、')}`)

  const hull = hullAssignment
    ? `${hullAssignment.hull_number}（${fmtDate(hullAssignment.assigned_at)}）`
    : '无'
  const number = member.member_number ? `成员编号：${member.member_number}  ` : ''
  lines.push(`${number}舷号：${hull}`)

  const status = [member.active ? '现役' : '已离队']
  if (member.is_second_team) status.push('二队')
  lines.push(`状态：${status.join(' · ')}`)

  if (guarantee) {
    const guarantor = guarantee.guarantor_name ? `担保人：${guarantee.guarantor_name}` : '担保人未填写'
    const date = guarantee.guaranteed_at ? ` · ${fmtDate(guarantee.guaranteed_at)}标注` : ''
    lines.push(`担保进队：是（${guarantor}${date}）`)
    if (guarantee.note) lines.push(`担保备注：${guarantee.note}`)
  }

  const activeQQ = qqAccounts.filter(account => !account.left_at)
  const leftQQ = qqAccounts.filter(account => account.left_at)
  if (activeQQ.length) {
    for (const account of activeQQ) {
      const name = account.card || account.nickname || String(account.qq_id)
      const joined = account.join_time ? `，${fmtDate(account.join_time)}入群` : ''
      lines.push(`内群：${name}（${account.qq_id}${joined}）`)
    }
  } else if (leftQQ.length) {
    const latest = [...leftQQ].sort((a, b) => new Date(b.left_at) - new Date(a.left_at))[0]
    const name = latest.card || latest.nickname || String(latest.qq_id)
    lines.push(`内群：不在内群（离群 ${fmtDate(latest.left_at)}，曾用 ${name}（${latest.qq_id}））`)
  } else {
    lines.push('内群：不在内群')
  }

  if (result.activity) {
    lines.push(`最新活跃度（${formatActivityTime(result.activity.sessionTime)}）：`)
    lines.push(`  周活跃度 ${result.activity.weekly} | 赛季活跃度 ${result.activity.season}`)
  }

  if (events.length) {
    lines.push(`历史（共 ${events.length} 次）：`)
    for (const event of events) {
      const eventName = event.event_type === 'join' ? '入队' : '离队'
      const kicked = event.event_type === 'leave' && event.is_kicked ? '（被踢）' : ''
      lines.push(`  ${fmtDate(event.event_time)} ${eventName}${kicked}`)
    }
  } else {
    lines.push('历史：无入离队记录')
  }

  return lines.join('\n')
}
