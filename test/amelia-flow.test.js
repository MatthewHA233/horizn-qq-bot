import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyConfirmationReply,
  shouldContinueAfterSearch
} from '../src/amelia.js'
import {
  buildConfirmMessage,
  CONFIRM_REQUIRED_TOOLS,
  TOOL_DEFINITIONS,
  executeAmeliaTool,
  formatToolResult
} from '../src/ameliaTools.js'
import { formatMemberLookup } from '../src/memberLookup.js'
import { stripQQFaces, textToSegments } from '../src/qqFace.js'

test('复合黑名单请求在搜索后继续，不被完整档案提前截断', () => {
  assert.equal(shouldContinueAfterSearch('877D027F103D9541 黑名单，拿奖励退队'), true)
  assert.equal(shouldContinueAfterSearch('把池鱼思故渊列入黑名单'), true)
  assert.equal(shouldContinueAfterSearch('把池鱼思故渊标记成由宝哥担保进队'), true)
  assert.equal(shouldContinueAfterSearch('查一下池鱼思故渊'), false)
})

test('二次确认只接受明确短回复', () => {
  assert.equal(classifyConfirmationReply('确认'), 'confirm')
  assert.equal(classifyConfirmationReply('好的！'), 'confirm')
  assert.equal(classifyConfirmationReply('取消'), 'cancel')
  assert.equal(classifyConfirmationReply('我再想想'), 'unknown')
})

function createBlacklistMock({ existing = true } = {}) {
  let memberFromCount = 0
  let updatePayload = null

  const supabase = {
    from(table) {
      if (table === 'horizn_name_variants') {
        return resolvedQuery([{
          name: '当前可信名',
          is_primary: false,
          group_index: 0,
          last_seen: '2026-08-04T00:00:00Z',
          source: 'http'
        }])
      }

      assert.equal(table, 'horizn_members')
      memberFromCount++

      if (memberFromCount === 1) {
        const chain = {
          select() { return chain },
          eq() { return chain },
          async maybeSingle() {
            return {
              data: existing ? { id: 'MEMBER-1', player_id: 'PLAYER123' } : null,
              error: null
            }
          }
        }
        return chain
      }

      const chain = {
        update(payload) { updatePayload = payload; return chain },
        eq() { return chain },
        select() { return chain },
        async maybeSingle() {
          return {
            data: { player_id: 'PLAYER123', is_blacklisted: updatePayload.is_blacklisted },
            error: null
          }
        }
      }
      return chain
    }
  }

  return { supabase, getUpdatePayload: () => updatePayload }
}

test('成员黑名单写入先校验目标并返回实际更新行', async () => {
  const mock = createBlacklistMock()
  const result = await executeAmeliaTool('set_member_blacklist', {
    player_id: 'PLAYER123',
    blacklisted: true,
    note: '拿奖励退队'
  }, {
    supabase: mock.supabase,
    now: new Date('2026-08-01T00:30:00Z')
  })

  assert.deepEqual(result, {
    success: true,
    player_id: 'PLAYER123',
    current_name: '当前可信名',
    blacklisted: true
  })
  assert.deepEqual(mock.getUpdatePayload(), {
    is_blacklisted: true,
    blacklist_date: '2026-08-01',
    blacklist_note: '拿奖励退队'
  })
})

test('成员不存在时拒绝伪成功', async () => {
  const mock = createBlacklistMock({ existing: false })
  await assert.rejects(
    executeAmeliaTool('set_member_blacklist', {
      player_id: 'MISSING123',
      blacklisted: true
    }, { supabase: mock.supabase }),
    /成员 MISSING123 不存在/
  )
  assert.equal(mock.getUpdatePayload(), null)
})

