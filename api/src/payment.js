'use strict';

const express = require('express');
const crypto  = require('crypto');
const pool    = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();

// ---- Config ----

const MIDTRANS_SERVER_KEY    = process.env.MIDTRANS_SERVER_KEY || '';
const MIDTRANS_IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const MIDTRANS_BASE_URL      = MIDTRANS_IS_PRODUCTION
  ? 'https://app.midtrans.com'
  : 'https://app.sandbox.midtrans.com';
const MIDTRANS_API_BASE      = MIDTRANS_IS_PRODUCTION
  ? 'https://api.midtrans.com'
  : 'https://api.sandbox.midtrans.com';

// ---- Plan definitions ----

const PLANS = {
  yearly_promo: { basePrice: 69900, durationDays: 365, label: 'Tahunan Promo' },
  monthly:      { basePrice: 39900, durationDays: 30,  label: 'Bulanan'       },
};

const PLATFORM_FEE = 2500;

// ---- Coupon definitions ----

const COUPONS = {
  HANXA: { discount: 10000, label: 'HANXA' },
};

// ---- Midtrans helpers ----

function midtransAuthHeader() {
  return 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64');
}

async function createSnapTransaction(payload) {
  const res = await fetch(`${MIDTRANS_BASE_URL}/snap/v1/transactions`, {
    method:  'POST',
    headers: {
      Accept:        'application/json',
      'Content-Type': 'application/json',
      Authorization: midtransAuthHeader(),
    },
    body: JSON.stringify(payload),
  });
  return res;
}

async function getMidtransStatus(orderId) {
  const res = await fetch(`${MIDTRANS_API_BASE}/v2/${encodeURIComponent(orderId)}/status`, {
    headers: { Authorization: midtransAuthHeader() },
  });
  return res.json();
}

// ---- POST /fn/create-payment ----

