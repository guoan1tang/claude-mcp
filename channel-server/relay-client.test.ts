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
