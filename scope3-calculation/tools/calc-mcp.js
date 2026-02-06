#!/usr/bin/env node
'use strict';

// Minimal MCP stdio server (LSP-style message framing + JSON-RPC 2.0).
// Implements: initialize, tools/list, tools/call.
// No external deps. Uses Node built-ins only.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json');

function readPluginManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      name: typeof parsed?.name === 'string' ? parsed.name : 'scope3-calculation',
      version: typeof parsed?.version === 'string' ? parsed.version : '0.0.0',
    };
  } catch (_err) {
    return { name: 'scope3-calculation', version: '0.0.0' };
  }
}

const PLUGIN = readPluginManifest();
const SERVER_NAME = `${PLUGIN.name}-mcp`;
const SERVER_VERSION = PLUGIN.version;

function write(msg) {
  const json = JSON.stringify(msg);
  const byteLen = Buffer.byteLength(json, 'utf8');
  process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { jsonrpc: '2.0', id, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

function listTools() {
  return {
    tools: [
      {
        name: 'calc.health',
        description: 'Returns plugin name/version and server timestamp.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: 'calc.sha256',
        description: 'Computes SHA-256 hex digest of the provided UTF-8 string.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Input text (UTF-8).',
            },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
  };
}

function callTool(name, args) {
  switch (name) {
    case 'calc.health': {
      const body = {
        plugin: { name: PLUGIN.name, version: PLUGIN.version },
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        timestamp: new Date().toISOString(),
      };
      return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false };
    }
    case 'calc.sha256': {
      if (!args || typeof args.text !== 'string') {
        return jsonRpcError(null, -32602, 'Invalid params: expected { text: string }');
      }
      const digest = crypto.createHash('sha256').update(args.text, 'utf8').digest('hex');
      return { content: [{ type: 'text', text: digest }], isError: false };
    }
    default:
      return jsonRpcError(null, -32601, `Unknown tool: ${name}`);
  }
}

function handleMessage(msg) {
  // Notifications have no id; ignore them.
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // Only respond to invalid requests if an id exists (or id is explicitly null).
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id')) {
      write(jsonRpcError(msg.id, -32600, 'Invalid Request'));
    }
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(msg, 'id')) return;
  const id = msg.id;

  try {
    switch (msg.method) {
      case 'initialize': {
        const requested =
          msg.params && typeof msg.params.protocolVersion === 'string'
            ? msg.params.protocolVersion
            : '2024-11-05';
        write(
          jsonRpcResult(id, {
            protocolVersion: requested,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: { listChanged: false } },
            instructions:
              'Minimal tools-only MCP server for scope3-calculation. Exposes calc.health and calc.sha256.',
          })
        );
        return;
      }
      case 'tools/list': {
        write(jsonRpcResult(id, { ...listTools(), nextCursor: null }));
        return;
      }
      case 'tools/call': {
        const name = msg.params && msg.params.name;
        const args = msg.params && (msg.params.arguments || msg.params.args);
        if (typeof name !== 'string') {
          write(jsonRpcError(id, -32602, 'Invalid params: missing tool name'));
          return;
        }

        const result = callTool(name, args);
        // callTool may return a JSON-RPC error skeleton (with id null). Convert to proper response.
        if (result && result.jsonrpc === '2.0' && result.error) {
          write(jsonRpcError(id, result.error.code, result.error.message, result.error.data));
          return;
        }
        write(jsonRpcResult(id, result));
        return;
      }
      default: {
        write(jsonRpcError(id, -32601, `Method not found: ${msg.method}`));
        return;
      }
    }
  } catch (e) {
    write(
      jsonRpcError(id, -32603, 'Internal error', {
        message: e && e.message ? e.message : String(e),
      })
    );
  }
}

let buffer = Buffer.alloc(0);

function tryParseMessages() {
  while (buffer.length > 0) {
    let headerEnd = buffer.indexOf('\r\n\r\n');
    let headerSepLen = 4;
    if (headerEnd === -1) {
      headerEnd = buffer.indexOf('\n\n');
      headerSepLen = 2;
    }
    if (headerEnd === -1) return;

    const headerText = buffer.slice(0, headerEnd).toString('utf8');
    const lengthMatch = /content-length\s*:\s*(\d+)/i.exec(headerText);
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + headerSepLen);
      continue;
    }

    const bodyLen = Number.parseInt(lengthMatch[1], 10);
    const bodyStart = headerEnd + headerSepLen;
    const bodyEnd = bodyStart + bodyLen;
    if (buffer.length < bodyEnd) return;

    const body = buffer.slice(bodyStart, bodyEnd).toString('utf8');
    buffer = buffer.slice(bodyEnd);

    let msg;
    try {
      msg = JSON.parse(body);
    } catch (_e) {
      write(jsonRpcError(null, -32700, 'Parse error'));
      continue;
    }
    handleMessage(msg);
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  tryParseMessages();
});

process.stdin.on('error', (err) => {
  // Never write non-MCP output to stdout.
  process.stderr.write(`[mcp] stdin error: ${err?.stack || String(err)}\\n`);
});

process.stdin.resume();
