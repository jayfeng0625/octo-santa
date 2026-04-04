// src/repl/index.ts
import { openDb } from "../bootstrap";
import { startApp } from "./app";
import { startupRepl } from "./startup";

function parseArgs(argv: string[]): { agentId: string; channel: string } {
  let agentId = "";
  let channel = "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--as" && i + 1 < argv.length) {
      agentId = argv[i + 1]!;
      i++;
    } else if (argv[i] === "-c" && i + 1 < argv.length) {
      channel = argv[i + 1]!;
      i++;
    }
  }

  if (!agentId) {
    console.error("Usage: bun run src/repl/index.ts --as <name> -c <channel>");
    process.exit(1);
  }
  if (!channel) {
    console.error("Usage: bun run src/repl/index.ts --as <name> -c <channel>");
    process.exit(1);
  }

  return { agentId, channel };
}

const { agentId, channel } = parseArgs(process.argv.slice(2));
const db = openDb();

// REPL startup: register → create channel → subscribe
startupRepl(db, agentId, channel);

const pollIntervalMs = Number(process.env.OCTO_SANTA_POLL_INTERVAL_MS) || 1000;

// Detect Kitty protocol support — check TERM_PROGRAM or just enable and let fallback handle it
const kittyTerminals = new Set(["ghostty", "WezTerm", "iTerm2", "kitty"]);
const termProgram = process.env.TERM_PROGRAM ?? "";
const kittyEnabled = kittyTerminals.has(termProgram) || process.env.OCTO_SANTA_KITTY === "1";

startApp({ db, agentId, channel, pollIntervalMs, kittyEnabled });
