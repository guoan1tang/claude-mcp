# Claude Code Web Chat — Design Spec

**Date:** 2026-05-25  
**Status:** Approved

## Overview

A system that lets you control Claude Code CLI from a remote browser (phone or any device), send it messages, approve/deny tool calls, and monitor its activity — all without exposing any port on the local machine.

---

## Architecture

### Components

1. **Relay Worker** — Cloudflare Worker + KV, deployed on free tier. Acts as the central message store. Both the web frontend and the local MCP server connect outward to it; neither side needs to accept inbound connections.

2. **Channel MCP Server** — TypeScript/Bun process running on the same machine as Claude Code. Registered in `.mcp.json` so Claude Code spawns it as a subprocess on startup. Polls the relay for incoming messages and permission verdicts; pushes Claude's replies and permission requests back out.

3. **Web Frontend** — Single HTML page served by the Relay Worker. Split-panel layout: left panel for chat and inline approval cards, right panel for Claude CLI activity log with collapsible output.

### Data Flow

```
[Remote Browser]
    │  POST /api/send              GET /api/replies (poll)
    │  POST /api/verdict           GET /api/permissions (poll)
    ▼
[Cloudflare Worker + KV]
    ▲
    │  GET /api/poll (every 3s)    POST /api/reply
    │  GET /api/verdicts (every 3s) POST /api/permission
    ▼
[Channel MCP Server — local]
    │  stdio
    ▼
[Claude Code CLI]
```

### Message Lifecycle

**Chat:**
1. User types in web UI → `POST /api/send` → Worker stores in `messages` KV
2. MCP server polls `GET /api/poll` → receives message → emits `notifications/claude/channel`
3. Claude processes → calls `reply` tool → MCP server `POST /api/reply` → Worker stores in `replies` KV
4. Web UI polls `GET /api/replies` → renders Claude's response

**Permission Relay:**
1. Claude wants to run a tool → Claude Code fires `notifications/claude/channel/permission_request` to MCP server
2. MCP server `POST /api/permission` → Worker stores in `permission_requests` KV
3. Web UI polls `GET /api/permissions` → renders inline approval card in left panel + highlights pending item in right panel
4. User clicks Allow/Deny → `POST /api/verdict` → Worker stores in `verdicts` KV
5. MCP server polls `GET /api/verdicts` → emits `notifications/claude/channel/permission` → Claude Code applies verdict

---

## Relay Worker API

All endpoints require `Authorization: Bearer <token>` header. Token is set as a Worker environment variable (`RELAY_TOKEN`).

| Method | Path | Caller | Description |
|--------|------|--------|-------------|
| `GET` | `/` | Browser | Serve web frontend HTML |
| `POST` | `/api/send` | Web | Enqueue a message for Claude |
| `GET` | `/api/poll` | MCP | Dequeue all pending messages (clears queue) |
| `POST` | `/api/reply` | MCP | Store Claude's reply |
| `GET` | `/api/replies` | Web | Dequeue all pending replies (clears queue) |
| `POST` | `/api/permission` | MCP | Store a permission request |
| `GET` | `/api/permissions` | Web | Dequeue all pending permission requests |
| `POST` | `/api/verdict` | Web | Store an approval verdict |
| `GET` | `/api/verdicts` | MCP | Dequeue all pending verdicts (clears queue) |

### Storage Pattern

Each queued item is stored as an individual KV key with a typed prefix:

```
msg:{uuid}      → { id, text, ts }
reply:{uuid}    → { id, text, ts }
perm:{uuid}     → { request_id, tool_name, description, input_preview, ts }
verdict:{uuid}  → { request_id, behavior, ts }
```

**Dequeue:** list all keys with the target prefix, read each value, delete each key, return the values. This avoids the 25 MB array size limit and is safe for a single-consumer setup (the MCP server is the only reader of `msg:` and `verdict:` keys; the web UI is the only reader of `reply:` and `perm:` keys).

**Delivery guarantees:**
- `msg:` and `verdict:` (MCP server, long-running process): at-least-once. A crash mid-dequeue is rare and the server is restartable.
- `reply:` and `perm:` (web browser): at-most-once. Items are deleted on the Worker before the browser renders them. If the tab crashes or network drops after deletion, those items are gone. This is a known limitation acceptable for personal single-user use.

---

## Channel MCP Server

**Runtime:** Bun  
**Location:** `channel-server/index.ts`

### MCP Capabilities

```ts
capabilities: {
  experimental: {
    'claude/channel': {},           // register channel notification listener
    'claude/channel/permission': {} // opt in to permission relay
  },
  tools: {}                         // expose reply tool
}
```

### Polling Loop

Runs every 3 seconds after `mcp.connect()`:
1. `GET /api/poll` → for each message, emit `notifications/claude/channel`
2. `GET /api/verdicts` → for each verdict, emit `notifications/claude/channel/permission`

### Reply Tool

Claude calls this to send a response back. Schema:
```ts
{ name: 'reply', inputSchema: { text: string } }
```
Handler: `POST /api/reply` with `{ id: uuid(), text, ts: Date.now() }`

### Permission Request Handler

Handles `notifications/claude/channel/permission_request`:
```ts
{ request_id, tool_name, description, input_preview }
```
Action: `POST /api/permission` forwarding all four fields plus `ts`.

### Configuration

