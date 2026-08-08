/**
 * 艾米莉亚 AI 会话管理器
 * - 管理群 @艾米莉亚 触发，单用户持久会话，最多 30 轮
 * - 使用阿里云百炼 DashScope OpenAI 兼容接口
 * - 支持 function calling 工具（查询/黑名单/舷号/担保进队管理）
 * - 需要确认的操作：AI 调用工具 → 向用户发确认气泡 → 用户明确回复“确认”
 *   → 系统执行原始待确认工具及参数，避免 AI 二次生成时丢失或篡改操作
 * - 会话结束后将对话记录保存到本地 logs/amelia/
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  executeAmeliaTool,
  formatToolResult,
  TOOL_DEFINITIONS,
  CONFIRM_REQUIRED_TOOLS,
  getToolLabel,
  buildConfirmMessage,
  resolveMemberOperationTarget
} from './ameliaTools.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const MAX_USER_TURNS = 30
const SESSION_IDLE_MS = 60 * 1000   // 1分钟无消息自动结束

const CONFIRM_WORDS = new Set(['确认', '确定', '同意', '执行', '可以', '好', '好的', '是', '是的'])
const CANCEL_WORDS = new Set(['取消', '不要', '不用', '不同意', '不执行', '否', '不是', '算了', '停止'])

function normalizeShortReply(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/[\s，,。.!！?？、]+$/g, '')
}

/**
 * 二次确认只接受明确的短回复；其余内容按取消处理，避免误执行写操作。
 */
export function classifyConfirmationReply(text) {
  const normalized = normalizeShortReply(text)
  if (CONFIRM_WORDS.has(normalized)) return 'confirm'
  if (CANCEL_WORDS.has(normalized)) return 'cancel'
  return 'unknown'
}

/**
 * 查询只是复合写操作的第一步时，不能把完整档案发完就提前结束 AI loop。
 */
export function shouldContinueAfterSearch(text) {
  const normalized = String(text ?? '').normalize('NFKC')
  return /(黑名单|拉黑|解黑|移出黑名单|解除黑名单|取消黑名单|设置舷号|分配舷号|授予舷号|修改舷号|更改舷号|担保进队|担保入队|担保人|取消担保|解除担保)/.test(normalized)
}

function buildSystemPrompt() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} CST`
  return `你是艾米莉亚，HORIZN 地平线联队的AI管理助手，性格温和专业。
当前时间：${timestamp}
  职责：帮管理员查询成员档案、管理黑名单、舷号和担保进队标注。
  风格：简洁，使用中文；普通回答不超过200字，成员完整档案不受此限制。
  查询规则：用户提供玩家ID、QQ号、QQ群名片/昵称、当前或历史游戏名时，必须调用 search_member。不要自行声称“没有权限”；只有工具明确返回权限错误时才能这样说明。
  复合操作规则：用户要求按名字、QQ号或群名片执行加入/解除黑名单、设置舷号、标记/取消担保进队等操作时，必须先调用 search_member。唯一命中后使用工具返回的真实 player_id 继续完成原请求，不要停在查询结果，也绝不能把名字或QQ号伪装成 player_id。若有多个候选则请用户明确选择；没有成员记录时，加入黑名单应改用 add_external_blacklist。担保标注的 guarantor_name 是管理员口中的担保人称呼，可留空；不要把担保人误当成被标注成员。担保日期由系统在管理员确认执行时自动记录为北京时间当天，不得自行指定或倒填。用户询问所有被担保人时调用 query_guaranteed_members，并完整呈现名单。
  管理操作回复规则：拉黑、赐予舷号和担保标记的确认与完成回复只需在玩家ID旁多显示一个当前游戏名，格式为“游戏名（玩家ID）”；不要重复成员档案或附加无关字段。
