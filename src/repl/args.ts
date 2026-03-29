// src/repl/args.ts

export interface Args {
  mode: "repl" | "send";
  agentId: string;
  channel: string;
  filePath?: string;
}

export function parseArgs(argv: string[]): Args {
  const raw = argv.slice(2);
  let mode: "repl" | "send" = "repl";
  let agentId = "";
  let channel = "";
  let filePath: string | undefined;

  let i = 0;
  if (raw[0] === "send") {
    mode = "send";
    i = 1;
  }

  for (; i < raw.length; i++) {
    switch (raw[i]) {
      case "--as":
        agentId = raw[++i] ?? "";
        break;
      case "-c":
        channel = raw[++i] ?? "";
        break;
      case "-f":
        filePath = raw[++i] ?? "";
        break;
    }
  }

  if (!agentId) throw new Error("--as <name> is required");
  if (!/^[\w-]+$/.test(agentId))
    throw new Error("--as name must match [\\w-]+ (letters, digits, underscores, hyphens)");
  if (agentId === "all" || agentId === "here")
    throw new Error(`"${agentId}" is a reserved name`);
  if (!channel) throw new Error("-c <channel> is required");

  return { mode, agentId, channel, ...(filePath ? { filePath } : {}) };
}
