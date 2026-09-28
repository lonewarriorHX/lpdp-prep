'use strict';

const express = require('express');
const pool    = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

// Usage limits per action per day
const LIMITS = {
  free: {
    essay_check:        3,
    interview_session:  999999,
  },
  pro: {
    essay_check:        10,
    interview_session:  999999,
  },
};

// ---- POST /rpc/check_and_record_usage ----
// Atomically checks if user is under their daily limit and records the usage.
// Uses Asia/Jakarta timezone for "today".

router.post('/check_and_record_usage', requireAuth, async (req, res) => {
  const { p_action } = req.body || {};
  if (!p_action) {
    return res.status(400).json({ data: null, error: 'p_action is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get is_pro from profiles
    const profileResult = await client.query(
      "SELECT is_pro FROM profiles WHERE id = $1",
      [req.userId],
    );
    const isPro = profileResult.rows.length > 0 && !!profileResult.rows[0].is_pro;

    const tier   = isPro ? 'pro' : 'free';
    const limits = LIMITS[tier] || LIMITS.free;
    const limit  = limits[p_action] ?? 0;

    // Count today's usage in Asia/Jakarta timezone
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS used
       FROM usage_log
       WHERE user_id = $1
         AND action  = $2
         AND (created_at AT TIME ZONE 'Asia/Jakarta')::date
             = (NOW()    AT TIME ZONE 'Asia/Jakarta')::date`,
      [req.userId, p_action],
    );
    const used = countResult.rows[0]?.used || 0;

    const allowed   = used < limit;
    const remaining = Math.max(0, limit - used);

    if (allowed) {
      await client.query(
        `INSERT INTO usage_log (user_id, action) VALUES ($1, $2)`,
        [req.userId, p_action],
      );
    }

    await client.query('COMMIT');

    return res.json({
      data: {
        allowed,
        used:      allowed ? used + 1 : used,
        limit,
        remaining: allowed ? remaining - 1 : remaining,
        is_pro:    isPro,
      },
      error: null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[rpc] check_and_record_usage error:', err.message);
    return res.status(500).json({ data: null, error: 'Database error' });
  } finally {
    client.release();
  }
});

// ---- POST /rpc/get_today_usage ----

router.post('/get_today_usage', requireAuth, async (req, res) => {
  const { p_action } = req.body || {};
  if (!p_action) {
    return res.status(400).json({ data: null, error: 'p_action is required' });
  }

  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM usage_log
       WHERE user_id = $1
         AND action  = $2
         AND (created_at AT TIME ZONE 'Asia/Jakarta')::date
             = (NOW()    AT TIME ZONE 'Asia/Jakarta')::date`,
      [req.userId, p_action],
    );
    return res.json({ data: result.rows[0]?.count || 0, error: null });
  } catch (err) {
    console.error('[rpc] get_today_usage error:', err.message);
    return res.status(500).json({ data: null, error: 'Database error' });
  }
});

// ---- POST /rpc/promo_pro_count ----
// Public — no auth required. Count distinct users with a paid yearly_promo payment.

router.post('/promo_pro_count', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(DISTINCT user_id)::int AS count
       FROM payments
       WHERE plan   = 'yearly_promo'
         AND status = 'paid'`,
    );
    return res.json({ data: result.rows[0]?.count || 0, error: null });
  } catch (err) {
    console.error('[rpc] promo_pro_count error:', err.message);
    return res.status(500).json({ data: null, error: 'Database error' });
  }
});

module.exports = router;
