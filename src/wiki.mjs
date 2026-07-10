import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { platform, arch, release, hostname, cpus, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { ProtobufEncoder, connectFrameEncode, connectFrameDecode } from "./protobuf.mjs";
import { extractKey } from "./extract-key.mjs";
import { checkRg } from "./executor.mjs";

const API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const API_TIMEOUT_MS = 60000;
const RG_TIMEOUT_MS = 15000;
const RG_MAX_BUFFER = 5 * 1024 * 1024;
const RG_MAX_MATCHES_PER_FILE = 10;
const RG_MAX_FILES = 20;
const CONTEXT_PADDING = 10;
const MAX_MATCHES_PER_FILE_FOR_CONTEXT = 50;
const MAX_SECTIONS = 50;

const SYMBOL_TYPE_MAP = {
  unspecified: 0, file: 1, module: 2, namespace: 3, package: 4,
  class: 5, method: 6, property: 7, field: 8, constructor: 9,
  enum: 10, interface: 11, function: 12, variable: 13, constant: 14,
  string: 15, number: 16, boolean: 17, array: 18, object: 19,
  key: 20, null: 21, enum_member: 22, struct: 23, event: 24,
  operator: 25, type_parameter: 26,
};

function _generateSessionId() {
  const buf = randomUUID().replace(/-/g, "");
  return buf;
}

async function _getApiKey(apiKeyOverride) {
  if (apiKeyOverride) return apiKeyOverride;
  const envKey = process.env.WINDSURF_API_KEY;
  if (envKey) return envKey;
  const result = await extractKey();
  if (result.api_key && result.api_key.startsWith("sk-")) return result.api_key;
  throw new Error(
    "Windsurf API Key not found. Set WINDSURF_API_KEY env var or ensure Windsurf is logged in."
  );
}

function _buildMetadata(apiKey, locale) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, "windsurf");
  meta.writeString(2, "1.48.2");
  meta.writeString(3, apiKey);
  meta.writeString(4, locale);

  const plat = platform();
  const sysInfo = {
    Os: plat === "win32" ? "windows" : plat === "darwin" ? "darwin" : "linux",
    Arch: arch(),
    Release: release(),
    Version: release(),
    Machine: arch(),
    Nodename: hostname(),
    Sysname: plat === "darwin" ? "Darwin" : plat === "win32" ? "Windows_NT" : "Linux",
    ProductVersion: "",
  };
  meta.writeString(5, JSON.stringify(sysInfo));
  meta.writeString(7, "1.12.27");

  const cpuList = cpus();
  const ncpu = cpuList.length || 4;
  const cpuInfo = {
    NumSockets: 1,
    NumCores: Math.max(1, Math.floor(ncpu / 2)),
    NumThreads: ncpu,
    VendorID: "GenuineIntel",
    Family: "0",
    Model: "0",
    ModelName: cpuList[0]?.model || "Unknown",
    Memory: totalmem(),
  };
  meta.writeString(8, JSON.stringify(cpuInfo));
  meta.writeString(12, "windsurf");
  meta.writeString(24, _generateSessionId());
  meta.writeString(26, "Pro");
  return meta;
}

function _buildDeepwikiRequest(apiKey, params) {
  const meta = _buildMetadata(apiKey, params.language);
  const req = new ProtobufEncoder();
  req.writeMessage(1, meta);
  req.writeVarint(2, params.summary ? 1 : 2);
  req.writeString(3, params.symbol);
  if (params.symbolUri) req.writeString(4, params.symbolUri);
  if (params.context) req.writeString(5, params.context);
  if (params.symbolType !== undefined) req.writeVarint(6, params.symbolType);
  req.writeString(7, params.language);
  req.writeVarint(8, 1);
  return req.toBuffer();
}

function _runsilent(args) {
  try {
    return execFileSync("rg", args, {
      timeout: RG_TIMEOUT_MS,
      maxBuffer: RG_MAX_BUFFER,
      env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
      encoding: "utf-8",
    });
  } catch {
    return "";
  }
}

