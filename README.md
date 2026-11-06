# Lumina bug portal

Players of Lumina2 report bugs from three doors (the game, Discord, the web site), with screen recordings up to
2 GB. Every report gets one code (`LUM-482193`). An AI on Valor1 triages each report against the private Lumina2
code and, when the fix is simple and off the risk paths, opens a draft pull request. The design, the API and the
limits are in [CONTRACT.md](CONTRACT.md).

| Folder | What | Runs on |
|---|---|---|
| `worker/` | Cloudflare Worker: API, D1, R2, Turnstile, cron | Cloudflare |
| `web/` | Player site (3 steps, add a video, status) and team desk | Cloudflare Pages |
| `agent/` | Queue poller, frames, AI triage, simple fixes | Valor1 |
| `bot/` | Discord app "Lumina Bugs" | Valor1 |

The in-game part lives in the Lumina2 repository (`DamianStBeat/Lumina2`).
