import { z } from "zod";
import type { AdminRunResult } from "../../core/admin/types";
import type { TypeheadSearchResult } from "../../core/admin/typehead-index";

// Wire schemas for the admin API's structured tool output.

export const SearchOutput = z.object({
  matches: z
    .array(
      z.object({
        module: z.string().describe("Module global the declaration belongs to"),
        name: z.string().describe("Method or type name"),
        declaration: z
          .string()
          .describe("The declaration with its doc comment, ready to code against"),
      })
    )
    .describe("Best-matching declarations, most relevant first"),
  total: z
    .number()
    .describe("Total declarations that matched, before the limit was applied"),
}) satisfies z.ZodType<TypeheadSearchResult>;

export const ExecuteOutput = z.object({
  result: z
    .json()
    .describe("The JSON value the submitted code returned (null if it returned nothing)"),
  logs: z
    .array(z.string())
    .describe("Captured console output from the run, one entry per call"),
}) satisfies z.ZodType<AdminRunResult>;
