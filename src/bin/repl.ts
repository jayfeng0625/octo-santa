// src/bin/repl.ts
import { createDb } from "../storage/sqlite/db";
import { runMigrations, allMigrations } from "../storage/sqlite/migrations";
import { createSqliteRepos } from "../storage/sqlite";
import { MessagingService } from "../core/messaging/service";
import { startApp } from "../transports/repl/app";
import { startupRepl } from "../transports/repl/startup";
import { YamlProfileStore } from "../storage/yaml-profiles/store";
import { homedir } from "node:os";
import { join } from "node:path";

function parseArgs(argv: string[]): { agentId: string; channel: string } {
  let agentId = "";
  let channel = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--as" && i + 1 < argv.length) { agentId = argv[i + 1]!; i++; }
    else if (argv[i] === "-c" && i + 1 < argv.length) { channel = argv[i + 1]!; i++; }
  }
  if (!agentId || !channel) {
    console.error("Usage: bun run src/bin/repl.ts --as <name> -c <channel>");
    process.exit(1);
  }
  return { agentId, channel };
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

const { agentId, channel } = parseArgs(process.argv.slice(2));
const dbPath = expandHome(process.env.OCTO_SANTA_DB ?? join(homedir(), ".octo-santa", "messages.db"));
const db = createDb(dbPath);
runMigrations(db, allMigrations);
const repos = createSqliteRepos(db);
const profilesDir = expandHome(process.env.OCTO_SANTA_PROFILES_DIR ?? "~/.octo-santa/profiles");
const profiles = new YamlProfileStore(profilesDir);
const svc = new MessagingService(repos.agents, repos.channels, repos.messages, repos.cursors, process.pid, undefined, profiles);

const resolvedName = startupRepl(svc, agentId, channel);

const pollIntervalMs = Number(process.env.OCTO_SANTA_POLL_INTERVAL_MS) || 1000;
const kittyTerminals = new Set(["ghostty", "WezTerm", "iTerm2", "kitty"]);
const termProgram = process.env.TERM_PROGRAM ?? "";
const kittyEnabled = kittyTerminals.has(termProgram) || process.env.OCTO_SANTA_KITTY === "1";

startApp({ svc, channelRepo: repos.channels, agentId: resolvedName, channel, pollIntervalMs, kittyEnabled });
