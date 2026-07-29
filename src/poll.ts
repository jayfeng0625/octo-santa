// One-shot unread check for programmatic polling — e.g. Claude Code's Monitor
// tool or a shell loop. Read-only: never advances cursors and never registers,
// so the agent's MCP session still sees everything via messaging_read_messages.
//
// Exit codes: 0 = unread messages exist, 1 = none, 2 = usage error.
import { homedir } from "node:os";
import { join } from "node:path";
import { createDb } from "./storage/sqlite/db";
import { runMigrations, allMigrations } from "./storage/sqlite/migrations";
import { SqliteNotificationQueryRepo } from "./storage/sqlite/notification-query-repo";
import type { MessageWithChannel } from "./core/messaging/types";

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function parseArgs(argv: string[]): { agentId: string; channel?: string; limit: number } {
  let agentId = "";
  let channel: string | undefined;
  let limit = 100;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--as" && i + 1 < argv.length) agentId = argv[++i]!;
    else if (argv[i] === "--channel" && i + 1 < argv.length) channel = argv[++i]!;
    else if (argv[i] === "--limit" && i + 1 < argv.length) limit = Number(argv[++i]) || 100;
  }
  if (!agentId) {
    console.error("Usage: bun run src/poll.ts --as <agent-id> [--channel <name>] [--limit <n>]");
    process.exit(2);
  }
  return { agentId, channel, limit };
}

const { agentId, channel, limit } = parseArgs(process.argv.slice(2));
const dbPath = expandHome(
  process.env.OCTO_SANTA_DB ?? join(homedir(), ".octo-santa", "messages.db")
);
const db = createDb(dbPath);
runMigrations(db, allMigrations);

const unread = new SqliteNotificationQueryRepo(db).getUnreadForAgent(agentId, channel, limit);

const byChannel = new Map<string, MessageWithChannel[]>();
for (const msg of unread) {
  const bucket = byChannel.get(msg.channel_name);
  if (bucket) bucket.push(msg);
  else byChannel.set(msg.channel_name, [msg]);
}

const channels = [...byChannel.entries()].map(([name, messages]) => ({
  channel: name,
  count: messages.length,
  messages: messages.map((m) => ({
    id: m.id,
    from: m.agent_id,
    content: m.content,
    created_at: m.created_at,
  })),
}));

console.log(JSON.stringify({ agent: agentId, unread: channels }));
process.exit(unread.length > 0 ? 0 : 1);
