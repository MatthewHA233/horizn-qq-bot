/**
 * 艾米莉亚 AI 会话管理器
 * - 管理群 @艾米莉亚 触发，单用户持久会话，最多 30 轮
 * - 使用阿里云百炼 DashScope OpenAI 兼容接口
 * - 支持 function calling 工具（查询/黑名单/舷号管理）
 * - 需要确认的操作：AI 调用工具 → 向用户发确认气泡 → 用户自然语言回复
 *   → AI 重新判断是否继续执行（无硬编码关键词）
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
const MAX_USER_TURNS = 30
const SESSION_IDLE_MS = 60 * 1000   // 1分钟无消息自动结束

const SYSTEM_PROMPT = `你是艾米莉亚，HORIZN 地平线联队的AI管理助手，性格温和专业。
职责：帮管理员查询成员档案、管理黑名单和舷号。
风格：简洁，使用中文，回答不超过200字。
关于确认操作：当你调用需要确认的工具时，系统会自动暂停并询问用户。
用户回复后你会重新收到对话，请根据用户的回复判断是否继续执行该工具。
用户明确同意则再次调用工具；用户拒绝或犹豫则取消并说明。`

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
    this.awaitingExecution = false
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
      await client.sendGroupMessage(groupId, [
        { type: 'at', data: { qq: String(userId) } },
        { type: 'text', data: { text: '\n' + content } }
      ])
    } catch (e) {
      console.error('[Amelia] 发送失败:', e.message)
    }
  }

  let session = getSession(userId)

  // ── pendingConfirm：用户回复了确认/拒绝，设标记后继续走 AI loop ──
  // 不做关键词判断，把用户的自然语言回复交给 AI 去理解
  if (session?.pendingConfirm) {
    session.pendingConfirm = null
    session.awaitingExecution = true
    // 继续向下，把用户消息加入历史，进入 AI loop
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
      session.awaitingExecution = false
      await sendReply(assistantMsg.content || '（无回复）')
      return
    }

    // 处理工具调用
    let waitForConfirm = false
    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name
      let args
      try { args = JSON.parse(toolCall.function.arguments) } catch { args = {} }

      if (CONFIRM_REQUIRED_TOOLS.has(toolName) && !session.awaitingExecution) {
        // 需要确认：先插一条占位 tool result（保持消息格式合法），再发确认气泡
        const confirmMsg = buildConfirmMessage(toolName, args)
        session.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: `[等待管理员确认] 已发送确认请求：「${confirmMsg}」`
        })
        session.pendingConfirm = { toolCallId: toolCall.id, toolName, args }
        await sendReply(confirmMsg)
        waitForConfirm = true
        break
      } else {
        // 直接执行（普通工具 或 awaitingExecution=true 已确认）
        session.awaitingExecution = false
        await sendReply(`🔧 正在${getToolLabel(toolName)}...`)
        try {
          const result = await executeAmeliaTool(toolName, args)
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
          const resultText = formatToolResult(toolName, result)
          session.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: resultText })
        } catch (err) {
          console.error(`[Amelia] 工具 ${toolName} 失败:`, err.message)
          session.push({ role: 'tool', tool_call_id: toolCall.id, name: toolName, content: `失败: ${err.message}` })
        }
      }
    }

    if (waitForConfirm) return
    // 有工具结果 → 继续循环让 AI 生成最终文字回复
  }
}
