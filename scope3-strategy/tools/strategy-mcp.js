#!/usr/bin/env node
/* eslint-disable no-console */

// Scope3 Strategy MCP Server (Model Context Protocol) - stdio transport.
// Implements: initialize, tools/list, tools/call
// Transport framing: LSP-style headers with Content-Length.
// No external dependencies - Node built-ins only.

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

// ---------------------------------------------------------------------------
// FileStore - simple JSON-file-backed persistence
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "..", "data");

class FileStore {
  constructor(dataDir) {
    this._dir = dataDir;
    if (!fs.existsSync(this._dir)) {
      fs.mkdirSync(this._dir, { recursive: true });
    }
  }

  _collectionPath(collection) {
    // Sanitize collection name to prevent path traversal
    const safe = String(collection).replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this._dir, `${safe}.json`);
  }

  _readCollection(collection) {
    const filePath = this._collectionPath(collection);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  _writeCollection(collection, docs) {
    const filePath = this._collectionPath(collection);
    fs.writeFileSync(filePath, JSON.stringify(docs, null, 2), "utf8");
  }

  _matchesQuery(doc, query) {
    if (!query || Object.keys(query).length === 0) return true;
    for (const [key, val] of Object.entries(query)) {
      if (doc[key] !== val) return false;
    }
    return true;
  }

  get(collection, query) {
    const docs = this._readCollection(collection);
    return docs.find((d) => this._matchesQuery(d, query)) || null;
  }

  set(collection, doc) {
    if (!doc || typeof doc !== "object") throw new Error("doc must be an object");
    const docs = this._readCollection(collection);
    if (!doc._id) {
      doc._id = crypto.randomUUID();
    }
    const idx = docs.findIndex((d) => d._id === doc._id);
    if (idx >= 0) {
      docs[idx] = { ...docs[idx], ...doc, updated_at: new Date().toISOString() };
    } else {
      doc.created_at = new Date().toISOString();
      doc.updated_at = doc.created_at;
      docs.push(doc);
    }
    this._writeCollection(collection, docs);
    return idx >= 0 ? docs[idx] : doc;
  }

  delete(collection, query) {
    const docs = this._readCollection(collection);
    const remaining = docs.filter((d) => !this._matchesQuery(d, query));
    const removed = docs.length - remaining.length;
    this._writeCollection(collection, remaining);
    return { removed };
  }

  list(collection, query, limit) {
    const docs = this._readCollection(collection);
    let results = query ? docs.filter((d) => this._matchesQuery(d, query)) : docs;
    if (typeof limit === "number" && limit > 0) {
      results = results.slice(0, limit);
    }
    return results;
  }
}

