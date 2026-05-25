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
