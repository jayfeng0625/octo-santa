import type { Database } from "bun:sqlite";
import { SqliteAgentRepo } from "./agent-repo";
import { SqliteChannelRepo } from "./channel-repo";
import { SqliteMessageRepo } from "./message-repo";

export function createSqliteRepos(db: Database) {
  return {
    agents: new SqliteAgentRepo(db),
    channels: new SqliteChannelRepo(db),
    messages: new SqliteMessageRepo(db),
  };
}