function _grepSymbolInDir(symbol, searchDir) {
  const out = _runsilent([
    "--no-heading", "-n", "-C", String(CONTEXT_PADDING),
    "--max-count", String(RG_MAX_MATCHES_PER_FILE),
    "-g", "!*.min.*",
    "-g", "!package-lock.json",
    "-g", "!pnpm-lock.yaml",
    "-g", "!yarn.lock",
    "-g", "!*.svg",
    "-g", "!*.png",
    "-g", "!*.jpg",
    "-g", "!*.woff2",
    "-g", "!*.md",
    symbol, searchDir,
  ]);
  if (!out) return [];
  const fileMap = new Map();
  for (const block of out.trim().split("\n--\n")) {
    if (!block.trim()) continue;
    const lines = block.split("\n");
    let filePath = null;
    const matchNums = [];
    for (const raw of lines) {
      const m = raw.match(/^(.+?):(\d+):/);
      if (m) {
        filePath = filePath || m[1];
        matchNums.push(parseInt(m[2], 10));
      }
    }
    if (!filePath || !matchNums.length) continue;
    const start = Math.max(1, Math.min(...matchNums) - CONTEXT_PADDING);
    const end = Math.max(...matchNums) + CONTEXT_PADDING;
    if (!fileMap.has(filePath)) fileMap.set(filePath, []);
    fileMap.get(filePath).push([start, end]);
  }
  const results = [];
  for (const [file, ranges] of fileMap) {
    const sorted = ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    let [curS, curE] = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      if (s <= curE + 1) { curE = Math.max(curE, e); }
      else { merged.push([curS, curE]); [curS, curE] = [s, e]; }
    }
    merged.push([curS, curE]);
    results.push({ file, ranges: merged });
    if (results.length >= RG_MAX_FILES) break;
  }
  return results;
}

function _addFileSections(sections, absPath, lines, ranges) {
  for (const [start, end] of ranges) {
    if (sections.length >= MAX_SECTIONS) break;
    const s = Math.max(0, start - 1);
    const e = Math.min(lines.length, end);
    sections.push(
      `File: ${absPath}\nShowing lines ${start}-${end} around:\n` +
      lines.slice(s, e).map((l, i) => `${s + i + 1}|${l}`).join("\n")
    );
  }
}

function _allMatchLines(lines, symbol, max = MAX_MATCHES_PER_FILE_FOR_CONTEXT) {
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(symbol)) {
      result.push(i);
      if (result.length >= max) break;
    }
  }
  return result;
}

function _computeRanges(lines, targets) {
  if (!targets.length) return [];
  const sorted = [...targets].sort((a, b) => a - b);
  const ranges = [];
  let curStart = Math.max(0, sorted[0] - CONTEXT_PADDING);
  let curEnd = Math.min(lines.length, sorted[0] + CONTEXT_PADDING + 1);
  for (let i = 1; i < sorted.length; i++) {
    const s = Math.max(0, sorted[i] - CONTEXT_PADDING);
    const e = Math.min(lines.length, sorted[i] + CONTEXT_PADDING + 1);
    if (s < curEnd) { curEnd = Math.max(curEnd, e); }
    else { ranges.push([curStart + 1, curEnd]); [curStart, curEnd] = [s, e]; }
  }
  ranges.push([curStart + 1, curEnd]);
  return ranges;
}

function _buildContext(filePath, line, symbol) {
  const sections = [];
  let grepDir = null;

  if (filePath) {
    const absPath = resolve(filePath);
    if (existsSync(absPath)) {
      let st;
      try { st = statSync(absPath); } catch { st = null; }
      if (st && st.isFile()) {
        const content = readFileSync(absPath, "utf-8");
        const fileLines = content.split("\n");
        let targets;
        if (typeof line === "number" && Number.isFinite(line)) {
          targets = [Math.max(0, Math.min(line - 1, fileLines.length - 1))];
        } else {
          targets = _allMatchLines(fileLines, symbol);
        }
        _addFileSections(sections, absPath, fileLines, _computeRanges(fileLines, targets));
        grepDir = dirname(absPath);
      } else {
        grepDir = absPath;
      }
    }
  }

  if (!grepDir) {
    grepDir = process.cwd();
  }

  const seenFiles = new Set(sections.map(s => {
    const m = s.match(/^File: (.+)$/m);
    return m ? m[1] : null;
  }).filter(Boolean));

  const grepResults = _grepSymbolInDir(symbol, grepDir);
  for (const { file, ranges } of grepResults) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    let st;
    try { st = statSync(file); } catch { continue; }
    if (!st.isFile()) continue;
    const content = readFileSync(file, "utf-8");
    const fileLines = content.split("\n");
    _addFileSections(sections, file, fileLines, ranges);
    if (sections.length >= MAX_SECTIONS) break;
  }

  return sections.join("\n\n");
}