const store = new FileStore(DATA_DIR);

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function uid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function textResult(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function errorResult(msg) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  // --- Existing tools ---
  {
    name: "strategy.health",
    description: "Basic health check for the scope3 strategy MCP server.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "strategy.sha256",
    description: "Compute SHA-256 hex digest of provided UTF-8 text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to hash (UTF-8)." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  // --- DB tools ---
  {
    name: "strategy.db.get",
    description: "Retrieve a single document from a collection matching query.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        query: { type: "object", description: "Key-value query to match." },
      },
      required: ["collection", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.db.set",
    description: "Upsert a document into a collection. If doc has _id and matches existing, updates it; otherwise inserts.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        doc: { type: "object", description: "Document to upsert. Include _id to update existing." },
      },
      required: ["collection", "doc"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.db.delete",
    description: "Delete documents from a collection matching query.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        query: { type: "object", description: "Key-value query to match for deletion." },
      },
      required: ["collection", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.db.list",
    description: "List documents from a collection, optionally filtered by query and limited.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        query: { type: "object", description: "Optional key-value filter." },
        limit: { type: "number", description: "Max documents to return." },
      },
      required: ["collection"],
      additionalProperties: false,
    },
  },
  // --- Assessment tools ---
  {
    name: "strategy.assessment.create",
    description: "Create a new DMA assessment for an organization and year.",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string", description: "Organization identifier." },
        year: { type: "number", description: "Reporting year." },
      },
      required: ["org_id", "year"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.assessment.get",
    description: "Retrieve a DMA assessment by its ID.",
    inputSchema: {
      type: "object",
      properties: {
        assessment_id: { type: "string", description: "Assessment identifier." },
      },
      required: ["assessment_id"],
      additionalProperties: false,
    },
  },
  // --- IRO tools ---
  {
    name: "strategy.iro.list",
    description: "List all IROs (Impacts, Risks, Opportunities) for a given assessment.",
    inputSchema: {
      type: "object",
      properties: {
        assessment_id: { type: "string", description: "Assessment identifier." },
      },
      required: ["assessment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.iro.create",
    description: "Create a new IRO linked to an assessment.",
    inputSchema: {
      type: "object",
      properties: {
        assessment_id: { type: "string", description: "Assessment identifier." },
        type: { type: "string", description: "IRO type: impact, risk, or opportunity." },
        topic: { type: "string", description: "ESRS topic code (e.g. E1, S1, G1)." },
        title: { type: "string", description: "Descriptive title for this IRO." },
      },
      required: ["assessment_id", "type", "topic", "title"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.iro.score",
    description: "Score an IRO with impact and financial materiality values.",
    inputSchema: {
      type: "object",
      properties: {
        iro_id: { type: "string", description: "IRO identifier." },
        impact_materiality: { type: "number", description: "Impact materiality score (1-5)." },
        financial_materiality: { type: "number", description: "Financial materiality score (1-5)." },
        likelihood: { type: "number", description: "Optional likelihood score (1-5)." },
        confidence: { type: "string", description: "Confidence level: low, medium, high." },
      },
      required: ["iro_id", "impact_materiality", "financial_materiality"],
      additionalProperties: false,
    },
  },
  // --- Evidence ---
  {
    name: "strategy.evidence.add",
    description: "Attach stakeholder evidence to an IRO.",
    inputSchema: {
      type: "object",
      properties: {
        iro_id: { type: "string", description: "IRO identifier." },
        source: { type: "string", description: "Evidence source name or URL." },
        stakeholder_type: { type: "string", enum: ["internal", "external"], description: "Whether source is internal or external." },
        description: { type: "string", description: "Description of the evidence." },
      },
      required: ["iro_id", "source", "stakeholder_type", "description"],
      additionalProperties: false,
    },
  },
  // --- Analytical tools ---
  {
    name: "strategy.materiality_matrix",
    description: "Generate materiality matrix from scored IROs for an assessment. Classifies each IRO into quadrants based on impact and financial materiality thresholds.",
    inputSchema: {
      type: "object",
      properties: {
        assessment_id: { type: "string", description: "Assessment identifier." },
      },
      required: ["assessment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.esrs_sequence",
    description: "Compute ESRS materiality sequencing from assessed IROs. Groups material topics by ESRS standard and orders by combined materiality score.",
    inputSchema: {
      type: "object",
      properties: {
        assessment_id: { type: "string", description: "Assessment identifier." },
      },
      required: ["assessment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.snapshot",
    description: "Create an immutable snapshot of an assessment. Optionally finalize to lock further mutations.",
    inputSchema: {
      type: "object",
      properties: {
        assessment_id: { type: "string", description: "Assessment identifier." },
        finalize: { type: "boolean", description: "If true, finalize the assessment (irreversible)." },
      },
      required: ["assessment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.risk_scan",
    description: "Simulate external risk intelligence scan across regulatory, media, and NGO channels.",
    inputSchema: {
      type: "object",
      properties: {
        org_id: { type: "string", description: "Organization identifier." },
        keywords: { type: "array", items: { type: "string" }, description: "Optional keywords to focus the scan." },
      },
      required: ["org_id"],
      additionalProperties: false,
    },
  },
  {
    name: "strategy.export",
    description: "Export an assessment as JSON or evidence pack.",
    inputSchema: {
      type: "object",
      properties: {
        assessment_id: { type: "string", description: "Assessment identifier." },
        format: { type: "string", enum: ["json", "evidence_pack"], description: "Export format." },
      },
      required: ["assessment_id", "format"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function handleHealth() {
  return textResult({
    ok: true,
    name: SERVER_NAME,
    version: SERVER_VERSION,
    pid: process.pid,
    timestamp: now(),
    collections_dir: DATA_DIR,
  });
}

function handleSha256(args) {
  if (typeof args?.text !== "string") return errorResult("Missing required argument: text (string)");
  return textResult(sha256Hex(args.text));
}

// --- DB handlers ---

function handleDbGet(args) {
  if (!args?.collection) return errorResult("Missing required argument: collection");
  if (!args?.query) return errorResult("Missing required argument: query");
  const doc = store.get(args.collection, args.query);
  if (!doc) return textResult({ found: false, doc: null });
  return textResult({ found: true, doc });
}

function handleDbSet(args) {
  if (!args?.collection) return errorResult("Missing required argument: collection");
  if (!args?.doc || typeof args.doc !== "object") return errorResult("Missing required argument: doc (object)");
  const doc = store.set(args.collection, args.doc);
  return textResult({ ok: true, doc });
}

function handleDbDelete(args) {
  if (!args?.collection) return errorResult("Missing required argument: collection");
  if (!args?.query) return errorResult("Missing required argument: query");
  const result = store.delete(args.collection, args.query);
  return textResult({ ok: true, ...result });
}

function handleDbList(args) {
  if (!args?.collection) return errorResult("Missing required argument: collection");
  const docs = store.list(args.collection, args.query, args.limit);
  return textResult({ count: docs.length, docs });
}

// --- Assessment handlers ---

function handleAssessmentCreate(args) {
  if (!args?.org_id) return errorResult("Missing required argument: org_id");
  if (typeof args?.year !== "number") return errorResult("Missing required argument: year (number)");

  // Check for duplicate active assessment
  const existing = store.get("assessments", { org_id: args.org_id, year: args.year });
  if (existing && !existing.finalized) {
    return errorResult(`Active assessment already exists for org ${args.org_id} year ${args.year}: ${existing._id}`);
  }

  const assessment = store.set("assessments", {
    _id: `asmt_${uid()}`,
    org_id: args.org_id,
    year: args.year,
    status: "draft",
    finalized: false,
    snapshot_count: 0,
  });

  return textResult({ ok: true, assessment });
}

function handleAssessmentGet(args) {
  if (!args?.assessment_id) return errorResult("Missing required argument: assessment_id");
  const assessment = store.get("assessments", { _id: args.assessment_id });
  if (!assessment) return errorResult(`Assessment not found: ${args.assessment_id}`);
  return textResult({ assessment });
}

// --- IRO handlers ---

function handleIroList(args) {
  if (!args?.assessment_id) return errorResult("Missing required argument: assessment_id");
  const assessment = store.get("assessments", { _id: args.assessment_id });
  if (!assessment) return errorResult(`Assessment not found: ${args.assessment_id}`);
  const iros = store.list("iros", { assessment_id: args.assessment_id });
  return textResult({ count: iros.length, iros });
}

function handleIroCreate(args) {
  if (!args?.assessment_id) return errorResult("Missing required argument: assessment_id");
  if (!args?.type) return errorResult("Missing required argument: type");
  if (!args?.topic) return errorResult("Missing required argument: topic");
  if (!args?.title) return errorResult("Missing required argument: title");

  const validTypes = ["impact", "risk", "opportunity"];
  if (!validTypes.includes(args.type)) return errorResult(`type must be one of: ${validTypes.join(", ")}`);

  const assessment = store.get("assessments", { _id: args.assessment_id });
  if (!assessment) return errorResult(`Assessment not found: ${args.assessment_id}`);
  if (assessment.finalized) return errorResult("409 DMA assessment is finalized");

  const iro = store.set("iros", {
    _id: `iro_${uid()}`,
    assessment_id: args.assessment_id,
    org_id: assessment.org_id,
    type: args.type,
    topic: args.topic,
    title: args.title,
    scores: null,
    evidence_count: 0,
  });

  return textResult({ ok: true, iro });
}

function handleIroScore(args) {
  if (!args?.iro_id) return errorResult("Missing required argument: iro_id");
  if (typeof args?.impact_materiality !== "number") return errorResult("Missing required argument: impact_materiality (number)");
  if (typeof args?.financial_materiality !== "number") return errorResult("Missing required argument: financial_materiality (number)");

  if (args.impact_materiality < 1 || args.impact_materiality > 5) return errorResult("impact_materiality must be between 1 and 5");
  if (args.financial_materiality < 1 || args.financial_materiality > 5) return errorResult("financial_materiality must be between 1 and 5");

  const iro = store.get("iros", { _id: args.iro_id });
  if (!iro) return errorResult(`IRO not found: ${args.iro_id}`);

  const assessment = store.get("assessments", { _id: iro.assessment_id });
  if (assessment?.finalized) return errorResult("409 DMA assessment is finalized");

  const scores = {
    impact_materiality: args.impact_materiality,
    financial_materiality: args.financial_materiality,
  };
  if (typeof args.likelihood === "number") {
    if (args.likelihood < 1 || args.likelihood > 5) return errorResult("likelihood must be between 1 and 5");
    scores.likelihood = args.likelihood;
  }
  if (args.confidence) {
    const validConf = ["low", "medium", "high"];
    if (!validConf.includes(args.confidence)) return errorResult(`confidence must be one of: ${validConf.join(", ")}`);
    scores.confidence = args.confidence;
  }
  scores.scored_at = now();

  iro.scores = scores;
  store.set("iros", iro);

  return textResult({ ok: true, iro });
}

// --- Evidence handler ---

function handleEvidenceAdd(args) {
  if (!args?.iro_id) return errorResult("Missing required argument: iro_id");
  if (!args?.source) return errorResult("Missing required argument: source");
  if (!args?.stakeholder_type) return errorResult("Missing required argument: stakeholder_type");
  if (!args?.description) return errorResult("Missing required argument: description");

  if (!["internal", "external"].includes(args.stakeholder_type)) {
    return errorResult("stakeholder_type must be 'internal' or 'external'");
  }

  const iro = store.get("iros", { _id: args.iro_id });
  if (!iro) return errorResult(`IRO not found: ${args.iro_id}`);

  const assessment = store.get("assessments", { _id: iro.assessment_id });
  if (assessment?.finalized) return errorResult("409 DMA assessment is finalized");

  // Check for duplicate evidence (same source + iro)
  const existing = store.get("evidence", { iro_id: args.iro_id, source_hash: sha256Hex(args.source) });
  if (existing) return errorResult("409 Evidence already attached");

  const evidence = store.set("evidence", {
    _id: `ev_${uid()}`,
    iro_id: args.iro_id,
    assessment_id: iro.assessment_id,
    source: args.source,
    source_hash: sha256Hex(args.source),
    stakeholder_type: args.stakeholder_type,
    description: args.description,
    captured_at: now(),
  });

  // Increment evidence count on IRO
  iro.evidence_count = (iro.evidence_count || 0) + 1;
  store.set("iros", iro);

  return textResult({ ok: true, evidence });
}

// --- Materiality matrix ---

function handleMaterialityMatrix(args) {
  if (!args?.assessment_id) return errorResult("Missing required argument: assessment_id");

  const assessment = store.get("assessments", { _id: args.assessment_id });
  if (!assessment) return errorResult(`Assessment not found: ${args.assessment_id}`);

  const iros = store.list("iros", { assessment_id: args.assessment_id });
  const scored = iros.filter((i) => i.scores);
  const unscored = iros.filter((i) => !i.scores);

  if (scored.length === 0) return errorResult("No scored IROs found. Score IROs before generating the matrix.");

  const THRESHOLD = 3;
  const quadrants = {
    material: [],       // both >= 3
    impact_only: [],    // impact >= 3, financial < 3
    financial_only: [], // financial >= 3, impact < 3
    not_material: [],   // both < 3
  };

  for (const iro of scored) {
    const im = iro.scores.impact_materiality;
    const fm = iro.scores.financial_materiality;

    const entry = {
      iro_id: iro._id,
      title: iro.title,
      type: iro.type,
      topic: iro.topic,
      impact_materiality: im,
      financial_materiality: fm,
      likelihood: iro.scores.likelihood || null,
      confidence: iro.scores.confidence || null,
      evidence_count: iro.evidence_count || 0,
    };

    if (im >= THRESHOLD && fm >= THRESHOLD) {
      entry.quadrant = "material";
      quadrants.material.push(entry);
    } else if (im >= THRESHOLD) {
      entry.quadrant = "impact_only";
      quadrants.impact_only.push(entry);
    } else if (fm >= THRESHOLD) {
      entry.quadrant = "financial_only";
      quadrants.financial_only.push(entry);
    } else {
      entry.quadrant = "not_material";
      quadrants.not_material.push(entry);
    }
  }

  // Sort each quadrant by combined score descending
  for (const key of Object.keys(quadrants)) {
    quadrants[key].sort((a, b) =>
      (b.impact_materiality + b.financial_materiality) - (a.impact_materiality + a.financial_materiality)
    );
  }

  const matrix = {
    assessment_id: args.assessment_id,
    org_id: assessment.org_id,
    year: assessment.year,
    generated_at: now(),
    threshold: THRESHOLD,
    total_iros: iros.length,
    scored_count: scored.length,
    unscored_count: unscored.length,
    summary: {
      material: quadrants.material.length,
      impact_only: quadrants.impact_only.length,
      financial_only: quadrants.financial_only.length,
      not_material: quadrants.not_material.length,
    },
    quadrants,
  };

  // Persist the matrix result
  store.set("matrices", {
    _id: `mtx_${uid()}`,
    assessment_id: args.assessment_id,
    ...matrix,
  });

  return textResult(matrix);
}

// --- ESRS Sequencing ---

function handleEsrsSequence(args) {
  if (!args?.assessment_id) return errorResult("Missing required argument: assessment_id");

  const assessment = store.get("assessments", { _id: args.assessment_id });
  if (!assessment) return errorResult(`Assessment not found: ${args.assessment_id}`);

  const iros = store.list("iros", { assessment_id: args.assessment_id });
  const scored = iros.filter((i) => i.scores);

  if (scored.length === 0) return errorResult("No scored IROs. Score IROs before computing ESRS sequencing.");

  // ESRS topic mapping
  const esrsStandards = {
    E1: "Climate change",
    E2: "Pollution",
    E3: "Water and marine resources",
    E4: "Biodiversity and ecosystems",
    E5: "Resource use and circular economy",
    S1: "Own workforce",
    S2: "Workers in the value chain",
    S3: "Affected communities",
    S4: "Consumers and end-users",
    G1: "Business conduct",
  };

  // Group by topic
  const topicGroups = {};
  for (const iro of scored) {
    const topic = iro.topic;
    if (!topicGroups[topic]) {
      topicGroups[topic] = {
        topic,
        standard_name: esrsStandards[topic] || "Unknown",
        iros: [],
        max_impact: 0,
        max_financial: 0,
        combined_score: 0,
        is_material: false,
      };
    }
    const g = topicGroups[topic];
    const im = iro.scores.impact_materiality;
    const fm = iro.scores.financial_materiality;
    g.iros.push({
      iro_id: iro._id,
      title: iro.title,
      type: iro.type,
      impact_materiality: im,
      financial_materiality: fm,
    });
    g.max_impact = Math.max(g.max_impact, im);
    g.max_financial = Math.max(g.max_financial, fm);
    g.combined_score += im + fm;
    if (im >= 3 || fm >= 3) g.is_material = true;
  }

  // Sequence: material first, sorted by combined score descending
  const groups = Object.values(topicGroups);
  groups.sort((a, b) => {
    if (a.is_material !== b.is_material) return a.is_material ? -1 : 1;
    return b.combined_score - a.combined_score;
  });

  const sequence = groups.map((g, idx) => ({
    sequence_order: idx + 1,
    topic: g.topic,
    standard_name: g.standard_name,
    is_material: g.is_material,
    iro_count: g.iros.length,
    max_impact: g.max_impact,
    max_financial: g.max_financial,
    combined_score: g.combined_score,
    iros: g.iros,
  }));

  const result = {
    assessment_id: args.assessment_id,
    org_id: assessment.org_id,
    year: assessment.year,
    generated_at: now(),
    material_topics: sequence.filter((s) => s.is_material).length,
    total_topics: sequence.length,
    sequence,
  };

  return textResult(result);
}

// --- Snapshot ---

function handleSnapshot(args) {
  if (!args?.assessment_id) return errorResult("Missing required argument: assessment_id");

  const assessment = store.get("assessments", { _id: args.assessment_id });
  if (!assessment) return errorResult(`Assessment not found: ${args.assessment_id}`);

  if (assessment.finalized && args.finalize) {
    return errorResult("409 DMA assessment is finalized");
  }

  const iros = store.list("iros", { assessment_id: args.assessment_id });
  const evidence = store.list("evidence", { assessment_id: args.assessment_id });

  // Finalization gate: every IRO must have at least 1 evidence link
  if (args.finalize) {
    const zeroEvidence = iros.filter((i) => (i.evidence_count || 0) === 0);
    if (zeroEvidence.length > 0) {
      return errorResult(
        `Finalization blocked: ${zeroEvidence.length} IRO(s) have zero evidence links: ${zeroEvidence.map((i) => i._id).join(", ")}`
      );
    }
  }

  // Build snapshot payload
  const snapshotData = {
    assessment,
    iros,
    evidence,
    iro_count: iros.length,
    evidence_count: evidence.length,
  };
  const snapshotJson = JSON.stringify(snapshotData);
  const snapshotSha = sha256Hex(snapshotJson);

  assessment.snapshot_count = (assessment.snapshot_count || 0) + 1;
  const version = assessment.snapshot_count;

  const snapshot = store.set("snapshots", {
    _id: `snap_${uid()}`,
    assessment_id: args.assessment_id,
    version,
    sha256: snapshotSha,
    finalized: !!args.finalize,
    created_at: now(),
    iro_count: iros.length,
    evidence_count: evidence.length,
  });

  if (args.finalize) {
    assessment.finalized = true;
    assessment.status = "finalized";
    assessment.finalized_at = now();
  }
  store.set("assessments", assessment);

  return textResult({
    ok: true,
    snapshot_id: snapshot._id,
    version,
    sha256: snapshotSha,
    finalized: !!args.finalize,
    iro_count: iros.length,
    evidence_count: evidence.length,
  });
}

// --- Risk scan ---

function handleRiskScan(args) {
  if (!args?.org_id) return errorResult("Missing required argument: org_id");

  const keywords = args.keywords || [];
  const scanId = `rscan_${uid()}`;
  const timestamp = now();

  // Simulated risk intelligence signals
  const baseSignals = [
    {
      channel: "regulatory",
      source_name: "EU Official Journal",
      jurisdiction: "EU",
      topic_hint: "E1",
      severity: 8,
      relevance: 9,
      source_credibility: 10,
      novelty: 6,
      actionability: 7,
      claim_summary: "New CSRD delegated acts tighten Scope 3 GHG disclosure requirements for upstream supply chains, effective FY2026.",
    },
    {
      channel: "regulatory",
      source_name: "SEC Climate Disclosure Rule",
      jurisdiction: "US",
      topic_hint: "E1",
      severity: 7,
      relevance: 7,
      source_credibility: 9,
      novelty: 5,
      actionability: 6,
      claim_summary: "SEC finalizes climate-related disclosure rules requiring material Scope 1 and 2 emissions reporting with phased Scope 3.",
    },
    {
      channel: "media",
      source_name: "Reuters ESG Wire",
      jurisdiction: "Global",
      topic_hint: "E2",
      severity: 6,
      relevance: 7,
      source_credibility: 8,
      novelty: 8,
      actionability: 5,
      claim_summary: "Industry consortium reports 40% gap between stated decarbonization targets and actual supply chain emission trajectories.",
    },
    {
      channel: "media",
      source_name: "Financial Times",
      jurisdiction: "EU",
      topic_hint: "S1",
      severity: 5,
      relevance: 6,
      source_credibility: 9,
      novelty: 7,
      actionability: 4,
      claim_summary: "New research links transition risk exposure to workforce reskilling gaps in carbon-intensive sectors.",
    },
    {
      channel: "ngo",
      source_name: "CDP Global Supply Chain Report",
      jurisdiction: "Global",
      topic_hint: "E1",
      severity: 7,
      relevance: 8,
      source_credibility: 8,
      novelty: 6,
      actionability: 8,
      claim_summary: "CDP analysis reveals only 37% of suppliers have validated science-based targets, creating material transition risk.",
    },
    {
      channel: "ngo",
      source_name: "WWF Living Planet Report",
      jurisdiction: "Global",
      topic_hint: "E4",
      severity: 8,
      relevance: 5,
      source_credibility: 8,
      novelty: 4,
      actionability: 5,
      claim_summary: "Biodiversity loss accelerating in key commodity sourcing regions, increasing nature-related financial risk.",
    },
  ];

  // Filter by keywords if provided
  let signals = baseSignals;
  if (keywords.length > 0) {
    const kw = keywords.map((k) => k.toLowerCase());
    signals = baseSignals.filter((s) =>
      kw.some((k) =>
        s.claim_summary.toLowerCase().includes(k) ||
        s.topic_hint.toLowerCase().includes(k) ||
        s.source_name.toLowerCase().includes(k) ||
        s.channel.includes(k)
      )
    );
    // Always return at least some results
    if (signals.length === 0) signals = baseSignals.slice(0, 3);
  }

  // Score and rank signals
  const ranked = signals.map((s) => {
    const priority =
      0.3 * s.severity +
      0.25 * s.relevance +
      0.2 * s.source_credibility +
      0.15 * s.novelty +
      0.1 * s.actionability;

    return {
      signal_id: `sig_${uid()}`,
      channel: s.channel,
      source_name: s.source_name,
      jurisdiction: s.jurisdiction,
      topic_hint: s.topic_hint,
      claim_summary: s.claim_summary,
      scores: {
        severity: s.severity,
        relevance: s.relevance,
        source_credibility: s.source_credibility,
        novelty: s.novelty,
        actionability: s.actionability,
      },
      priority: Math.round(priority * 100) / 100,
      classification: priority >= 7 ? "high" : priority >= 5 ? "medium" : "low",
      disposition: "pending_review",
    };
  });

  ranked.sort((a, b) => b.priority - a.priority);

  // Persist the scan
  const scan = store.set("risk_scans", {
    _id: scanId,
    org_id: args.org_id,
    keywords,
    scanned_at: timestamp,
    signal_count: ranked.length,
    channels_covered: [...new Set(ranked.map((r) => r.channel))],
  });

  return textResult({
    scan_id: scanId,
    org_id: args.org_id,
    scanned_at: timestamp,
    keywords,
    signal_count: ranked.length,
    channels_covered: scan.channels_covered,
    signals: ranked,
  });
}

// --- Export ---

function handleExport(args) {
  if (!args?.assessment_id) return errorResult("Missing required argument: assessment_id");
  if (!args?.format) return errorResult("Missing required argument: format");
  if (!["json", "evidence_pack"].includes(args.format)) return errorResult("format must be 'json' or 'evidence_pack'");

  const assessment = store.get("assessments", { _id: args.assessment_id });
  if (!assessment) return errorResult(`Assessment not found: ${args.assessment_id}`);

  const iros = store.list("iros", { assessment_id: args.assessment_id });
  const evidence = store.list("evidence", { assessment_id: args.assessment_id });
  const snapshots = store.list("snapshots", { assessment_id: args.assessment_id });

  if (args.format === "json") {
    const exportData = {
      export_format: "json",
      exported_at: now(),
      assessment,
      iros,
      evidence,
      snapshots,
      summary: {
        iro_count: iros.length,
        evidence_count: evidence.length,
        snapshot_count: snapshots.length,
        finalized: assessment.finalized,
      },
    };
    const exportJson = JSON.stringify(exportData);
    exportData.export_sha256 = sha256Hex(exportJson);
    return textResult(exportData);
  }

  // evidence_pack format - organized by IRO
  const iroEvidenceMap = {};
  for (const iro of iros) {
    const iroEvidence = evidence.filter((e) => e.iro_id === iro._id);
    iroEvidenceMap[iro._id] = {
      iro_id: iro._id,
      title: iro.title,
      type: iro.type,
      topic: iro.topic,
      scores: iro.scores,
      evidence: iroEvidence.map((e) => ({
        evidence_id: e._id,
        source: e.source,
        stakeholder_type: e.stakeholder_type,
        description: e.description,
        captured_at: e.captured_at,
        source_hash: e.source_hash,
      })),
      evidence_count: iroEvidence.length,
      has_internal: iroEvidence.some((e) => e.stakeholder_type === "internal"),
      has_external: iroEvidence.some((e) => e.stakeholder_type === "external"),
    };
  }

  const latestSnapshot = snapshots.length > 0
    ? snapshots.sort((a, b) => b.version - a.version)[0]
    : null;

  const pack = {
    export_format: "evidence_pack",
    exported_at: now(),
    assessment_id: args.assessment_id,
    org_id: assessment.org_id,
    year: assessment.year,
    status: assessment.status,
    finalized: assessment.finalized,
    latest_snapshot: latestSnapshot
      ? { snapshot_id: latestSnapshot._id, version: latestSnapshot.version, sha256: latestSnapshot.sha256 }
      : null,
    iro_evidence: iroEvidenceMap,
    summary: {
      total_iros: iros.length,
      total_evidence: evidence.length,
      iros_with_evidence: iros.filter((i) => (i.evidence_count || 0) > 0).length,
      iros_without_evidence: iros.filter((i) => (i.evidence_count || 0) === 0).length,
    },
  };
  const packJson = JSON.stringify(pack);
  pack.pack_sha256 = sha256Hex(packJson);
  return textResult(pack);
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

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

    const handlers = {
      "strategy.health": handleHealth,
      "strategy.sha256": handleSha256,
      "strategy.db.get": handleDbGet,
      "strategy.db.set": handleDbSet,
      "strategy.db.delete": handleDbDelete,
      "strategy.db.list": handleDbList,
      "strategy.assessment.create": handleAssessmentCreate,
      "strategy.assessment.get": handleAssessmentGet,
      "strategy.iro.list": handleIroList,
      "strategy.iro.create": handleIroCreate,
      "strategy.iro.score": handleIroScore,
      "strategy.evidence.add": handleEvidenceAdd,
      "strategy.materiality_matrix": handleMaterialityMatrix,
      "strategy.esrs_sequence": handleEsrsSequence,
      "strategy.snapshot": handleSnapshot,
      "strategy.risk_scan": handleRiskScan,
      "strategy.export": handleExport,
    };

    const handler = handlers[name];
    if (handler) return handler(args);

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

// ---------------------------------------------------------------------------
// LSP framing transport
// ---------------------------------------------------------------------------

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

let buffer = Buffer.alloc(0);

function tryParseMessages() {
  while (buffer.length > 0) {
    let headerEnd = buffer.indexOf("\r\n\r\n");
    let headerSepLen = 4;
    if (headerEnd === -1) {
      headerEnd = buffer.indexOf("\n\n");
      headerSepLen = 2;
    }
    if (headerEnd === -1) return;

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const lengthMatch = /content-length\s*:\s*(\d+)/i.exec(headerText);
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + headerSepLen);
      continue;
    }

    const bodyLen = Number.parseInt(lengthMatch[1], 10);
    const bodyStart = headerEnd + headerSepLen;
    const bodyEnd = bodyStart + bodyLen;

    if (buffer.length < bodyEnd) return;

    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);

    let msg;
    try {
      msg = JSON.parse(body);
    } catch (e) {
      sendError(null, -32700, "Parse error", { error: String(e) });
      continue;
    }

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
  console.error("stdin error:", e);
});

process.stdin.resume();
