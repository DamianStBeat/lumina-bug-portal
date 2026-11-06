The player site (report a bug, add a video, see a report's status) and the team desk, a Vite + React app for Cloudflare Pages built to `../CONTRACT.md`.
Install: `npm ci`
Run locally: `npm run dev`
`VITE_API_BASE`: where the worker API lives, default `/api/v1`.
`VITE_TURNSTILE_SITE_KEY`: the Turnstile site key. `npm run dev` falls back to Cloudflare's always-pass test key `1x00000000000000000000AA`; a production build without it has no key, and the pages show "The safety check did not load" instead of the widget, so set it before deploying.
