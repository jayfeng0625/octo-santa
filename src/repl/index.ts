// src/repl/index.ts

import { openDb } from "../bootstrap";
import { parseArgs } from "./args";
import { runSendMode } from "./send";

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb();

  if (args.mode === "send") {
    const msg = runSendMode(db, args.agentId, args.channel, args.filePath);
    console.log(msg.id);
    process.exit(0);
  }

  // Interactive mode — temporary: delegate to legacy startRepl until Ink app lands
  const { startRepl } = await import("../repl-legacy");
  startRepl(db, args.agentId, args.channel);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