function createGuaranteeMock({ memberExists = true } = {}) {
  let guaranteePayload = null
  let upsertOptions = null
  let deletedMemberId = null

  const supabase = {
    from(table) {
      if (table === 'horizn_members') {
        const chain = {
          select() { return chain },
          eq() { return chain },
          async maybeSingle() {
            return {
              data: memberExists ? { id: 'MEMBER-1', player_id: 'PLAYER123' } : null,
              error: null
            }
          }
        }
        return chain
      }

      if (table === 'horizn_name_variants') {
        return resolvedQuery([{
          name: '当前可信名',
          is_primary: false,
          group_index: 0,
          last_seen: '2026-08-04T00:00:00Z',
          source: 'http'
        }])
      }

      assert.equal(table, 'horizn_member_guarantees')
      const chain = {
        error: null,
        upsert(payload, options) {
          guaranteePayload = payload
          upsertOptions = options
          return chain
        },
        select() { return chain },
        async maybeSingle() {
          return { data: guaranteePayload, error: null }
        },
        delete() { return chain },
        eq(column, value) {
          assert.equal(column, 'member_id')
          deletedMemberId = value
          return chain
        }
      }
      return chain
    }
  }

  return {
    supabase,
    getGuaranteePayload: () => guaranteePayload,
    getUpsertOptions: () => upsertOptions,
    getDeletedMemberId: () => deletedMemberId
  }
}

test('担保进队支持记录担保人并要求二次确认', async () => {
  assert.equal(CONFIRM_REQUIRED_TOOLS.has('set_member_guarantee'), true)
  const mock = createGuaranteeMock()
  const result = await executeAmeliaTool('set_member_guarantee', {
    player_id: 'PLAYER123',
    guaranteed: true,
    guarantor_name: ' 宝哥 ',
    guarantee_date: '2000-01-01',
    note: ' 管理员确认 '
  }, {
    supabase: mock.supabase,
    now: new Date('2026-08-03T16:30:00Z')
  })

  assert.deepEqual(mock.getGuaranteePayload(), {
    member_id: 'MEMBER-1',
    guarantor_name: '宝哥',
    guaranteed_at: '2026-08-04',
    note: '管理员确认'
  })
  assert.deepEqual(mock.getUpsertOptions(), { onConflict: 'member_id' })
  assert.deepEqual(result, {
    success: true,
    player_id: 'PLAYER123',
    current_name: '当前可信名',
    guaranteed: true,
    guarantor_name: '宝哥',
    guaranteed_at: '2026-08-04',
    note: '管理员确认'
  })
  assert.match(formatToolResult('set_member_guarantee', result), /由 宝哥 担保进队/)

  const definition = TOOL_DEFINITIONS.find(tool => tool.function.name === 'set_member_guarantee')
  assert.equal('guarantee_date' in definition.function.parameters.properties, false)
})

test('担保进队允许不填写担保人，也可以取消标记', async () => {
  const createMock = createGuaranteeMock()
  const created = await executeAmeliaTool('set_member_guarantee', {
    player_id: 'PLAYER123',
    guaranteed: true
  }, {
    supabase: createMock.supabase,
    now: new Date('2026-08-04T02:00:00Z')
  })
  assert.equal(createMock.getGuaranteePayload().guarantor_name, null)
  assert.match(formatToolResult('set_member_guarantee', created), /未填写担保人/)

  const clearMock = createGuaranteeMock()
  const cleared = await executeAmeliaTool('set_member_guarantee', {
    player_id: 'PLAYER123',
    guaranteed: false
  }, { supabase: clearMock.supabase })
  assert.equal(clearMock.getDeletedMemberId(), 'MEMBER-1')
  assert.deepEqual(cleared, {
    success: true,
    player_id: 'PLAYER123',
    current_name: '当前可信名',
    guaranteed: false
  })
})

test('拉黑、赐予舷号和担保只多显示一个当前游戏名', async () => {
  const rows = {
    horizn_members: { id: 'MEMBER-1', player_id: 'PLAYER123' },
    horizn_name_variants: [{
      name: '当前可信名',
      is_primary: false,
      group_index: 0,
      last_seen: '2026-08-04T00:00:00Z',
      source: 'http'
    }]
  }
  const supabase = {
    from(table) {
      if (table === 'horizn_name_variants') return resolvedQuery(rows[table])
      assert.equal(table, 'horizn_members')
      const chain = {
        select() { return chain },
        eq() { return chain },
        async maybeSingle() { return { data: rows[table], error: null } }
      }
      return chain
    },
    async rpc(name, args) {
      assert.equal(name, 'horizn_assign_hull')
      assert.deepEqual(args, {
        p_player_id: 'PLAYER123',
        p_hull_number: 'No.042',
        p_notes: null
      })
      return { data: { success: true }, error: null }
    }
  }

  const hull = await executeAmeliaTool('set_hull_number', {
    player_id: 'PLAYER123',
    hull_number: '42'
  }, { supabase })
  assert.equal(
    formatToolResult('set_hull_number', hull),
    '已为 当前可信名（PLAYER123）设置舷号 No.042。'
  )

  assert.equal(
    buildConfirmMessage('set_member_blacklist', {
      player_id: 'PLAYER123',
      current_name: '当前可信名',
      blacklisted: true
    }),
    '⚠️ 确认将 当前可信名（PLAYER123） 加入黑名单？\n回复「确认」执行，其他内容取消。'
  )
  assert.equal(
    buildConfirmMessage('set_member_guarantee', {
      player_id: 'PLAYER123',
      current_name: '当前可信名',
      guaranteed: true,
      guarantor_name: '宝哥'
    }),
    '确认将 当前可信名（PLAYER123） 标记为担保进队（担保人：宝哥）？\n回复「确认」执行，其他内容取消。'
  )
})

