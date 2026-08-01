import type { AdminModulePort, CodeRunnerPort } from "../ports";
import type {
  AdminApiDescription,
  AdminRunResult,
  CodeRunResult,
  JsonValue,
} from "./types";

// Composes the typed surface from the registered modules, binds each module's
// API into the caller's run (read-only APIs for search, full APIs for
// execute), and normalizes the outcome onto the wire contract. Core never
// inspects the code or the module APIs, so modules with entirely different
// interaction patterns compose without core changes.
export class AdminService {
  private readonly modules = new Map<string, AdminModulePort>();
  private readonly description: AdminApiDescription;

  constructor(
    private readonly runner: CodeRunnerPort,
    modules: AdminModulePort[]
  ) {
    const reserved = new Set(runner.reservedNames);
    const descriptions = modules.map((m) => m.describe());

    for (const [i, { globalName }] of descriptions.entries()) {
      if (reserved.has(globalName)) {
        throw new Error(`Admin module name "${globalName}" is reserved`);
      }
      if (this.modules.has(globalName)) {
        throw new Error(`Duplicate admin module name "${globalName}"`);
      }
      this.modules.set(globalName, modules[i]!);
    }

    // Built once: describe() is not required to be cheap, and the composed
    // document is identical for every caller.
    this.description = {
      language: runner.language,
      modules: descriptions.map(({ globalName, provider }) => ({ globalName, provider })),
      typehead: [
        buildTypeheadHeader(descriptions.map((d) => d.globalName)),
        ...descriptions.map((d) => d.typehead),
      ].join("\n"),
    };
  }

  describe(): AdminApiDescription {
    return this.description;
  }

  async search(code: string): Promise<AdminRunResult> {
    return this.run(code, (m) => m.createReadApi());
  }

  async execute(code: string): Promise<AdminRunResult> {
    return this.run(code, (m) => m.createWriteApi());
  }

  private async run(
    code: string,
    apiOf: (module: AdminModulePort) => object
  ): Promise<AdminRunResult> {
    if (!code.trim()) throw new Error("code must not be empty");
    const bindings: Record<string, object> = {};
    for (const [name, module] of this.modules) {
      bindings[name] = apiOf(module);
    }
    return normalizeResult(await this.runner.run(code, bindings));
  }
}

// The execution-model half of the composed .d.ts — core owns this contract;
// modules own everything below it. Deliberately does not name the MCP tools:
// the operations are core's, the tool names belong to the transport, which
// appends the mapping when it serves this document.
function buildTypeheadHeader(globalNames: string[]): string {
  return `\
/**
 * octo-santa admin API.
 *
 * Your code runs as the body of an async function: use \`await\` freely and
 * \`return\` a value that can be written as JSON — that value, plus anything
 * you logged with console, comes back as the result. Imports and require()
 * do not work; everything you need is already a global variable:
 * ${globalNames.join(", ")} (declared below) and console.
 *
 * There are two ways to run code. A read-only run binds each module's reading
 * methods only — the writing methods are not there at all. A read/write run
 * binds everything, including the methods that change data. Each module lists
 * both sets below.
 */
`;
}

function normalizeResult(outcome: CodeRunResult): AdminRunResult {
  const result = outcome.result === undefined ? null : outcome.result;
  try {
    // Round-trip so the wire result is exactly what JSON can carry — catches
    // cycles, bigints, and functions here with a clear message instead of
    // deep inside the transport.
    return { result: JSON.parse(JSON.stringify(result)) as JsonValue, logs: outcome.logs };
  } catch (error) {
    throw new Error(
      `code returned a value that cannot be written as JSON: ${error instanceof Error ? error.message : error}`
    );
  }
}
