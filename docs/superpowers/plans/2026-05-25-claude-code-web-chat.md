# Claude Code Web Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Worker relay + local Channel MCP server that lets you send messages to Claude Code CLI and approve tool calls from any browser, without exposing any port on the local machine.

**Architecture:** The Relay Worker (Cloudflare Worker + KV, free tier) acts as a message store; the Channel MCP Server polls it every 3s and bridges Claude Code via stdio. The web frontend is a single HTML file served by the Worker with a split-panel layout.

**Tech Stack:** Bun + TypeScript (MCP server), Cloudflare Workers + KV + Wrangler (relay), @modelcontextprotocol/sdk, vanilla HTML/CSS/JS (frontend), Vitest (Worker tests), Bun test (MCP server tests)

---

## File Map

| File | Responsibility |
|------|---------------|
| `relay-worker/src/index.ts` | Worker entry: routing, auth, serving HTML, all API endpoints |
| `relay-worker/src/kv.ts` | KV helpers: `enqueue(prefix, item)` / `dequeue(prefix)` |
| `relay-worker/src/auth.ts` | Auth helpers: `checkBearer`, `checkQueryToken` |
| `relay-worker/src/ui.html` | Web frontend: split-panel chat UI, approval cards, activity log |
| `relay-worker/src/kv.test.ts` | Unit tests for KV helpers |
| `relay-worker/src/auth.test.ts` | Unit tests for auth helpers |
| `relay-worker/wrangler.toml` | KV namespace binding, worker name, HTML module rule |
| `relay-worker/package.json` | Wrangler, Vitest, TypeScript |
| `channel-server/index.ts` | MCP server: capabilities, polling loop, reply tool, permission handler |
| `channel-server/relay-client.ts` | HTTP client for talking to the Relay Worker |
| `channel-server/relay-client.test.ts` | Bun unit tests for relay client |
| `channel-server/package.json` | Bun + @modelcontextprotocol/sdk + zod |
| `.mcp.json` | MCP server registration for Claude Code |

---

### Task 1: Project Scaffolding

**Files:**
- Create: `relay-worker/package.json`
- Create: `relay-worker/wrangler.toml`
- Create: `channel-server/package.json`
- Create: `.mcp.json`

- [ ] **Step 1: Create relay-worker/package.json**

```json
{
  "name": "relay-worker",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "wrangler": "^3.0.0",
    "vitest": "^1.0.0",
    "typescript": "^5.0.0",
    "uuid": "^9.0.0",
    "@types/uuid": "^9.0.0"
  }
}
```

- [ ] **Step 2: Install relay-worker deps**

```bash
cd relay-worker && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create relay-worker/wrangler.toml**

```toml
name = "claude-relay"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
# Remove this block after setting the real secret with: wrangler secret put RELAY_TOKEN
# RELAY_TOKEN = "dev-test-token"

[[kv_namespaces]]
binding = "KV"
id = "PLACEHOLDER_REPLACE_AFTER_CREATE"

[rules]
[[rules]]
type = "Text"
globs = ["**/*.html"]
fallthrough = true
```

- [ ] **Step 4: Create channel-server/package.json**

```json
{
  "name": "channel-server",
  "private": true,
  "scripts": {
    "start": "bun run index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.0.0"
  }
}
```

- [ ] **Step 5: Install channel-server deps**

```bash
cd channel-server && bun install
```

Expected: `node_modules/` created with `@modelcontextprotocol/sdk` and `zod`.

- [ ] **Step 6: Create .mcp.json** (project root)

```json
{
  "mcpServers": {
    "channel-server": {
      "command": "bun",
      "args": ["./channel-server/index.ts"]
    }
  }
}
```

- [ ] **Step 7: Initialize git and commit**

```bash
cd /path/to/claude-mcp
git init
git add relay-worker/package.json relay-worker/wrangler.toml channel-server/package.json .mcp.json
git commit -m "chore: project scaffolding"
```

---

### Task 2: Relay Worker — KV Storage Layer

**Files:**
- Create: `relay-worker/src/kv.ts`
- Create: `relay-worker/src/kv.test.ts`

- [ ] **Step 1: Write failing tests**

Create `relay-worker/src/kv.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { enqueue, dequeue } from './kv'

