# HORIZN 地平线 QQ 群机器人

踢出审核回归查询机器人，自动识别群消息/私聊中的 player_id 并回复查询结果。

## 功能

- 监听 QQ 群消息（支持多个群）
- 支持私聊查询（白名单 QQ 号）
- 自动识别 player_id（大写字母+数字混合，6-16位）
- 查询 Supabase 数据库中的踢出记录
- 自动回复查询结果：
  - `通过` - 无踢出记录或冷却期已结束
  - `属于被踢冷却期，距离xx.xx结束还有xx天` - 踢出后30天内
  - `属于黑名单` - 黑名单成员（待实现）

## 安装

```bash
cd D:\my_pro\bot\horizn-qq-bot
npm install
```

## 配置

1. 复制环境变量模板：
```bash
cp .env.example .env
```

2. 编辑 `.env` 文件：
```env
# NapCat WebSocket 配置
NAPCAT_WS_URL=ws://47.120.77.124:3001
NAPCAT_TOKEN=napcat1234567

# 监听的 QQ 群号（多个用逗号分隔，留空则不监听群消息）
LISTEN_GROUPS=123456789,987654321

# 允许私聊查询的 QQ 号（多个用逗号分隔，留空则不允许私聊）
ALLOW_PRIVATE_USERS=123456789,111222333

# Supabase 配置
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJxxx...
```

## NapCat WebSocket 配置

你的 NapCat 已部署在阿里云服务器，需要开启 WebSocket 服务。

### 方式一：正向 WebSocket（推荐）

编辑 NapCat 配置文件（通常在 `config/onebot11.json`）：

```json
{
  "http": {
    "enable": true,
    "host": "0.0.0.0",
    "port": 4238,
    "secret": "",
    "enableHeart": false,
    "enablePost": false
  },
  "ws": {
    "enable": true,
    "host": "0.0.0.0",
    "port": 3001
  },
  "reverseWs": {
    "enable": false,
    "urls": []
  },
  "token": "napcat1234567",
  "debug": false,
  "heartInterval": 30000,
  "messagePostFormat": "array"
}
```

关键配置：
- `ws.enable`: 设为 `true`
- `ws.host`: `0.0.0.0` 允许外部连接
- `ws.port`: WebSocket 端口，如 `3001`
- `token`: 访问令牌

### 方式二：反向 WebSocket

如果机器人运行在有公网 IP 的服务器上，可以让 NapCat 主动连接：

```json
{
  "reverseWs": {
    "enable": true,
    "urls": ["ws://你的机器人IP:端口/onebot"]
  }
}
```

## 运行

```bash
# 开发模式（文件变化自动重启）
npm run dev

# 生产模式
npm start
```

## 示例

### 群消息查询
群消息：
```
请帮我审核一下这个ID: ABC123DEF
```

机器人回复（引用原消息）：
```
ABC123DEF: 通过
```

### 私聊查询
私聊消息：
```
ABC123DEF
PLAYER001
XYZ789ABC
```

机器人回复：
```
ABC123DEF: 通过
PLAYER001: 属于被踢冷却期，距离1.15结束还有12天
XYZ789ABC: 通过
```

## 注意事项

1. **服务器防火墙**：确保 WebSocket 端口（如 3001）已开放
2. **Supabase Service Key**：使用 Service Role Key（非 anon key），有完整数据库访问权限
3. **player_id 规则**：必须同时包含大写字母和数字，长度 6-16 位

## 项目结构

```
horizn-qq-bot/
├── src/
│   ├── index.js      # 入口文件
│   ├── napcat.js     # NapCat WebSocket 客户端
│   ├── supabase.js   # Supabase 查询服务
│   └── handler.js    # 消息处理逻辑
├── .env              # 环境变量配置
├── .env.example      # 环境变量模板
├── package.json
└── README.md
```

## 后续扩展

- [ ] 黑名单功能
- [ ] 管理员命令（添加/移除黑名单）
- [ ] 查询统计
- [ ] 多群配置（不同群不同回复策略）
