import type { AdminModulePort, CodeRunnerPort } from "../ports";
import type {
  AdminInterfaceDescription,
  AdminRunResult,
  CodeRunOutcome,
} from "./types";

// Names that submitted code already sees for other reasons — modules may not
// claim them as binding names.
const RESERVED_BINDINGS = new Set(["console"]);

// Orchestrates the code-mode admin plane: composes the typed surface from the
// registered modules, binds each module's API into the caller's TypeScript
// run (read-only APIs for search, full APIs for execute), and normalizes the
// outcome onto the wire contract. Core stays agnostic — it never inspects the
// code or the module APIs, so modules with entirely different interaction
// patterns compose without core changes.
export class AdminService {
  constructor(
    private readonly runner: CodeRunnerPort,
    private readonly modules: AdminModulePort[]
  ) {
    const seen = new Set<string>();
    for (const module of modules) {
      const { module: name } = module.describe();
      if (RESERVED_BINDINGS.has(name)) {
        throw new Error(`Admin module name "${name}" is reserved`);
      }
      if (seen.has(name)) {
        throw new Error(`Duplicate admin module name "${name}"`);
      }
      seen.add(name);
    }
  }

  describe(): AdminInterfaceDescription {
    const descriptions = this.modules.map((m) => m.describe());
    return {
      language: "typescript",
      modules: descriptions.map(({ module, provider }) => ({ module, provider })),
      typehead: [
        buildTypeheadHeader(descriptions.map((d) => d.module)),
        ...descriptions.map((d) => d.typehead),
      ].join("\n"),
    };
  }

  async search(code: string): Promise<AdminRunResult> {
    return this.run(code, (m) => m.createSearchApi());
  }

  async execute(code: string): Promise<AdminRunResult> {
    return this.run(code, (m) => m.createExecuteApi());
  }

  private async run(
    code: string,
    apiOf: (module: AdminModulePort) => object
  ): Promise<AdminRunResult> {
    if (!code.trim()) throw new Error("code must not be empty");
    const bindings: Record<string, object> = {};
    for (const module of this.modules) {
      bindings[module.describe().module] = apiOf(module);
    }
    return normalizeOutcome(await this.runner.run(code, bindings));
  }
}

// The execution-model half of the composed .d.ts — core owns this contract;
// modules own everything below it.
function buildTypeheadHeader(moduleNames: string[]): string {
  return `\
/**
 * octo-santa admin interface (composed).
 *
 * Code submitted to the admin_search / admin_execute tools is TypeScript,
 * run as the body of an async function: use \`await\` freely and \`return\` a
 * JSON-serializable value — that value, plus captured console output, is the
 * tool result. Imports and require() are rejected; everything you need is
 * pre-bound as globals: ${moduleNames.join(", ")} (declared below) and console.
 *
 * admin_search binds each module's read-only API — nothing reachable from it
 * mutates state. admin_execute binds the full API, including each module's
 * controlled write methods. Each module declares both surfaces below.
 */
`;
}

function normalizeOutcome(outcome: CodeRunOutcome): AdminRunResult {
  const result = outcome.result === undefined ? null : outcome.result;
  try {
    // Round-trip so the wire result is exactly what JSON can carry — catches
    // cycles, bigints, and functions here with a clear message instead of
    // deep inside the transport.
    return { result: JSON.parse(JSON.stringify(result)), logs: outcome.logs };
  } catch (error) {
    throw new Error(
      `code returned a value that is not JSON-serializable: ${error instanceof Error ? error.message : error}`
    );
  }
}