function _extractTextDelta(buf) {
  let offset = 0;
  const parts = [];
  while (offset < buf.length) {
    let tag = 0, shift = 0;
    while (offset < buf.length) {
      const b = buf[offset++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (wireType === 0) {
      while (offset < buf.length) {
        if (!(buf[offset++] & 0x80)) break;
      }
    } else if (wireType === 2) {
      let len = 0; shift = 0;
      while (offset < buf.length) {
        const b = buf[offset++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      if (offset + len > buf.length) break;
      if (fieldNum === 1) {
        parts.push(_extractTextDeltaFromChatResponse(buf.subarray(offset, offset + len)));
      }
      offset += len;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break;
    }
  }
  return parts.join("");
}

function _extractTextDeltaFromChatResponse(buf) {
  let offset = 0;
  const parts = [];
  while (offset < buf.length) {
    let tag = 0, shift = 0;
    while (offset < buf.length) {
      const b = buf[offset++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;
    if (wireType === 0) {
      while (offset < buf.length) {
        if (!(buf[offset++] & 0x80)) break;
      }
    } else if (wireType === 2) {
      let len = 0; shift = 0;
      while (offset < buf.length) {
        const b = buf[offset++];
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      if (offset + len > buf.length) break;
      if (fieldNum === 3) {
        parts.push(buf.subarray(offset, offset + len).toString("utf-8"));
      }
      offset += len;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      break;
    }
  }
  return parts.join("");
}

function _parseDeepwikiResponse(data) {
  const frames = connectFrameDecode(data);
  let text = "";
  for (const frameData of frames) {
    try {
      const textCandidate = frameData.toString("utf-8").trimStart();
      if (textCandidate.startsWith("{") || textCandidate.startsWith("[")) {
        continue;
      }
    } catch {
    }
    text += _extractTextDelta(frameData);
  }
  return text;
}

async function _streamingRequest(protoBytes, timeoutMs = API_TIMEOUT_MS) {
  const frame = connectFrameEncode(protoBytes);
  const url = `${API_BASE}/GetDeepWiki`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Connect-Content-Encoding": "gzip",
      "Connect-Accept-Encoding": "gzip",
      "Accept-Encoding": "identity",
      "User-Agent": "connect-go/1.18.1 (go1.25.5)",
      "Accept": "*/*",
    },
    body: frame,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`DeepWiki request failed: ${resp.status} ${resp.statusText}`);
  }
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

export async function deepwiki({
  symbol,
  path,
  line,
  symbolType,
  symbolUri,
  language = "zh-cn",
  summary = false,
  debug = false,
  apiKey,
  timeoutMs = API_TIMEOUT_MS,
}) {
  if (!symbol) throw new Error("symbol is required");
  if (!checkRg()) {
    throw new Error("rg (ripgrep) not found in PATH. Install: winget install BurntSushi.ripgrep.MSVC (Windows), brew install ripgrep (macOS), or apt install ripgrep (Linux)");
  }

  const context = _buildContext(path, line, symbol);

  if (debug) {
    process.stderr.write(`[wiki debug] symbol: ${symbol}\n`);
    process.stderr.write(`[wiki debug] path: ${path || "(none)"}\n`);
    process.stderr.write(`[wiki debug] line: ${line ?? "(none)"}\n`);
    process.stderr.write(`[wiki debug] context (${Buffer.byteLength(context, "utf-8")} bytes):\n`);
    process.stderr.write(context || "(empty)");
    process.stderr.write("\n");
    process.stderr.write("[wiki debug] No API request made (--debug)\n");
    return "[Debug mode: context printed above, no API request was made]";
  }

  const key = await _getApiKey(apiKey);
  const typeValue = symbolType !== undefined ? SYMBOL_TYPE_MAP[symbolType] ?? 0 : undefined;
  const proto = _buildDeepwikiRequest(key, {
    symbol,
    symbolUri: symbolUri || "",
    context: context || "",
    symbolType: typeValue,
    language,
    summary,
  });
  const data = await _streamingRequest(proto, timeoutMs);
  return _parseDeepwikiResponse(data);
}

export async function deepwikiWithContent(opts) {
  try {
    const text = await deepwiki(opts);
    if (!text) return "DeepWiki returned empty result.";
    return text;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}
