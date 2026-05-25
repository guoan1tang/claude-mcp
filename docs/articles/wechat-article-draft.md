# 利用 Claude Code 的 Channels 扩展实现手机远程控制

> 草稿 · 微信公众号

---

## Claude Code 藏着一个不太为人知的扩展能力

大多数人用 Claude Code，都是通过终端交互：输入指令，看输出，批准工具调用。这是默认模式，也是唯一被广泛使用的模式。

但 Claude Code 还有另一层扩展机制，目前处于 Research Preview 阶段，文档也比较低调——**Channels API**。

它允许你通过 MCP Server 向 Claude Code 注入消息、接收工具审批请求、发回审批结果。换句话说：你可以让 Claude Code 的"输入来源"不再局限于终端，任何能跑代码的地方都可以成为它的控制端。

我用这个能力做了一件事：**让手机变成 Claude Code 的远程控制台**，包括发消息、看回复、审批危险操作。

---

## Channels API 是什么

MCP（Model Context Protocol）是 Claude Code 的插件协议，通常用来给 Claude 注册工具。Channels API 在此基础上加了一层——让 MCP Server 成为一个**消息频道**，Claude Code 会监听并响应这个频道。

它提供三个通知方法：

| 方向 | 方法 | 作用 |
|------|------|------|
| MCP Server → Claude | `notifications/claude/channel` | 向 Claude 注入一条用户消息 |
| Claude → MCP Server | `notifications/claude/channel/permission_request` | Claude 要执行工具，发出审批请求 |
| MCP Server → Claude | `notifications/claude/channel/permission` | 把审批结果（allow / deny）传回去 |

MCP Server 在启动时声明支持这两个能力：

```typescript
capabilities: {
  experimental: {
    'claude/channel': {},           // 注册为消息频道
    'claude/channel/permission': {} // 参与工具审批流
  }
}
```

Claude Code 收到 `notifications/claude/channel` 时，会把 `content` 字段的内容当作用户输入处理，和你在终端直接输入的效果完全一样。

---

## 工具审批：最有价值的部分

Claude Code 执行 `rm`、`git push` 这类操作之前，会弹出确认对话框，等待你在终端回答。

有了 Channels API，这个确认请求可以被拦截、转发到任何地方。审批结果也可以从任何地方发回。

流程是这样的：

```
1. Claude Code 要执行工具
       ↓
2. 发出 permission_request 通知（含 request_id、tool_name、description）
       ↓
3. MCP Server 收到，转发给手机
       ↓
4. 手机显示审批卡片，用户点击允许/拒绝
       ↓
5. MCP Server 发出 permission 通知（原样传回 request_id 和 behavior）
       ↓
6. Claude Code 匹配 request_id，继续或终止
```

有一个设计值得一提：`request_id` 全程透传，MCP Server 不需要维护任何状态映射，就是一个纯粹的转发管道。整个审批流的状态都由 Claude Code 自己维护。

---

## 把控制台搬到手机上——NAT 问题

能接管 Claude Code 的输入输出之后，下一步是让手机能触达本机。

最直接的想法是在本机起一个 HTTP server，手机访问。**但家用网络有 NAT**，外网根本访问不到本机的任何端口。

解法是反转方向：不让手机推消息进来，让本机主动去拉。

```
传统做法（需要入站端口，NAT 拦住）：
  手机 ──推消息──▶ 本机

改进做法（只需出站请求，NAT 不阻拦）：
  手机 ──▶ 云端中继 ◀── 本机（每 3 秒轮询）
```

中继选了 **Cloudflare Workers + KV**：免费套餐 10 万次请求/天，部署一条命令，不需要服务器运维。

---

## 完整架构

```
[手机 / 浏览器]
      │
      │  POST /api/send        GET /api/replies（轮询）
      │  POST /api/verdict     GET /api/permissions（轮询）
      ▼
[Cloudflare Worker + KV]   ← 消息暂存
      ▲
      │  GET /api/poll（每 3 秒）   POST /api/reply
      │  GET /api/verdicts（每 3 秒）POST /api/permission
      ▼
[Channel MCP Server — 本机]  ← Channels API 桥接层
      │  stdio
      ▼
[Claude Code CLI]
```