test('完整成员档案显示担保标注', () => {
  const output = formatMemberLookup({
    type: 'member',
    query: 'PLAYER123',
    matched: [],
    activity: null,
    info: {
      found: 'member',
      member: {
        player_id: 'PLAYER123',
        member_number: '001',
        active: true,
        is_second_team: false,
        is_blacklisted: false
      },
      primaryName: '测试成员',
      nameVariants: [],
      hullAssignment: null,
      guarantee: {
        guarantor_name: null,
        guaranteed_at: '2026-08-04',
        note: null
      },
      events: [],
      qqAccounts: []
    }
  })

  assert.match(output, /担保进队：是（担保人未填写 · 2026\.8\.4标注）/)
})

test('历史游戏名只展示 HTTP 精确名和 OCR 代表名，不展示 OCR 噪声', () => {
  const output = formatMemberLookup({
    type: 'member',
    query: '2B66696E8FB1FCF1',
    matched: [],
    activity: null,
    info: {
      found: 'member',
      member: {
        player_id: '2B66696E8FB1FCF1',
        member_number: 'member_167',
        active: true,
        is_second_team: false,
        is_blacklisted: false
      },
      primaryName: '剑指天涯岸',
      nameVariants: [
        { name: '剑指天涯岸', source: 'http', representative: null },
        { name: '旧HTTP名', source: 'http', representative: null },
        { name: 'PROMISE『ˣⁱᵃⁿᵍˢⁱ', source: null, representative: true },
        { name: '相思两行泪ˣᴺ', source: null, representative: true },
        { name: 'rxiangsiPROMISE', source: null, representative: false },
        { name: '相思两行泪心', source: 'ocr', representative: false },
        { name: '未审阅OCR名', source: null, representative: null }
      ],
      hullAssignment: null,
      guarantee: null,
      events: [],
      qqAccounts: []
    }
  })

  const historyLine = output.split('\n').find(line => line.startsWith('📜 历史游戏名：'))
  assert.equal(historyLine, '📜 历史游戏名：旧HTTP名、PROMISE『ˣⁱᵃⁿᵍˢⁱ、相思两行泪ˣᴺ')
  assert.doesNotMatch(output, /rxiangsiPROMISE|相思两行泪心|未审阅OCR名/)
})

test('小黄脸 CQ 码拆成 face 消息段，其余保持纯文本', () => {
  assert.deepEqual(textToSegments('\n[CQ:face,id=314] 查询：A\n    2026.3.1 [CQ:face,id=49] 入队'), [
    { type: 'text', data: { text: '\n' } },
    { type: 'face', data: { id: '314' } },
    { type: 'text', data: { text: ' 查询：A\n    2026.3.1 ' } },
    { type: 'face', data: { id: '49' } },
    { type: 'text', data: { text: ' 入队' } }
  ])
  assert.deepEqual(textToSegments('无小黄脸 [xiangsiPROMISE'), [
    { type: 'text', data: { text: '无小黄脸 [xiangsiPROMISE' } }
  ])
  assert.equal(stripQQFaces('[CQ:face,id=282] 状态：现役\n    2026.6.20 [CQ:face,id=39] 离队'), '状态：现役\n    2026.6.20 离队')
})

