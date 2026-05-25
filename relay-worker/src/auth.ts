export function checkBearer(headers: Headers, token: string): boolean {
  return headers.get('Authorization') === `Bearer ${token}`
}

export function checkQueryToken(url: URL, token: string): boolean {
  return url.searchParams.get('token') === token
}
