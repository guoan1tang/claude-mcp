# 用手机控制 Claude Code CLI —— 设计与实现全记录

> **用途：** 微信公众号文章素材。记录从想法到落地方案的完整过程，包括关键决策点和技术细节。

---

## 一、问题从哪里来

**场景：** 我在本地跑 Claude Code CLI，帮我自动写代码、跑命令。但有时候我不在电脑前，想用手机看进度、发指令，甚至在 Claude 要执行危险命令时能从手机确认或拒绝——而不是回去坐在电脑前。

**最直接的想法：** 在本地起一个 HTTP server，手机访问。

**问题：** 家用网络有 NAT，外网无法直接访问本机端口。就算用 ngrok 这类工具打洞，也需要额外配置，而且暴露了一个入站端口，有安全隐患。

---

## 二、反转思路：让本机主动去拉消息

**关键洞察：** 不让外部推消息进来——让本机自己去拉。

```
传统做法（需要入站端口）：
  手机 → 本机

改进做法（只需出站请求）：
  手机 → 云端中继 ← 本机轮询
```

这样本机永远只做**出站请求**，不接受任何入站连接，彻底规避了 NAT 穿透问题。

---

## 三、技术选型

**中继服务器：** Cloudflare Workers + KV
- 理由：免费套餐 10 万次请求/天，全球边缘节点，部署极简（一条命令），无需服务器运维
- 备选方案（被排除）：自建 VPS（需维护）、Supabase（overkill）、Firebase（需 Google 账号）

**MCP Server（本地桥接层）：** Bun + TypeScript + `@modelcontextprotocol/sdk`
- MCP（Model Context Protocol）是 Claude Code 的扩展协议，允许通过 stdio 向 Claude Code 注入消息、接收通知
- Claude Code 的 `claude/channel` 能力是关键：让 MCP Server 成为"频道"，Claude 会监听并响应频道消息

**Web 前端：** 单 HTML 文件，由 Worker 直接托管
- 无需独立部署，减少组件数量

---

## 四、架构图

```
[手机/浏览器]
    │
    │  POST /api/send        GET /api/replies（轮询）
    │  POST /api/verdict     GET /api/permissions（轮询）
    ▼
[Cloudflare Worker + KV]   ← 中继，消息暂存
    ▲
    │  GET /api/poll（每3秒）   POST /api/reply
    │  GET /api/verdicts（每3秒）POST /api/permission
    ▼
[Channel MCP Server — 本机]  ← 桥接层，stdio通信
    │
    ▼
[Claude Code CLI]
```

整个系统没有任何**入站**端口。本机和浏览器都只做出站请求。

---

## 五、消息流转过程

### 普通对话

1. 手机发一条消息 → `POST /api/send` → Worker 存入 KV（key: `msg:{uuid}`）
2. 本机 MCP Server 每 3 秒 `GET /api/poll` → 取出消息 → 通过 `notifications/claude/channel` 注入 Claude
3. Claude 处理后调用 `reply` 工具 → MCP Server `POST /api/reply` → Worker 存入 KV（key: `reply:{uuid}`）
4. 手机每 2 秒 `GET /api/replies` → 显示 Claude 的回复

### 工具确认（Permission Relay）

1. Claude 要执行工具 → Claude Code 发出 `notifications/claude/channel/permission_request`（含 `request_id`、`tool_name`、`description`、`input_preview`）
2. MCP Server 收到 → `POST /api/permission` 推送到 Worker KV（key: `perm:{uuid}`）
3. 手机轮询 `GET /api/permissions` → 显示审批卡片（工具名、命令、风险说明）
4. 用户点击允许/拒绝 → `POST /api/verdict`（含原始 `request_id` 和 `behavior: allow|deny`）
5. MCP Server 轮询 `GET /api/verdicts` → 发出 `notifications/claude/channel/permission`
6. Claude Code 匹配 `request_id`，应用结果，继续或终止

**关键设计：** `request_id` 全程透传，MCP Server 不需要维护任何映射表。

---

## 六、界面设计

**左右分栏布局：**

