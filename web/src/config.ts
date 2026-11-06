// An empty string in the env file counts as unset: a blank key would only break the widget silently.
export const API_BASE: string = import.meta.env.VITE_API_BASE || '/api/v1'

// Cloudflare's documented always-pass test site key in dev only. A production build without the real key gets none:
// the worker would refuse the test key's tokens, so the page says the check did not load instead of failing every Send.
export const TURNSTILE_SITE_KEY: string =
  import.meta.env.VITE_TURNSTILE_SITE_KEY || (import.meta.env.DEV ? '1x00000000000000000000AA' : '')
