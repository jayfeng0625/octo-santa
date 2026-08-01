import type { AdminStoragePort } from "../ports";
import type {
  AdminValue,
  AdminSearchResult,
  AdminExecuteResult,
  AdminInterfaceDescription,
} from "./types";

// Orchestrates the elevated admin plane: validates inputs, caps result sizes,
// and delegates to the storage provider. Deliberately thin — the provider owns
// the query language and its enforcement (read-only search, atomic execute);
// the service owns the transport-facing contract.
export class AdminService {
  constructor(
    private readonly storage: AdminStoragePort,
    private readonly maxRows: number = 10_000
  ) {}

  describe(): AdminInterfaceDescription {
    return this.storage.describe();
  }

  search(query: string, params: AdminValue[] = []): AdminSearchResult {
    if (!query.trim()) throw new Error("query must not be empty");
    const rows = this.storage.search(query, params);
    const truncated = rows.length > this.maxRows;
    const capped = truncated ? rows.slice(0, this.maxRows) : rows;
    return { rows: capped, row_count: capped.length, truncated };
  }

  execute(statement: string, params: AdminValue[] = []): AdminExecuteResult {
    if (!statement.trim()) throw new Error("statement must not be empty");
    return this.storage.execute(statement, params);
  }
}
