#!/usr/bin/env node
/**
 * pack-dxt.mjs  —  Build and package the QuickBooks MCP server as a .dxt file.
 *
 * Claude Desktop requires a real ZIP archive (not a .tgz tarball).
 * This script:
 *   1. Compiles TypeScript  →  dist/
 *   2. Copies dist/, manifest.json, package.json, LICENSE into a temp dir
 *   3. Installs only production dependencies in that temp dir
 *   4. Zips everything into quickbooks-mcp-server.dxt  (ZIP, not tar)
 *   5. Cleans up the temp dir
 *
 * Works on macOS, Linux, and Windows (PowerShell Compress-Archive on Win32).
 */

import { execSync } from "child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { join, resolve } from "path";
import { tmpdir } from "os";

const ROOT = resolve(".");
const OUT_FILE = join(ROOT, "quickbooks-mcp-server.dxt");
const TEMP = join(tmpdir(), `dxt-${randomBytes(4).toString("hex")}`);

const run = (cmd, cwd = ROOT) =>
  execSync(cmd, { cwd, stdio: "inherit", shell: true });

function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

console.log("╔══════════════════════════════════════════╗");
console.log("║   QuickBooks MCP  →  .dxt packager       ║");
console.log("╚══════════════════════════════════════════╝\n");

try {
  step(1, "Compiling TypeScript…");
  run("npm run build");

  step(2, "Staging files…");
  mkdirSync(TEMP, { recursive: true });
  cpSync(join(ROOT, "dist"), join(TEMP, "dist"), { recursive: true });
  cpSync(join(ROOT, "manifest.json"), join(TEMP, "manifest.json"));
  cpSync(join(ROOT, "package.json"), join(TEMP, "package.json"));
  if (existsSync(join(ROOT, "LICENSE")))
    cpSync(join(ROOT, "LICENSE"), join(TEMP, "LICENSE"));
  if (existsSync(join(ROOT, "README.md")))
    cpSync(join(ROOT, "README.md"), join(TEMP, "README.md"));

  step(3, "Installing production dependencies…");
  run("npm install --omit=dev --ignore-scripts --no-audit --no-fund", TEMP);

  step(4, "Creating ZIP archive…");
  if (existsSync(OUT_FILE)) rmSync(OUT_FILE);

  if (process.platform === "win32") {
    run(
      `powershell -NoProfile -Command ` +
        `"Compress-Archive -Path '${TEMP}\\*' ` +
        `-DestinationPath '${OUT_FILE}' -Force"`
    );
  } else {
    run(`cd "${TEMP}" && zip -r "${OUT_FILE}" .`);
  }

  const bytes = statSync(OUT_FILE).size;
  const mb = (bytes / 1024 / 1024).toFixed(1);

  console.log("\n╔══════════════════════════════════════════╗");
  console.log(`║  ✅  quickbooks-mcp-server.dxt  (${mb} MB)`.padEnd(43) + "║");
  console.log("╚══════════════════════════════════════════╝\n");
  console.log("Install in Claude Desktop:");
  console.log("  Extensions → Install Extension → select quickbooks-mcp-server.dxt\n");
} catch (err) {
  console.error("\n❌ Pack failed:", err.message);
  process.exit(1);
} finally {
  rmSync(TEMP, { recursive: true, force: true });
}
