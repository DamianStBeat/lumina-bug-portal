// An empty string in the env file counts as unset: a blank key would only break the widget silently.
export const API_BASE: string = import.meta.env.VITE_API_BASE || '/api/v1'

// Cloudflare's documented always-pass test site key, so dev and previews work without a real account.
export const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY || '1x00000000000000000000AA'
