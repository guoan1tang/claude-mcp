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
