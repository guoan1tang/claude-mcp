# Claude Code 远程控制

通过 Claude Code 的 **Channels API**，把手机变成 Claude Code 的远程控制台——发消息、看回复、审批危险操作，全程无需入站端口。

## 架构

```
[手机 / 浏览器]
      │
      │  POST /api/send        GET /api/replies（轮询）
      │  POST /api/verdict     GET /api/permissions（轮询）
      ▼
[Cloudflare Worker + KV]   ← 消息暂存
      ▲
      │  GET /api/poll（每 5 秒）   POST /api/reply
      │  GET /api/verdicts（每 5 秒）POST /api/permission
      ▼
[Channel MCP Server — 本机]  ← Channels API 桥接层
      │  stdio
      ▼
[Claude Code CLI]
```

- **relay-worker/** — Cloudflare Worker，负责消息中转和 Web UI
- **channel-server/** — MCP Server，桥接 Channels API 与 Relay Worker

## 快速开始

### 1. 部署 Relay Worker

```bash
cd relay-worker

# 创建 KV namespace，把输出的 id 填入 wrangler.toml 的 kv_namespaces.id
npx wrangler kv:namespace create RELAY_KV

# 生成 token 并设置为 Cloudflare secret
openssl rand -hex 32
npx wrangler secret put RELAY_TOKEN

# 部署，记下输出的 Worker URL
npx wrangler deploy
```

### 2. 安装 Channel MCP Server 依赖

```bash
cd channel-server
bun install
```

### 3. 配置 .mcp.json

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "channel-server": {
      "command": "bun",
      "args": ["./channel-server/index.ts"],
      "env": {
        "RELAY_URL": "https://<your-worker>.workers.dev",
        "RELAY_TOKEN": "<your-token>"
      }
    }
  }
}
```

> ⚠️ `.mcp.json` 含明文 token，已加入 `.gitignore`，**不要提交到 git**。

### 4. 启动

```bash
claude --dangerously-load-development-channels server:channel-server
```

输入 `/mcp` 确认 `channel-server` 已连接，然后手机访问：

```
https://<your-worker>.workers.dev/?token=<your-token>
```

## 环境要求

- Claude Code **v2.1.80+**（工具审批需要 v2.1.81+）
- [Bun](https://bun.sh) — channel-server 运行时
- Cloudflare 账号（免费套餐即可）

## Channels API 说明

| 方向 | 方法 | 作用 |
|------|------|------|
| MCP → Claude | `notifications/claude/channel` | 向 Claude 注入用户消息 |
| Claude → MCP | `notifications/claude/channel/permission_request` | Claude 发出工具审批请求 |
| MCP → Claude | `notifications/claude/channel/permission` | 把审批结果传回 Claude |

`--dangerously-load-development-channels` 标志是 Research Preview 阶段的开发绕过开关，正式发布后会变更。
