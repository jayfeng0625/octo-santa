import { z } from "zod";
import type { AdminRunResult } from "../../core/admin/types";

// Wire schema for the admin plane's structured tool output. Both tools return
// the same shape: whatever the submitted code returned (already normalized to
// a JSON value by the core service) plus captured console output.

export const RunOutput = z.object({
  result: z
    .json()
    .describe("The JSON value the submitted code returned (null if it returned nothing)"),
  logs: z
    .array(z.string())
    .describe("Captured console output from the run, one entry per call"),
}) satisfies z.ZodType<AdminRunResult>;
