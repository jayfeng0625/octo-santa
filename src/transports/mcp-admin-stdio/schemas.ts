import { z } from "zod";
import type { AdminRunResult } from "../../core/admin/types";

// Wire schema for the admin API's structured tool output, shared by both tools.

export const RunOutput = z.object({
  result: z
    .json()
    .describe("The JSON value the submitted code returned (null if it returned nothing)"),
  logs: z
    .array(z.string())
    .describe("Captured console output from the run, one entry per call"),
}) satisfies z.ZodType<AdminRunResult>;
