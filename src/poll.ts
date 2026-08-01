// Unread check for programmatic polling — e.g. Claude Code's Monitor tool or a
// shell loop. Read-only: never advances cursors and never registers, so the
// agent's MCP session still sees everything via messaging_read_messages.
//
// One-shot by default; --interval <secs> keeps checking until unread messages
// appear, --timeout <secs> bounds that wait.
// Exit codes: 0 = unread messages exist, 1 = none, 2 = usage error.
import { createDb, resolveDbPath } from "./storage/sqlite/db";
import { runMigrations, allMigrations } from "./storage/sqlite/migrations";
import { SqliteNotificationQueryRepo } from "./storage/sqlite/notification-query-repo";
import type { MessageWithChannel } from "./core/messaging/types";

interface PollArgs {
  agentId: string;
  channel?: string;
  limit: number;
  intervalSecs?: number;
  timeoutSecs?: number;
}

function usage(): never {
  console.error(
    "Usage: bun run src/poll.ts --as <agent-id> [--channel <name>] [--limit <n>] [--interval <secs> [--timeout <secs>]]"
  );
  process.exit(2);
}

function parseArgs(argv: string[]): PollArgs {
  let agentId = "";
  let channel: string | undefined;
  let limit = 100;
  let intervalSecs: number | undefined;
  let timeoutSecs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--as" && i + 1 < argv.length) agentId = argv[++i]!;
    else if (argv[i] === "--channel" && i + 1 < argv.length) channel = argv[++i]!;
    else if (argv[i] === "--limit" && i + 1 < argv.length) limit = Number(argv[++i]) || 100;
    else if (argv[i] === "--interval" && i + 1 < argv.length) intervalSecs = Number(argv[++i]);
    else if (argv[i] === "--timeout" && i + 1 < argv.length) timeoutSecs = Number(argv[++i]);
  }
  if (!agentId) usage();
  if (intervalSecs !== undefined && !(intervalSecs > 0)) usage();
  if (timeoutSecs !== undefined && (intervalSecs === undefined || !(timeoutSecs > 0))) usage();
  return { agentId, channel, limit, intervalSecs, timeoutSecs };
}

function report(agentId: string, unread: MessageWithChannel[]): never {
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
}

async function main(): Promise<void> {
  const { agentId, channel, limit, intervalSecs, timeoutSecs } = parseArgs(
    process.argv.slice(2)
  );
  const db = createDb(resolveDbPath());
  runMigrations(db, allMigrations);
  const queries = new SqliteNotificationQueryRepo(db);

  const deadline =
    timeoutSecs !== undefined ? Date.now() + timeoutSecs * 1000 : null;

  while (true) {
    const unread = queries.getUnreadForAgent(agentId, channel, limit);
    if (unread.length > 0 || intervalSecs === undefined) report(agentId, unread);
    if (deadline !== null && Date.now() >= deadline) report(agentId, unread);
    await Bun.sleep(intervalSecs * 1000);
  }
}

main();
