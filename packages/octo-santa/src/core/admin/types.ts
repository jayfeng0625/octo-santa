// Domain types for the elevated admin API. Core exposes exactly two code-mode
// operations — search (read-only) and execute (read/write) — that run
// caller-submitted code against typed APIs contributed by modules. Core never
// knows what a module's API does; each module describes its own surface with a
// TypeScript declaration fragment (its typehead), and core composes those into
// the single .d.ts contract served to clients.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// What one module contributes.
export interface AdminModuleDescription {
  // Global variable name the module's API is bound to inside submitted code,
  // e.g. "storage" → code calls `storage.getMessages(...)`.
  globalName: string;
  // Implementation identifier, e.g. "sqlite".
  provider: string;
  // TypeScript declaration fragment: the module's record shapes, its read and
  // write API interfaces, and a `declare const <globalName>: ...`.
  typehead: string;
}

// The composed contract for the whole admin API.
export interface AdminApiDescription {
  // Language submitted code is written in, as reported by the runner.
  language: string;
  modules: { globalName: string; provider: string }[];
  // Complete .d.ts source: core's execution-model header + module fragments.
  typehead: string;
}

// Raw outcome of one code run, straight from the runner — `result` is whatever
// the code returned and may not be JSON-safe yet.
export interface CodeRunResult {
  result: unknown;
  logs: string[];
}

// Wire-ready outcome: `result` is guaranteed JSON-serializable.
export interface AdminRunResult {
  result: JsonValue;
  logs: string[];
}