router.post('/create-payment', requireAuth, async (req, res) => {
  try {
    if (!MIDTRANS_SERVER_KEY) {
      return res.status(503).json({ ok: false, error: 'Payment service not configured.' });
    }

    const { plan, coupon_code } = req.body || {};
    if (!PLANS[plan]) {
      return res.status(400).json({ ok: false, error: `Invalid plan. Choose: ${Object.keys(PLANS).join(', ')}` });
    }

    const planDef   = PLANS[plan];
    let   basePrice = planDef.basePrice;

    // Check if user is already pro and not expired
    const profileRes = await pool.query(
      'SELECT is_pro, pro_expires_at, email, name FROM profiles WHERE id = $1',
      [req.userId],
    );
    const profile = profileRes.rows[0];
    if (profile?.is_pro && profile?.pro_expires_at && new Date(profile.pro_expires_at) > new Date()) {
      return res.status(409).json({ ok: false, error: 'User already has an active Pro subscription.' });
    }

    // Apply coupon
    let appliedCoupon = null;
    let discount      = 0;
    if (coupon_code) {
      const coupon = COUPONS[coupon_code.toUpperCase()];
      if (!coupon) {
        return res.status(400).json({ ok: false, error: 'Kode kupon tidak valid.' });
      }
      discount      = coupon.discount;
      appliedCoupon = coupon_code.toUpperCase();
    }

    const totalAmount = Math.max(0, basePrice - discount + PLATFORM_FEE);

    // Generate order ID
    const orderId = `SIAPSTUDI-${plan.toUpperCase()}-${req.userId.slice(0, 8)}-${Date.now()}`;

    // Insert payment row (pending)
    await pool.query(
      `INSERT INTO payments (user_id, order_id, plan, amount, status, coupon_code, duration_days)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6)`,
      [req.userId, orderId, plan, totalAmount, appliedCoupon, planDef.durationDays],
    );

    // Build Midtrans Snap payload
    const snapPayload = {
      transaction_details: {
        order_id:     orderId,
        gross_amount: totalAmount,
      },
      item_details: [
        {
          id:       plan,
          price:    basePrice - discount,
          quantity: 1,
          name:     `SiapStudi Pro — ${planDef.label}`,
        },
        {
          id:       'platform_fee',
          price:    PLATFORM_FEE,
          quantity: 1,
          name:     'Biaya Platform',
        },
      ],
      customer_details: {
        email: profile?.email || '',
        first_name: profile?.name || 'User',
      },
      callbacks: process.env.MIDTRANS_NOTIFICATION_URL
        ? { notification: process.env.MIDTRANS_NOTIFICATION_URL }
        : undefined,
    };

    const snapRes  = await createSnapTransaction(snapPayload);
    const snapData = await snapRes.json();

    if (!snapRes.ok || !snapData.token) {
      console.error('[payment] Midtrans Snap error:', JSON.stringify(snapData));
      return res.status(502).json({ ok: false, error: 'Gagal membuat transaksi Midtrans.', detail: snapData });
    }

    return res.json({
      ok:            true,
      snap_token:    snapData.token,
      redirect_url:  snapData.redirect_url,
      order_id:      orderId,
      plan,
      amount_idr:    totalAmount,
      duration_days: planDef.durationDays,
      breakdown: {
        base_price:   basePrice,
        discount,
        platform_fee: PLATFORM_FEE,
        total:        totalAmount,
      },
      applied_coupon: appliedCoupon,
    });
  } catch (err) {
    console.error('[payment] create-payment error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

// ---- POST /fn/payment-webhook ----
// Midtrans webhook — no auth, verified by SHA-512 signature.

router.post('/payment-webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const { order_id, status_code, gross_amount, signature_key, transaction_status, fraud_status } = body;

    if (!order_id) return res.status(400).json({ ok: false, error: 'Missing order_id' });

    // Verify Midtrans signature: sha512(order_id + status_code + gross_amount + server_key)
    const expectedSig = crypto
      .createHash('sha512')
      .update(`${order_id}${status_code}${gross_amount}${MIDTRANS_SERVER_KEY}`)
      .digest('hex');

    if (signature_key !== expectedSig) {
      console.warn('[payment] Invalid webhook signature for order:', order_id);
      return res.status(403).json({ ok: false, error: 'Invalid signature' });
    }

    // Re-fetch transaction status from Midtrans for security
    let statusData;
    try {
      statusData = await getMidtransStatus(order_id);
    } catch (e) {
      console.error('[payment] Failed to re-fetch Midtrans status:', e.message);
      // Fall back to body data if re-fetch fails
      statusData = body;
    }

    const txStatus    = statusData.transaction_status || transaction_status;
    const fraudStatus = statusData.fraud_status       || fraud_status;

    // Find payment row
    const paymentRes = await pool.query(
      'SELECT id, user_id, plan, duration_days, status FROM payments WHERE order_id = $1',
      [order_id],
    );
    if (!paymentRes.rows.length) {
      console.warn('[payment] Webhook for unknown order:', order_id);
      return res.status(404).json({ ok: false, error: 'Order not found' });
    }

    const payment = paymentRes.rows[0];

    // Determine new status
    const isPaid = (
      txStatus === 'capture' && fraudStatus === 'accept'
    ) || txStatus === 'settlement';

    const isRefunded = txStatus === 'refund' || txStatus === 'cancel' || txStatus === 'expire';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (isPaid && payment.status !== 'paid') {
        // Mark payment as paid
        await client.query(
          `UPDATE payments SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE order_id = $1`,
          [order_id],
        );

        // Calculate expiry date
        const durationDays = payment.duration_days || PLANS[payment.plan]?.durationDays || 30;
        const expiresAt    = new Date();
        expiresAt.setDate(expiresAt.getDate() + durationDays);

        // Set user as pro
        await client.query(
          `UPDATE profiles
           SET is_pro = true, pro_expires_at = $1, updated_at = NOW()
           WHERE id = $2`,
          [expiresAt.toISOString(), payment.user_id],
        );

        console.log(`[payment] User ${payment.user_id} activated Pro until ${expiresAt.toISOString()}`);
      } else if (isRefunded && payment.status === 'paid') {
        // Revoke pro on refund/cancel
        await client.query(
          `UPDATE payments SET status = $1, updated_at = NOW() WHERE order_id = $2`,
          [txStatus, order_id],
        );
        await client.query(
          `UPDATE profiles SET is_pro = false, pro_expires_at = NULL, updated_at = NOW() WHERE id = $1`,
          [payment.user_id],
        );
        console.log(`[payment] User ${payment.user_id} Pro revoked due to ${txStatus}`);
      } else {
        // Update status only
        await client.query(
          `UPDATE payments SET status = $1, updated_at = NOW() WHERE order_id = $2`,
          [txStatus, order_id],
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[payment] webhook error:', err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
});

module.exports = router;
