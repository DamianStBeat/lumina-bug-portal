# lumina-bug-agent

The program on Valor1 that reads new Lumina bug reports from the worker (outbound only, bearer `AGENT_KEY`), turns
their videos into contact sheets of frames (audio is never extracted), asks Claude for a structured summary
(stage A, no tools), a read-only triage of the Lumina2 code (stage B) and, for the simple and safe ones, a draft fix
PR (stage C, never merged, never published). The contract is `../CONTRACT.md`. Python 3.12, standard library only;
ffmpeg, ffprobe, claude, git and gh are external commands.

## Configuration

Copy `agent.env.example` to `~/.config/lumina-bug-portal/agent.env` and `chmod 600` it. The process environment
overrides the file. Missing `PORTAL_API_BASE`, `AGENT_KEY` or `LUMINA2_REPO`, or a bad number, exits 2.

`FRAME_FONT` is the font file of the time stamps drawn on the video sheets (default
`/usr/share/fonts/truetype/freefont/FreeSans.ttf`). When the file is missing the agent logs it and asks fontconfig for
`Sans`; if ffmpeg cannot draw with either, the video is `ffmpeg_failed` (never a sheet without times). The path goes
into an ffmpeg filter unescaped, so it must not contain `:`, `,`, `'` or `\`.

## One round

```sh
cd agent
python3 -m lumina_bug_agent run-once                       # default env file
python3 -m lumina_bug_agent --env-file ./my.env run-once   # another file
```

A round takes the lock `STATE_DIR/agent.lock` (a second round exits 0 at once), reads the queue, and per report:
claim, download into a private temp dir, file checks, frames, stage A, stage B, triage, stage C. A worker that does
not answer is logged as `worker unreachable` and the round exits 0; the next round retries. Logs go to stderr, one
line per event, with codes, ids and reasons only (never the key or the player's text).

## Dry run

`DRY_RUN=1` is the default. A dry round makes GET requests only (queue, report, downloads), checks the files and makes
the sheets in the temp dir, then deletes them; it starts no claude, git worktree, gh or red team process and logs
`dry run: would ...` lines. Each code is dry-run once (remembered in `STATE_DIR/cache.sqlite3`). Set `DRY_RUN=0` only
when the worker and the red team are ready.

## Tests

`python3 -m unittest discover tests` from this folder: a fake worker, fake claude/gh/red team, a real tiny mp4.
