'use strict';

const express = require('express');
const pool    = require('./db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();

// ---- Table authorization config ----

const TABLE_RULES = {
  profiles:             { ownerCol: 'id',      publicRead: false, allowInsert: false },
  essays:               { ownerCol: 'user_id', publicRead: false },
  tbs_sessions:         { ownerCol: 'user_id', publicRead: false },
  interview_sessions:   { ownerCol: 'user_id', publicRead: false },
  payments:             { ownerCol: 'user_id', publicRead: false, allowInsert: false, allowDelete: false },
  usage_log:            { ownerCol: 'user_id', publicRead: false },
  reference_essays:     { ownerCol: 'user_id', publicRead: true },
  reference_questions:  { ownerCol: 'user_id', publicRead: true },
  tbs_questions:        { ownerCol: 'user_id', publicRead: true },
  universities:         { ownerCol: null,       publicRead: true,  readOnly: true },
  ai_providers:         { ownerCol: null,       publicRead: false, adminOnly: true },
};

// Allowed table names (whitelist to prevent SQL injection via table name)
const ALLOWED_TABLES = new Set(Object.keys(TABLE_RULES));

// ---- Query param parsers ----

/**
 * Parse filter params from query string.
 * Supports: eq.COL=VAL, in.COL=v1,v2,v3
 * Returns { conditions: string[], params: any[], nextIdx: number }
 */
function parseFilters(query, startIdx) {
  const conditions = [];
  const params     = [];
  let idx          = startIdx;

  for (const [key, val] of Object.entries(query)) {
    if (key.startsWith('eq.')) {
      const col = key.slice(3);
      if (!isValidIdentifier(col)) continue;
      conditions.push(`"${col}" = $${idx}`);
      params.push(val);
      idx++;
    } else if (key.startsWith('in.')) {
      const col    = key.slice(3);
      if (!isValidIdentifier(col)) continue;
      const values = String(val).split(',').map((v) => v.trim());
      if (!values.length) continue;
      const placeholders = values.map(() => `$${idx++}`).join(', ');
      conditions.push(`"${col}" IN (${placeholders})`);
      params.push(...values);
    }
  }

  return { conditions, params, nextIdx: idx };
}

/** Very simple identifier check — only allow word chars and underscores. */
function isValidIdentifier(name) {
  return /^\w+$/.test(name);
}

// ---- GET /data/:table ----

router.get('/:table', async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.has(table)) {
    return res.status(404).json({ error: `Unknown table: ${table}` });
  }

  const rules = TABLE_RULES[table];

  if (rules.adminOnly) {
    if (!req.userId)  return res.status(401).json({ error: 'Unauthorized' });
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
  } else if (!rules.publicRead) {
    if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { select, order, limit, single } = req.query;

    // Column selection — pass through the comma-separated list.
    // The table name is whitelisted; column injection risk is low but
    // we keep the raw string out of parameterized params (it goes into SQL
    // text only). For production hardening, validate each col name too.
    const cols = select && typeof select === 'string'
      ? select.split(',').map((c) => c.trim()).filter(isValidIdentifier).map((c) => `"${c}"`).join(', ') || '*'
      : '*';

    const params     = [];
    const conditions = [];
    let   idx        = 1;

    // Owner filter for private tables
    if (!rules.publicRead && rules.ownerCol) {
      conditions.push(`"${rules.ownerCol}" = $${idx}`);
      params.push(req.userId);
      idx++;
    }

    // Caller-supplied filters
    const filterResult = parseFilters(req.query, idx);
    conditions.push(...filterResult.conditions);
    params.push(...filterResult.params);
    idx = filterResult.nextIdx;

    let sql = `SELECT ${cols} FROM "${table}"`;
    if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;

    // ORDER BY
    if (order && typeof order === 'string') {
      const [col, dir] = order.split('.');
      if (isValidIdentifier(col) && (!dir || dir === 'asc' || dir === 'desc')) {
        sql += ` ORDER BY "${col}" ${dir === 'desc' ? 'DESC' : 'ASC'}`;
      }
    }

    // LIMIT
    if (limit) {
      const n = parseInt(limit, 10);
      if (n > 0 && n <= 10000) sql += ` LIMIT ${n}`;
    }

    const { rows } = await pool.query(sql, params);

    // PostgREST-style ?single=1 — return object or 406
    if (single === '1' || single === 'true') {
      if (rows.length === 0) return res.status(406).json({ error: 'No rows found' });
      return res.json(rows[0]);
    }

    return res.json(rows);
  } catch (err) {
    console.error(`[crud] GET ${table}:`, err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ---- POST /data/:table ----

router.post('/:table', requireAuth, async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.has(table)) {
    return res.status(404).json({ error: `Unknown table: ${table}` });
  }

  const rules = TABLE_RULES[table];

  if (rules.readOnly)     return res.status(405).json({ error: 'Table is read-only' });
  if (rules.allowInsert === false) return res.status(405).json({ error: 'Insert not allowed on this table' });
  if (rules.adminOnly && !req.isAdmin) return res.status(403).json({ error: 'Admin only' });

  try {
    const data = { ...req.body };

    // Auto-set owner column
    if (rules.ownerCol === 'user_id') {
      data.user_id = req.userId;
    }

    const keys   = Object.keys(data).filter(isValidIdentifier);
    const values = keys.map((k) => data[k]);

    if (!keys.length) return res.status(400).json({ error: 'No data provided' });

    const cols        = keys.map((k) => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const sql         = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) RETURNING *`;

    const { rows } = await pool.query(sql, values);
    return res.status(201).json(rows[0] || {});
  } catch (err) {
    console.error(`[crud] POST ${table}:`, err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ---- PATCH /data/:table ----

router.patch('/:table', requireAuth, async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.has(table)) {
    return res.status(404).json({ error: `Unknown table: ${table}` });
  }

  const rules = TABLE_RULES[table];

  if (rules.readOnly)  return res.status(405).json({ error: 'Table is read-only' });
  if (rules.adminOnly && !req.isAdmin) return res.status(403).json({ error: 'Admin only' });

  // Require at least one eq. filter to prevent accidental mass-updates
  const hasFilter = Object.keys(req.query).some((k) => k.startsWith('eq.') || k.startsWith('in.'));
  if (!hasFilter) {
    return res.status(400).json({ error: 'At least one filter (eq.COL=VAL) is required for PATCH' });
  }

  try {
    const data = { ...req.body };
    const keys = Object.keys(data).filter(isValidIdentifier);
    if (!keys.length) return res.status(400).json({ error: 'No data provided' });

    const params     = keys.map((k) => data[k]);
    let   idx        = params.length + 1;
    const conditions = [];

    // Owner filter (non-admins can only update their own rows)
    if (rules.ownerCol && !rules.adminOnly) {
      conditions.push(`"${rules.ownerCol}" = $${idx}`);
      params.push(req.userId);
      idx++;
    }

    const filterResult = parseFilters(req.query, idx);
    conditions.push(...filterResult.conditions);
    params.push(...filterResult.params);

    if (!conditions.length) {
      return res.status(400).json({ error: 'No conditions resolved — aborting to prevent mass update' });
    }

    const setClauses = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const sql        = `UPDATE "${table}" SET ${setClauses} WHERE ${conditions.join(' AND ')} RETURNING *`;

    const { rows } = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    console.error(`[crud] PATCH ${table}:`, err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ---- DELETE /data/:table ----

router.delete('/:table', requireAuth, async (req, res) => {
  const { table } = req.params;
  if (!ALLOWED_TABLES.has(table)) {
    return res.status(404).json({ error: `Unknown table: ${table}` });
  }

  const rules = TABLE_RULES[table];

  if (rules.readOnly)  return res.status(405).json({ error: 'Table is read-only' });
  if (rules.allowDelete === false) return res.status(405).json({ error: 'Delete not allowed on this table' });
  if (rules.adminOnly && !req.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const hasFilter = Object.keys(req.query).some((k) => k.startsWith('eq.') || k.startsWith('in.'));
  if (!hasFilter) {
    return res.status(400).json({ error: 'At least one filter (eq.COL=VAL) is required for DELETE' });
  }

  try {
    const params     = [];
    const conditions = [];
    let   idx        = 1;

    // Owner filter
    if (rules.ownerCol && !rules.adminOnly) {
      conditions.push(`"${rules.ownerCol}" = $${idx}`);
      params.push(req.userId);
      idx++;
    }

    const filterResult = parseFilters(req.query, idx);
    conditions.push(...filterResult.conditions);
    params.push(...filterResult.params);

    if (!conditions.length) {
      return res.status(400).json({ error: 'No conditions resolved — aborting to prevent mass delete' });
    }

    const sql       = `DELETE FROM "${table}" WHERE ${conditions.join(' AND ')} RETURNING *`;
    const { rows }  = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    console.error(`[crud] DELETE ${table}:`, err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

module.exports = router;
