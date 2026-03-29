// src/repl/index.ts

import React from "react";
import { render } from "ink";
import { openDb } from "../bootstrap";
import { parseArgs } from "./args";
import { runSendMode } from "./send";
import { App } from "./app";

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb();

  if (args.mode === "send") {
    const msg = runSendMode(db, args.agentId, args.channel, args.filePath);
    console.log(msg.id);
    process.exit(0);
  }

  // Interactive mode
  const pollIntervalMs = Number(process.env.OCTO_SANTA_POLL_INTERVAL_MS) || undefined;
  const { waitUntilExit } = render(
    React.createElement(App, {
      db,
      agentId: args.agentId,
      initialChannel: args.channel,
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
    })
  );
  await waitUntilExit();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