重要：成员的游戏名（player_id / name）必须原样引用，不得删改任何部分。例如「地平线『No.188』孤独与风」应完整输出，禁止缩写为「孤独与风」。
概念区分：「佩戴舷号」指成员的游戏名中包含舷号字段（如名字里含有 No.XXX 字样），与数据库 hull_number 列无关。查询谁佩戴/未佩戴舷号时，应检查成员游戏名是否含有 No.\d+ 模式。
关于确认操作：当你调用需要确认的工具时，系统会自动暂停并询问用户；用户明确确认后，系统会执行原始工具和参数，无需你再次调用。`
}

// ============================================================
// Session 数据结构
// ============================================================

class Session {
  constructor(userId, userName, groupId, client) {
    this.userId = userId
    this.userName = userName
    this.groupId = groupId
    this.client = client
    this.messages = []
    this.userTurnCount = 0
    this.lastActivity = Date.now()
    this.pendingConfirm = null
    this.id = `${Date.now()}_${userId}`
    this.timer = null
  }

  push(msg) {
    this.messages.push(msg)
    this.lastActivity = Date.now()
  }
}

const sessions = new Map()

function _resetIdleTimer(session) {
  if (session.timer) clearTimeout(session.timer)
  session.timer = setTimeout(async () => {
    if (!sessions.has(session.userId)) return
    try {
      await session.client.sendGroupMessage(session.groupId, [
        { type: 'at', data: { qq: String(session.userId) } },
        { type: 'text', data: { text: '\n超过1分钟没有消息，本次对话已结束。如需继续请重新@我。' } }
      ])
    } catch {}
    _endSession(session.userId, 'idle')
  }, SESSION_IDLE_MS)
}

function getSession(userId) {
  return sessions.get(userId) || null
}

function _endSession(userId, reason) {
  const s = sessions.get(userId)
  if (s) {
    if (s.timer) clearTimeout(s.timer)
    _saveLog(s, reason)
    sessions.delete(userId)
  }
}

function _saveLog(session, reason) {
  try {
    const logDir = path.join(__dirname, '..', 'logs', 'amelia')
    fs.mkdirSync(logDir, { recursive: true })
    const date = new Date().toISOString().slice(0, 10)
    const logPath = path.join(logDir, `${date}_${session.userId}_${session.id}.log`)
    const lines = [
      `Session: ${session.id}`,
      `User: ${session.userName} (${session.userId})`,
      `Turns: ${session.userTurnCount}`,
      `Ended: ${reason}  Time: ${new Date().toISOString()}`,
      '─'.repeat(40)
    ]
    for (const m of session.messages) {
      if (m.role === 'user') {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
        lines.push(`[用户] ${content}`)
      } else if (m.role === 'assistant' && m.content) {
        lines.push(`[艾米莉亚] ${m.content}`)
      } else if (m.role === 'assistant' && m.tool_calls) {
        lines.push(`[工具调用] ${m.tool_calls.map(tc => tc.function.name).join(', ')}`)
      } else if (m.role === 'tool') {
        lines.push(`[工具结果(${m.name})] ${m.content}`)
      }
    }
    fs.writeFileSync(logPath, lines.join('\n'), 'utf-8')
    console.log(`[Amelia] 会话已存档: ${logPath}`)
  } catch (err) {
    console.error('[Amelia] 存档失败:', err.message)
  }
}

// ============================================================
// AI 调用
// ============================================================

async function callAI(messages) {
  const apiKey = process.env.DASHSCOPE_API_KEY
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY 未配置')
  const model = process.env.AMELIA_MODEL || 'qwen-plus'

  const resp = await fetch(DASHSCOPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      max_tokens: 800
    }),
    signal: AbortSignal.timeout(30000)
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`DashScope ${resp.status}: ${body.slice(0, 200)}`)
  }
  return resp.json()
}

// ============================================================
// 公共接口
// ============================================================

export function hasActiveSession(userId) {
  return sessions.has(userId)
}

/**
 * 处理一条艾米莉亚消息
 *
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} opts.userName
 * @param {string} opts.text
 * @param {string[]} opts.images      - 图片 URL 列表
 * @param {Array}  opts.contextMsgs   - 前 5 条群聊消息（仅首次会话）
 * @param {boolean} opts.isNewMention
 * @param {number} opts.groupId
 * @param {object} opts.client
 */
export async function processAmeliaMessage({
  userId, userName, text, images = [], contextMsgs, isNewMention, groupId, client
}) {
  const sendReply = async (content) => {
    try {
      const res = await client.sendGroupMessage(groupId, [
        { type: 'at', data: { qq: String(userId) } },
        { type: 'text', data: { text: '\n' + content } }
      ])
      return res?.message_id || null
    } catch (e) {
      console.error('[Amelia] 发送失败:', e.message)
      return null
    }
  }

  const recallMessage = async (msgId) => {
    if (!msgId) return
    try { await client.deleteMessage(msgId) } catch {}
  }

  let session = getSession(userId)

  // ── pendingConfirm：确定性执行原始待确认动作 ─────────────────
  if (session?.pendingConfirm) {
    const pending = session.pendingConfirm
    session.pendingConfirm = null
    session.push({ role: 'user', content: text })
    session.userTurnCount++
    _resetIdleTimer(session)

    const decision = classifyConfirmationReply(text)
    if (decision !== 'confirm') {
      const cancelled = decision === 'cancel'
        ? `已取消${getToolLabel(pending.toolName)}。`
        : `未收到明确的“确认”，已取消${getToolLabel(pending.toolName)}。`
      session.push({ role: 'assistant', content: cancelled })
      await sendReply(cancelled)
      return
    }

    const statusMsgId = await sendReply(`🔧 正在${getToolLabel(pending.toolName)}...`)
    try {
      const result = await executeAmeliaTool(pending.toolName, pending.args)
      const resultText = formatToolResult(pending.toolName, result)
      session.push({ role: 'assistant', content: resultText })
      await recallMessage(statusMsgId)
      await sendReply(resultText)
    } catch (err) {
      console.error(`[Amelia] 已确认工具 ${pending.toolName} 失败:`, err.message)
      const failed = `${getToolLabel(pending.toolName)}失败：${err.message}`
      session.push({ role: 'assistant', content: failed })
      await recallMessage(statusMsgId)
      await sendReply(failed)
    }
    return
  }

  // ── 构建用户消息（支持多模态）─────────────────────────────────
  async function fetchImageAsBase64(url) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const contentType = resp.headers.get('content-type') || 'image/jpeg'
      const mimeType = contentType.split(';')[0].trim()
      const buffer = await resp.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')
      console.log(`[Amelia] 图片转base64成功: ${url.slice(0, 60)}... mime=${mimeType} size=${buffer.byteLength}`)
      return `data:${mimeType};base64,${base64}`
    } catch (err) {
      console.error(`[Amelia] 图片下载失败: ${url.slice(0, 60)}... ${err.message}`)
      return null
    }
  }

  async function buildUserContent(msgText, msgImages = []) {
    if (!msgImages.length) return msgText
    console.log('[Amelia] 原始图片URLs:', msgImages)
    const parts = []
    if (msgText) parts.push({ type: 'text', text: msgText })
    for (const url of msgImages) {
      const dataUrl = await fetchImageAsBase64(url)
      if (dataUrl) {
        parts.push({ type: 'image_url', image_url: { url: dataUrl } })
      }
    }
    return parts.length > (msgText ? 1 : 0) ? parts : msgText
  }

  // ── 创建或继续会话 ─────────────────────────────────────────────
  if (!session) {
    if (!isNewMention) return
    session = new Session(userId, userName, groupId, client)
    sessions.set(userId, session)

    const ctxPart = contextMsgs?.length
      ? `[本次对话前的群聊背景：\n${contextMsgs.map(m => `${m.name}: ${m.text}`).join('\n')}\n]\n\n`
      : ''
    session.push({ role: 'user', content: await buildUserContent(ctxPart + text, images) })
    console.log(`[Amelia] 新会话: ${userName}(${userId})`)
  } else {
    session.push({ role: 'user', content: await buildUserContent(text, images) })
  }

  _resetIdleTimer(session)
  session.userTurnCount++

  if (session.userTurnCount > MAX_USER_TURNS) {
    await sendReply('会话已达30次上限，本次对话结束。如需继续请重新@我。')
    _endSession(userId, 'limit')
    return
  }

  // ── 主 AI 循环 ──────────────────────────────────────────────────
  for (let round = 0; round < 5; round++) {
    let aiResp
    try {
      aiResp = await callAI(session.messages)
    } catch (err) {
      console.error('[Amelia] AI 调用失败:', err.message)
      await sendReply(`AI 服务暂时不可用：${err.message}`)
      return
    }

    const assistantMsg = aiResp.choices[0].message
    session.push(assistantMsg)

    // 纯文本回复
    if (!assistantMsg.tool_calls?.length) {
      await sendReply(assistantMsg.content || '（无回复）')
      return
    }

    // 处理工具调用
    let waitForConfirm = false
    const directSearchReplies = []
    const directGuaranteeListReplies = []
    const directHullReplies = []
    const directTexts = []  // _directText 逐字直发（舷号成员名单 / 舷号列表文本回退），不过 LLM 转述
    const onlySearchTools = assistantMsg.tool_calls.every(call => call.function.name === 'search_member')
    const onlyGuaranteeListTools = assistantMsg.tool_calls.every(call => call.function.name === 'query_guaranteed_members')
    const onlyHullTools = assistantMsg.tool_calls.every(call => call.function.name === 'set_hull_number')
    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name
      let args
      try { args = JSON.parse(toolCall.function.arguments) } catch { args = {} }

      if (CONFIRM_REQUIRED_TOOLS.has(toolName)) {
        if (args.player_id && ['set_member_blacklist', 'set_member_guarantee'].includes(toolName)) {
          try {
            const target = await resolveMemberOperationTarget(args.player_id)
            args.current_name = target.current_name
          } catch (err) {
            const failed = `${getToolLabel(toolName)}失败：${err.message}`
            session.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: failed })
            await sendReply(failed)
            return
          }
        }
        // 需要确认：先插一条占位 tool result（保持消息格式合法），再发确认气泡
        const confirmMsg = buildConfirmMessage(toolName, args)
        session.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: `[等待管理员确认] 已发送确认请求：「${confirmMsg}」`
        })
        session.pendingConfirm = { toolName, args }
        await sendReply(confirmMsg)
        waitForConfirm = true
        break
      } else {
        // 普通工具直接执行；需要确认的工具只会在上方挂起
        const statusMsgId = await sendReply(`🔧 正在${getToolLabel(toolName)}...`)
        try {
          const result = await executeAmeliaTool(toolName, args)
          // end_session：发告别语后关闭会话
          if (result._endSession) {
            await recallMessage(statusMsgId)
            await sendReply(result.farewell)
            _endSession(userId, 'dismissed')
            return
          }
          // 若工具返回图片文件，直接发图到群
          if (result._imageFile) {
            try {
              await client.sendGroupMessage(groupId, [
                { type: 'image', data: { file: `file://${result._imageFile}` } }
              ])
              console.log(`[Amelia] 座位图已发送: ${result._imageFile}`)
            } catch (imgErr) {
              console.error('[Amelia] 发送图片失败:', imgErr.message)
            }
          }
          // 逐字直发文本（名单 / 舷号列表文本回退）
          if (result._directText) directTexts.push(result._directText)
          const resultText = formatToolResult(toolName, result)
          session.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: resultText })
          if (toolName === 'search_member') directSearchReplies.push(resultText)
          if (toolName === 'query_guaranteed_members') directGuaranteeListReplies.push(resultText)
          if (toolName === 'set_hull_number') directHullReplies.push(resultText)
        } catch (err) {
          console.error(`[Amelia] 工具 ${toolName} 失败:`, err.message)
          session.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: `失败: ${err.message}` })
        }
        await recallMessage(statusMsgId)
      }
    }

    if (waitForConfirm) return
    if (onlySearchTools && directSearchReplies.length && !shouldContinueAfterSearch(text)) {
      await sendReply(directSearchReplies.join('\n\n'))
      return
    }
    if (onlyGuaranteeListTools && directGuaranteeListReplies.length) {
      await sendReply(directGuaranteeListReplies.join('\n\n'))
      return
    }
    if (onlyHullTools && directHullReplies.length) {
      await sendReply(directHullReplies.join('\n\n'))
      return
    }
    // 有工具结果 → 继续循环让 AI 生成最终文字回复
  }
}
