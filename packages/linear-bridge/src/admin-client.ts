import { fileURLToPath } from "node:url";

// Minimal MCP stdio client for octo-santa's admin server. This package must
// never import octo-santa source — the only coupling is the filesystem path
// used to spawn the server (below) plus env vars. The admin server speaks
// stateless MCP (2026-07-28): newline-delimited JSON-RPC on stdio, no
// initialize handshake required, and responses may arrive out of order, so
// requests are matched back by id.
const DEFAULT_ADMIN_ENTRY = fileURLToPath(
  new URL("../../octo-santa/src/admin.ts", import.meta.url)
);

export interface SearchMatch {
  module: string;
  name: string;
  declaration: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  total: number;
}

export interface ExecuteResult {
  result: unknown;
  logs: string[];
}

export interface AdminClientOptions {
  // Command to spawn the admin server. Defaults to running octo-santa's
  // admin entrypoint with bun.
  cmd?: string[];
  // Extra env for the subprocess (merged over process.env) — set
  // OCTO_SANTA_DB here to pick the shared database.
  env?: Record<string, string | undefined>;
  // Per-request timeout. Admin runs are local SQLite work, so this is a
  // backstop against a wedged subprocess, not a tuning knob.
  timeoutMs?: number;
}

interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: ToolCallResult;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class AdminClient {
  private readonly cmd: string[];
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private proc: Bun.Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(options: AdminClientOptions = {}) {
    this.cmd = options.cmd ?? ["bun", "run", DEFAULT_ADMIN_ENTRY];
    this.env = { ...process.env, ...options.env };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(query: string, limit?: number): Promise<SearchResult> {
    const args: Record<string, unknown> = { query };
    if (limit !== undefined) args.limit = limit;
    return (await this.callTool("admin_search", args)) as SearchResult;
  }

  async execute(code: string): Promise<ExecuteResult> {
    return (await this.callTool("admin_execute", { code })) as ExecuteResult;
  }

  async close(): Promise<void> {
    this.closed = true;
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.kill();
      await proc.exited;
    }
    this.rejectAll(new Error("admin client closed"));
  }

  private callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("admin client closed"));
    const proc = this.ensureProc();
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`admin request ${id} (${name}) timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    try {
      proc.stdin.write(`${request}\n`);
      proc.stdin.flush();
    } catch (error) {
      this.settle(id, undefined, new Error(`failed to write to admin server: ${error}`));
    }
    return promise;
  }

  // Spawns lazily and respawns on the next request after the subprocess dies —
  // in-flight requests are rejected at death (no silent hangs), callers retry.
  private ensureProc(): Bun.Subprocess<"pipe", "pipe", "inherit"> {
    if (this.proc !== null) return this.proc;
    const proc = Bun.spawn({
      cmd: this.cmd,
      env: this.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    this.proc = proc;
    void this.readLoop(proc);
    void proc.exited.then(() => {
      if (this.proc === proc) {
        this.proc = null;
        this.rejectAll(new Error("admin server exited unexpectedly"));
      }
    });
    return proc;
  }

  private async readLoop(proc: Bun.Subprocess<"pipe", "pipe", "inherit">): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch {
      // Stream errors surface via proc.exited rejecting the pending map.
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // Not JSON-RPC — ignore stray output defensively.
    }
    const id = message.id;
    if (typeof id !== "number" || !this.pending.has(id)) return;

    if (message.error) {
      this.settle(id, undefined, new Error(message.error.message ?? "admin request failed"));
      return;
    }
    const result = message.result;
    if (!result) {
      this.settle(id, undefined, new Error("admin response had no result"));
      return;
    }
    if (result.isError) {
      // Tool-level failure (e.g. the submitted code threw): the message is in
      // the text content, structuredContent is absent.
      const text = result.content?.find((c) => typeof c.text === "string")?.text;
      this.settle(id, undefined, new Error(text ?? "admin tool call failed"));
      return;
    }
    this.settle(id, result.structuredContent, undefined);
  }

  private settle(id: number, value: unknown, error: Error | undefined): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(value);
  }

  private rejectAll(error: Error): void {
    for (const [id] of this.pending) this.settle(id, undefined, error);
  }
}
