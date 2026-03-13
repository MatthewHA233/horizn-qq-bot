/**
 * HORIZN 地平线 QQ 群机器人
 * 成员档案查询 + QQ群成员同步
 */
import 'dotenv/config'
import { NapCatClient } from './napcat.js'
import { initSupabase } from './supabase.js'
import { createMessageHandler } from './handler.js'
import { startSyncLoop } from './sync.js'
import { startDailyReport } from './reporter.js'

// 配置检查
const requiredEnvs = ['NAPCAT_WS_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']
for (const key of requiredEnvs) {
  if (!process.env[key]) {
    console.error(`[错误] 缺少环境变量: ${key}`)
    console.error('请复制 .env.example 为 .env 并填写配置')
    process.exit(1)
  }
}

// 解析配置
function parseNumberList(envValue) {
  if (!envValue) return new Set()
  const numbers = envValue.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n))
  return new Set(numbers)
}

const listenGroups = parseNumberList(process.env.LISTEN_GROUPS)
const allowPrivateUsers = parseNumberList(process.env.ALLOW_PRIVATE_USERS)
const syncGroupId = process.env.QQ_GROUP_ID ? parseInt(process.env.QQ_GROUP_ID) : null

console.log('========================================')
console.log('  HORIZN 地平线 QQ 群机器人')
console.log('  踢出审核回归查询')
console.log('========================================')
console.log()

async function main() {
  // 1. 初始化 Supabase
  console.log('[启动] 初始化数据库连接...')
  initSupabase(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

  // 2. 创建 NapCat 客户端
  console.log('[启动] 连接 NapCat WebSocket...')
  const client = new NapCatClient({
    wsUrl: process.env.NAPCAT_WS_URL,
    token: process.env.NAPCAT_TOKEN || ''
  })

  // 3. 注册消息处理器
  const config = { listenGroups, allowPrivateUsers }
  const handler = createMessageHandler(client, config)
  client.onMessage(handler)

  // 4. 连接 NapCat
  try {
    await client.connect()

    // 获取登录信息
    const loginInfo = await client.getLoginInfo()
    console.log(`[启动] 登录账号: ${loginInfo.nickname} (${loginInfo.user_id})`)

    // 显示监听配置
    if (listenGroups.size > 0) {
      console.log(`[启动] 监听群号: ${[...listenGroups].join(', ')}`)
    } else {
      console.log('[启动] 未配置监听群号，不监听群消息')
    }

    if (allowPrivateUsers.size > 0) {
      console.log(`[启动] 允许私聊: ${[...allowPrivateUsers].join(', ')}`)
    } else {
      console.log('[启动] 未配置私聊白名单，不处理私聊消息')
    }

    // 启动 QQ 群成员同步 + 每日播报
    if (syncGroupId) {
      startSyncLoop(client, syncGroupId)
      startDailyReport(client, syncGroupId)
    } else {
      console.log('[启动] 未配置 QQ_GROUP_ID，跳过群成员同步和每日播报')
    }

    console.log()
    console.log('[运行中] 等待消息...')
    console.log('[提示] 发送包含 player_id 的消息即可触发查询')
    console.log('[提示] player_id 规则: 大写字母+数字混合，6-16位')
    console.log()

  } catch (err) {
    console.error('[启动失败] 无法连接 NapCat:', err.message)
    console.error('[提示] 请检查:')
    console.error('  1. NapCat 是否已启动')
    console.error('  2. WebSocket 端口是否正确')
    console.error('  3. Token 是否匹配')
    process.exit(1)
  }

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n[退出] 正在关闭连接...')
    client.close()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    console.log('\n[退出] 正在关闭连接...')
    client.close()
    process.exit(0)
  })
}

main().catch(err => {
  console.error('[致命错误]:', err)
  process.exit(1)
})
