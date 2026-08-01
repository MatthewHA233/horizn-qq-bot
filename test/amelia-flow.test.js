import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyConfirmationReply,
  shouldContinueAfterSearch
} from '../src/amelia.js'
import { executeAmeliaTool } from '../src/ameliaTools.js'

test('复合黑名单请求在搜索后继续，不被完整档案提前截断', () => {
  assert.equal(shouldContinueAfterSearch('877D027F103D9541 黑名单，拿奖励退队'), true)
  assert.equal(shouldContinueAfterSearch('把池鱼思故渊列入黑名单'), true)
  assert.equal(shouldContinueAfterSearch('查一下池鱼思故渊'), false)
})

test('二次确认只接受明确短回复', () => {
  assert.equal(classifyConfirmationReply('确认'), 'confirm')
  assert.equal(classifyConfirmationReply('好的！'), 'confirm')
  assert.equal(classifyConfirmationReply('取消'), 'cancel')
  assert.equal(classifyConfirmationReply('我再想想'), 'unknown')
})

function createBlacklistMock({ existing = true } = {}) {
  let fromCount = 0
  let updatePayload = null

  const supabase = {
    from(table) {
      assert.equal(table, 'horizn_members')
      fromCount++

      if (fromCount === 1) {
        const chain = {
          select() { return chain },
          eq() { return chain },
          async maybeSingle() {
            return {
              data: existing ? { player_id: 'PLAYER123', is_blacklisted: false } : null,
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

  assert.deepEqual(result, { success: true, player_id: 'PLAYER123', blacklisted: true })
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
