'use strict';

const express = require('express');
const cors    = require('cors');

const { router: authRouter, authMiddleware } = require('./auth');
const crudRouter    = require('./crud');
const rpcRouter     = require('./rpc');
const aiRouter      = require('./ai');
const paymentRouter = require('./payment');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---- Global middleware ----

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// Apply auth middleware globally — it NEVER blocks, it just sets req.userId etc.
// Individual routes call requireAuth / requireAdmin when needed.
app.use(authMiddleware);

// ---- Routes ----

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), env: process.env.NODE_ENV || 'development' });
});

app.use('/api/auth',  authRouter);
app.use('/api/data',  crudRouter);
app.use('/api/rpc',   rpcRouter);
app.use('/api/fn',    aiRouter);
app.use('/api/fn',    paymentRouter);

// ---- 404 catch-all ----

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ---- Global error handler ----

app.use((err, req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---- Start ----

app.listen(PORT, () => {
  console.log(`[siapstudi-api] Server running on port ${PORT}`);
  console.log(`[siapstudi-api] Health: http://localhost:${PORT}/api/health`);
  console.log(`[siapstudi-api] ENV: ${process.env.NODE_ENV || 'development'}`);
  if (!process.env.JWT_SECRET) {
    console.warn('[siapstudi-api] WARNING: JWT_SECRET not set — using random secret (tokens will invalidate on restart!)');
  }
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    console.warn('[siapstudi-api] WARNING: No database config found (DATABASE_URL or PGHOST)');
  }
});

module.exports = app;
