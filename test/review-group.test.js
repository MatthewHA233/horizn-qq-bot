import test from 'node:test'
import assert from 'node:assert/strict'

import { extractPlayerIds, isPlayerId } from '../src/playerId.js'
import {
  buildReviewIdReply,
  handleReviewGroupMessage,
  handleReviewGroupNotice,
  needsIdReminder,
  REVIEW_EXAMPLE_PLAYER_ID,
  REVIEW_ID_RETRY_TEXT,
  REVIEW_WELCOME_TEXT
} from '../src/reviewGroup.js'

test('player_id 识别：游戏名片段不再误判，13-16 位十六进制正常识别', () => {
  assert.deepEqual(extractPlayerIds('地平线『No.130』STS1508'), [])
  assert.deepEqual(extractPlayerIds('ABC123DEF45'), [])           // 11 位太短
  assert.deepEqual(extractPlayerIds('accededfacade'), [])          // 纯字母单词
  assert.deepEqual(extractPlayerIds('RJGTO8OB74V26H'), [])         // 非十六进制
  assert.deepEqual(extractPlayerIds('我的id是 C86DA773478609A5 谢谢'), ['C86DA773478609A5'])
  assert.deepEqual(extractPlayerIds('1c3afd10ef1d6'), ['1C3AFD10EF1D6'])  // 13 位、小写转大写
  assert.deepEqual(extractPlayerIds('C86DA773478609A5 c86da773478609a5'), ['C86DA773478609A5'])
  assert.deepEqual(extractPlayerIds('C86DA773478609A5FF'), [])     // 18 位超长
  assert.equal(isPlayerId('1F39B2763263D5A'), true)
  assert.equal(isPlayerId('STS1508'), false)
})

test('审核群登记回复区分新登记 / 改报，库里有名字才附识别名，不提内群绑定', () => {
  assert.equal(REVIEW_WELCOME_TEXT, '欢迎来到Horizon地平线！请发一下你的游戏ID（12~16位字母数字组合）')
  assert.equal(
    buildReviewIdReply({ playerId: 'C86DA773478609A5', previousId: null, displayName: '晨不昏' }),
    '已登记游戏ID：C86DA773478609A5（识别为「晨不昏」）'
  )
  assert.equal(
    buildReviewIdReply({ playerId: 'C86DA773478609A5', previousId: 'B8FE50545EB633EA', displayName: null }),
    '已更新游戏ID：C86DA773478609A5'
  )
  assert.equal(
    buildReviewIdReply({ playerId: 'C86DA773478609A5', previousId: 'C86DA773478609A5', displayName: null }),
    '已登记游戏ID：C86DA773478609A5'
  )
})

function createFakeClient() {
  const sent = []
  return {
    sent,
    async replyGroupMessageWithAt(groupId, messageId, userId, text) { sent.push({ kind: 'reply', groupId, userId, text }) },
    async sendGroupMessageWithAt(groupId, userId, text) { sent.push({ kind: 'at', groupId, userId, text }) }
  }
}

function createDeps({ boundInInner = false, previousId = null, displayName = null, bound = [], reviewRow = null } = {}) {
  const calls = { recorded: [], upserted: [], left: [], transfers: 0 }
  return {
    calls,
    deps: {
      async getReviewQQMember() { return reviewRow },
      async isBoundInInnerGroup() { return boundInInner },
      async recordReviewPlayerId(args) { calls.recorded.push(args); return previousId },
      async getMemberDisplayName() { return displayName },
      async transferReviewBindings() { calls.transfers++; return { bound, conflicts: [] } },
      async upsertReviewQQMember(args) { calls.upserted.push(args) },
      async markReviewQQMemberLeft(qqId, leftAt) { calls.left.push({ qqId, leftAt }) }
    }
  }
}

const groupMessage = (role = 'member') => ({
  group_id: 1074579925,
  message_id: 42,
  sender: { user_id: 3650262251, card: '新人', nickname: 'n', role }
})

test('审核群新人报 ID：登记初绑定、立即尝试转入内群并回复', async () => {
  const client = createFakeClient()
  const { deps, calls } = createDeps({ displayName: '星辰大海', bound: [{ qq_id: 3650262251, player_id: 'AA6ADD330EDCE6B7' }] })

  const handled = await handleReviewGroupMessage(groupMessage(), client, '我的ID：aa6add330edce6b7', deps)

  assert.equal(handled, true)
  assert.deepEqual(calls.recorded, [{ qqId: 3650262251, nickname: 'n', card: '新人', playerId: 'AA6ADD330EDCE6B7' }])
  assert.equal(calls.transfers, 1)
  assert.equal(client.sent.length, 1)
  assert.equal(client.sent[0].text, '已登记游戏ID：AA6ADD330EDCE6B7（识别为「星辰大海」）')
})

