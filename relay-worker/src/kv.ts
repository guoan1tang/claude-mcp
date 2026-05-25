export interface KVAdapter {
  put(key: string, value: string): Promise<void>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
  list(opts: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>
}

export async function enqueue(kv: KVAdapter, prefix: string, item: unknown): Promise<void> {
  await kv.put(`${prefix}:${crypto.randomUUID()}`, JSON.stringify(item))
}

export async function dequeue<T>(kv: KVAdapter, prefix: string): Promise<T[]> {
  const { keys } = await kv.list({ prefix: `${prefix}:` })
  if (keys.length === 0) return []
  const items = await Promise.all(
    keys.map(async ({ name }) => {
      const raw = await kv.get(name)
      await kv.delete(name)
      return raw ? JSON.parse(raw) as T : null
    })
  )
  return items.filter((item): item is T => item !== null)
}
