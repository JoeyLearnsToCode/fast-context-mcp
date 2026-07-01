#!/usr/bin/env node
import { parseArgs } from "node:util";
import { searchWithContent, search } from "./core.mjs";
import { startMcpServer } from "./server.mjs";

const SEARCH_OPTIONS = {
  "project-path": { type: "string", default: "" },
  "tree-depth": { type: "string", default: "3" },
  "max-turns": { type: "string", default: undefined },
  "max-results": { type: "string", default: "10" },
  "exclude-paths": { type: "string", default: "" },
  "timeout-ms": { type: "string", default: undefined },
  "max-commands": { type: "string", default: undefined },
  "api-key": { type: "string", default: "" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
};

function showHelp() {
  process.stdout.write(`fast-context-mcp - AI-driven semantic code search

USAGE:
  fast-context-mcp                        Start MCP server (stdio)
  fast-context-mcp mcp                    Start MCP server (stdio)
  fast-context-mcp search <query>         Search codebase via CLI
    [--project-path <path>]               Project root (default: cwd)
    [--tree-depth <n>]                    Directory tree depth 1-6 (default: 3)
    [--max-turns <n>]                     Search rounds 1-5 (default: 3)
    [--max-results <n>]                   Max files to return 1-30 (default: 10)
    [--exclude-paths <p1,p2,...>]         Comma-separated exclude patterns
    [--timeout-ms <n>]                    Connect timeout in ms (default: 30000)
    [--max-commands <n>]                  Max parallel commands per round (default: 8)
    [--api-key <key>]                     Windsurf API key (override)
    [--json]                              Output raw JSON
  fast-context-mcp help                   Show this help
`);
}

function done(exitCode = 0) {
  process.exit(exitCode);
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    showHelp();
    done();
    return;
  }

  if (!cmd || cmd === "mcp") {
    const rest = process.argv.slice(3);
    if (rest.includes("--help") || rest.includes("-h")) {
      showHelp();
      done();
      return;
    }
    await startMcpServer();
    return;
  }

  if (cmd === "search") {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(3),
      options: SEARCH_OPTIONS,
      allowPositionals: true,
    });

    if (values.help) {
      showHelp();
      done();
      return;
    }

    const query = positionals[0];
    if (!query) {
      process.stderr.write("Error: search requires a query string\n");
      done(1);
      return;
    }

    const opts = {
      query,
      projectRoot: values["project-path"] || process.cwd(),
      treeDepth: parseInt(values["tree-depth"], 10) || 3,
      maxResults: parseInt(values["max-results"], 10) || 10,
      apiKey: values["api-key"] || undefined,
    };
    if (values["max-turns"]) opts.maxTurns = parseInt(values["max-turns"], 10);
    if (values["max-commands"]) opts.maxCommands = parseInt(values["max-commands"], 10);
    if (values["timeout-ms"]) opts.timeoutMs = parseInt(values["timeout-ms"], 10);
    if (values["exclude-paths"]) {
      opts.excludePaths = values["exclude-paths"].split(",").map(s => s.trim()).filter(Boolean);
    }

    if (values.json) {
      opts.onProgress = (msg) => process.stderr.write(`[fast-context] ${msg}\n`);
      const result = await search(opts);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      const result = await searchWithContent(opts);
      process.stdout.write(result + "\n");
    }
    done();
    return;
  }

  process.stderr.write(`Error: unknown command '${cmd}'\n`);
  done(1);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  done(1);
});
