'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('./db');

const router = express.Router();

const JWT_SECRET  = process.env.JWT_SECRET || 'change-me-in-production-' + Math.random().toString(36);
const JWT_EXPIRES = '7d';

// ---- Helpers ----

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function formatUser(row) {
  return {
    id:            row.id,
    email:         row.email,
    user_metadata: { name: row.name || '' },
  };
}

function formatResponse(user, token) {
  const u = formatUser(user);
  return {
    data: {
      session: { access_token: token, user: u },
      user:    u,
    },
    error: null,
  };
}

// ---- Auth Middleware ----

/**
 * Verifies JWT from the Authorization header.
 * Sets req.userId, req.userEmail, req.userName, req.isAdmin.
 * Never blocks — unauthenticated requests get req.userId = null.
 */
async function authMiddleware(req, res, next) {
  req.userId    = null;
  req.userEmail = null;
  req.userName  = null;
  req.isAdmin   = false;

  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return next();

  const token = authHeader.slice(7).trim();
  if (!token) return next();

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return next(); // expired or invalid token — treat as unauthenticated
  }

  req.userId    = payload.sub;
  req.userEmail = payload.email || null;
  req.userName  = payload.name  || null;

  // Look up is_admin from profiles
  try {
    const { rows } = await pool.query(
      'SELECT is_admin FROM profiles WHERE id = $1',
      [req.userId],
    );
    req.isAdmin = rows.length > 0 && !!rows[0].is_admin;
  } catch {
    req.isAdmin = false;
  }

  next();
}

/** Returns 401 if not authenticated. */
function requireAuth(req, res, next) {
  if (!req.userId) {
    return res.status(401).json({ error: 'Unauthorized', data: null });
  }
  next();
}

/** Returns 403 if user is not admin. */
function requireAdmin(req, res, next) {
  if (!req.userId) {
    return res.status(401).json({ error: 'Unauthorized', data: null });
  }
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Forbidden — admin only', data: null });
  }
  next();
}

// ---- Routes ----

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ data: null, error: 'Email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ data: null, error: 'Password must be at least 6 characters.' });
    }

    // Check existing user
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ data: null, error: 'User already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Insert user — profile is created via DB trigger or we do it manually
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email.toLowerCase(), passwordHash, name || ''],
    );
    const user = result.rows[0];

    // Upsert profile in case there's no DB trigger
    await pool.query(
      `INSERT INTO profiles (id, email, name, is_pro, is_admin)
       VALUES ($1, $2, $3, false, false)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, user.email, user.name || ''],
    ).catch(() => {}); // ignore if profiles table doesn't have this schema

    const token = signToken({ sub: user.id, email: user.email, name: user.name });
    return res.status(201).json(formatResponse(user, token));
  } catch (err) {
    console.error('[auth] signup error:', err.message);
    return res.status(500).json({ data: null, error: 'Internal server error.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ data: null, error: 'Email and password are required.' });
    }

    const result = await pool.query(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ data: null, error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ data: null, error: 'Invalid email or password.' });
    }

    const token = signToken({ sub: user.id, email: user.email, name: user.name });
    return res.json(formatResponse(user, token));
  } catch (err) {
    console.error('[auth] login error:', err.message);
    return res.status(500).json({ data: null, error: 'Internal server error.' });
  }
});

// GET /api/auth/session
router.get('/session', authMiddleware, (req, res) => {
  if (!req.userId) {
    return res.json({ data: { session: null }, error: null });
  }
  // Re-sign so we always return a fresh-looking token (same secret, same payload)
  const token = signToken({ sub: req.userId, email: req.userEmail, name: req.userName });
  const user  = { id: req.userId, email: req.userEmail, user_metadata: { name: req.userName } };
  return res.json({ data: { session: { access_token: token, user } }, error: null });
});

// GET /api/auth/user
router.get('/user', authMiddleware, (req, res) => {
  if (!req.userId) {
    return res.json({ data: { user: null }, error: null });
  }
  const user = { id: req.userId, email: req.userEmail, user_metadata: { name: req.userName } };
  return res.json({ data: { user }, error: null });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  // JWT is stateless — client must discard the token
  return res.json({ data: null, error: null });
});

module.exports = { router, authMiddleware, requireAuth, requireAdmin };
