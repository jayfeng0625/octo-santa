import { z } from "zod";
import type {
  AdminValue,
  AdminSearchResult,
  AdminExecuteResult,
} from "../../core/admin/types";

// Wire schemas for the admin plane's structured tool output. The `satisfies`
// clauses fail compilation if a core admin type drifts from the wire contract.

export const AdminValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]) satisfies z.ZodType<AdminValue>;

export const AdminParamsInput = z
  .array(AdminValueSchema)
  .optional()
  .describe("Positional bindings for ? placeholders");

export const SearchOutput = z.object({
  rows: z
    .array(z.record(z.string(), AdminValueSchema))
    .describe("Result rows; BLOB cells arrive base64-encoded"),
  row_count: z.number().describe("Number of rows returned"),
  truncated: z
    .boolean()
    .describe("True when rows were capped at the server's max row count"),
}) satisfies z.ZodType<AdminSearchResult>;

export const ExecuteOutput = z.object({
  changes: z.number().describe("Rows changed by the statement"),
  last_insert_row_id: z
    .number()
    .describe("rowid of the last inserted row (0 when not an insert)"),
}) satisfies z.ZodType<AdminExecuteResult>;
