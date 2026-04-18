#!/usr/bin/env node
'use strict';

// MCP (Model Context Protocol) stdio server for scope3-execution.
// Transport: stdio with LSP-style message framing (Content-Length headers) + JSON-RPC 2.0.
// No external deps -- Node built-ins only.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// FileStore -- simple JSON-file persistence (one file per collection)
// ---------------------------------------------------------------------------
const DATA_DIR = path.resolve(__dirname, '..', 'data');

class FileStore {
  constructor(dir) {
    this._dir = dir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _filePath(collection) {
    // sanitise collection name to prevent path traversal
    const safe = String(collection).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this._dir, `${safe}.json`);
  }

  _readAll(collection) {
    const fp = this._filePath(collection);
    if (!fs.existsSync(fp)) return [];
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }

  _writeAll(collection, docs) {
    const fp = this._filePath(collection);
    fs.writeFileSync(fp, JSON.stringify(docs, null, 2), 'utf8');
  }

  _matches(doc, query) {
    if (!query || typeof query !== 'object') return true;
    for (const [k, v] of Object.entries(query)) {
      if (doc[k] !== v) return false;
    }
    return true;
  }

  /** Return first doc matching query, or null. */
  get(collection, query) {
    const docs = this._readAll(collection);
    return docs.find((d) => this._matches(d, query)) ?? null;
  }

  /** Upsert: if _id matches, replace; else append. Returns the saved doc. */
  set(collection, doc) {
    const docs = this._readAll(collection);
    const id = doc._id ?? crypto.randomUUID();
    const record = { ...doc, _id: id, _updated: new Date().toISOString() };
    const idx = docs.findIndex((d) => d._id === id);
    if (idx >= 0) {
      docs[idx] = record;
    } else {
      record._created = record._updated;
      docs.push(record);
    }
    this._writeAll(collection, docs);
    return record;
  }

  /** Delete docs matching query. Returns count deleted. */
  delete(collection, query) {
    const docs = this._readAll(collection);
    const keep = docs.filter((d) => !this._matches(d, query));
    const removed = docs.length - keep.length;
    if (removed > 0) this._writeAll(collection, keep);
    return removed;
  }

  /** List docs, optional query filter and limit. */
  list(collection, query, limit) {
    let docs = this._readAll(collection);
    if (query && typeof query === 'object' && Object.keys(query).length > 0) {
      docs = docs.filter((d) => this._matches(d, query));
    }
    if (typeof limit === 'number' && limit > 0) {
      docs = docs.slice(0, limit);
    }
    return docs;
  }
}

