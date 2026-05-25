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
    // Add a second item and verify two distinct keys:
    await enqueue(kv as any, 'msg', { id: '2', text: 'world', ts: 2000 })
    const { keys: keys2 } = await kv.list({ prefix: 'msg:' })
    expect(keys2).toHaveLength(2)
    expect(new Set(keys2.map(k => k.name)).size).toBe(2)
  })
})

describe('dequeue', () => {
  it('returns all items and clears them', async () => {
    await enqueue(kv as any, 'msg', { id: '1', text: 'a', ts: 1 })
    await enqueue(kv as any, 'msg', { id: '2', text: 'b', ts: 2 })
    const items = await dequeue(kv as any, 'msg')
    expect(items).toHaveLength(2)
    expect(items).toContainEqual({ id: '1', text: 'a', ts: 1 })
    expect(items).toContainEqual({ id: '2', text: 'b', ts: 2 })
    const { keys } = await kv.list({ prefix: 'msg:' })
    expect(keys).toHaveLength(0)
  })

  it('returns empty array when nothing queued', async () => {
    const items = await dequeue(kv as any, 'msg')
    expect(items).toEqual([])
  })
})
