// Supabase Edge Function: create-payment
// Creates a Midtrans Snap transaction for the SIAP Studi yearly Pro plan.
//
// Deploy:  supabase functions deploy create-payment
// Secrets: supabase secrets set MIDTRANS_SERVER_KEY=<your_key>
//          supabase secrets set MIDTRANS_IS_PRODUCTION=false
//
// Auth: requires the user's Supabase JWT (sent automatically by supabase-js).
//
// Request body: { coupon_code?: string }
// Response: { ok: true, snap_token, redirect_url, order_id, plan, amount_idr,
//             breakdown: { subtotal, fee, discount, total }, applied_coupon }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// === Pricing config — edit here to change price ============================
const PLAN_NAME = "yearly_promo";
const PLAN_BASE_IDR = 1000;     // Early Bird subscription price
const TRANSACTION_FEE_IDR = 0; // Midtrans handling fee passed to user
const PLAN_LABEL = "SIAP Studi Pro Early Bird — 1 Tahun";
const PLAN_DURATION_DAYS = 365;
// Promo coupons. Add more entries as needed.
const COUPONS: Record<string, { discount: number; label: string }> = {
  HANXA: { discount: 10000, label: "HANXA" },
};
// ===========================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MIDTRANS_SERVER_KEY = Deno.env.get("MIDTRANS_SERVER_KEY") ?? "";
const IS_PROD = (Deno.env.get("MIDTRANS_IS_PRODUCTION") || "false") === "true";
const SNAP_URL = IS_PROD
  ? "https://app.midtrans.com/snap/v1/transactions"
  : "https://app.sandbox.midtrans.com/snap/v1/transactions";
// Per-transaction notification URL override — lets us share a Midtrans account
// with other projects without changing the dashboard-wide notification URL.
// If unset, falls back to the dashboard URL configured in Midtrans.
const NOTIFICATION_URL = Deno.env.get("MIDTRANS_NOTIFICATION_URL") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  try {
    if (!MIDTRANS_SERVER_KEY) {
      return json({ ok: false, error: "MIDTRANS_SERVER_KEY belum di-set." }, 500);
    }

    // Auth: extract user from JWT
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ ok: false, error: "Tidak terautentikasi." }, 401);

    const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await supa.auth.getUser(jwt);
    if (userErr || !userData?.user) {
      return json({ ok: false, error: "Sesi tidak valid." }, 401);
    }
    const user = userData.user;

    // Check if user is already pro (active)
    const { data: profile } = await supa
      .from("profiles")
      .select("is_pro, pro_expires_at, name, email")
      .eq("id", user.id)
      .maybeSingle();
    if (profile?.is_pro && profile?.pro_expires_at &&
        new Date(profile.pro_expires_at) > new Date()) {
      return json({ ok: false, error: "Anda sudah aktif sebagai Pro." }, 400);
    }

    // Parse optional coupon from body
    const body = await req.json().catch(() => ({}));
    const couponCode = String(body.coupon_code || "").trim().toUpperCase();
    let appliedCoupon: { code: string; discount: number; label: string } | null = null;
    if (couponCode) {
      const c = COUPONS[couponCode];
      if (!c) {
        return json({ ok: false, error: "Kode promo tidak valid." }, 400);
      }
      appliedCoupon = { code: couponCode, discount: c.discount, label: c.label };
    }

    // Calculate breakdown
    const subtotal = PLAN_BASE_IDR;
    const fee = TRANSACTION_FEE_IDR;
    const discount = appliedCoupon?.discount ?? 0;
    const total = Math.max(0, subtotal + fee - discount);
    if (total <= 0) {
      return json({ ok: false, error: "Total pembayaran tidak valid." }, 400);
    }

    // Generate unique order_id
    const orderId = `lpdp-${user.id.slice(0, 8)}-${Date.now()}`;

    // Insert pending payment row
    const { error: insertErr } = await supa.from("payments").insert({
      user_id: user.id,
      order_id: orderId,
      plan: PLAN_NAME,
      amount_idr: total,
      status: "pending",
    });
    if (insertErr) {
      console.error("payments insert error:", insertErr);
      return json({ ok: false, error: "Gagal membuat order." }, 500);
    }

    // Build Snap payload — itemize so the user sees the breakdown in Midtrans
    const customerName = profile?.name || user.user_metadata?.name || user.email?.split("@")[0] || "User";
    const items: Array<{ id: string; price: number; quantity: number; name: string }> = [
      { id: PLAN_NAME, price: subtotal, quantity: 1, name: PLAN_LABEL },
      { id: "transaction_fee", price: fee, quantity: 1, name: "Biaya Transaksi" },
    ];
    if (appliedCoupon) {
      items.push({
        id: `coupon_${appliedCoupon.code.toLowerCase()}`,
        price: -appliedCoupon.discount,
        quantity: 1,
        name: `Diskon Kode ${appliedCoupon.label}`,
      });
    }
    const payload = {
      transaction_details: {
        order_id: orderId,
        gross_amount: total,
      },
      item_details: items,
      customer_details: {
        first_name: customerName,
        email: user.email || profile?.email,
      },
      credit_card: { secure: true },
      callbacks: {
        // Optional finish redirect — set in pricing.js client-side too.
      },
    };

    const auth = btoa(`${MIDTRANS_SERVER_KEY}:`);
    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Basic ${auth}`,
    };
    // Override the dashboard-wide webhook URL for this transaction only,
    // so SIAP Studi payments don't fire to other projects' webhooks.
    if (NOTIFICATION_URL) {
      headers["X-Override-Notification"] = NOTIFICATION_URL;
    }

    const r = await fetch(SNAP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("Midtrans Snap error:", r.status, data);
      return json(
        { ok: false, error: data?.error_messages?.[0] || `Midtrans ${r.status}` },
        502,
      );
    }

    return json({
      ok: true,
      snap_token: data.token,
      redirect_url: data.redirect_url,
      order_id: orderId,
      plan: PLAN_NAME,
      amount_idr: total,
      duration_days: PLAN_DURATION_DAYS,
      breakdown: { subtotal, fee, discount, total },
      applied_coupon: appliedCoupon,
    });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
