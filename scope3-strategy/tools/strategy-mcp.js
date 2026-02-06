#!/usr/bin/env node
/* eslint-disable no-console */

// Minimal MCP (Model Context Protocol) stdio server with no dependencies.
// Implements: initialize, tools/list, tools/call
//
// Transport framing: LSP-style headers with Content-Length.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SERVER_NAME = "scope3-strategy-mcp";

function readServerVersion() {
  try {
    const manifestPath = path.join(__dirname, "..", ".claude-plugin", "plugin.json");
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Best-effort only.
  }
  return "0.0.0";
}

const SERVER_VERSION = readServerVersion();

const TOOLS = [
  {
    name: "strategy.health",
    description: "Basic health check for the scope3 strategy MCP server.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "strategy.sha256",
    description: "Compute SHA-256 hex digest of provided UTF-8 text.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to hash (UTF-8)." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function writeMessage(msg) {
  const json = JSON.stringify(msg);
  const byteLen = Buffer.byteLength(json, "utf8");
  process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
}

function sendResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMessage({ jsonrpc: "2.0", id, error });
}

async function handleRequest(msg) {
  const method = msg?.method;

  if (method === "initialize") {
    const requestedVersion = msg?.params?.protocolVersion;
    const protocolVersion =
      typeof requestedVersion === "string" && requestedVersion.trim().length > 0
        ? requestedVersion.trim()
        : "2024-11-05";

    return {
      protocolVersion,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: {
        tools: { listChanged: false },
      },
    };
  }

  if (method === "tools/list") {
    return { tools: TOOLS };
  }

  if (method === "tools/call") {
    const name = msg?.params?.name;
    const args = msg?.params?.arguments ?? {};

    if (name === "strategy.health") {
      const payload = {
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        pid: process.pid,
        timestamp: new Date().toISOString(),
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    if (name === "strategy.sha256") {
      if (typeof args?.text !== "string") {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing required argument: text (string)" }],
        };
      }
      return {
        content: [{ type: "text", text: sha256Hex(args.text) }],
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${String(name)}` }],
    };
  }

  // Optional but safe: treat notifications/unknown methods as method-not-found.
  const err = new Error(`Method not found: ${String(method)}`);
  err.code = -32601;
  throw err;
}

let buffer = Buffer.alloc(0);

function tryParseMessages() {
  while (buffer.length > 0) {
    // MCP stdio uses LSP framing: headers + \r\n\r\n + JSON.
    let headerEnd = buffer.indexOf("\r\n\r\n");
    let headerSepLen = 4;
    if (headerEnd === -1) {
      // Tolerate \n\n in case a client uses LF-only.
      headerEnd = buffer.indexOf("\n\n");
      headerSepLen = 2;
    }
    if (headerEnd === -1) return;

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const lengthMatch = /content-length\s*:\s*(\d+)/i.exec(headerText);
    if (!lengthMatch) {
      // Malformed frame. Drop headers and continue.
      buffer = buffer.slice(headerEnd + headerSepLen);
      continue;
    }

    const bodyLen = Number.parseInt(lengthMatch[1], 10);
    const bodyStart = headerEnd + headerSepLen;
    const bodyEnd = bodyStart + bodyLen;

    if (buffer.length < bodyEnd) return; // Wait for more data.

    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);

    let msg;
    try {
      msg = JSON.parse(body);
    } catch (e) {
      // JSON parse error
      sendError(null, -32700, "Parse error", { error: String(e) });
      continue;
    }

    // Notifications have no id. We ignore them.
    const id = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
    Promise.resolve()
      .then(() => handleRequest(msg))
      .then((result) => {
        if (id === undefined) return;
        sendResult(id, result);
      })
      .catch((err) => {
        if (id === undefined) return;
        const code = Number.isInteger(err?.code) ? err.code : -32603;
        sendError(id, code, err?.message || "Internal error");
      });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  tryParseMessages();
});

process.stdin.on("error", (e) => {
  // Not much to do here besides logging to stderr.
  console.error("stdin error:", e);
});

// Keep process alive until stdin closes.
process.stdin.resume();
