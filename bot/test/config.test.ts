// design.md "config.ts": the bot reads its settings from the environment (bot.env); a missing variable is named,
// never its value, so a token can never end up in journald through an error message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ConfigError, loadConfig } from '../src/config.ts';

const FULL = {
  DISCORD_TOKEN: 'test-discord-token-not-real',
  DISCORD_APP_ID: '900000000000000001',
  DISCORD_GUILD_ID: '111111111111111111',
  BUG_FORUM_CHANNEL_ID: '222222222222222222',
  PORTAL_API_BASE: 'https://api.example.test/api/v1/',
  AGENT_KEY: 'test-agent-key-not-real',
  SITE_BASE: 'https://bugs.example.test/',
  LUMINA_BOT_STATE_DIR: '/tmp/lumina-bot-state-test',
  HOME: '/home/someone',
};

test('design: loadConfig maps every variable and strips trailing slashes', () => {
  const c = loadConfig(FULL);
  assert.equal(c.discordToken, FULL.DISCORD_TOKEN);
  assert.equal(c.appId, FULL.DISCORD_APP_ID);
  assert.equal(c.guildId, FULL.DISCORD_GUILD_ID);
  assert.equal(c.forumChannelId, FULL.BUG_FORUM_CHANNEL_ID);
  assert.equal(c.apiBase, 'https://api.example.test/api/v1');
  assert.equal(c.agentKey, FULL.AGENT_KEY);
  assert.equal(c.siteBase, 'https://bugs.example.test');
  assert.equal(c.stateDir, '/tmp/lumina-bot-state-test');
});

test('design: guild, forum and state dir fall back to their defaults when absent', () => {
  const env: Record<string, string | undefined> = { ...FULL };
  delete env['DISCORD_GUILD_ID'];
  delete env['BUG_FORUM_CHANNEL_ID'];
  delete env['LUMINA_BOT_STATE_DIR'];
  const c = loadConfig(env);
  assert.equal(c.guildId, '1440485385112125563');
  assert.equal(c.forumChannelId, '1561007238103961620');
  assert.equal(c.stateDir, path.join('/home/someone', '.local', 'state', 'lumina-bug-bot'));
});

for (const name of ['DISCORD_TOKEN', 'DISCORD_APP_ID', 'PORTAL_API_BASE', 'AGENT_KEY', 'SITE_BASE'] as const) {
  test(`design: missing ${name} throws ConfigError naming the variable, not leaking values`, () => {
    const env: Record<string, string | undefined> = { ...FULL };
    delete env[name];
    assert.throws(
      () => loadConfig(env),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, 'a ConfigError');
        const message = (err as Error).message;
        assert.match(message, new RegExp(name));
        assert.ok(!message.includes(FULL.DISCORD_TOKEN), 'no token in the message');
        assert.ok(!message.includes(FULL.AGENT_KEY), 'no agent key in the message');
        return true;
      },
    );
  });
}

test('design: an empty string counts as missing (not yet set is not a value)', () => {
  assert.throws(() => loadConfig({ ...FULL, AGENT_KEY: '' }), ConfigError);
});
