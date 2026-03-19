/**
 * NapCat WebSocket 客户端
 * 基于 OneBot v11 协议
 */
import WebSocket from 'ws'

export class NapCatClient {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || 'ws://localhost:3001'
    this.token = options.token || ''
    this.reconnectInterval = options.reconnectInterval || 5000
    this.ws = null
    this.isConnected = false
    this.messageHandlers = []
    this.echoCallbacks = new Map()
    this.echoCounter = 0
  }

  /**
   * 连接到 NapCat WebSocket 服务
   */
  connect() {
    return new Promise((resolve, reject) => {
      const url = this.token ? `${this.wsUrl}?access_token=${this.token}` : this.wsUrl

      console.log(`[NapCat] 正在连接: ${this.wsUrl}`)

      this.ws = new WebSocket(url)

      this.ws.on('open', () => {
        console.log('[NapCat] WebSocket 连接成功')
        this.isConnected = true
        resolve()
      })

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString())
          this._handleMessage(message)
        } catch (err) {
          console.error('[NapCat] 解析消息失败:', err)
        }
      })

      this.ws.on('close', () => {
        console.log('[NapCat] WebSocket 连接关闭')
        this.isConnected = false
        this._scheduleReconnect()
      })

      this.ws.on('error', (err) => {
        console.error('[NapCat] WebSocket 错误:', err.message)
        if (!this.isConnected) {
          reject(err)
        }
      })
    })
  }

  /**
   * 处理收到的消息
   */
  _handleMessage(message) {
    // 处理 API 调用响应
    if (message.echo) {
      const callback = this.echoCallbacks.get(message.echo)
      if (callback) {
        callback(message)
        this.echoCallbacks.delete(message.echo)
      }
      return
    }

    // 处理事件上报
    if (message.post_type) {
      for (const handler of this.messageHandlers) {
        try {
          handler(message)
        } catch (err) {
          console.error('[NapCat] 消息处理器错误:', err)
        }
      }
    }
  }

  /**
   * 自动重连
   */
  _scheduleReconnect() {
    console.log(`[NapCat] ${this.reconnectInterval / 1000}秒后尝试重连...`)
    setTimeout(() => {
      this.connect().catch(() => {})
    }, this.reconnectInterval)
  }

  /**
   * 注册消息处理器
   */
  onMessage(handler) {
    this.messageHandlers.push(handler)
  }

  /**
   * 调用 OneBot API
   */
  callApi(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject(new Error('WebSocket 未连接'))
        return
      }

      const echo = `${Date.now()}_${++this.echoCounter}`

      const request = {
        action,
        params,
        echo
      }

      this.echoCallbacks.set(echo, (response) => {
        if (response.status === 'ok') {
          resolve(response.data)
        } else {
          reject(new Error(response.message || 'API 调用失败'))
        }
      })

      // 10秒超时
      setTimeout(() => {
        if (this.echoCallbacks.has(echo)) {
          this.echoCallbacks.delete(echo)
          reject(new Error('API 调用超时'))
        }
      }, 10000)

      this.ws.send(JSON.stringify(request))
    })
  }

  /**
   * 发送群消息
   */
  async sendGroupMessage(groupId, message) {
    return this.callApi('send_group_msg', {
      group_id: groupId,
      message
    })
  }

  /**
   * 发送群消息（回复格式）
   */
  async replyGroupMessage(groupId, messageId, text) {
    // 使用 CQ 码格式回复
    const message = [
      { type: 'reply', data: { id: messageId } },
      { type: 'text', data: { text } }
    ]
    return this.sendGroupMessage(groupId, message)
  }

  /**
   * 发送群消息（引用 + @发送者 + 内容）
   */
  async replyGroupMessageWithAt(groupId, messageId, userId, text) {
    const message = [
      { type: 'reply', data: { id: messageId } },
      { type: 'at', data: { qq: String(userId) } },
      { type: 'text', data: { text: ' ' + text } }
    ]
    return this.sendGroupMessage(groupId, message)
  }

  /**
   * 发送私聊消息
   */
  async sendPrivateMessage(userId, message) {
    return this.callApi('send_private_msg', {
      user_id: userId,
      message: typeof message === 'string' ? message : message
    })
  }

  /**
   * 发送私聊消息（引用格式）
   */
  async replyPrivateMessage(userId, messageId, text) {
    const message = [
      { type: 'reply', data: { id: messageId } },
      { type: 'text', data: { text } }
    ]
    return this.sendPrivateMessage(userId, message)
  }

  /**
   * 撤回消息
   */
  async deleteMessage(messageId) {
    return this.callApi('delete_msg', { message_id: messageId })
  }

  /**
   * 获取 QQ 群成员列表
   */
  async getGroupMemberList(groupId) {
    const data = await this.callApi('get_group_member_list', { group_id: groupId })
    return data.map(m => ({
      qq_id: m.user_id,
      nickname: m.nickname || '',
      card: m.card || '',
      role: m.role || 'member',
      join_time: m.join_time || 0,
      last_sent_time: m.last_sent_time || 0,
      level: m.level || ''
    }))
  }

  /**
   * 获取登录信息
   */
  async getLoginInfo() {
    return this.callApi('get_login_info')
  }

  /**
   * 关闭连接
   */
  close() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}
