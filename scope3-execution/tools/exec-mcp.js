#!/usr/bin/env node
'use strict';

// Minimal MCP (Model Context Protocol) stdio server.
// Transport: stdio with LSP-style message framing (Content-Length headers) + JSON-RPC 2.0.
// No external deps.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json');

function readPluginManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      name: typeof parsed?.name === 'string' ? parsed.name : 'scope3-execution',
      version: typeof parsed?.version === 'string' ? parsed.version : '0.0.0',
    };
  } catch (_err) {
    return { name: 'scope3-execution', version: '0.0.0' };
  }
}

const PLUGIN = readPluginManifest();
const SERVER_INFO = {
  name: `${PLUGIN.name}-mcp`,
  version: PLUGIN.version,
};

// Keep this list small and conservative; we only implement tools.
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

function negotiateProtocolVersion(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested;
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function getTools() {
  return [
    {
      name: 'exec.health',
      title: 'Execution Plugin Health',
      description: 'Returns plugin name/version and server timestamp.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'exec.sha256',
      title: 'SHA-256 (UTF-8)',
      description: 'Computes SHA-256 hex digest of the provided UTF-8 string.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Input string to hash (UTF-8).',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  ];
}

function send(message) {
  // MCP stdio framing: Content-Length + JSON payload (LSP-style).
  const json = JSON.stringify(message);
  const byteLen = Buffer.byteLength(json, 'utf8');
  process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
}

function respondResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id: id ?? null, error });
}

function toolTextResult(text) {
  return {
    content: [{ type: 'text', text: String(text) }],
    isError: false,
  };
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  const isNotification = !hasId;
  const id = hasId ? msg.id : undefined;
  const method = msg.method;

  if (typeof method !== 'string') {
    if (!isNotification) respondError(id, -32600, 'Invalid Request: expected method string');
    return;
  }

  // Notifications are fire-and-forget.
  if (isNotification) return;

  if (method === 'ping') {
    respondResult(id, {});
    return;
  }

  if (method === 'initialize') {
    const requested = msg.params?.protocolVersion;
    const protocolVersion = negotiateProtocolVersion(requested);
    respondResult(id, {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: SERVER_INFO,
      instructions:
        'Minimal tools-only MCP server for scope3-execution. Exposes exec.health and exec.sha256.',
    });
    return;
  }

  if (method === 'tools/list') {
    respondResult(id, { tools: getTools(), nextCursor: null });
    return;
  }

  if (method === 'tools/call') {
    const toolName = msg.params?.name;
    const args = msg.params?.arguments ?? {};

    if (typeof toolName !== 'string' || toolName.length === 0) {
      respondError(id, -32602, 'Invalid params: expected params.name string');
      return;
    }

    if (toolName === 'exec.health') {
      respondResult(
        id,
        toolTextResult(
          JSON.stringify({
            plugin: { name: PLUGIN.name, version: PLUGIN.version },
            server: SERVER_INFO,
            timestamp: new Date().toISOString(),
          }),
        ),
      );
      return;
    }

    if (toolName === 'exec.sha256') {
      // Be lenient for callers, but document `text` in the schema.
      const text =
        typeof args?.text === 'string'
          ? args.text
          : typeof args?.input === 'string'
            ? args.input
            : typeof args?.value === 'string'
              ? args.value
              : undefined;

      if (typeof text !== 'string') {
        respondError(id, -32602, 'Invalid params: expected arguments.text string');
        return;
      }

      respondResult(id, toolTextResult(sha256HexUtf8(text)));
      return;
    }

    respondError(id, -32601, `Unknown tool: ${toolName}`);
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

let buffer = Buffer.alloc(0);

function tryParseMessages() {
  while (buffer.length > 0) {
    // Headers + \r\n\r\n + JSON.
    let headerEnd = buffer.indexOf('\r\n\r\n');
    let headerSepLen = 4;
    if (headerEnd === -1) {
      // Tolerate \n\n in case a client uses LF-only.
      headerEnd = buffer.indexOf('\n\n');
      headerSepLen = 2;
    }
    if (headerEnd === -1) return;

    const headerText = buffer.slice(0, headerEnd).toString('utf8');
    const lengthMatch = /content-length\s*:\s*(\d+)/i.exec(headerText);
    if (!lengthMatch) {
      // Malformed frame; drop headers and continue.
      buffer = buffer.slice(headerEnd + headerSepLen);
      continue;
    }

    const bodyLen = Number.parseInt(lengthMatch[1], 10);
    const bodyStart = headerEnd + headerSepLen;
    const bodyEnd = bodyStart + bodyLen;
    if (buffer.length < bodyEnd) return; // Wait for more data.

    const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.slice(bodyEnd);

    let msg;
    try {
      msg = JSON.parse(body);
    } catch (_err) {
      respondError(null, -32700, 'Parse error');
      continue;
    }

    Promise.resolve(handleMessage(msg)).catch((err) => {
      const reqId = Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : null;
      if (reqId !== null && reqId !== undefined) respondError(reqId, -32603, 'Internal error');
      // Stderr is allowed for logs; never write non-MCP output to stdout.
      process.stderr.write(`[mcp] internal error: ${err?.stack || String(err)}\n`);
    });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  tryParseMessages();
});

process.stdin.on('error', (err) => {
  process.stderr.write(`[mcp] stdin error: ${err?.stack || String(err)}\n`);
});

process.stdin.resume();
