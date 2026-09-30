import { createHmac, timingSafeEqual } from 'node:crypto';

export interface GatewayOrderRequest {
  amount: string;
  fiatCurrency: string;
  reference: string;
  token?: 'quai' | 'qi';
  expiresInSecs?: number;
}

export interface GatewayOrderResponse {
  gatewayId: string;
  reference: string | null;
  merchant: string;
  checkoutUrl: string;
  expiresAt: number;
  token: string;
  orderId: string;
  quote: {
    currency: string;
    amount: string;
    quaiWei: string;
    quaiDisplay: string;
    fiatPerQuai: number;
    markupBps: number;
  };
}

export interface GatewayOrderStatus {
  gatewayId: string;
  reference: string | null;
  token: string;
  amount: string;
  createdAt: number;
  expiresAt: number | null;
  status: 'pending' | 'paid' | 'settled' | 'expired';
  orderId: string;
  qi: { address: string; qits: string; receivedQits: string; settled: boolean; txHashes: string[] } | null;
  webhook: { status: string; attempts: number } | null;
}

export interface PaymentWebhookData {
  merchantId: string;
  merchant: string;
  orderId: string;
  payer: string;
  token: string;
  amount: string;
  feeBps: number;
  fee: string;
  net: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  nonce: number;
  asset?: string;
  qi?: { address: string; qits: string; receivedQits: string; txHashes: string[] };
  reference?: string;
}

export interface PaymentWebhook {
  id: string;
  type: string;
  created: number;
  data: PaymentWebhookData;
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly merchantKey: string,
  ) {}

  async createOrder(req: GatewayOrderRequest): Promise<GatewayOrderResponse> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/v1/gateway/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-merchant-key': this.merchantKey },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayError(res.status, text.slice(0, 300));
    }
    return (await res.json()) as GatewayOrderResponse;
  }

  async getOrderStatus(gatewayId: string): Promise<GatewayOrderStatus> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/v1/gateway/orders/${gatewayId}`, {
      headers: { 'x-merchant-key': this.merchantKey },
    });
    if (!res.ok) throw new Error(`gateway order lookup failed: ${res.status}`);
    return (await res.json()) as GatewayOrderStatus;
  }
}

export class GatewayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function verifyGatewayWebhook(
  secret: string,
  header: string | undefined,
  rawBody: string,
  nowSec: number,
  toleranceSec = 300,
): boolean {
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) {
    const idx = kv.indexOf('=');
    if (idx === -1) continue;
    parts[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  if (!/^[0-9a-fA-F]{64}$/.test(v1)) return false;
  const received = Buffer.from(v1, 'hex');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}