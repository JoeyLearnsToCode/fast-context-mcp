/**
 * Windsurf/Devin API Key extraction from local installation.
 *
 * Cross-platform: macOS / Windows / Linux.
 * Uses sql.js (pure JS/WASM) to read state.vscdb — no native compilation needed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import initSqlJs from "sql.js";

/**
 * Get platform-specific candidate paths to Windsurf/Devin's state.vscdb.
 * The renamed app uses Deviv on disk; Windsurf is kept as a compatibility fallback.
 * @param {{ platformName?: string, homeDir?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string[]}
 */
export function getDbPathCandidates(opts = {}) {
  const plat = opts.platformName || platform();
  const home = opts.homeDir || homedir();
  const env = opts.env || process.env;

  if (plat === "darwin") {
    return ["Deviv", "Windsurf"].map((appName) =>
      join(home, "Library", "Application Support", appName, "User", "globalStorage", "state.vscdb")
    );
  }

  if (plat === "win32") {
    const appdata = env.APPDATA || "";
    if (!appdata) throw new Error("Cannot determine APPDATA path");
    return ["Deviv", "Windsurf"].map((appName) =>
      join(appdata, appName, "User", "globalStorage", "state.vscdb")
    );
  }

  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  return ["Deviv", "Windsurf"].map((appName) =>
    join(config, appName, "User", "globalStorage", "state.vscdb")
  );
}

/**
 * Get the preferred platform-specific path to Windsurf/Devin's state.vscdb.
 * @returns {string}
 */
export function getDbPath() {
  return getDbPathCandidates()[0];
}

/**
 * Extract API Key from a Windsurf/Devin state.vscdb file.
 * @param {string} dbPath
 * @returns {Promise<{ api_key?: string, db_path: string, error?: string, hint?: string }>}
 */
async function extractKeyFromDb(dbPath) {
  if (!existsSync(dbPath)) {
    return {
      error: `Windsurf/Devin database not found: ${dbPath}`,
      hint: "Ensure Windsurf or Devin is installed and logged in.",
      db_path: dbPath,
    };
  }

  let db;
  try {
    const SQL = await initSqlJs();
    const buf = readFileSync(dbPath);
    db = new SQL.Database(buf);
  } catch (e) {
    return { error: `Failed to open database: ${e.message}`, db_path: dbPath };
  }

  try {
    const stmt = db.prepare("SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'");
    if (!stmt.step()) {
      stmt.free();
      return {
        error: "windsurfAuthStatus record not found",
        hint: "Ensure Windsurf or Devin is logged in.",
        db_path: dbPath,
      };
    }

    const row = stmt.getAsObject();
    stmt.free();

    let data;
    try {
      data = JSON.parse(row.value);
    } catch {
      return { error: "windsurfAuthStatus data parse failed", db_path: dbPath };
    }

    const apiKey = data.apiKey || "";
    if (!apiKey) {
      return { error: "apiKey field is empty", db_path: dbPath };
    }

    return { api_key: apiKey, db_path: dbPath };
  } catch (e) {
    return { error: `Extraction failed: ${e.message}`, db_path: dbPath };
  } finally {
    db.close();
  }
}

/**
 * Extract API Key from the first available Windsurf/Devin state.vscdb.
 * @param {string} [dbPath]
 * @returns {Promise<{ api_key?: string, db_path: string, error?: string, hint?: string, tried_paths?: string[] }>}
 */
export async function extractKey(dbPath) {
  const dbPaths = dbPath ? [dbPath] : getDbPathCandidates();
  const triedPaths = [];
  let firstExistingError = null;

  for (const candidate of dbPaths) {
    triedPaths.push(candidate);
    if (!existsSync(candidate)) continue;

    const result = await extractKeyFromDb(candidate);
    if (result.api_key) return result;
    if (!firstExistingError) firstExistingError = result;
  }

  if (firstExistingError) {
    return { ...firstExistingError, tried_paths: triedPaths };
  }

  return {
    error: "Windsurf/Devin database not found",
    hint: "Ensure Windsurf or Devin is installed and logged in.",
    db_path: dbPaths[0],
    tried_paths: triedPaths,
  };
}
