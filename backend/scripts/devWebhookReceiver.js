#!/usr/bin/env node
/**
 * Dependency-free local webhook receiver for manual testing — plain `node:http` + `node:crypto`
 * only, so it runs with a bare `node` invocation (no ts-node/tsx, no build step, no express).
 * Complements the existing `npm run webhook-receiver` (src/dev/webhookReceiver.ts).
 *
 *   WEBHOOK_SECRET=whsec_... node backend/scripts/devWebhookReceiver.js
 *   PORT_RECEIVER=5000 WEBHOOK_SECRET=whsec_... node backend/scripts/devWebhookReceiver.js
 *
 * Then onboard a merchant whose webhookUrl points here, e.g. http://localhost:4000/webhook
 * (WEBHOOK_ALLOW_INSECURE_URLS=true is required on the relayer for a plain-http localhost URL).
 *
 * Signature scheme — re-implemented here (not imported) to keep this script dependency-free;
 * must match backend/src/webhooks/signer.ts exactly:
 *   Header:        X-PayWithQuai-Signature: t=<unixSeconds>,v1=<hexHmacSha256>
 *   Signed string: `${t}.${rawBody}`, HMAC-SHA256'd with the merchant's webhook secret.
 *   Verification:  constant-time compare, 300s clock-skew tolerance.
 */
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT_RECEIVER ?? 4000);
const SECRET = process.env.WEBHOOK_SECRET;
const SIGNATURE_HEADER = 'x-paywithquai-signature'; // see backend/src/webhooks/signer.ts

if (!SECRET) {
  console.error('Set WEBHOOK_SECRET (the whsec_... value returned when the merchant was onboarded).');
  process.exit(1);
}

function parseSignatureHeader(header) {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return undefined;
  return { t, v1: parts.v1 };
}

function verifySignature(secret, header, rawBody, nowSec, toleranceSec = 300) {
  if (!header) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowSec - parsed.t) > toleranceSec) return false;

  const expected = createHmac('sha256', secret).update(`${parsed.t}.${rawBody}`).digest();
  if (!/^[0-9a-fA-F]{64}$/.test(parsed.v1)) return false; // exact 32-byte hex, else non-constant-time path
  const received = Buffer.from(parsed.v1, 'hex');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const sigHeader = req.headers[SIGNATURE_HEADER];
    const nowSec = Math.floor(Date.now() / 1000);
    const ok = verifySignature(SECRET, sigHeader, raw, nowSec);

    console.log(`\n${new Date().toISOString()}  POST ${req.url}`);
    console.log(`Signature header: ${sigHeader ?? '(none)'}`);
    console.log(`Signature valid:  ${ok ? '✅ yes' : '❌ NO'}`);

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      event = null;
    }
    if (event) {
      console.log(`Event: ${event.type ?? '(unknown type)'} (${event.id ?? '(no id)'})`);
      console.dir(event.data ?? event, { depth: null });
    } else {
      console.log('Body (not valid JSON):', raw);
    }

    if (!ok) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid signature' }));
      return;
    }
    // Respond 2xx so the relayer marks the delivery as delivered.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: true }));
  });
});

server.listen(PORT, () => {
  console.log(`dev webhook receiver listening on http://localhost:${PORT}/webhook (any path accepted)`);
  console.log("Point a merchant's webhookUrl here for local testing.");
});
