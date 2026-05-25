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

const ReplyInput = z.object({ text: z.string() })

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const parsed = ReplyInput.safeParse(req.params.arguments)
    if (!parsed.success) throw new Error('reply tool: missing required field "text"')
    await relay.postReply({ id: crypto.randomUUID(), text: parsed.data.text, ts: Date.now() })
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`Unknown tool: ${req.params.name}`)
})

await mcp.connect(new StdioServerTransport())

mcp.fallbackNotificationHandler = async (notification) => {
  console.error('[channel-server] notification:', JSON.stringify(notification))
  if (notification.method === 'notifications/claude/channel/permission_request') {
    const p = notification.params as Record<string, unknown>
    const request_id = (p.request_id ?? p.requestId) as string
    const tool_name = (p.tool_name ?? p.toolName) as string
    const description = (p.description ?? '') as string
    const input_preview = (p.input_preview ?? p.inputPreview ?? '') as string
    await relay.postPermission({ request_id, tool_name, description, input_preview })
  }
}

async function tick() {
  try {
    const [messages, verdicts] = await Promise.all([
      relay.pollMessages(),
      relay.pollVerdicts(),
    ])
    console.error('[channel-server] tick: messages=%d verdicts=%d', messages.length, verdicts.length)
    for (const msg of messages) {
      console.error('[channel-server] injecting message:', msg.text)
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

async function scheduleTick() {
  await tick()
  setTimeout(scheduleTick, 5000)
}
scheduleTick()
