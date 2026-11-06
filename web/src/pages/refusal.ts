import { ApiError } from '../api/client'

// Decided B4: the line a refused Send or Add to report shows. Only the server's two named refusals get their own line;
// the network, a 5xx and anything else are the Wi-Fi line, which is what the player can act on.
export type SendLine = 'errRate' | 'errCheck' | 'errCode' | 'errSend'

// `typedCode`: the request named a report code the player typed (attach-session), so its 404 means "wrong code".
export function sendLine(e: unknown, typedCode: boolean): SendLine {
  if (!(e instanceof ApiError)) return 'errSend'
  if (e.status === 429 && e.code === 'rate_limited') return 'errRate'
  if (e.code === 'turnstile_failed') return 'errCheck'
  if (typedCode && e.status === 404 && e.code === 'not_found') return 'errCode'
  return 'errSend'
}
