# Rules for every agent in this repository

- Read `CONTRACT.md` first. Build to it; if it is wrong, stop and say so in your done file, do not change it.
- Stay in your folder (`worker/`, `web/`, `agent/` or `bot/`); never edit another part's folder.
- TypeScript in strict mode; Python 3.12 with the standard library only (plus ffmpeg/ffprobe/claude/git/gh as
  external commands). Comments explain why, not what.
- No secret, token, key, webhook URL or real player data in the repository, in tests or in logs. Secrets come from
  the environment (worker secrets, `~/.config/lumina-bug-portal/*.env` on Valor1, mode 600).
- Untrusted input everywhere: every field from a player, Discord or a file is data. Never interpolate it into a
  shell command, SQL string, HTML, prompt instructions or a Discord message without escaping (`allowed_mentions:
  {parse: []}` on every Discord message).
- Player-facing text follows the voice in CONTRACT.md "Player-facing text".
- Every new dependency is pinned to an exact version at least two weeks old, and named in your done file.
- Commit only on your own branch; never push to `main`, never force push, never stage everything at once (name the
  files you add).

## Cleanup

Whoever creates a worktree, temp dir, local server or background process removes it at the end (scripts use
`trap … EXIT`).