Environment variables (set in shell or `.env` file, not committed):
- `RELAY_URL` — Worker URL, e.g. `https://claude-relay.example.workers.dev`
- `RELAY_TOKEN` — shared secret, same value as Worker's `RELAY_TOKEN`

### Registration

`.mcp.json` in project root:
```json
{
  "mcpServers": {
    "channel-server": { "command": "bun", "args": ["./channel-server/index.ts"] }
  }
}
```

Start Claude Code:
```bash
claude --dangerously-load-development-channels server:channel-server
```

---

## Web Frontend

Single HTML file (`relay-worker/src/ui.html`), served by the Worker at `GET /`.

### Layout

**Left panel — Chat + Approvals**
- Conversation bubbles (user right-aligned, Claude left-aligned with avatar)
- Inline approval cards appear in the conversation flow when a permission request arrives:
  - Shows tool name, full command/description, and a short risk note
  - Two buttons: Allow / Deny
  - Card grays out after decision
- Input bar at bottom with send button

**Right panel — CLI Activity**
- Chronological list of tool calls received via `replies` metadata
- Each item shows: status icon (✓ done / ⏳ pending), tool name, brief target
- Completed items with output: collapsible section showing first 3 lines + "expand" toggle
- Pending approval items highlighted in amber

### Permission Request ID Lifecycle

`request_id` originates in Claude Code and arrives in the `notifications/claude/channel/permission_request` notification params. The MCP server forwards it verbatim to the relay (`POST /api/permission`). The web UI reads it, shows the approval card, and sends it back verbatim in `POST /api/verdict`. The MCP server dequeues the verdict and emits `notifications/claude/channel/permission` with the same `request_id` to Claude Code. No ID mapping is required in the MCP server — the ID passes through unchanged.

Claude Code matches the `request_id` to the open terminal dialog internally. If no matching open request exists (e.g., the user already answered in the terminal), Claude Code silently drops the verdict.

### Permission Request Timeout

The MCP server does **not** auto-deny timed-out permission requests. The local terminal dialog stays open indefinitely as a fallback — the user can always answer there. If no verdict arrives from the web UI, Claude Code waits until the terminal dialog is answered. This is acceptable given the use case (personal, single-user setup).

Worst-case latency for a verdict to reach Claude Code from the web UI: ~5 seconds (3s MCP poll + 2s web poll). Claude Code's local dialog has no timeout.

### Authentication

`GET /` requires the token as a URL query param: `https://worker.example.workers.dev/?token=<RELAY_TOKEN>`. The Worker validates the param before serving the page. If the token is missing or wrong, the Worker returns a plain "Enter token" form. Once validated, the Worker injects the token into the HTML as `window.RELAY_TOKEN` so subsequent API calls can use it. This means the token-bearing page is only served to someone who already knows the token.

---

## File Structure

```
claude-mcp/
├── channel-server/
│   ├── index.ts          # MCP server
│   └── package.json      # { "dependencies": { "@modelcontextprotocol/sdk": "..." } }
├── relay-worker/
│   ├── src/
│   │   ├── index.ts      # Cloudflare Worker
│   │   └── ui.html       # Web frontend
│   ├── wrangler.toml     # Worker config + KV binding
│   └── package.json
├── .mcp.json             # MCP server registration
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-05-25-claude-code-web-chat-design.md
```

---

## Protocol Reference

The `claude/channel` capability and `notifications/claude/channel` / `notifications/claude/channel/permission_request` / `notifications/claude/channel/permission` notification methods are Claude Code extensions to the MCP protocol, documented at https://code.claude.com/docs/en/channels-reference. They require Claude Code v2.1.80+ (permission relay requires v2.1.81+). These are not part of the base MCP spec.

## `--dangerously-load-development-channels` Flag

During Claude Code's research preview, custom channels must be on Anthropic's approved allowlist to load. This flag bypasses the allowlist for a named server entry, allowing local development and testing. It does **not** change Claude Code's security posture beyond allowlist bypass; all other policies (org `channelsEnabled`, tool permissions) still apply. This flag is required until the channel is submitted and approved for the official allowlist. Usage:

```bash
claude --dangerously-load-development-channels server:channel-server
```



## Security

- All API calls require `Authorization: Bearer <token>`. Requests without valid token receive `401`.
- `GET /` requires token as URL query param; unauthenticated requests get a login form, not the token-bearing page.
- Token is a randomly generated secret (32+ chars), never committed to git.
- Worker is public internet facing; token is the only access control. Keep it secret.
- The MCP server only runs locally; it never accepts inbound connections.
- Permission verdicts flow through by `request_id` (issued by Claude Code). Stale or replayed verdicts are silently dropped by Claude Code if no matching open request exists.

---

## Deployment

**Relay Worker:**
```bash
cd relay-worker
npx wrangler kv:namespace create RELAY_KV
# add KV binding id to wrangler.toml
npx wrangler secret put RELAY_TOKEN
npx wrangler deploy
```

**Channel MCP server:**
```bash
cd channel-server
bun install
export RELAY_URL=https://claude-relay.<account>.workers.dev
export RELAY_TOKEN=<same secret>
```

Then start Claude Code normally (see Registration above).

---

## Out of Scope

- File attachments in chat
- Multiple concurrent sessions
- Message persistence / history across sessions (messages are dequeued and gone)
- Claude Code terminal output streaming (only tool call metadata is shown in right panel)
