// @ts-ignore — wrangler injects this as a text module
import UI_HTML from './ui.html'
import { enqueue, dequeue } from './kv'
import { checkBearer, checkQueryToken } from './auth'

export interface Env {
  KV: KVNamespace
  RELAY_TOKEN: string
}

const LOGIN_FORM = `<!DOCTYPE html>
<html><head><title>Claude Relay</title><style>
  body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
       min-height:100vh;margin:0;background:#0f1117;color:#e0e0e0}
  form{display:flex;flex-direction:column;gap:12px;width:300px}
  h2{margin:0}
  input{padding:10px;border-radius:6px;border:1px solid #333;background:#1a1a2e;color:#e0e0e0;font-size:14px}
  button{padding:10px;background:#7c3aed;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px}
</style></head><body>
<form onsubmit="go(event)">
  <h2>Claude Relay</h2>
  <input id="t" type="password" placeholder="Enter token" required>
  <button type="submit">Enter</button>
</form>
<script>function go(e){e.preventDefault();const t=document.getElementById('t').value;window.location.href='/?token='+encodeURIComponent(t)}</script>
</body></html>`

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const token = env.RELAY_TOKEN

    // GET / — serve UI (requires ?token= query param auth)
    if (req.method === 'GET' && url.pathname === '/') {
      if (!checkQueryToken(url, token)) {
        return new Response(LOGIN_FORM, { headers: { 'Content-Type': 'text/html' } })
      }
      const html = (UI_HTML as string).replace(
        '</head>',
        `<script>window.RELAY_TOKEN=${JSON.stringify(token)};window.RELAY_URL=''</script></head>`
      )
      return new Response(html, { headers: { 'Content-Type': 'text/html' } })
    }

    // All other routes require Bearer token
    if (!checkBearer(req.headers, token)) {
      return new Response('Unauthorized', { status: 401 })
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const { text } = await req.json() as { text: string }
      if (!text) return new Response('Bad Request', { status: 400 })
      await enqueue(env.KV, 'msg', { id: crypto.randomUUID(), text, ts: Date.now() })
      return new Response('ok')
    }

    if (req.method === 'GET' && url.pathname === '/api/poll') {
      return Response.json(await dequeue(env.KV, 'msg'))
    }

    if (req.method === 'POST' && url.pathname === '/api/reply') {
      await enqueue(env.KV, 'reply', await req.json())
      return new Response('ok')
    }

    if (req.method === 'GET' && url.pathname === '/api/replies') {
      return Response.json(await dequeue(env.KV, 'reply'))
    }

    if (req.method === 'POST' && url.pathname === '/api/permission') {
      await enqueue(env.KV, 'perm', { ...await req.json() as Record<string, unknown>, ts: Date.now() })
      return new Response('ok')
    }

    if (req.method === 'GET' && url.pathname === '/api/permissions') {
      return Response.json(await dequeue(env.KV, 'perm'))
    }

    if (req.method === 'POST' && url.pathname === '/api/verdict') {
      await enqueue(env.KV, 'verdict', { ...await req.json() as Record<string, unknown>, ts: Date.now() })
      return new Response('ok')
    }

    if (req.method === 'GET' && url.pathname === '/api/verdicts') {
      return Response.json(await dequeue(env.KV, 'verdict'))
    }

    return new Response('Not Found', { status: 404 })
  },
}