function makeKV() {
  const store: Record<string, string> = {}
  return {
    async put(key: string, value: string) { store[key] = value },
    async get(key: string) { return store[key] ?? null },
    async delete(key: string) { delete store[key] },
    async list({ prefix }: { prefix: string }) {
      const keys = Object.keys(store).filter(k => k.startsWith(prefix)).map(name => ({ name }))
      return { keys }
    },
  }
}

type KVMock = ReturnType<typeof makeKV>
let kv: KVMock
beforeEach(() => { kv = makeKV() })

describe('enqueue', () => {
  it('stores item under prefix:uuid key', async () => {
    await enqueue(kv as any, 'msg', { id: '1', text: 'hello', ts: 1000 })
    const { keys } = await kv.list({ prefix: 'msg:' })
    expect(keys).toHaveLength(1)
    expect(keys[0].name).toMatch(/^msg:/)
  })
})

describe('dequeue', () => {
  it('returns all items and clears them', async () => {
    await enqueue(kv as any, 'msg', { id: '1', text: 'a', ts: 1 })
    await enqueue(kv as any, 'msg', { id: '2', text: 'b', ts: 2 })
    const items = await dequeue(kv as any, 'msg')
    expect(items).toHaveLength(2)
    const { keys } = await kv.list({ prefix: 'msg:' })
    expect(keys).toHaveLength(0)
  })

  it('returns empty array when nothing queued', async () => {
    const items = await dequeue(kv as any, 'msg')
    expect(items).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd relay-worker && npm test
```

Expected: FAIL — `Cannot find module './kv'`

- [ ] **Step 3: Implement kv.ts**

Create `relay-worker/src/kv.ts`:

```typescript
import { v4 as uuid } from 'uuid'

export interface KVNamespace {
  put(key: string, value: string): Promise<void>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
  list(opts: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>
}

export async function enqueue(kv: KVNamespace, prefix: string, item: unknown): Promise<void> {
  await kv.put(`${prefix}:${uuid()}`, JSON.stringify(item))
}

export async function dequeue<T>(kv: KVNamespace, prefix: string): Promise<T[]> {
  const { keys } = await kv.list({ prefix: `${prefix}:` })
  if (keys.length === 0) return []
  const items = await Promise.all(
    keys.map(async ({ name }) => {
      const raw = await kv.get(name)
      await kv.delete(name)
      return raw ? JSON.parse(raw) as T : null
    })
  )
  return items.filter(Boolean) as T[]
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd relay-worker && npm test
```

Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add relay-worker/src/kv.ts relay-worker/src/kv.test.ts
git commit -m "feat: KV enqueue/dequeue helpers"
```

---

### Task 3: Relay Worker — Auth Helpers

**Files:**
- Create: `relay-worker/src/auth.ts`
- Create: `relay-worker/src/auth.test.ts`

- [ ] **Step 1: Write failing tests**

Create `relay-worker/src/auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { checkBearer, checkQueryToken } from './auth'

describe('checkBearer', () => {
  it('returns true when Authorization matches', () => {
    expect(checkBearer(new Headers({ Authorization: 'Bearer secret123' }), 'secret123')).toBe(true)
  })
  it('returns false when token is wrong', () => {
    expect(checkBearer(new Headers({ Authorization: 'Bearer wrong' }), 'secret123')).toBe(false)
  })
  it('returns false when header is missing', () => {
    expect(checkBearer(new Headers(), 'secret123')).toBe(false)
  })
})

describe('checkQueryToken', () => {
  it('returns true when ?token= matches', () => {
    expect(checkQueryToken(new URL('https://x.com/?token=secret123'), 'secret123')).toBe(true)
  })
  it('returns false when ?token= is wrong', () => {
    expect(checkQueryToken(new URL('https://x.com/?token=wrong'), 'secret123')).toBe(false)
  })
  it('returns false when ?token= is absent', () => {
    expect(checkQueryToken(new URL('https://x.com/'), 'secret123')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd relay-worker && npm test
```

Expected: FAIL — `Cannot find module './auth'`

- [ ] **Step 3: Implement auth.ts**

Create `relay-worker/src/auth.ts`:

```typescript
export function checkBearer(headers: Headers, token: string): boolean {
  return headers.get('Authorization') === `Bearer ${token}`
}

export function checkQueryToken(url: URL, token: string): boolean {
  return url.searchParams.get('token') === token
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd relay-worker && npm test
```

Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add relay-worker/src/auth.ts relay-worker/src/auth.test.ts
git commit -m "feat: auth helpers for relay worker"
```

---

### Task 4: Relay Worker — API Handlers

**Files:**
- Create: `relay-worker/src/index.ts`

Implements all 9 API endpoints plus the login form / UI serving.

- [ ] **Step 1: Create relay-worker/src/index.ts**

```typescript
// @ts-ignore — wrangler injects this as a text module
import UI_HTML from './ui.html'
import { enqueue, dequeue } from './kv'
import { checkBearer, checkQueryToken } from './auth'

export interface Env {
  KV: KVNamespace
  RELAY_TOKEN: string
}

const LOGIN_FORM = `<!DOCTYPE html>
<html><head><title>Claude Relay</title><style>
  body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
       min-height:100vh;margin:0;background:#0f1117;color:#e0e0e0}
  form{display:flex;flex-direction:column;gap:12px;width:300px}
  h2{margin:0}
  input{padding:10px;border-radius:6px;border:1px solid #333;background:#1a1a2e;color:#e0e0e0;font-size:14px}
  button{padding:10px;background:#7c3aed;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px}
</style></head><body>
<form onsubmit="go(event)">
  <h2>Claude Relay</h2>
  <input id="t" type="password" placeholder="Enter token" required>
  <button type="submit">Enter</button>
</form>
<script>function go(e){e.preventDefault();const t=document.getElementById('t').value;window.location.href='/?token='+encodeURIComponent(t)}</script>
</body></html>`

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const token = env.RELAY_TOKEN

    // GET / — serve UI (requires ?token= query param auth)
    if (req.method === 'GET' && url.pathname === '/') {
      if (!checkQueryToken(url, token)) {
        return new Response(LOGIN_FORM, { headers: { 'Content-Type': 'text/html' } })
      }
      const html = (UI_HTML as string).replace(
        '</head>',
        `<script>window.RELAY_TOKEN=${JSON.stringify(token)};window.RELAY_URL=''</script></head>`
      )
      return new Response(html, { headers: { 'Content-Type': 'text/html' } })
    }

    // All other routes require Bearer token
    if (!checkBearer(req.headers, token)) {
      return new Response('Unauthorized', { status: 401 })
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const { text } = await req.json() as { text: string }
      if (!text) return new Response('Bad Request', { status: 400 })
      await enqueue(env.KV, 'msg', { id: crypto.randomUUID(), text, ts: Date.now() })
      return new Response('ok')
    }

    if (req.method === 'GET' && url.pathname === '/api/poll') {
      return Response.json(await dequeue(env.KV, 'msg'))
    }

    if (req.method === 'POST' && url.pathname === '/api/reply') {
      await enqueue(env.KV, 'reply', await req.json())
      return new Response('ok')
    }

    if (req.method === 'GET' && url.pathname === '/api/replies') {
      return Response.json(await dequeue(env.KV, 'reply'))
    }

    if (req.method === 'POST' && url.pathname === '/api/permission') {
      await enqueue(env.KV, 'perm', { ...await req.json(), ts: Date.now() })
      return new Response('ok')
    }

    if (req.method === 'GET' && url.pathname === '/api/permissions') {
      return Response.json(await dequeue(env.KV, 'perm'))
    }

    if (req.method === 'POST' && url.pathname === '/api/verdict') {
      await enqueue(env.KV, 'verdict', { ...await req.json(), ts: Date.now() })
      return new Response('ok')
    }

    if (req.method === 'GET' && url.pathname === '/api/verdicts') {
      return Response.json(await dequeue(env.KV, 'verdict'))
    }

    return new Response('Not Found', { status: 404 })
  },
}
```

- [ ] **Step 2: Create a placeholder ui.html so TypeScript can resolve the import**

```bash
touch relay-worker/src/ui.html
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd relay-worker && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add relay-worker/src/index.ts relay-worker/src/ui.html
git commit -m "feat: relay worker API handlers"
```

---

### Task 5: Relay Worker — Web Frontend

**Files:**
- Modify: `relay-worker/src/ui.html` (replace placeholder with full UI)

- [ ] **Step 1: Write the full ui.html**

Replace `relay-worker/src/ui.html` with:

```html
<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Code</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
       background: #0f1117; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
header { padding: 10px 16px; background: #0a0a0f; border-bottom: 1px solid #1e1e3a;
         font-size: 13px; color: #888; }
header span { color: #a78bfa; font-weight: 600; }
#app { display: flex; flex: 1; overflow: hidden; }

/* Left: Chat */
#chat-panel { flex: 1; display: flex; flex-direction: column; border-right: 1px solid #1e1e3a; }
#messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.msg-user { display: flex; justify-content: flex-end; }
.msg-user .bubble { background: #2a2a4a; color: #aad4f5; border-radius: 12px 12px 3px 12px;
                    padding: 8px 12px; max-width: 75%; font-size: 13px; line-height: 1.5; }
.msg-claude { display: flex; gap: 8px; align-items: flex-start; }
.avatar { width: 24px; height: 24px; background: #7c3aed; border-radius: 50%; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center; font-size: 10px; color: white; margin-top: 2px; }
.msg-claude .bubble { background: #1e1e3a; color: #e0e0e0; border-radius: 3px 12px 12px 12px;
                      padding: 8px 12px; max-width: 75%; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }

/* Approval card */
.approval-card { margin-left: 32px; background: #1c1400; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px; }
.approval-card .ac-title { color: #f59e0b; font-size: 11px; font-weight: 600; margin-bottom: 8px; }
.approval-card .ac-tool { color: #e0e0e0; font-size: 12px; margin-bottom: 4px; }
.approval-card .ac-cmd { font-family: monospace; background: #0f1117; color: #86efac;
                         padding: 3px 7px; border-radius: 4px; font-size: 11px; word-break: break-all; display: block; }
.approval-card .ac-desc { color: #9ca3af; font-size: 11px; margin-top: 4px; margin-bottom: 10px; }
.approval-card .btns { display: flex; gap: 6px; }
.btn-allow { background: #16a34a; color: white; border: none; padding: 6px 16px; border-radius: 5px; font-size: 12px; cursor: pointer; }
.btn-deny  { background: #dc2626; color: white; border: none; padding: 6px 16px; border-radius: 5px; font-size: 12px; cursor: pointer; }
.approval-card.decided { opacity: 0.5; pointer-events: none; }
.approval-card.decided .btns::after { content: '已处理'; font-size: 11px; color: #888; align-self: center; }

#input-bar { padding: 10px; background: #0a0a0f; border-top: 1px solid #1e1e3a; display: flex; gap: 8px; }
#msg-input { flex: 1; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 8px;
             padding: 8px 12px; color: #e0e0e0; font-size: 13px; outline: none; font-family: inherit; resize: none; }
#msg-input:focus { border-color: #7c3aed; }
#send-btn { background: #7c3aed; color: white; border: none; border-radius: 8px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
#send-btn:hover { background: #6d28d9; }

/* Right: Activity */
#activity-panel { width: 260px; display: flex; flex-direction: column; background: #0a0a0f; }
#activity-header { padding: 10px 12px; color: #888; font-size: 11px; border-bottom: 1px solid #1e1e3a; }
#activity-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.ai { border-radius: 5px; padding: 7px 9px; font-size: 11px; font-family: monospace; }
.ai.pending { background: #1c1400; border: 1px solid #854d0e; }
.ai.allowed { background: #0a1f0a; border: 1px solid #166534; }
.ai.denied  { background: #1f0a0a; border: 1px solid #7f1d1d; }
.ai .ai-tool { font-weight: 600; }
.ai.pending .ai-tool { color: #f59e0b; }
.ai.allowed .ai-tool { color: #4ade80; }
.ai.denied  .ai-tool { color: #f87171; }
.ai .ai-preview { color: #6b7280; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
details summary { cursor: pointer; color: #555; font-size: 10px; margin-top: 3px; }
details pre { font-size: 10px; color: #9ca3af; margin-top: 4px; white-space: pre-wrap; word-break: break-all; }
</style>
</head><body>
<header>🤖 <span>Claude Code</span> <span style="color:#555">— 远程控制</span></header>
<div id="app">
  <div id="chat-panel">
    <div id="messages"></div>
    <div id="input-bar">
      <textarea id="msg-input" rows="1" placeholder="发送消息给 Claude..."></textarea>
      <button id="send-btn">发送</button>
    </div>
  </div>
  <div id="activity-panel">
    <div id="activity-header">🖥️ 工具调用记录</div>
    <div id="activity-list"></div>
  </div>
</div>
<script>
const token = window.RELAY_TOKEN
const base = window.RELAY_URL || ''
const hdrs = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
const $msgs = document.getElementById('messages')
const $input = document.getElementById('msg-input')
const $acts = document.getElementById('activity-list')

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function appendUserMsg(text) {
  $msgs.insertAdjacentHTML('beforeend', `<div class="msg-user"><div class="bubble">${esc(text)}</div></div>`)
  $msgs.scrollTop = $msgs.scrollHeight
}

function appendClaudeMsg(text) {
  $msgs.insertAdjacentHTML('beforeend',
    `<div class="msg-claude"><div class="avatar">C</div><div class="bubble">${esc(text)}</div></div>`)
  $msgs.scrollTop = $msgs.scrollHeight
}

function appendApprovalCard(p) {
  $msgs.insertAdjacentHTML('beforeend', `
    <div class="approval-card" data-rid="${esc(p.request_id)}">
      <div class="ac-title">⚠️ 需要确认操作</div>
      <div class="ac-tool">工具: <strong>${esc(p.tool_name)}</strong></div>
      <code class="ac-cmd">${esc(p.description)}</code>
      <div class="ac-desc">${esc(p.input_preview)}</div>
      <div class="btns">
        <button class="btn-allow" onclick="verdict('${esc(p.request_id)}','allow',this)">✓ 允许执行</button>
        <button class="btn-deny"  onclick="verdict('${esc(p.request_id)}','deny',this)">✗ 拒绝</button>
      </div>
    </div>`)
  $msgs.scrollTop = $msgs.scrollHeight
  addActivityItem(p, 'pending')
}

function addActivityItem(p, state) {
  const icon = state === 'allowed' ? '✓' : state === 'denied' ? '✗' : '⏳'
  const el = document.createElement('div')
  el.className = `ai ${state}`
  el.dataset.rid = p.request_id
  el.innerHTML = `
    <div class="ai-tool">${icon} ${esc(p.tool_name)}</div>
    <div class="ai-preview">${esc(p.description)}</div>
    ${p.input_preview ? `<details><summary>详情</summary><pre>${esc(p.input_preview)}</pre></details>` : ''}`
  $acts.appendChild(el)
  $acts.scrollTop = $acts.scrollHeight
}

function updateActivityItem(rid, state) {
  const el = $acts.querySelector(`[data-rid="${rid}"]`)
  if (!el) return
  el.className = `ai ${state}`
  const t = el.querySelector('.ai-tool')
  if (t) t.textContent = (state === 'allowed' ? '✓ ' : '✗ ') + t.textContent.slice(2)
}

async function verdict(rid, behavior, btn) {
  btn.closest('.approval-card').classList.add('decided')
  updateActivityItem(rid, behavior === 'allow' ? 'allowed' : 'denied')
  await fetch(base + '/api/verdict', { method: 'POST', headers: hdrs, body: JSON.stringify({ request_id: rid, behavior }) })
}

async function sendMessage() {
  const text = $input.value.trim()
  if (!text) return
  $input.value = ''
  appendUserMsg(text)
  await fetch(base + '/api/send', { method: 'POST', headers: hdrs, body: JSON.stringify({ text }) })
}

async function poll() {
  try {
    const [rr, pr] = await Promise.all([
      fetch(base + '/api/replies', { headers: hdrs }),
      fetch(base + '/api/permissions', { headers: hdrs }),
    ])
    const replies = await rr.json()
    const perms = await pr.json()
    for (const r of replies) appendClaudeMsg(r.text)
    for (const p of perms) appendApprovalCard(p)
  } catch (_) {}
}

$input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
})
document.getElementById('send-btn').addEventListener('click', sendMessage)
setInterval(poll, 2000)
poll()
</script>
</body></html>
```

- [ ] **Step 2: Test locally**

Add a local token to `wrangler.toml` temporarily for testing:
```toml
[vars]
RELAY_TOKEN = "dev-test-token"
```

```bash
cd relay-worker && npx wrangler dev --local
```

Open `http://localhost:8787/`. Expected: Login form.  
Navigate to `http://localhost:8787/?token=dev-test-token`. Expected: Split-panel UI loads.

- [ ] **Step 3: Remove the local vars block from wrangler.toml**

Delete the `[vars]` section (the real token will be set as a secret in Task 6).

- [ ] **Step 4: Commit**

```bash
git add relay-worker/src/ui.html relay-worker/wrangler.toml
git commit -m "feat: web frontend UI"
```

---

### Task 6: Deploy Relay Worker to Cloudflare

**Prerequisites:** Cloudflare account (free). Install wrangler globally or use npx. Run `npx wrangler login` if not already authenticated.

- [ ] **Step 1: Create KV namespace**

```bash
cd relay-worker && npx wrangler kv:namespace create RELAY_KV
```

Output includes a line like: `id = "abc123..."`. Copy that ID.

- [ ] **Step 2: Update wrangler.toml with real KV id**

Replace `PLACEHOLDER_REPLACE_AFTER_CREATE` with the ID from Step 1.

- [ ] **Step 3: Generate and set the secret token**

```bash
openssl rand -hex 32
# Copy the output — this is your RELAY_TOKEN

cd relay-worker && npx wrangler secret put RELAY_TOKEN
# Paste the token when prompted
```

Save this token somewhere safe (you'll need it for the MCP server env var).

- [ ] **Step 4: Deploy**

```bash
cd relay-worker && npx wrangler deploy
```

Expected output includes: `https://claude-relay.<account>.workers.dev`

- [ ] **Step 5: Smoke test**

```bash
WORKER_URL=https://claude-relay.<account>.workers.dev
TOKEN=<your-token>

# No token → 401
curl -s -o /dev/null -w "%{http_code}" $WORKER_URL/api/poll
# Expected: 401

# With token → empty array
curl -s -H "Authorization: Bearer $TOKEN" $WORKER_URL/api/poll
# Expected: []

# Enqueue and retrieve
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"test message"}' $WORKER_URL/api/send
curl -s -H "Authorization: Bearer $TOKEN" $WORKER_URL/api/poll
# Expected: [{"id":"...","text":"test message","ts":...}]
```

- [ ] **Step 6: Commit wrangler.toml with real KV id**

```bash
git add relay-worker/wrangler.toml
git commit -m "chore: set KV namespace id"
```

---

### Task 7: Channel MCP Server — Relay Client + Core

**Files:**
- Create: `channel-server/relay-client.ts`
- Create: `channel-server/relay-client.test.ts`
- Create: `channel-server/index.ts`

- [ ] **Step 1: Write failing tests for relay client**

Create `channel-server/relay-client.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import { buildRelayClient } from './relay-client'

describe('buildRelayClient', () => {
  it('polls GET /api/poll and returns parsed messages', async () => {
    const messages = [{ id: 'm1', text: 'hi', ts: 1 }]
    const fakeFetch = async () => new Response(JSON.stringify(messages))
    const client = buildRelayClient('https://relay.test', 'tok', fakeFetch as typeof fetch)
    expect(await client.pollMessages()).toEqual(messages)
  })

  it('sends POST /api/reply with correct body', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fakeFetch = async (url: string, opts: RequestInit) => {
      calls.push({ url, body: JSON.parse(opts.body as string) })
      return new Response('ok')
    }
    const client = buildRelayClient('https://relay.test', 'tok', fakeFetch as typeof fetch)
    await client.postReply({ id: 'r1', text: 'hello', ts: 1000 })
    expect(calls[0].url).toBe('https://relay.test/api/reply')
    expect(calls[0].body).toMatchObject({ id: 'r1', text: 'hello' })
  })

  it('posts permission request to /api/permission', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fakeFetch = async (url: string, opts: RequestInit) => {
      calls.push({ url, body: JSON.parse(opts.body as string) })
      return new Response('ok')
    }
    const client = buildRelayClient('https://relay.test', 'tok', fakeFetch as typeof fetch)
    await client.postPermission({ request_id: 'abcde', tool_name: 'Bash', description: 'run ls', input_preview: '{}' })
    expect(calls[0].url).toBe('https://relay.test/api/permission')
    expect(calls[0].body).toMatchObject({ request_id: 'abcde', tool_name: 'Bash' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd channel-server && bun test
```

Expected: FAIL — `Cannot find module './relay-client'`

- [ ] **Step 3: Create relay-client.ts**

```typescript
export interface Message { id: string; text: string; ts: number }
export interface PermRequest { request_id: string; tool_name: string; description: string; input_preview: string }
export interface Verdict { request_id: string; behavior: 'allow' | 'deny'; ts: number }

export interface RelayClient {
  pollMessages(): Promise<Message[]>
  pollVerdicts(): Promise<Verdict[]>
  postReply(reply: Message): Promise<void>
  postPermission(perm: PermRequest): Promise<void>
}

export function buildRelayClient(
  baseUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): RelayClient {
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }

  async function get<T>(path: string): Promise<T> {
    const res = await fetchFn(`${baseUrl}${path}`, { headers })
    return res.json() as Promise<T>
  }

  async function post(path: string, body: unknown): Promise<void> {
    await fetchFn(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  }

  return {
    pollMessages: () => get<Message[]>('/api/poll'),
    pollVerdicts: () => get<Verdict[]>('/api/verdicts'),
    postReply: (reply) => post('/api/reply', reply),
    postPermission: (perm) => post('/api/permission', perm),
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd channel-server && bun test
```

Expected: PASS — 3 tests green.

- [ ] **Step 5: Create channel-server/index.ts**

```typescript
#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { buildRelayClient } from './relay-client'

const RELAY_URL = process.env.RELAY_URL
const RELAY_TOKEN = process.env.RELAY_TOKEN
if (!RELAY_URL || !RELAY_TOKEN) {
  console.error('RELAY_URL and RELAY_TOKEN env vars are required')
  process.exit(1)
}

const relay = buildRelayClient(RELAY_URL, RELAY_TOKEN)

const mcp = new Server(
  { name: 'channel-server', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="channel-server">. ' +
      'Reply to the user using the reply tool. Keep replies concise.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message back to the web chat UI',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Message to send' } },
      required: ['text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { text } = req.params.arguments as { text: string }
    await relay.postReply({ id: crypto.randomUUID(), text, ts: Date.now() })
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`Unknown tool: ${req.params.name}`)
})

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  await relay.postPermission(params)
})

await mcp.connect(new StdioServerTransport())

async function tick() {
  try {
    const [messages, verdicts] = await Promise.all([
      relay.pollMessages(),
      relay.pollVerdicts(),
    ])
    for (const msg of messages) {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: msg.text, meta: { msg_id: msg.id } },
      })
    }
    for (const verdict of verdicts) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: verdict.request_id, behavior: verdict.behavior },
      })
    }
  } catch (e) {
    console.error('[channel-server] poll error:', e)
  }
}

setInterval(tick, 3000)
```

- [ ] **Step 6: Commit**

```bash
git add channel-server/relay-client.ts channel-server/relay-client.test.ts channel-server/index.ts
git commit -m "feat: channel MCP server with reply tool, permission relay, and polling"
```

---

### Task 8: End-to-End Integration Test

No new files. Verifies the full system works.

- [ ] **Step 1: Set environment variables**

```bash
export RELAY_URL=https://claude-relay.<your-account>.workers.dev
export RELAY_TOKEN=<your-token>
```

- [ ] **Step 2: Start Claude Code with the channel**

```bash
cd /path/to/claude-mcp
claude --dangerously-load-development-channels server:channel-server
```

In Claude Code, type `/mcp` to verify the server is connected. Expected: `channel-server` listed as connected.

- [ ] **Step 3: Open the web UI on your phone or browser**

Navigate to: `https://claude-relay.<account>.workers.dev/?token=<your-token>`

Expected: Split-panel chat UI loads.

- [ ] **Step 4: Test basic chat**

In the web UI, type: `你好，请用中文简单介绍一下你自己`

Expected within ~5 seconds: Claude's reply appears in the left panel.

- [ ] **Step 5: Test permission relay — allow path**

In the web UI, type: `请帮我列出当前目录的文件（运行 ls 命令）`

Expected:
1. A permission approval card appears in the web UI chat
2. The right panel shows a pending ⏳ Bash item
3. Click "✓ 允许执行" in the web UI
4. Claude Code terminal dialog closes, `ls` runs
5. Claude's reply with the file list appears in the chat
6. Right panel item updates to ✓ (green)

- [ ] **Step 6: Test permission relay — deny path**

Ask Claude to run another command. When the approval card appears, click "✗ 拒绝".

Expected: Claude Code terminal dialog closes. Claude responds that the operation was not permitted.

- [ ] **Step 7: Final commit**

```bash
git add .
git commit -m "feat: complete claude-code web chat with permission relay"
```

---

## Quick Reference

**Deploy once:**
```bash
cd relay-worker
npx wrangler kv:namespace create RELAY_KV   # → copy id into wrangler.toml
openssl rand -hex 32                         # → your RELAY_TOKEN
npx wrangler secret put RELAY_TOKEN          # → paste token
npx wrangler deploy                          # → get Worker URL
```

**Every session:**
```bash
export RELAY_URL=https://claude-relay.<account>.workers.dev
export RELAY_TOKEN=<your-token>
claude --dangerously-load-development-channels server:channel-server
```

**Access from any device:**
```
https://claude-relay.<account>.workers.dev/?token=<your-token>
```
