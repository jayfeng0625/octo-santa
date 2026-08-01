import type { CodeRunnerPort } from "../../core/ports";
import type { CodeRunResult } from "../../core/admin/types";

// Runs caller-submitted TypeScript as the body of an async function with the
// given globals bound. Bun.Transpiler strips types; imports (static, dynamic,
// and require) are rejected up front so the code can only reach what the
// admin API bound for it.
//
// This is hygiene, not a security sandbox: code still runs in-process, and
// the trust boundary is whoever can launch the admin entrypoint at all — the
// same boundary as file access to the database. The hygiene exists so
// integrations fail loudly when they reach outside their typed surface
// instead of quietly depending on process internals.
const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

// Ambient globals shadowed to undefined inside runs.
const SHADOWED = ["process", "Bun", "require", "module", "exports"] as const;

export class TypeScriptRunner implements CodeRunnerPort {
  readonly language = "typescript";
  readonly reservedNames = ["console", ...SHADOWED];

  private readonly transpiler = new Bun.Transpiler({ loader: "ts" });

  constructor(private readonly timeoutMs: number = 5_000) {}

  async run(
    code: string,
    bindings: Record<string, object>
  ): Promise<CodeRunResult> {
    for (const name of Object.keys(bindings)) {
      if (this.reservedNames.includes(name)) {
        throw new Error(`binding name "${name}" is reserved`);
      }
    }

    const imports = this.transpiler.scanImports(code);
    if (imports.length > 0) {
      throw new Error(
        `imports are not allowed in admin code (found: ${imports
          .map((i) => `${i.kind} "${i.path}"`)
          .join(", ")}). Use the pre-bound module globals instead.`
      );
    }

    // Wrapping before transpiling keeps top-level `return` valid and lets the
    // transpiler see the code in the async context it will run in.
    const js = this.transpiler.transformSync(
      `async function __main__() {\n${code}\n}`
    );

    const logs: string[] = [];
    const capture =
      (level: string) =>
      (...args: unknown[]) =>
        void logs.push(
          `[${level}] ` +
            args
              .map((a) => (typeof a === "string" ? a : safeStringify(a)))
              .join(" ")
        );
    const consoleShim = {
      log: capture("log"),
      info: capture("info"),
      warn: capture("warn"),
      error: capture("error"),
      debug: capture("debug"),
    };

    const names = [...Object.keys(bindings), "console", ...SHADOWED];
    const values = [
      ...Object.values(bindings),
      consoleShim,
      ...SHADOWED.map(() => undefined),
    ];
    const fn = new AsyncFunction(...names, `"use strict";\n${js}\nreturn __main__();`);

    let timer!: ReturnType<typeof setTimeout>;
    // Catches hung awaits; a synchronous busy-loop cannot be preempted
    // in-process and will still block (accepted for this surface).
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`admin code timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs
      );
    });
    try {
      const result = await Promise.race([fn(...values), timeout]);
      return { result, logs };
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
