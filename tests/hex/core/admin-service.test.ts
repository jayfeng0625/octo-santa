import { describe, it, expect } from "bun:test";
import { AdminService } from "../../../src/core/admin/service";
import type { AdminStoragePort } from "../../../src/core/ports";
import type {
  AdminValue,
  AdminRow,
  AdminExecuteResult,
} from "../../../src/core/admin/types";

// Core-level tests with a fake port: the service must stay dialect-agnostic
// and delegate opaque query strings untouched.

function makeFakePort(overrides: Partial<AdminStoragePort> = {}): AdminStoragePort & {
  calls: { method: string; text: string; params: AdminValue[] }[];
} {
  const calls: { method: string; text: string; params: AdminValue[] }[] = [];
  return {
    calls,
    describe: () => ({
      provider: "fake",
      dialect: "fakeql",
      typehead: "declare module 'fake' {}",
    }),
    search: (query: string, params: AdminValue[]): AdminRow[] => {
      calls.push({ method: "search", text: query, params });
      return [{ a: 1 }, { a: 2 }, { a: 3 }];
    },
    execute: (statement: string, params: AdminValue[]): AdminExecuteResult => {
      calls.push({ method: "execute", text: statement, params });
      return { changes: 1, last_insert_row_id: 42 };
    },
    ...overrides,
  };
}

describe("AdminService", () => {
  it("passes queries and params through to the port opaquely", () => {
    const port = makeFakePort();
    const svc = new AdminService(port);
    const result = svc.search("ANYTHING the provider understands", ["x", 1, true, null]);
    expect(port.calls).toEqual([
      { method: "search", text: "ANYTHING the provider understands", params: ["x", 1, true, null] },
    ]);
    expect(result.rows).toHaveLength(3);
    expect(result.row_count).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("defaults params to an empty array", () => {
    const port = makeFakePort();
    const svc = new AdminService(port);
    svc.search("q");
    svc.execute("s");
    expect(port.calls.map((c) => c.params)).toEqual([[], []]);
  });

  it("rejects empty and whitespace-only query/statement", () => {
    const svc = new AdminService(makeFakePort());
    expect(() => svc.search("")).toThrow("query must not be empty");
    expect(() => svc.search("   ")).toThrow("query must not be empty");
    expect(() => svc.execute("")).toThrow("statement must not be empty");
    expect(() => svc.execute("  \n ")).toThrow("statement must not be empty");
  });

  it("caps search results at maxRows and flags truncation", () => {
    const port = makeFakePort({
      search: () => Array.from({ length: 5 }, (_, i) => ({ n: i })),
    });
    const svc = new AdminService(port, 2);
    const result = svc.search("q");
    expect(result.rows).toEqual([{ n: 0 }, { n: 1 }]);
    expect(result.row_count).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("returns execute results from the port unchanged", () => {
    const svc = new AdminService(makeFakePort());
    expect(svc.execute("s", [7])).toEqual({ changes: 1, last_insert_row_id: 42 });
  });

  it("surfaces the provider's interface description verbatim", () => {
    const svc = new AdminService(makeFakePort());
    expect(svc.describe()).toEqual({
      provider: "fake",
      dialect: "fakeql",
      typehead: "declare module 'fake' {}",
    });
  });
});
