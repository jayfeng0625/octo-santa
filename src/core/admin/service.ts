import type { AdminModulePort, CodeRunnerPort } from "../ports";
import type {
  AdminApiDescription,
  AdminRunResult,
  CodeRunResult,
  JsonValue,
} from "./types";
import { TypeheadIndex, type TypeheadSearchResult } from "./typehead-index";

const DEFAULT_SEARCH_LIMIT = 10;

// The two operations of the admin API, code-mode style:
// - search: discovery. Looks up methods and types in the modules' composed
//   typehead by keyword, so an agent pulls only the declarations it needs
//   into context instead of the whole document.
// - execute: the only operation that runs code. Binds every module's API as
//   a global and hands the caller's code to the runner.
// Core never inspects the code or the module APIs, so modules with entirely
// different interaction patterns compose without core changes.
export class AdminService {
  private readonly modules = new Map<string, AdminModulePort>();
  private readonly index: TypeheadIndex;
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
    // document and its search index are identical for every caller.
    this.index = new TypeheadIndex(descriptions);
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

  search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): TypeheadSearchResult {
    if (!query.trim()) throw new Error("query must not be empty");
    return this.index.search(query, Math.max(1, limit));
  }

  async execute(code: string): Promise<AdminRunResult> {
    if (!code.trim()) throw new Error("code must not be empty");
    const bindings: Record<string, object> = {};
    for (const [name, module] of this.modules) {
      bindings[name] = module.createApi();
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
 * Two operations drive everything here. Search looks up methods and types in
 * these declarations by keyword — use it to find what to call and how, and
 * pull in only what you need. Execute runs your code against them.
 *
 * Your code runs as the body of an async function: use \`await\` freely and
 * \`return\` a value that can be written as JSON — that value, plus anything
 * you logged with console, comes back as the result. Imports and require()
 * do not work; everything you need is already a global variable:
 * ${globalNames.join(", ")} (declared below) and console.
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
