export interface KVAdapter {
  put(key: string, value: string): Promise<void>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
  list(opts: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>
}

// Single key per queue to avoid kv.list() — free tier allows 1,000 list/day but 100,000 reads/day
export async function enqueue(kv: KVAdapter, prefix: string, item: unknown): Promise<void> {
  const raw = await kv.get(`queue:${prefix}`)
  const items: unknown[] = raw ? JSON.parse(raw) : []
  items.push(item)
  await kv.put(`queue:${prefix}`, JSON.stringify(items))
}

export async function dequeue<T>(kv: KVAdapter, prefix: string): Promise<T[]> {
  const raw = await kv.get(`queue:${prefix}`)
  if (!raw) return []
  const items = JSON.parse(raw) as T[]
  if (items.length === 0) return []
  await kv.put(`queue:${prefix}`, '[]')
  return items
}