const store = new FileStore(DATA_DIR);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256HexUtf8(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function nowISO() {
  return new Date().toISOString();
}

function requireString(args, key) {
  const v = args?.[key];
  if (typeof v === 'string' && v.length > 0) return v;
  throw Object.assign(new Error(`Missing required string: ${key}`), { code: -32602 });
}

function optString(args, key, fallback) {
  const v = args?.[key];
  return typeof v === 'string' ? v : fallback;
}

function optNumber(args, key, fallback) {
  const v = args?.[key];
  return typeof v === 'number' ? v : fallback;
}

function optObject(args, key, fallback) {
  const v = args?.[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Pipeline stages (simulated -- no backend, all local data)
// ---------------------------------------------------------------------------
const PIPELINE_STAGES = ['seed', 'sources', 'ingest', 'seed_data', 'generate'];

function runStage(stage, runId) {
  const ts = nowISO();
  const result = { run_id: runId, stage, status: 'completed', started_at: ts, completed_at: ts };

  if (stage === 'seed') {
    const count = store.list('emission_factors').length || 0;
    result.detail = `Seeded baseline emission factors (${count} existing records)`;
  } else if (stage === 'sources') {
    const docs = store.list('documents');
    result.detail = `Sources indexed: ${docs.length} documents`;
  } else if (stage === 'ingest') {
    const docs = store.list('documents');
    let ingested = 0;
    for (const doc of docs) {
      if (!doc.ingested) {
        store.set('documents', { ...doc, ingested: true, ingested_at: ts });
        ingested++;
      }
    }
    result.detail = `Ingested ${ingested} new documents (${docs.length} total)`;
  } else if (stage === 'seed_data') {
    const benchmarks = store.list('benchmarks').length;
    const evidence = store.list('evidence').length;
    result.detail = `Seed data check: ${benchmarks} benchmarks, ${evidence} evidence records`;
  } else if (stage === 'generate') {
    const suppliers = store.list('suppliers');
    let generated = 0;
    for (const s of suppliers) {
      if (!s.recommendations_generated) {
        store.set('suppliers', { ...s, recommendations_generated: true, recommendation_ts: ts });
        generated++;
      }
    }
    result.detail = `Generated recommendations for ${generated} suppliers`;
  } else {
    result.status = 'error';
    result.detail = `Unknown stage: ${stage}`;
  }

  // Persist run log
  store.set('pipeline_runs', {
    _id: `${runId}__${stage}`,
    run_id: runId,
    stage,
    status: result.status,
    detail: result.detail,
    timestamp: ts,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Maturity scoring
// ---------------------------------------------------------------------------
function computeMaturityScore(supplierId) {
  const supplier = store.get('suppliers', { _id: supplierId });
  if (!supplier) return { error: `Supplier not found: ${supplierId}` };

  const engagements = store.list('engagements', { supplier_id: supplierId });
  const provenance = store.list('provenance', { entity_type: 'supplier', entity_id: supplierId });
  const engagement = engagements[0] ?? null;

  let level = 'M0_unverified';
  let score = 0;

  if (provenance.length === 0 && (!supplier.evidence_status || supplier.evidence_status === 'missing_public_report')) {
    level = 'M0_unverified';
    score = 0;
  } else if (supplier.evidence_status === 'insufficient_context' || (provenance.length > 0 && provenance.length < 3)) {
    level = 'M1_partial_evidence';
    score = 25;
  } else if (supplier.evidence_status === 'ok' && (!engagement || engagement.status === 'not_started')) {
    level = 'M2_evidence_ready';
    score = 50;
  } else if (supplier.evidence_status === 'ok' && engagement && ['in_progress', 'pending_response'].includes(engagement.status)) {
    level = 'M3_engagement_active';
    score = 75;
  } else if (engagement && engagement.status === 'completed') {
    level = 'M4_commitment_recorded';
    score = 100;
  }

  return {
    supplier_id: supplierId,
    supplier_name: supplier.name ?? supplier.supplier_name ?? supplierId,
    level,
    score,
    evidence_count: provenance.length,
    engagement_status: engagement?.status ?? 'none',
    computed_at: nowISO(),
  };
}

// ---------------------------------------------------------------------------
// Quality gates
// ---------------------------------------------------------------------------
function runQualityGates(runId) {
  const gates = [];
  const ts = nowISO();

  // Gate 1: all pipeline stages completed
  const stages = PIPELINE_STAGES.map((s) => {
    const log = store.get('pipeline_runs', { run_id: runId, stage: s });
    return { stage: s, status: log?.status ?? 'not_run' };
  });
  const allCompleted = stages.every((s) => s.status === 'completed');
  gates.push({ gate: 'pipeline_stages_complete', pass: allCompleted, detail: stages });

  // Gate 2: at least one supplier exists
  const supplierCount = store.list('suppliers').length;
  gates.push({ gate: 'suppliers_exist', pass: supplierCount > 0, detail: { count: supplierCount } });

  // Gate 3: emission factors loaded
  const factorCount = store.list('emission_factors').length;
  gates.push({ gate: 'emission_factors_loaded', pass: factorCount > 0, detail: { count: factorCount } });

  // Gate 4: no orphan provenance (provenance refs valid suppliers)
  const allProvenance = store.list('provenance');
  const supplierIds = new Set(store.list('suppliers').map((s) => s._id));
  const orphans = allProvenance.filter((p) => p.entity_type === 'supplier' && !supplierIds.has(p.entity_id));
  gates.push({ gate: 'no_orphan_provenance', pass: orphans.length === 0, detail: { orphan_count: orphans.length } });

  // Gate 5: documents ingested
  const docs = store.list('documents');
  const unIngested = docs.filter((d) => !d.ingested);
  gates.push({ gate: 'documents_ingested', pass: unIngested.length === 0, detail: { pending: unIngested.length, total: docs.length } });

  const overallPass = gates.every((g) => g.pass);

  return { run_id: runId ?? 'latest', overall: overallPass ? 'pass' : 'fail', gates, checked_at: ts };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function buildExport(format, period) {
  const ts = nowISO();
  const suppliers = store.list('suppliers');
  const emissions = store.list('emissions');
  const provenance = store.list('provenance');
  const engagements = store.list('engagements');

  const meta = { format, period: period ?? 'latest', exported_at: ts, record_counts: { suppliers: suppliers.length, emissions: emissions.length, provenance: provenance.length, engagements: engagements.length } };

  if (format === 'json') {
    return { ...meta, data: { suppliers, emissions, provenance, engagements } };
  }

  if (format === 'csrd') {
    return {
      ...meta,
      framework: 'CSRD/ESRS',
      sections: {
        E1_climate_change: { emission_records: emissions.length, supplier_engagements: engagements.length },
        S2_value_chain_workers: { supplier_count: suppliers.length },
        G1_governance: { provenance_records: provenance.length },
      },
    };
  }

  if (format === 'ghg') {
    const scope1 = emissions.filter((e) => e.scope === 1 || e.scope === 'scope1');
    const scope2 = emissions.filter((e) => e.scope === 2 || e.scope === 'scope2');
    const scope3 = emissions.filter((e) => e.scope === 3 || e.scope === 'scope3');
    return {
      ...meta,
      framework: 'GHG Protocol',
      scopes: {
        scope1: { records: scope1.length, total_tco2e: scope1.reduce((a, e) => a + (e.tco2e ?? 0), 0) },
        scope2: { records: scope2.length, total_tco2e: scope2.reduce((a, e) => a + (e.tco2e ?? 0), 0) },
        scope3: { records: scope3.length, total_tco2e: scope3.reduce((a, e) => a + (e.tco2e ?? 0), 0) },
      },
    };
  }

  if (format === 'pdf') {
    return { ...meta, note: 'PDF generation produces a structured manifest. Render with a PDF library client-side.', pages: [{ title: 'Executive Summary', content: `Total emissions records: ${emissions.length}` }, { title: 'Supplier Overview', content: `Total suppliers: ${suppliers.length}` }, { title: 'Provenance Audit', content: `Total provenance links: ${provenance.length}` }] };
  }

  return { ...meta, error: `Unsupported format: ${format}` };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
function getTools() {
  return [
    // -- Core --
    {
      name: 'exec.health',
      title: 'Execution Plugin Health',
      description: 'Returns plugin name/version and server timestamp.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'exec.sha256',
      title: 'SHA-256 (UTF-8)',
      description: 'Computes SHA-256 hex digest of the provided UTF-8 string.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Input string to hash.' } },
        required: ['text'],
        additionalProperties: false,
      },
    },

    // -- DB --
    {
      name: 'exec.db.get',
      title: 'DB Get',
      description: 'Get first document matching query from a collection.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection name.' },
          query: { type: 'object', description: 'Key-value query filter.' },
        },
        required: ['collection', 'query'],
        additionalProperties: false,
      },
    },
    {
      name: 'exec.db.set',
      title: 'DB Set (Upsert)',
      description: 'Insert or update a document in a collection. Upserts by _id.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection name.' },
          doc: { type: 'object', description: 'Document to upsert. Include _id to update existing.' },
        },
        required: ['collection', 'doc'],
        additionalProperties: false,
      },
    },
    {
      name: 'exec.db.delete',
      title: 'DB Delete',
      description: 'Delete documents matching query from a collection.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection name.' },
          query: { type: 'object', description: 'Key-value query filter for docs to delete.' },
        },
        required: ['collection', 'query'],
        additionalProperties: false,
      },
    },
    {
      name: 'exec.db.list',
      title: 'DB List',
      description: 'List documents in a collection, optionally filtered by query.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection name.' },
          query: { type: 'object', description: 'Optional key-value filter.' },
          limit: { type: 'number', description: 'Max documents to return.' },
        },
        required: ['collection'],
        additionalProperties: false,
      },
    },

    // -- Pipeline --
    {
      name: 'exec.pipeline.run',
      title: 'Run Full Pipeline',
      description: 'Runs the 5-stage execution pipeline: seed -> sources -> ingest -> seed_data -> generate.',
      inputSchema: {
        type: 'object',
        properties: { period: { type: 'string', description: 'Reporting period (e.g. "2025").' } },
        additionalProperties: false,
      },
    },
    {
      name: 'exec.pipeline.stage',
      title: 'Run Single Pipeline Stage',
      description: 'Run a single pipeline stage.',
      inputSchema: {
        type: 'object',
        properties: {
          stage: { type: 'string', enum: ['seed', 'sources', 'ingest', 'seed_data', 'generate'], description: 'Stage to run.' },
        },
        required: ['stage'],
        additionalProperties: false,
      },
    },

    // -- Documents --
    {
      name: 'exec.render_page',
      title: 'Render PDF Page',
      description: 'Render a specific page of a stored PDF document.',
      inputSchema: {
        type: 'object',
        properties: {
          doc_id: { type: 'string', description: 'Document ID.' },
          page_number: { type: 'number', description: 'Page number (1-based).' },
          zoom: { type: 'number', description: 'Zoom factor (default 1.0).' },
        },
        required: ['doc_id', 'page_number'],
        additionalProperties: false,
      },
    },
    {
      name: 'exec.ocr',
      title: 'OCR Page',
      description: 'Run OCR on a rendered PDF page and return text blocks with confidence scores.',
      inputSchema: {
        type: 'object',
        properties: {
          doc_id: { type: 'string', description: 'Document ID.' },
          page_number: { type: 'number', description: 'Page number (1-based).' },
        },
        required: ['doc_id', 'page_number'],
        additionalProperties: false,
      },
    },
    {
      name: 'exec.upload_pdf',
      title: 'Upload PDF',
      description: 'Register a PDF document in the store.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Original filename.' },
          title: { type: 'string', description: 'Document title.' },
          company_id: { type: 'string', description: 'Owning company/supplier ID.' },
          category: { type: 'string', description: 'Document category (e.g. sustainability_report, cdp_response).' },
        },
        required: ['filename'],
        additionalProperties: false,
      },
    },

    // -- Engagements --
    {
      name: 'exec.engagement.update',
      title: 'Update Engagement',
      description: 'Update a supplier engagement status.',
      inputSchema: {
        type: 'object',
        properties: {
          supplier_id: { type: 'string', description: 'Supplier ID.' },
          status: { type: 'string', enum: ['not_started', 'in_progress', 'pending_response', 'completed', 'on_hold'], description: 'New engagement status.' },
        },
        required: ['supplier_id', 'status'],
        additionalProperties: false,
      },
    },
    {
      name: 'exec.engagement.list',
      title: 'List Engagements',
      description: 'List all supplier engagements.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },

    // -- Suppliers --
    {
      name: 'exec.suppliers.list',
      title: 'List Suppliers',
      description: 'List suppliers, optionally filtered by category, rating, or minimum impact.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category.' },
          rating: { type: 'string', description: 'Filter by CEE rating (A-E).' },
          min_impact: { type: 'number', description: 'Minimum upstream impact percentage.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'exec.suppliers.heatmap',
      title: 'Supplier Heatmap',
      description: 'Generate a heatmap summary of suppliers by category and rating.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },

    // -- Provenance --
    {
      name: 'exec.provenance.save',
      title: 'Save Provenance',
      description: 'Create a field-level provenance link between a data field and a source document + OCR blocks.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_type: { type: 'string', description: 'Entity type (e.g. supplier, emission_factor, benchmark).' },
          entity_id: { type: 'string', description: 'Entity ID.' },
          field_key: { type: 'string', description: 'Field being cited (e.g. scope1_emissions).' },
          doc_id: { type: 'string', description: 'Source document ID.' },
          page_number: { type: 'number', description: 'Page number in source document.' },
          ocr_block_ids: { type: 'array', items: { type: 'string' }, description: 'OCR block IDs referenced.' },
          value: { type: 'string', description: 'Extracted value.' },
          unit: { type: 'string', description: 'Unit of measure.' },
        },
        required: ['entity_type', 'entity_id', 'field_key', 'doc_id', 'page_number', 'ocr_block_ids'],
        additionalProperties: false,
      },
    },
    {
      name: 'exec.provenance.list',
      title: 'List Provenance',
      description: 'List provenance records for an entity.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_type: { type: 'string', description: 'Entity type.' },
          entity_id: { type: 'string', description: 'Entity ID.' },
        },
        required: ['entity_type', 'entity_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'exec.provenance.delete',
      title: 'Delete Provenance',
      description: 'Delete a provenance record by ID.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Provenance record _id.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },

    // -- Analysis --
    {
      name: 'exec.maturity_score',
      title: 'Supplier Maturity Score',
      description: 'Compute the maturity scorecard for a supplier (M0-M4).',
      inputSchema: {
        type: 'object',
        properties: { supplier_id: { type: 'string', description: 'Supplier ID.' } },
        required: ['supplier_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'exec.quality_gates',
      title: 'Quality Gates',
      description: 'Run quality gate checks for a pipeline run.',
      inputSchema: {
        type: 'object',
        properties: { run_id: { type: 'string', description: 'Pipeline run ID (defaults to "latest").' } },
        additionalProperties: false,
      },
    },

    // -- Export --
    {
      name: 'exec.export',
      title: 'Export Data',
      description: 'Export execution data in CSRD, GHG Protocol, PDF manifest, or raw JSON format.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['csrd', 'ghg', 'pdf', 'json'], description: 'Export format.' },
          period: { type: 'string', description: 'Reporting period.' },
        },
        required: ['format'],
        additionalProperties: false,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// MCP framing
// ---------------------------------------------------------------------------
function send(message) {
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
  return { content: [{ type: 'text', text: String(text) }], isError: false };
}

function toolJSON(obj) {
  return toolTextResult(JSON.stringify(obj, null, 2));
}

function toolError(msg) {
  return { content: [{ type: 'text', text: String(msg) }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------
async function callTool(toolName, args) {
  // -- Core --
  if (toolName === 'exec.health') {
    return toolJSON({
      plugin: { name: PLUGIN.name, version: PLUGIN.version },
      server: SERVER_INFO,
      timestamp: nowISO(),
      data_dir: DATA_DIR,
    });
  }

  if (toolName === 'exec.sha256') {
    const text = typeof args?.text === 'string' ? args.text : typeof args?.input === 'string' ? args.input : undefined;
    if (typeof text !== 'string') throw Object.assign(new Error('Missing arguments.text'), { code: -32602 });
    return toolTextResult(sha256HexUtf8(text));
  }

  // -- DB --
  if (toolName === 'exec.db.get') {
    const collection = requireString(args, 'collection');
    const query = optObject(args, 'query', {});
    const doc = store.get(collection, query);
    return toolJSON({ found: doc !== null, doc });
  }

  if (toolName === 'exec.db.set') {
    const collection = requireString(args, 'collection');
    const doc = args?.doc;
    if (!doc || typeof doc !== 'object') throw Object.assign(new Error('Missing arguments.doc object'), { code: -32602 });
    const saved = store.set(collection, doc);
    return toolJSON({ ok: true, doc: saved });
  }

  if (toolName === 'exec.db.delete') {
    const collection = requireString(args, 'collection');
    const query = optObject(args, 'query', {});
    if (Object.keys(query).length === 0) throw Object.assign(new Error('Empty query would delete all -- provide a filter'), { code: -32602 });
    const count = store.delete(collection, query);
    return toolJSON({ ok: true, deleted: count });
  }

  if (toolName === 'exec.db.list') {
    const collection = requireString(args, 'collection');
    const query = optObject(args, 'query', undefined);
    const limit = optNumber(args, 'limit', 0);
    const docs = store.list(collection, query, limit);
    return toolJSON({ collection, count: docs.length, docs });
  }

  // -- Pipeline --
  if (toolName === 'exec.pipeline.run') {
    const period = optString(args, 'period', 'latest');
    const runId = `run_${period}_${Date.now()}`;
    const results = [];
    for (const stage of PIPELINE_STAGES) {
      results.push(runStage(stage, runId));
    }
    return toolJSON({ run_id: runId, period, stages: results, message: 'Pipeline run complete' });
  }

  if (toolName === 'exec.pipeline.stage') {
    const stage = requireString(args, 'stage');
    if (!PIPELINE_STAGES.includes(stage)) {
      return toolError(`Invalid stage: ${stage}. Must be one of: ${PIPELINE_STAGES.join(', ')}`);
    }
    const runId = `stage_${stage}_${Date.now()}`;
    const result = runStage(stage, runId);
    return toolJSON(result);
  }

  // -- Documents --
  if (toolName === 'exec.render_page') {
    const docId = requireString(args, 'doc_id');
    const pageNumber = optNumber(args, 'page_number', 1);
    const zoom = optNumber(args, 'zoom', 1.0);

    const doc = store.get('documents', { _id: docId });
    if (!doc) return toolError(`Document not found: ${docId}`);

    // Simulated render -- no actual PDF rendering, return metadata
    const renderId = crypto.randomUUID();
    const renderRecord = {
      _id: renderId,
      doc_id: docId,
      page_number: pageNumber,
      zoom,
      width: Math.round(612 * zoom),
      height: Math.round(792 * zoom),
      rendered_at: nowISO(),
    };
    store.set('renders', renderRecord);
    return toolJSON({ ok: true, render: renderRecord, note: 'Simulated render -- no actual image produced in local mode.' });
  }

  if (toolName === 'exec.ocr') {
    const docId = requireString(args, 'doc_id');
    const pageNumber = optNumber(args, 'page_number', 1);

    const doc = store.get('documents', { _id: docId });
    if (!doc) return toolError(`Document not found: ${docId}`);

    // Return deterministic pseudo-blocks
    const blockCount = 5;
    const blocks = [];
    for (let i = 0; i < blockCount; i++) {
      blocks.push({
        block_id: `${docId}_p${pageNumber}_b${i}`,
        text: `[simulated OCR block ${i + 1} for ${doc.filename ?? docId} page ${pageNumber}]`,
        confidence: +(0.85 + Math.random() * 0.14).toFixed(3),
        bbox: [50 + i * 10, 50 + i * 100, 550 - i * 10, 130 + i * 100],
      });
    }

    // Persist OCR blocks
    for (const b of blocks) {
      store.set('ocr_blocks', { _id: b.block_id, doc_id: docId, page_number: pageNumber, ...b });
    }

    return toolJSON({ doc_id: docId, page_number: pageNumber, block_count: blocks.length, blocks });
  }

  if (toolName === 'exec.upload_pdf') {
    const filename = requireString(args, 'filename');
    const title = optString(args, 'title', filename);
    const companyId = optString(args, 'company_id', undefined);
    const category = optString(args, 'category', 'general');

    const docId = crypto.randomUUID();
    const doc = store.set('documents', {
      _id: docId,
      filename,
      title,
      company_id: companyId,
      category,
      mime_type: 'application/pdf',
      ingested: false,
      uploaded_at: nowISO(),
    });
    return toolJSON({ ok: true, doc_id: docId, doc });
  }

  // -- Engagements --
  if (toolName === 'exec.engagement.update') {
    const supplierId = requireString(args, 'supplier_id');
    const status = requireString(args, 'status');
    const validStatuses = ['not_started', 'in_progress', 'pending_response', 'completed', 'on_hold'];
    if (!validStatuses.includes(status)) {
      return toolError(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }

    // Upsert engagement
    const existing = store.get('engagements', { supplier_id: supplierId });
    const engagement = store.set('engagements', {
      _id: existing?._id ?? crypto.randomUUID(),
      supplier_id: supplierId,
      status,
      updated_at: nowISO(),
    });
    return toolJSON({ ok: true, engagement });
  }

  if (toolName === 'exec.engagement.list') {
    const engagements = store.list('engagements');
    return toolJSON({ count: engagements.length, engagements });
  }

  // -- Suppliers --
  if (toolName === 'exec.suppliers.list') {
    let suppliers = store.list('suppliers');
    const category = optString(args, 'category', undefined);
    const rating = optString(args, 'rating', undefined);
    const minImpact = optNumber(args, 'min_impact', undefined);

    if (category) suppliers = suppliers.filter((s) => s.category === category);
    if (rating) suppliers = suppliers.filter((s) => s.cee_rating === rating);
    if (typeof minImpact === 'number') suppliers = suppliers.filter((s) => (s.upstream_impact_pct ?? 0) >= minImpact);

    return toolJSON({ count: suppliers.length, suppliers });
  }

  if (toolName === 'exec.suppliers.heatmap') {
    const suppliers = store.list('suppliers');
    const heatmap = {};
    for (const s of suppliers) {
      const cat = s.category ?? 'unknown';
      const rating = s.cee_rating ?? 'unrated';
      if (!heatmap[cat]) heatmap[cat] = {};
      if (!heatmap[cat][rating]) heatmap[cat][rating] = 0;
      heatmap[cat][rating]++;
    }
    return toolJSON({ total_suppliers: suppliers.length, heatmap });
  }

  // -- Provenance --
  if (toolName === 'exec.provenance.save') {
    const entityType = requireString(args, 'entity_type');
    const entityId = requireString(args, 'entity_id');
    const fieldKey = requireString(args, 'field_key');
    const docId = requireString(args, 'doc_id');
    const pageNumber = optNumber(args, 'page_number', 1);
    const ocrBlockIds = Array.isArray(args?.ocr_block_ids) ? args.ocr_block_ids : [];
    const value = optString(args, 'value', undefined);
    const unit = optString(args, 'unit', undefined);

    if (pageNumber < 1) return toolError('page_number must be >= 1');

    // Validate OCR blocks exist if any provided
    for (const blockId of ocrBlockIds) {
      const block = store.get('ocr_blocks', { _id: blockId });
      if (!block) return toolError(`OCR block not found: ${blockId}`);
      if (block.doc_id !== docId || block.page_number !== pageNumber) {
        return toolError(`OCR block ${blockId} does not match doc_id/page_number`);
      }
    }

    // Compute min confidence from referenced blocks
    let ocrConfMin = null;
    if (ocrBlockIds.length > 0) {
      const confs = ocrBlockIds.map((bid) => {
        const b = store.get('ocr_blocks', { _id: bid });
        return b?.confidence ?? 0;
      });
      ocrConfMin = Math.min(...confs);
    }

    const record = store.set('provenance', {
      _id: crypto.randomUUID(),
      entity_type: entityType,
      entity_id: entityId,
      field_key: fieldKey,
      doc_id: docId,
      page_number: pageNumber,
      ocr_block_ids: ocrBlockIds,
      ocr_confidence_min: ocrConfMin,
      value,
      unit,
      created_at: nowISO(),
    });

    return toolJSON({ ok: true, provenance: record });
  }

  if (toolName === 'exec.provenance.list') {
    const entityType = requireString(args, 'entity_type');
    const entityId = requireString(args, 'entity_id');
    const records = store.list('provenance', { entity_type: entityType, entity_id: entityId });
    return toolJSON({ entity_type: entityType, entity_id: entityId, count: records.length, records });
  }

  if (toolName === 'exec.provenance.delete') {
    const id = requireString(args, 'id');
    const count = store.delete('provenance', { _id: id });
    return toolJSON({ ok: true, deleted: count });
  }

  // -- Analysis --
  if (toolName === 'exec.maturity_score') {
    const supplierId = requireString(args, 'supplier_id');
    const result = computeMaturityScore(supplierId);
    if (result.error) return toolError(result.error);
    return toolJSON(result);
  }

  if (toolName === 'exec.quality_gates') {
    const runId = optString(args, 'run_id', 'latest');
    const result = runQualityGates(runId);
    return toolJSON(result);
  }

  // -- Export --
  if (toolName === 'exec.export') {
    const format = requireString(args, 'format');
    const validFormats = ['csrd', 'ghg', 'pdf', 'json'];
    if (!validFormats.includes(format)) return toolError(`Invalid format: ${format}. Must be one of: ${validFormats.join(', ')}`);
    const period = optString(args, 'period', undefined);
    const result = buildExport(format, period);
    return toolJSON(result);
  }

  return null; // not found
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
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
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions:
        'MCP server for scope3-execution. Provides DB CRUD, pipeline orchestration, PDF upload/render/OCR, supplier engagement & maturity scoring, provenance tracking, quality gates, and multi-format export.',
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

    try {
      const result = await callTool(toolName, args);
      if (result === null) {
        respondError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }
      respondResult(id, result);
    } catch (err) {
      const code = typeof err?.code === 'number' ? err.code : -32603;
      respondError(id, code, err?.message ?? 'Internal error');
    }
    return;
  }

  respondError(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// stdin parser (LSP framing)
// ---------------------------------------------------------------------------
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
    } catch (_err) {
      respondError(null, -32700, 'Parse error');
      continue;
    }

    Promise.resolve(handleMessage(msg)).catch((err) => {
      const reqId = Object.prototype.hasOwnProperty.call(msg, 'id') ? msg.id : null;
      if (reqId !== null && reqId !== undefined) respondError(reqId, -32603, 'Internal error');
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
