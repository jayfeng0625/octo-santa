// Domain types for the elevated admin plane. Core exposes exactly two
// code-mode operations — search (read-only) and execute (read/write) — that
// run caller-submitted TypeScript against typed APIs contributed by modules.
// Core never knows what a module's API does; each module describes its own
// surface with a TypeScript declaration fragment (its typehead), and core
// composes those into the single .d.ts contract served to clients.

// What one module contributes to the admin plane.
export interface AdminModuleDescription {
  // Global binding name the module's API is exposed under inside submitted
  // code, e.g. "storage" → code calls `storage.getMessages(...)`.
  module: string;
  // Implementation identifier, e.g. "sqlite".
  provider: string;
  // TypeScript declaration fragment: the module's record shapes, its search
  // (read-only) and execute (read/write) API interfaces, and a
  // `declare const <module>: ...` for the binding.
  typehead: string;
}

// The composed contract for the whole admin plane.
export interface AdminInterfaceDescription {
  language: "typescript";
  modules: { module: string; provider: string }[];
  // Complete .d.ts source: core's execution-model header + module fragments.
  typehead: string;
}

// Raw outcome of one code run, as produced by the runner adapter.
export interface CodeRunOutcome {
  // Whatever the submitted code returned. May not be JSON-safe yet.
  result: unknown;
  // Captured console output, one entry per call.
  logs: string[];
}

// Wire-ready outcome: result is guaranteed JSON-serializable (undefined
// normalized to null).
export interface AdminRunResult {
  result: unknown;
  logs: string[];
}
