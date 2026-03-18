/**
 * 艾米莉亚 AI 会话管理器
 * - 管理群 @艾米莉亚 触发，单用户持久会话，最多 30 轮
 * - 使用阿里云百炼 DashScope OpenAI 兼容接口
 * - 支持 function calling 工具（查询/黑名单/舷号管理）
 * - 需要确认的操作在执行前发气泡等用户回复
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
  buildConfirmMessage
} from './ameliaTools.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const MAX_USER_TURNS = 30       // 最多 30 轮用户消息
const SESSION_TIMEOUT_MS = 30 * 60 * 1000  // 30 分钟无活动自动结束

const SYSTEM_PROMPT = `你是艾米莉亚，HORIZN 地平线联队的AI管理助手，性格温和专业。
职责：帮管理员查询成员档案、管理黑名单和舷号。
风格：简洁，使用中文，回答不超过200字。
注意：涉及黑名单或删除操作，必须通过工具调用，系统会自动向管理员请求确认，你不用手动询问。`

// ============================================================
// Session 数据结构
// ============================================================

class Session {
  constructor(userId, userName) {
    this.userId = userId
    this.userName = userName
    this.messages = []       // OpenAI message format，不含 system
    this.userTurnCount = 0   // 用户发言轮次
    this.lastActivity = Date.now()
    this.pendingConfirm = null  // { toolCallId, toolName, args }
    this.id = `${Date.now()}_${userId}`
  }

  push(msg) {
    this.messages.push(msg)
    this.lastActivity = Date.now()
  }

  isExpired() {
    return Date.now() - this.lastActivity > SESSION_TIMEOUT_MS
  }
}

// userId → Session
const sessions = new Map()

function getSession(userId) {
  const s = sessions.get(userId)
  if (!s) return null
  if (s.isExpired()) {
    _endSession(userId, 'timeout')
    return null
  }
  return s
}

function _endSession(userId, reason) {
  const s = sessions.get(userId)
  if (s) {
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
      if (m.role === 'user') lines.push(`[用户] ${m.content}`)
      else if (m.role === 'assistant' && m.content) lines.push(`[艾米莉亚] ${m.content}`)
      else if (m.role === 'assistant' && m.tool_calls) {
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
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
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
  const s = sessions.get(userId)
  return !!s && !s.isExpired()
}

/**
 * 处理一条艾米莉亚消息
 * 所有发送通过 sendReply / sendBubble 完成，无返回值
 *
 * @param {object} opts
 * @param {number} opts.userId       - 发送者 QQ
 * @param {string} opts.userName     - 发送者昵称
 * @param {string} opts.text         - 消息文本（已去除 @艾米莉亚 前缀）
 * @param {Array}  opts.contextMsgs  - 前 5 条群聊消息 [{name, text}]（仅首次会话用）
 * @param {boolean} opts.isNewMention - 本条消息是否含 @bot
 * @param {number} opts.groupId
 * @param {object} opts.client       - NapCatClient
 */
export async function processAmeliaMessage({
  userId, userName, text, contextMsgs, isNewMention, groupId, client
}) {
  // 发送 @用户 的气泡
  const sendReply = async (content) => {
    try {
      await client.sendGroupMessage(groupId, [
        { type: 'at', data: { qq: String(userId) } },
        { type: 'text', data: { text: '\n' + content } }
      ])
    } catch (e) {
      console.error('[Amelia] 发送失败:', e.message)
    }
  }

  let session = getSession(userId)

  // ── 处理待确认操作 ──────────────────────────────────────────
  if (session?.pendingConfirm) {
    const { toolCallId, toolName, args } = session.pendingConfirm
    session.pendingConfirm = null

    if (_isConfirmation(text)) {
      await sendReply('正在执行...')
      try {
        const result = await executeAmeliaTool(toolName, args)
        const resultText = formatToolResult(toolName, result)
        session.push({ role: 'tool', tool_call_id: toolCallId, name: toolName, content: resultText })

        const followUp = await callAI(session.messages)
        const finalText = followUp.choices[0].message.content || '操作已完成。'
        session.push({ role: 'assistant', content: finalText })
        await sendReply(finalText)
      } catch (err) {
        console.error('[Amelia] 工具执行失败:', err.message)
        session.push({ role: 'tool', tool_call_id: toolCallId, name: toolName, content: `失败: ${err.message}` })
        await sendReply(`执行失败：${err.message}`)
      }
    } else {
      session.push({ role: 'tool', tool_call_id: toolCallId, name: toolName, content: '用户取消了操作' })
      await sendReply('操作已取消。')
    }
    return
  }

  // ── 创建或继续会话 ─────────────────────────────────────────
  if (!session) {
    if (!isNewMention) return  // 只有 @提及 才能开启新会话
    session = new Session(userId, userName)
    sessions.set(userId, session)

    // 首次消息带群聊背景
    const ctxPart = contextMsgs?.length
      ? `[本次对话前的群聊背景：\n${contextMsgs.map(m => `${m.name}: ${m.text}`).join('\n')}\n]\n\n`
      : ''
    session.push({ role: 'user', content: ctxPart + text })
    console.log(`[Amelia] 新会话: ${userName}(${userId})`)
  } else {
    session.push({ role: 'user', content: text })
  }

  session.userTurnCount++

  // 达到上限
  if (session.userTurnCount > MAX_USER_TURNS) {
    await sendReply('会话已达30次上限，本次对话结束。如需继续请重新@我。')
    _endSession(userId, 'limit')
    return
  }

  // ── 主 AI 循环（工具调用可能多轮）───────────────────────────
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
    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name
      let args
      try { args = JSON.parse(toolCall.function.arguments) } catch { args = {} }

      if (CONFIRM_REQUIRED_TOOLS.has(toolName)) {
        // 需要确认：发气泡后暂停
        session.pendingConfirm = { toolCallId: toolCall.id, toolName, args }
        await sendReply(buildConfirmMessage(toolName, args))
        waitForConfirm = true
        break
      } else {
        // 立即执行：先发"正在..."气泡
        await sendReply(`🔧 正在${getToolLabel(toolName)}...`)
        try {
          const result = await executeAmeliaTool(toolName, args)
          const resultText = formatToolResult(toolName, result)
          session.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: resultText })
        } catch (err) {
          session.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: `失败: ${err.message}` })
        }
      }
    }

    if (waitForConfirm) return
    // 有工具结果 → 继续循环让 AI 生成最终回复
  }
}
