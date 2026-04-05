#!/usr/bin/env bun
import { mkdirSync, existsSync, unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

const version = pkg.version;
const root = join(import.meta.dir, "..");
const versionDir = join(root, "dist", version);
const latestLink = join(root, "dist", "latest");

mkdirSync(versionDir, { recursive: true });

const target = process.argv[2]; // "mcp", "repl", or undefined (build all)

if (!target || target === "mcp") {
  console.log(`Building MCP bundle → dist/${version}/mcp.js`);
  const mcp = Bun.spawnSync(
    ["bun", "build", "src/main.ts", "--outdir", versionDir, "--target", "bun"],
    { cwd: root, stdio: ["inherit", "inherit", "inherit"] }
  );
  if (mcp.exitCode !== 0) process.exit(mcp.exitCode);
}

if (!target || target === "repl") {
  console.log(`Building REPL binary → dist/${version}/ocr`);
  const repl = Bun.spawnSync(
    ["bun", "build", "src/bin/repl.ts", "--compile", "--outfile", join(versionDir, "ocr")],
    { cwd: root, stdio: ["inherit", "inherit", "inherit"] }
  );
  if (repl.exitCode !== 0) process.exit(repl.exitCode);
}

// Update latest symlink
if (existsSync(latestLink)) unlinkSync(latestLink);
symlinkSync(version, latestLink);
console.log(`dist/latest → ${version}`);