test('完整成员档案每行带图标，小黄脸按定稿 id 发送', () => {
  const output = formatMemberLookup({
    type: 'member',
    query: '相思两行泪',
    matched: [{ type: 'current_name', value: '相思两行泪' }],
    activity: { sessionTime: '2026-10-10 11:50:00', weekly: 3520, season: 98760 },
    info: {
      found: 'member',
      member: {
        player_id: '2B66696E8FB1FCF1',
        member_number: 'member_167',
        active: true,
        is_second_team: true,
        is_blacklisted: false
      },
      primaryName: '相思两行泪',
      nameVariants: [],
      hullAssignment: { hull_number: '167', assigned_at: '2026-03-02' },
      guarantee: { guarantor_name: '某某', guaranteed_at: '2026-08-04', note: null },
      events: [
        { event_type: 'join', event_time: '2026-03-01T00:00:00+08:00', is_kicked: false },
        { event_type: 'leave', event_time: '2026-06-20T00:00:00+08:00', is_kicked: true }
      ],
      qqAccounts: [{ qq_id: 123456789, card: '相思两行泪', join_time: '2026-03-01', left_at: null }]
    }
  })

  const lines = output.split('\n')
  for (const prefix of ['🎯 匹配：', '🎮 游戏名：', '🆔 玩家ID：', '🔢 成员编号：', '⚓ 舷号：', '🗓️ 入离队记录（共 2 次）：']) {
    assert.ok(lines.some(line => line.startsWith(prefix)), `缺少行首「${prefix}」`)
  }

  const faceIds = textToSegments(output).filter(seg => seg.type === 'face').map(seg => seg.data.id)
  assert.deepEqual(faceIds, ['314', '282', '78', '125', '30', '49', '39'])
  const plain = textToSegments(output).filter(seg => seg.type === 'text').map(seg => seg.data.text).join('')
  assert.doesNotMatch(plain, /CQ:face/)
  assert.match(plain, /离队（被踢）/)
})

function resolvedQuery(data) {
  const chain = {
    select() { return chain },
    order() { return chain },
    in() { return chain },
    eq() { return chain },
    is() { return chain },
    then(resolve, reject) {
      return Promise.resolve({ data, error: null }).then(resolve, reject)
    }
  }
  return chain
}

test('可以查询所有担保进队成员并返回身份、QQ和担保日期', async () => {
  const rows = {
    horizn_member_guarantees: [{
      member_id: 'MEMBER-1',
      guarantor_name: '宝哥',
      guaranteed_at: '2026-08-04',
      note: '审核通过',
      created_at: '2026-08-04T02:00:00Z'
    }],
    horizn_members: [{
      id: 'MEMBER-1',
      player_id: 'PLAYER123',
      member_number: '025',
      active: true,
      is_blacklisted: false
    }],
    horizn_name_variants: [
      {
        member_id: 'MEMBER-1',
        name: '旧名字',
        is_primary: true,
        group_index: 1,
        last_seen: '2026-07-01T00:00:00Z',
        source: 'ocr'
      },
      {
        member_id: 'MEMBER-1',
        name: '当前可信名',
        is_primary: false,
        group_index: 0,
        last_seen: '2026-08-04T00:00:00Z',
        source: 'http'
      }
    ],
    horizn_qq_accounts: [{
      member_id: 'MEMBER-1',
      qq_id: '123456',
      card: '群名片',
      nickname: 'QQ昵称',
      join_time: '2026-03-01T00:00:00Z'
    }]
  }
  const supabase = {
    from(table) {
      assert.ok(table in rows, `unexpected table: ${table}`)
      return resolvedQuery(rows[table])
    }
  }

  const result = await executeAmeliaTool('query_guaranteed_members', {}, { supabase })
  assert.equal(result.count, 1)
  assert.deepEqual(result.members[0], {
    player_id: 'PLAYER123',
    member_number: '025',
    current_name: '当前可信名',
    active: true,
    is_blacklisted: false,
    guarantor_name: '宝哥',
    guaranteed_at: '2026-08-04',
    note: '审核通过',
    qq_id: '123456',
    qq_name: '群名片'
  })

  const output = formatToolResult('query_guaranteed_members', result)
  assert.match(output, /担保进队成员共 1 人/)
  assert.match(output, /当前可信名 \[编号 025\]/)
  assert.match(output, /QQ：群名片（123456）/)
  assert.match(output, /担保人：宝哥 · 设定日期：2026-08-04/)
})
