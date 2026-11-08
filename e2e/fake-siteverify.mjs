// A stand-in for Cloudflare's siteverify, on localhost: the worker reaches it through TURNSTILE_VERIFY_URL (dev only,
// CONTRACT.md "Worker bindings"). It answers success only for the token the fake widget hands out and the documented
// always-pass test secret, so a request that bypassed the form, or a worker that sent the wrong secret, is refused.
// GET /hits tells the harness how often it was asked: a run in which it was never asked proves nothing.
import { createServer } from 'node:http'

const port = Number(process.argv[2])
const SECRET = '1x0000000000000000000000000000000AA'
const TOKEN = /^e2e-turnstile-token-/
let hits = 0
let refused = 0

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/hits') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ hits, refused }))
    return
  }
  if (req.method !== 'POST' || req.url !== '/siteverify') {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const form = new URLSearchParams(body)
    const ok = form.get('secret') === SECRET && TOKEN.test(form.get('response') ?? '')
    hits++
    if (!ok) refused++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: ok }))
  })
}).listen(port, '127.0.0.1')
