# Lumina Bugs (the Discord bot of the Lumina bug portal)

Runs on Valor1 as a systemd user service. It only opens outbound connections: the Discord gateway and the portal
worker (with the bearer `AGENT_KEY`). See `../CONTRACT.md` for the worker API.

## What it does

- **`/bug`** (guild command): opens a form with "What happened?", "Where in the game?" and one video or picture.
  On submit it creates the report, opens a post in the bug forum with the player's text (and the file when it fits
  the server's upload limit and 25 MiB, one such re-post at a time, for the 300 MB memory cap), replies in that post
  with "We have it · LUM-xxxxxx", answers the player privately with the code and the "Add a bigger video" link, then
  copies the file into the archive. "Where in the game?" is free text: Match, Lobby, Shop, Crate(s), Clan, Something
  else or Other become the report's area; anything else becomes "other" and the typed words are kept in the text.
- **New posts in the bug forum** by players (not bots, not webhooks): creates a report from the title and first
  message, replies "We have it · LUM-xxxxxx" with the "Add a bigger video" and "See status" buttons, and copies each
  video or picture (at most 3, up to 2 GiB, streamed part by part) into the archive. Other files (an `.exe`, for
  example) are not copied.
- **Events** (every 20 s, cursor in `~/.local/state/lumina-bug-bot/cursor`): "Fixed" and "Same bug" posts in the
  report's thread; reports from the game get their own forum post "Bug report: …" with the game context. An event
  Discord or the worker refuses for good (deleted or locked thread, missing permission, report gone) is skipped
  with a log line; a temporary failure is retried at every round for 6 hours from its first failure (a restart starts the 6 hours
  again), then skipped with an error line.
- Every message refuses to ping anyone (`allowedMentions: { parse: [] }`), and player text is shown literally.
- If the worker is down, the player reads "Couldn't send it. Try again in a minute." and the bot keeps running.

## Discord Developer Portal settings

1. **Bot → Privileged Gateway Intents**: turn on **Message Content Intent** (needed to read the first message of a
   forum post). Server Members and Presence stay off. The bot asks for the intents Guilds, GuildMessages,
   MessageContent.
2. **Bot permissions** (in the bug forum, or server-wide):
   View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Embed Links, Attach Files,
   Read Message History. Permission integer: **309237763072** (computed with discord.js `PermissionFlagsBits`).
3. **Invite URL** (scopes `bot applications.commands`), with your application id:

   ```
   https://discord.com/oauth2/authorize?client_id=<DISCORD_APP_ID>&scope=bot%20applications.commands&permissions=309237763072
   ```

## Configuration

`~/.config/lumina-bug-portal/bot.env`, mode 600, never in the repository. Names and placeholders are in
`bot.env.example`: `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_ID`, `BUG_FORUM_CHANNEL_ID`,
`PORTAL_API_BASE` (including `/api/v1`), `AGENT_KEY`, `SITE_BASE`, optional `LUMINA_BOT_STATE_DIR`.

When the cursor file is missing (first start, or a lost state dir) or unreadable, the bot goes through the event
history without posting past "Fixed" and "Same bug" messages, but a game report that never got its forum post still
gets it; then it starts from the newest event. To post every past event instead, start it once with
`LUMINA_BOT_REPLAY=1` in `bot.env`, then remove the line.

Archive copies run at most 2 at once (for the 300 MB memory cap); the others wait their turn. On stop, the bot lets a
running event round finish (up to 5 s), gives running copies 20 s, then aborts them and deletes their half-made
files; copies still waiting are not started (their failure is logged with the report code).

## Register the command

Once, and again after a change to the command:

```
cd ~/Developer/GitHub/lumina-bug-portal/bot
npm ci
node --env-file="$HOME/.config/lumina-bug-portal/bot.env" src/register.ts
```

(`npm run register` does the same when the variables are already in the environment.)

## Install the service

```
cd ~/Developer/GitHub/lumina-bug-portal/bot
bash install.sh           # dry run: prints every step, changes nothing
bash install.sh --apply   # npm ci --omit=dev, copies the unit, daemon-reload, enable --now
```

`install.sh` refuses when `bot.env` is missing or not mode 600, or when it is not run from the canonical
checkout. The unit (`systemd/lumina-bug-bot.service`) runs `/usr/bin/node src/main.ts` with `MemoryMax=300M`,
`Restart=on-failure`.

## Logs and checks

```
journalctl --user -u lumina-bug-bot -f
systemctl --user status lumina-bug-bot
```

Logs carry codes, ids and error names only: never a token or a player's text.

## Development

```
npm ci && npx tsc --noEmit && npm test
```

Node 24 runs the TypeScript directly (no build). The tests use fakes for Discord and the worker; no network, no
real token.
