// Domain types for the elevated admin plane. Core stays dialect-agnostic:
// queries and statements are opaque strings written in the storage provider's
// own language, and the provider describes that language to clients through a
// machine-readable typehead (a TypeScript declaration file it authors).

// Scalar values that cross the admin boundary in both directions — bind
// parameters going in, row cells coming out. Providers must normalize richer
// native types (blobs, bigints) onto these before returning.
export type AdminValue = string | number | boolean | null;

export type AdminRow = Record<string, AdminValue>;

export interface AdminSearchResult {
  rows: AdminRow[];
  row_count: number;
  // True when the provider had more rows than the service's cap.
  truncated: boolean;
}

export interface AdminExecuteResult {
  changes: number;
  last_insert_row_id: number;
}

// How a client learns to talk to the admin plane. The typehead is a complete
// TypeScript .d.ts source text authored by the storage provider — core never
// interprets it, it only hands it through to the transport.
export interface AdminInterfaceDescription {
  // Storage provider identifier, e.g. "sqlite".
  provider: string;
  // Language that `query` / `statement` strings are written in, e.g. "sqlite".
  dialect: string;
  // Full TypeScript declaration source describing tables, row shapes, and the
  // search/execute contract for this provider.
  typehead: string;
}
