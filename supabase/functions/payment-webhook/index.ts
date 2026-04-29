// Supabase Edge Function: payment-webhook
// Receives Midtrans payment status notifications and updates the user's
// Pro status accordingly. Configure this URL in your Midtrans dashboard:
//   https://<project-ref>.supabase.co/functions/v1/payment-webhook
//
// Deploy:  supabase functions deploy payment-webhook --no-verify-jwt
//   (--no-verify-jwt is REQUIRED — Midtrans does not send a Supabase JWT;
//    we authenticate the webhook ourselves via the signature_key field.)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MIDTRANS_SERVER_KEY = Deno.env.get("MIDTRANS_SERVER_KEY") ?? "";
const IS_PROD = (Deno.env.get("MIDTRANS_IS_PRODUCTION") || "false") === "true";
const MIDTRANS_API = IS_PROD
  ? "https://api.midtrans.com/v2"
  : "https://api.sandbox.midtrans.com/v2";

const PLAN_DURATION_DAYS: Record<string, number> = {
  yearly_promo: 365,
  monthly: 30,
};

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const orderId: string = body.order_id;
    const statusCode: string = body.status_code;
    const grossAmount: string = body.gross_amount;
    const signatureKey: string = body.signature_key;
    const transactionStatus: string = body.transaction_status;
    const fraudStatus: string = body.fraud_status || "";
    const paymentType: string = body.payment_type || "";
    const transactionId: string = body.transaction_id || "";

    // 1. Verify signature: sha512(order_id + status_code + gross_amount + server_key)
    const expected = await sha512(
      orderId + statusCode + grossAmount + MIDTRANS_SERVER_KEY,
    );
    if (expected !== signatureKey) {
      console.error("Invalid signature for order:", orderId);
      return new Response("Invalid signature", { status: 401 });
    }

    // 2. Defense in depth: re-fetch transaction status from Midtrans API
    const auth = btoa(`${MIDTRANS_SERVER_KEY}:`);
    const verifyRes = await fetch(`${MIDTRANS_API}/${orderId}/status`, {
      headers: { "Authorization": `Basic ${auth}`, "Accept": "application/json" },
    });
    if (!verifyRes.ok) {
      console.error("Midtrans verify failed:", verifyRes.status);
      return new Response("Verify failed", { status: 502 });
    }
    const verified = await verifyRes.json();
    const verifiedStatus: string = verified.transaction_status;
    const verifiedFraud: string = verified.fraud_status || "";

    // 3. Decide final status
    let finalStatus: "paid" | "pending" | "denied" | "expired" | "refunded" = "pending";
    if (verifiedStatus === "settlement" ||
        (verifiedStatus === "capture" && verifiedFraud === "accept")) {
      finalStatus = "paid";
    } else if (verifiedStatus === "deny" || verifiedFraud === "deny") {
      finalStatus = "denied";
    } else if (verifiedStatus === "expire") {
      finalStatus = "expired";
    } else if (verifiedStatus === "cancel") {
      finalStatus = "denied";
    } else if (verifiedStatus === "refund" || verifiedStatus === "partial_refund") {
      finalStatus = "refunded";
    }

    const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 4. Look up payment row
    const { data: pay, error: payErr } = await supa
      .from("payments")
      .select("id, user_id, plan, status")
      .eq("order_id", orderId)
      .maybeSingle();
    if (payErr || !pay) {
      console.error("Payment row not found:", orderId, payErr);
      return new Response("Order not found", { status: 404 });
    }

    // 5. Update payment row
    await supa.from("payments").update({
      status: finalStatus,
      gateway_transaction_id: transactionId,
      payment_type: paymentType,
      raw_notification: body,
    }).eq("id", pay.id);

    // 6. On paid → flip is_pro and extend expiry
    if (finalStatus === "paid") {
      const days = PLAN_DURATION_DAYS[pay.plan] ?? 365;
      const now = new Date();
      const expires = new Date(now.getTime() + days * 86400000);

      // If already pro and not yet expired, extend from current expiry, not from now
      const { data: prof } = await supa
        .from("profiles")
        .select("pro_expires_at, is_pro")
        .eq("id", pay.user_id)
        .maybeSingle();

      let startedAt = now;
      let expiresAt = expires;
      if (prof?.is_pro && prof?.pro_expires_at && new Date(prof.pro_expires_at) > now) {
        // Renewal: extend from current expiry
        expiresAt = new Date(new Date(prof.pro_expires_at).getTime() + days * 86400000);
        startedAt = new Date(prof.pro_expires_at);
      }

      await supa.from("profiles").update({
        is_pro: true,
        pro_plan: pay.plan,
        pro_started_at: startedAt.toISOString(),
        pro_expires_at: expiresAt.toISOString(),
      }).eq("id", pay.user_id);
    }

    // 7. On refund → revoke pro
    if (finalStatus === "refunded") {
      await supa.from("profiles").update({
        is_pro: false,
      }).eq("id", pay.user_id);
    }

    return new Response("OK", { status: 200 });
  } catch (err) {
    console.error("webhook error:", err);
    return new Response("Server error", { status: 500 });
  }
});

async function sha512(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-512", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
