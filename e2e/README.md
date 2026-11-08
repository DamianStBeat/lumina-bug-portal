# End-to-end checks of the bug portal

**Valor1 only.** The script uses the fixed paths of this server (the `_inbox/bp-integration` tree, `~/.cache/ms-playwright`)
and fixed localhost ports. It is not a CI job.

```
e2e/run.sh                 # rows 1, 2, 8, 9, 10
e2e/run.sh --rows 1,2,8    # a subset
```

Needs: `npm ci` in `worker/` and `web/`, Node 24, the Chromium that `web`'s pinned `playwright-core` 1.64.1 uses.

## What runs

- **Worker**: real `wrangler dev`, local mode, D1 and R2 under the run's temp folder, migrations applied first. `ENVIRONMENT=dev`, `DESK_DEV_BYPASS=1`,
  `ALLOWED_ORIGINS=<the preview origin>`, `TURNSTILE_VERIFY_URL=<fake siteverify>` passed by `--var`, secrets from an env
  file inside the run's temp folder (dummy values, Cloudflare's documented always-pass Turnstile test secret). `worker/.dev.vars` is never written.
- **Site**: real `vite build`, served by `vite preview`, `VITE_API_BASE` pointing straight at the worker, `VITE_TURNSTILE_SITE_KEY` = Cloudflare's documented always-pass test site key.
- **Browser**: headless Chromium, at most 2 tabs open at once.

Only the outside is fake:
- Turnstile's script is answered by Playwright with `e2e/fake-turnstile.js`.
- siteverify is `e2e/fake-siteverify.mjs` on localhost, reached through the dev-only `TURNSTILE_VERIFY_URL`.
- Every other browser request outside localhost is aborted and counted; the run fails if any was tried.
- A sampler also lists sockets the run's processes open to anything but localhost, once a second (a net, not a proof).

One thing is not the real path: the worker's desk routes have no CORS (`worker/src/index.ts`: same-site in production), and the preview has no same-site route to the worker.
The harness adds only the CORS headers to the desk answers (`deskSameSite` in `harness.mjs`); the worker's answers are unchanged.

## Rows

| Row | How it is proven |
|---|---|
| 1 | 390x844, 300 MB random file through the form, the bar seen moving, "We have it" and a `LUM-` code, the object downloaded through `GET /agent/attachments/{id}/download` with the same sha256 |
| 2 | A 160 MB file (10 parts): four parts pass, the next three PUTs are held, reload, re-pick: only parts 5 to 10 are sent, no new report or attachment, the object's sha256 matches |
| 8 | Reports moved through the desk API, one per status, plus two duplicates: `/status/<code>` shows the contract's public status and the desk's row agrees; an unknown code shows the error line, no state |
| 9 | Every tab seeded through the real APIs: tab labels `Label · N`, the row line `Video 300 MB · Phone`, the Fix ready tab lists just its report; screenshot to the logs |
| 10 | A saved attachment, the same file re-picked, its fingerprint held in the page, Remove pressed: no DELETE until the reload, exactly one after it, the attachment leaves `uploading`, nothing resumed. A first pick removed while hashing creates nothing |

Row 9 runs first in a run, so its tabs count only what it seeded; the database of a run starts empty.

## Output

One line per row, `row N PASS|FAIL <reason>`, a summary, the browser's outside-request count, the fake siteverify's hit count,
peak RSS of each kind of process (`/proc/<pid>/status` VmHWM, sampled once a second), and any outside socket seen. Exit 0 only if every asked row passed and nothing tried to leave localhost.

Logs (wrangler, vite, siteverify, the row lines, row 9's screenshot, one `rowN-error.txt` per failed row, the RSS table) are copied to
`~/Developer/GitHub/_inbox/bp-integration/e2e-logs/<run>/` before the temp folder is removed.

## Cleanup

`run.sh` removes the temp folder and every process of the run on exit, signals included: the servers by their process group, and anything left (Chromium is started detached) by the `E2E_RUN=<run>` mark in its environment, never by name. Nothing is left behind on a port.