```
┌─────────────────────────┬──────────────────┐
│  💬 对话                 │  🖥️ 工具调用记录  │
│                          │                  │
│  [用户消息]→             │  ✓ Read  src/     │
│  ← [Claude回复]          │  ✓ Bash  grep...  │
│                          │  ⏳ Bash  rm *.ts │
│  ┌──────────────────┐   │    等待审批...     │
│  │⚠️ 需要确认操作    │   │                  │
│  │工具: Bash        │   │                  │
│  │命令: rm *.ts     │   │                  │
│  │[允许] [拒绝]     │   │                  │
│  └──────────────────┘   │                  │
│                          │                  │
│  [输入框]      [发送]    │                  │
└─────────────────────────┴──────────────────┘
```

- 左侧：对话气泡 + 审批卡片（嵌入对话流中，而不是弹窗）
- 右侧：工具调用列表，支持展开查看完整输出，待审批项高亮显示

---

## 七、KV 存储设计的一个坑

**初版想法：** 每种消息类型用一个 KV key，存 JSON 数组。

**问题：** Cloudflare KV 没有原子性的 read-then-clear 操作。如果两个请求同时读，会重复消费；如果边读边写，可能丢数据。另外单个 value 有 25MB 上限，高并发下数组会越来越大。

**解决方案：** 每条消息独立存一个 key，按前缀索引：

```
msg:{uuid}     → { id, text, ts }
reply:{uuid}   → { id, text, ts }
perm:{uuid}    → { request_id, tool_name, description, input_preview, ts }
verdict:{uuid} → { request_id, behavior, ts }
```

取消息时：list 前缀 → 并发 get + delete 每个 key → 返回结果。

**副作用（已接受）：** 极端情况下（网络中断恰好在 delete 之后 get 之前），对 MCP Server（长进程）来说是"至少一次"投递；对浏览器来说是"最多一次"（已 delete 后标签崩溃则丢失）。对个人单用户场景完全可接受。

---

## 八、安全设计

- 所有 API 端点要求 `Authorization: Bearer <token>`，否则返回 401
- `GET /`（Web UI）需要 `?token=` URL 参数，缺少时返回登录表单而不是 token 注入的页面
- Token 通过 `wrangler secret put` 设置，不进代码仓库
- Worker 是公网暴露的，token 是唯一访问控制——保管好就行
- MCP Server 只在本机跑，从不接受入站连接

---

## 九、Claude Code Channels API 简介

这是 Claude Code 的扩展协议，目前处于 Research Preview 阶段：

- 通过 `--dangerously-load-development-channels` 标志启用自定义 channel（绕过白名单，用于本地开发）
- MCP Server 在 `capabilities.experimental` 中声明 `claude/channel` 和 `claude/channel/permission`
- `notifications/claude/channel` — 向 Claude 注入用户消息（出现在 Claude 的上下文中）
- `notifications/claude/channel/permission_request` — Claude Code 需要工具审批时发给 MCP Server
- `notifications/claude/channel/permission` — MCP Server 把审批结果发回给 Claude Code
- 需要 Claude Code v2.1.80+，permission relay 需要 v2.1.81+
- 官方文档：https://code.claude.com/docs/en/channels-reference

---

## 十、部署三步走

```bash
# 1. 创建 KV namespace
cd relay-worker
npx wrangler kv:namespace create RELAY_KV
# 把输出的 id 填入 wrangler.toml

# 2. 生成并设置 token
openssl rand -hex 32          # 复制输出
npx wrangler secret put RELAY_TOKEN  # 粘贴

# 3. 部署
npx wrangler deploy
# 输出: https://claude-relay.<account>.workers.dev
```

之后每次启动：

```bash
export RELAY_URL=https://claude-relay.<account>.workers.dev
export RELAY_TOKEN=<your-token>
claude --dangerously-load-development-channels server:channel-server
```

手机访问：`https://claude-relay.<account>.workers.dev/?token=<your-token>`

---

## 十一、潜在文章角度

1. **"无需公网 IP，用手机控制本地 AI"** — 主打反直觉：不打洞、不 VPN，靠拉模式绕过 NAT
2. **"Cloudflare Workers 免费方案的正确打开方式"** — 具体算算 100k req/day 够不够用
3. **"MCP 不只是工具调用——频道扩展让 AI 有了耳朵"** — 介绍 Channels API 这个新能力
4. **"AI 危险操作如何把关——permission relay 原理"** — 重点讲审批流，配合截图

---

## 十二、技术关键词（SEO/标签用）

Claude Code、MCP、Channels API、Cloudflare Workers、KV、远程控制、Permission Relay、Bun、TypeScript、无公网 IP、手机控制 AI
