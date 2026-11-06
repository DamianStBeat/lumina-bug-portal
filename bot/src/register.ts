// Registers /bug as a guild command (instant, unlike global commands). Run by hand after a change to the command:
// `npm run register` with bot.env loaded (see README.md). Never run by the tests.
import { REST, Routes } from 'discord.js';
import { bugCommandData } from './bugCommand.ts';
import { ConfigError, loadConfig } from './config.ts';

try {
  const config = loadConfig(process.env);
  const rest = new REST().setToken(config.discordToken);
  // PUT replaces this app's guild commands with exactly this list.
  await rest.put(Routes.applicationGuildCommands(config.appId, config.guildId), { body: [bugCommandData()] });
  console.log(`registered /bug in guild ${config.guildId}`);
} catch (err) {
  const reason = err instanceof ConfigError ? err.message : err instanceof Error ? err.name : 'unknown';
  console.error(`registration failed: ${reason}`);
  process.exitCode = 1;
}