test('审核群管理员或内群已绑定成员贴 ID 不登记，无 ID 的闲聊不回复', async () => {
  const client = createFakeClient()

  const admin = createDeps()
  assert.equal(await handleReviewGroupMessage(groupMessage('admin'), client, 'C86DA773478609A5', admin.deps), false)
  assert.equal(admin.calls.recorded.length, 0)

  const veteran = createDeps({ boundInInner: true })
  assert.equal(await handleReviewGroupMessage(groupMessage(), client, 'C86DA773478609A5', veteran.deps), false)
  assert.equal(veteran.calls.recorded.length, 0)

  // 无审核群记录的人闲聊（如进群事件漏收且尚未对账）不提示
  const chatter = createDeps()
  assert.equal(await handleReviewGroupMessage(groupMessage(), client, '地平线『No.130』STS1508 你好', chatter.deps), false)
  assert.equal(client.sent.length, 0)
})

test('新人进群 5 小时内未登记 ID：每次发言不带 ID 都提示重发', async () => {
  const joinedAgo = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString()

  const client = createFakeClient()
  const fresh = createDeps({ reviewRow: { join_time: joinedAgo(1), player_id: null } })
  assert.equal(await handleReviewGroupMessage(groupMessage(), client, '你好，我是STS1508', fresh.deps), true)
  assert.equal(await handleReviewGroupMessage(groupMessage(), client, '', fresh.deps), true)  // 纯图片等无文字消息
  // 照抄示例里七宝队长的 ID 不登记，同样提示重发
  assert.equal(await handleReviewGroupMessage(groupMessage(), client, REVIEW_EXAMPLE_PLAYER_ID, fresh.deps), true)
  assert.deepEqual(client.sent.map(s => s.text), [REVIEW_ID_RETRY_TEXT, REVIEW_ID_RETRY_TEXT, REVIEW_ID_RETRY_TEXT])
  assert.match(REVIEW_ID_RETRY_TEXT, /例如七宝队长的ID：4AA67B15FC3585E7$/)
  assert.equal(fresh.calls.recorded.length, 0)

  const quiet = createFakeClient()
  for (const deps of [
    createDeps({ reviewRow: { join_time: joinedAgo(6), player_id: null } }).deps,                    // 超过 5 小时
    createDeps({ reviewRow: { join_time: joinedAgo(1), player_id: 'C86DA773478609A5' } }).deps,       // 已登记
    createDeps({ reviewRow: { join_time: joinedAgo(1), player_id: null }, boundInInner: true }).deps  // 内群已绑定
  ]) {
    assert.equal(await handleReviewGroupMessage(groupMessage(), quiet, '在吗', deps), false)
  }
  assert.equal(quiet.sent.length, 0)

  assert.equal(needsIdReminder(null), false)
  assert.equal(needsIdReminder({ join_time: null, player_id: null }), false)
})

test('审核群进群登记并 @ 欢迎，退群只标记退群时间，机器人自己进出不处理', async () => {
  const client = createFakeClient()
  const { deps, calls } = createDeps()
  const config = { botQQId: 3660672216 }

  await handleReviewGroupNotice({ notice_type: 'group_increase', group_id: 1074579925, user_id: 111222333, time: 1763190000 }, client, config, deps)
  assert.equal(calls.upserted[0].qqId, 111222333)
  assert.deepEqual(client.sent, [{ kind: 'at', groupId: 1074579925, userId: 111222333, text: REVIEW_WELCOME_TEXT }])

  await handleReviewGroupNotice({ notice_type: 'group_decrease', group_id: 1074579925, user_id: 111222333, time: 1763193600 }, client, config, deps)
  assert.deepEqual(calls.left, [{ qqId: 111222333, leftAt: new Date(1763193600 * 1000).toISOString() }])

  await handleReviewGroupNotice({ notice_type: 'group_increase', group_id: 1074579925, user_id: 3660672216 }, client, config, deps)
  assert.equal(calls.upserted.length, 1)
  assert.equal(client.sent.length, 1)
})
