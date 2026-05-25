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