整个系统**没有任何入站端口**。本机和浏览器都只做出站请求。

KV 存储按消息类型分前缀，每条消息独立一个 key：

```
msg:{uuid}      → 用户发给 Claude 的消息
reply:{uuid}    → Claude 的回复
perm:{uuid}     → 待审批的工具请求
verdict:{uuid}  → 审批结果
```

---

## Channel MCP Server 的核心代码

MCP Server 做两件事：轮询消息并注入 Claude，监听审批请求并转发。

**注入消息：**
```typescript
// 每 3 秒取一次新消息，逐条注入 Claude
for (const msg of messages) {
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: { content: msg.text },
  })
}
```

**转发审批请求：**
```typescript
// Claude Code 发来审批请求，推到中继等手机处理
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  await relay.postPermission(params)  // request_id 原样透传
})
```

**发回审批结果：**
```typescript
// 手机点了允许/拒绝，取出 verdict，发回 Claude Code
for (const verdict of verdicts) {
  await mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id: verdict.request_id, behavior: verdict.behavior },
  })
}
```

---

## 手机界面

访问 Worker URL，左侧是对话，右侧是工具调用记录：

```
┌─────────────────────────┬──────────────────┐
│  对话                    │  工具调用记录     │
│                          │                  │
│  你: 帮我列出当前目录→   │  ⏳ Bash  ls -la │
│                          │    等待审批...   │
│  ┌──────────────────┐   │                  │
│  │ ⚠️  需要确认操作  │   │                  │
│  │ 工具: Bash        │   │                  │
│  │ 命令: ls -la      │   │                  │
│  │ [✓ 允许]  [✗ 拒绝]│   │                  │
│  └──────────────────┘   │                  │
│                          │                  │
│  [输入框]        [发送]  │                  │
└─────────────────────────┴──────────────────┘
```

---

## 启用方式

Channels API 目前需要用 `--dangerously-load-development-channels` 标志绕过白名单（Research Preview 阶段，用于本地开发）：

```bash
claude --dangerously-load-development-channels server:channel-server
```

需要 Claude Code **v2.1.80+**，工具审批功能需要 **v2.1.81+**。

### 第一步：部署 Relay Worker

```bash
# 创建 KV namespace，把输出的 id 填入 wrangler.toml
cd relay-worker && npx wrangler kv:namespace create RELAY_KV

# 生成 token 并设置为 Cloudflare secret
openssl rand -hex 32
npx wrangler secret put RELAY_TOKEN

# 部署，记下输出的 Worker URL
npx wrangler deploy
```

### 第二步：注册 Channel MCP Server

在项目根目录创建 `.mcp.json`，把 Worker URL 和 token 填进去：

```json
{
  "mcpServers": {
    "channel-server": {
      "command": "bun",
      "args": ["./channel-server/index.ts"],
      "env": {
        "RELAY_URL": "https://claude-relay.<account>.workers.dev",
        "RELAY_TOKEN": "<your-token>"
      }
    }
  }
}
```

`env` 字段会在 Claude Code 启动 MCP Server 时注入为环境变量，不需要手动 `export`。

> **注意：** `.mcp.json` 里有明文 token，不要提交到 git。把它加进 `.gitignore`。

### 第三步：启动

```bash
cd /path/to/project
claude --dangerously-load-development-channels server:channel-server
```

输入 `/mcp` 确认 `channel-server` 已连接，然后手机访问：

```
https://claude-relay.<account>.workers.dev/?token=<your-token>
```

---

## 小结

Channels API 做了一件很关键的事：把 Claude Code 的"控制界面"从终端抽离出来，变成一个可编程的接口。

注入消息、拦截审批、发回结果——这三个能力组合在一起，理论上可以接入任何前端：手机、Web、企业内网的审批系统，甚至另一个 AI。

这次做的是最简单的一种：一个静态 HTML 页面 + Cloudflare Worker 中继，零服务器成本，手机打开就能用。

代码已开源：[github.com/guoan1tang/claude-mcp](https://github.com/guoan1tang/claude-mcp)
