import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Info,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { CodeBlock } from "@/components/docs/code-block";
import { DocsSideNav } from "@/components/docs/side-nav";

export const metadata: Metadata = {
  title: "Documentation — TripplePay || Merchants",
  description:
    "Accept crypto payments on Quai in 3 steps. Merchant integration guide for TripplePay || Merchants.",
};

const sections = [
  { id: "overview", label: "Overview" },
  { id: "before-you-start", label: "Before you start" },
  { id: "supported-assets", label: "Supported assets" },
  { id: "register-order", label: "Step 1 — Register the order" },
  { id: "customer-pays", label: "Step 2 — Customer pays" },
  { id: "read-order", label: "Read an order on-chain" },
  { id: "payment-links", label: "Payment Links" },
  { id: "mobile-payments", label: "Mobile payments & auth (Blip)" },
  { id: "webhook", label: "Step 3 — Verify the webhook" },
  { id: "confirmation", label: "Confirmation & fulfillment" },
  { id: "quick-reference", label: "Quick reference" },
  { id: "testing", label: "Deployment & local development" },
];

const installQuais = `npm install quais   # Quai's ethers fork — usePathing, formatQuai, parseQuai`;

const received = `import { Contract, Wallet, JsonRpcProvider, id } from 'quais';   // NOT ethers

const provider = new JsonRpcProvider('https://rpc.quai.network', undefined, { usePathing: true });
const wallet   = new Wallet(BACKEND_PRIVATE_KEY, provider);   // your payout wallet
const pay      = new Contract(PAYWITHQUAI_ADDRESS, PAYWITHQUAI_ABI, wallet);

// Cryptographically random order id — Math.random()/timestamps are predictable, and a
// guessed id is a DoS vector on the order-lookup API. Same pattern as the checkout:
const bytes = crypto.getRandomValues(new Uint8Array(24));
const orderId = id('ord_web_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''));

const amount  = 25000000n;   // $25.00 for a 6-decimal stablecoin; native QUAI = 18 decimals

// registerOrder(orderId, token, amount, expiry)   expiry 0 = never expires
// NOTE: msg.sender becomes the merchant — this payout wallet is the address customers pay to.
const tx = await pay.registerOrder(orderId, TOKEN_ADDRESS, amount, 0n);
await tx.wait();`;

const abiSnippet = `const PAYWITHQUAI_ABI = [
  // Register — merchant backend, broadcast from the payout wallet
  "function registerOrder(bytes32 orderId, address token, uint256 amount, uint256 expiry)",
  "function registerOrderWithPayer(bytes32 orderId, address token, uint256 amount, uint256 expiry, address payer)",
  // Pay — customer wallet
  "function payOrder(address merchant, bytes32 orderId)",
  "function payOrderNative(address merchant, bytes32 orderId) payable",
  // Read — anyone; display a checkout and verify settlement
  "function getOrder(address merchant, bytes32 orderId) view returns (address merchant, bool settled, bool exists, uint16 feeBps, address token, uint256 amount, uint256 expiry, address feeRecipient, uint256 settledAt, address expectedPayer, uint64 nonce)",
  "function isSettled(address merchant, bytes32 orderId) view returns (bool)",
  // Manage — merchant wallet
  "function cancelOrder(bytes32 orderId)",
  "function purgeSettledOrder(bytes32 orderId)",
];`;

const erc20Pay = `await token.approve(PAYWITHQUAI_ADDRESS, amount);   // customer approves exact amount
await pay.payOrder(MERCHANT_ADDRESS, orderId);       // customer pays`;

const nativePay = `await pay.payOrderNative(MERCHANT_ADDRESS, orderId, { value: amount });`;

const walletDetect = `// Only these wallets can sign for Quai — detect them in this order:
//   window.quai     → Blip (mobile; injected inside Blip's in-app browser)
//   window.pelagus  → Pelagus (desktop extension)
//   window.ethereum → MetaMask (with Quai network added, chainId 15000)
const provider = new BrowserProvider(window.quai ?? window.pelagus ?? window.ethereum);
const accounts = await provider.send('quai_requestAccounts', []);   // EIP-1193
const payer    = accounts[0];

// MetaMask needs the Quai network first:
await window.ethereum.request({
  method: 'wallet_addEthereumChain',
  params: [{
    chainId: '0x9',   // 9 — Quai mainnet (Cyprus-1 zone)
    chainName: 'Quai Network (Mainnet)',
    nativeCurrency: { name: 'Quai', symbol: 'QUAI', decimals: 18 },
    rpcUrls: ['https://rpc.quai.network'],
    blockExplorerUrls: ['https://quaiscan.io'],
  }],
});`;

const readOrder = `// The checkout renders the order FROM THE CHAIN — never trust a client-side
// cart total. getOrder is authoritative for amount, fee and payer restriction.
const provider = new JsonRpcProvider(RPC_URL, undefined, { usePathing: true });
const pay      = new Contract(PAYWITHQUAI_ADDRESS, PAYWITHQUAI_ABI, provider);

const order = await pay.getOrder(MERCHANT_ADDRESS, orderId);
// { merchant, settled, exists, feeBps, token, amount, expiry,
//   feeRecipient, settledAt, expectedPayer, nonce }

if (!order.exists)                 return 'order not found';
if (order.settled)                 return 'already paid';
if (order.expiry > 0n && Date.now() / 1000 > Number(order.expiry)) return 'expired';

const net = order.amount - (order.amount * BigInt(order.feeBps)) / 10000n;
// Display: \${formatQuai(order.amount)} QUAI due · includes \${order.feeBps / 100}% fee ·
//          merchant receives \${formatQuai(net)} QUAI
// expectedPayer != address(0) → only that wallet may pay (payOrder reverts with WrongPayer)`;

const confirmPoll = `// After the customer's payOrderNative tx confirms, the relayer re-checks
// settlement and POSTs the signed webhook. Poll until delivered — that's the
// signal to fulfill. On-chain settlement alone is NOT treated as complete.

let settled = false;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const res    = await fetch(\`https://<platform>/v1/orders/\${merchant}/\${orderId}\`);
  const status = await res.json();
  // { merchant, orderId, token, amount, feeBps, expiry, settled,
  //   webhook: { status: 'pending' | 'delivered' | 'failed', attempts } | null }
  if (status.settled && status.webhook?.status === 'delivered') {
    settled = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 5000));
}

// Fallback if the relayer API is unreachable: pay.isSettled(merchant, orderId)`;

const envVars = `# Client (browser) — MUST be NEXT_PUBLIC_* or it ships as undefined
NEXT_PUBLIC_RPC_URL=https://rpc.quai.network
NEXT_PUBLIC_CHAIN_ID=9
NEXT_PUBLIC_PAYWITHQUAI_ADDRESS=0x…   # from contracts/deployments/cyprus1.json
NEXT_PUBLIC_MUSDQ_ADDRESS=0x…         # mainnet stablecoin (6 decimals)
NEXT_PUBLIC_USDT_ADDRESS=0x…          # optional override — canonical USDT is built in
NEXT_PUBLIC_WQUAI_ADDRESS=0x…         # optional override — canonical WQUAI is built in
NEXT_PUBLIC_BACKEND_URL=https://tripplepay-three.vercel.app

# Server-only — NEVER prefix with NEXT_PUBLIC_ (ships to the browser bundle)
BACKEND_PRIVATE_KEY=...   # payout wallet: signs registrations, receives funds
WEBHOOK_SECRET=...        # shown once at onboarding
ADMIN_API_KEY=...         # relayer admin routes (onboarding)`;

const webhookJson = `{
  "id":   "0xabc...:3",
  "type": "payment.confirmed",
  "created": 1738340000,
  "data": {
    "merchantId": "mch_ab12...",
    "merchant":   "0x00...",       // on-chain payout address
    "orderId":    "0x...",
    "payer":      "0x...",
    "token":      "0x0000000000000000000000000000000000000000",
    "amount":     "25000000",   // gross the payer sent
    "feeBps":     30,           // platform fee rate locked at registration (0.3%)
    "fee":        "75000",      // platform fee = floor(amount × feeBps / 10000)
    "net":        "24925000",   // what you actually received
    "txHash":     "0x...",
    "blockNumber": 1234567,
    "timestamp":  1738340000,  // on-chain settlement time
    "nonce":      1            // per-merchant order nonce; bumps when an order id is reused after a purge
  }
}`;

const webhookVerify = `import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const app = express();
// IMPORTANT: hash the raw body — not parsed-then-restringified JSON.
app.post('/webhooks/paywithquai', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.header('X-PayWithQuai-Signature') ?? '';        // "t=...,v1=..."
  const raw    = req.body.toString('utf8');
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > 300) return res.sendStatus(400);   // reject stale (>5 min)

  const expected = createHmac('sha256', WEBHOOK_SECRET).update(\`\${t}.\${raw}\`).digest();
  const received = Buffer.from(v1, 'hex');
  const ok = received.length === expected.length && timingSafeEqual(received, expected);
  if (!ok) return res.sendStatus(401);

  const { data } = JSON.parse(raw);
  // Idempotent: if you've already fulfilled this orderId/txHash, just ack and return.
  fulfillOrder(data.orderId, data.net);

  res.sendStatus(200);   // 2xx within 10s = success. Anything else is retried.
});`;

const deployMainnet = `# Deploy PayWithQuai to Quai mainnet (chain 9, Cyprus-1 zone):
cd contracts
cp .env.example .env
# Fill in: RPC_URL=https://rpc.quai.network, CHAIN_ID=9, CYPRUS1_PK (funded hot key),
# FEE_RECIPIENT (treasury), STABLECOIN_ADDR, MULTISIG_ADDR, PAUSE_GUARDIAN_ADDR.
npx hardhat run scripts/deploy.js --network cyprus1
# Writes contracts/deployments/cyprus1.json — copy payWithQuai into NEXT_PUBLIC_PAYWITHQUAI_ADDRESS.`;

function SectionHeading({
  id,
  kicker,
  title,
}: {
  id: string;
  kicker?: string;
  title: string;
}) {
  return (
    <div id={id} className="scroll-mt-24">
      {kicker && (
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#38bdf8]">
          {kicker}
        </p>
      )}
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
        {title}
      </h2>
    </div>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: "info" | "warning" | "success";
  title: string;
  children: React.ReactNode;
}) {
  const styles = {
    info: "border-[#38bdf8]/25 bg-[#38bdf8]/6 text-[#8b93a7]",
    warning: "border-amber-400/25 bg-amber-400/6 text-[#8b93a7]",
    success: "border-[#34d399]/25 bg-[#34d399]/6 text-[#8b93a7]",
  }[tone];

  const Icon = tone === "info" ? Info : tone === "warning" ? AlertTriangle : Check;

  return (
    <div className={`rounded-2xl border p-4 ${styles}`}>
      <p className="flex items-center gap-2 text-sm font-medium text-white">
        <Icon size={15} className={tone === "info" ? "text-[#38bdf8]" : tone === "warning" ? "text-amber-400" : "text-[#34d399]"} />
        {title}
      </p>
      <div className="mt-2 text-sm leading-6">{children}</div>
    </div>
  );
}

export default function DocsPage() {
  return (
    <main className="min-h-screen bg-[#171717] text-white">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b border-white/7 bg-[#171717]/80 backdrop-blur-xl">
        <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <span className="text-sm font-semibold tracking-tight text-white">
              TRIPPLEPAY ||<span className="text-[#38bdf8]">Merchants</span>
              <span className="ml-2 rounded-md border border-[#38bdf8]/25 bg-[#38bdf8]/8 px-1.5 py-0.5 text-[10px] font-medium text-[#38bdf8]">
                Docs
              </span>
            </span>
          </Link>

          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-[#8b93a7] transition hover:text-white"
          >
            <ArrowLeft size={15} />
            Back to site
          </Link>
        </nav>
      </header>

      <div className="mx-auto grid max-w-7xl gap-12 px-6 py-14 lg:grid-cols-[220px_1fr] lg:px-8">
        {/* Sidebar */}
        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <p className="px-3 pb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8b93a7]">
              On this page
            </p>

            <nav className="space-y-1">
              <DocsSideNav sections={sections} />
            </nav>
          </div>
        </aside>

        {/* Content */}
        <article className="min-w-0 max-w-7xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#38bdf8]">
            Merchant Integration
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">
            Accept crypto payments on Quai in 3 steps.
          </h1>
          <p className="mt-4 max-w-2xl text-lg leading-8 text-[#8b93a7]">
            Funds go straight to your wallet (the contract holds nothing), and
            you get a signed webhook when a payment confirms.
          </p>

          {/* Overview */}
          <section className="mt-12">
            <SectionHeading id="overview" kicker="Overview" title="The flow at a glance" />

            <div className="mt-6 space-y-3">
              {[
                {
                  n: "1",
                  t: "Register an order",
                  d: "Your backend registers the expected payment on-chain.",
                },
                {
                  n: "2",
                  t: "Customer pays",
                  d: "One contract call — ERC-20 or native QUAI.",
                },
                {
                  n: "3",
                  t: "We POST a webhook",
                  d: "Signed webhook confirms the payment; you fulfill.",
                },
              ].map((s) => (
                <div
                  key={s.n}
                  className="flex items-start gap-4 rounded-2xl border border-white/7 bg-[#171717] p-5"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#38bdf8]/10 text-sm font-bold text-[#38bdf8]">
                    {s.n}
                  </span>
                  <div>
                    <p className="text-sm font-medium">{s.t}</p>
                    <p className="mt-1 text-sm leading-6 text-[#8b93a7]">
                      {s.d}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Before you start */}
          <section className="mt-16">
            <SectionHeading id="before-you-start" kicker="Setup" title="Before you start" />

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              Your platform operator gives you three things at onboarding:
            </p>

            <div className="mt-5 overflow-hidden rounded-2xl border border-white/7">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/7 bg-white/2">
                    <th className="px-4 py-3 font-medium text-[#8b93a7]">
                      You receive
                    </th>
                    <th className="px-4 py-3 font-medium text-[#8b93a7]">
                      What it&apos;s for
                    </th>
                  </tr>
                </thead>
                <tbody className="text-[#c9d4e0]">
                  <tr className="border-b border-white/7">
                    <td className="px-4 py-3 font-mono text-[13px]">
                      PAYWITHQUAI_ADDRESS
                    </td>
                    <td className="px-4 py-3 text-[#8b93a7]">
                      The contract address you register orders on
                    </td>
                  </tr>
                  <tr className="border-b border-white/7">
                    <td className="px-4 py-3 font-mono text-[13px]">
                      webhookSecret
                    </td>
                    <td className="px-4 py-3 text-[#8b93a7]">
                      Secret key to verify webhooks are really from us
                      <span className="ml-1 text-[#e0a95e]">
                        (shown once — store it safely)
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-mono text-[13px]">
                      merchantId
                    </td>
                    <td className="px-4 py-3 text-[#8b93a7]">
                      Your platform id, e.g. <span className="font-mono">mch_ab12...</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mt-5 space-y-4">
              <Callout tone="success" title="Quai mainnet (chain 9)">
                The platform runs on Quai mainnet, Cyprus-1 zone:
                <span className="mt-2 block font-mono text-[13px] text-[#c9d4e0]">
                  {`RPC https://rpc.quai.network · chainId 9`}
                </span>
                <span className="mt-2 block">
                  Deploy the PayWithQuai proxy once (see the deployment section
                  below) and set{" "}
                  <span className="font-mono text-[13px] text-[#c9d4e0]">
                    NEXT_PUBLIC_PAYWITHQUAI_ADDRESS
                  </span>{" "}
                  from{" "}
                  <span className="font-mono text-[13px] text-[#c9d4e0]">
                    contracts/deployments/cyprus1.json
                  </span>
                  . Your payout wallet and the contract must be in the same zone
                  — Cyprus-1 (0x00…).
                </span>
              </Callout>

              <Callout tone="info" title="Use the `quais` package, not ethers">
                All examples use{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">quais</span>{" "}
                — Quai&apos;s ethers fork. It ships{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">
                  usePathing
                </span>{" "}
                (zone-aware RPC),{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">
                  formatQuai / parseQuai
                </span>{" "}
                and the wallet types used below.
              </Callout>

              <Callout tone="info" title="Same zone — this matters">
                Quai is sharded. Your payout wallet, your customers, and the
                contract must all be in the same zone (the contract address
                prefix tells you which, e.g. <span className="font-mono text-[#c9d4e0]">0x00…</span> =
                Cyprus-1). Value can&apos;t move between zones.
              </Callout>

              <Callout tone="info" title="Amounts are in the token's smallest unit">
                Always use strings/bigint — never floats. For a 6-decimal
                stablecoin, <span className="font-mono text-[#c9d4e0]">$25.00</span> ={" "}
                <span className="font-mono text-[#c9d4e0]">25000000</span>. QUAI is{" "}
                <span className="font-mono text-[#c9d4e0]">token = address(0)</span>.
              </Callout>
            </div>
          </section>

          {/* Supported assets */}
          <section className="mt-16">
            <SectionHeading
              id="supported-assets"
              kicker="Currencies"
              title="Supported assets"
            />

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              Orders can be registered in native QUAI or any ERC-20 the contract
              owner has allowlisted. The platform ships with these assets built
              in — payment links, checkout, Blip and the dashboard balances
              panel all pick them up automatically:
            </p>

            <div className="mt-5 overflow-hidden rounded-xl border border-white/7">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/7 bg-white/3">
                    <th className="px-4 py-3 font-medium text-[#8b93a7]">Asset</th>
                    <th className="px-4 py-3 font-medium text-[#8b93a7]">Address</th>
                    <th className="px-4 py-3 font-medium text-[#8b93a7]">Decimals</th>
                    <th className="px-4 py-3 font-medium text-[#8b93a7]">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/6">
                  <tr>
                    <td className="px-4 py-3 font-medium">QUAI</td>
                    <td className="px-4 py-3 font-mono text-[12px] text-[#c9d4e0]">address(0)</td>
                    <td className="px-4 py-3 text-[#8b93a7]">18</td>
                    <td className="px-4 py-3 text-[#8b93a7]">Native gas asset — always accepted</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium">USDT</td>
                    <td className="px-4 py-3 break-all font-mono text-[12px] text-[#c9d4e0]">0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5</td>
                    <td className="px-4 py-3 text-[#8b93a7]">6</td>
                    <td className="px-4 py-3 text-[#8b93a7]">Tether USD — canonical mainnet token</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium">WQUAI</td>
                    <td className="px-4 py-3 break-all font-mono text-[12px] text-[#c9d4e0]">0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB</td>
                    <td className="px-4 py-3 text-[#8b93a7]">18</td>
                    <td className="px-4 py-3 text-[#8b93a7]">Wrapped Quai — ERC-20 form of QUAI</td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3 font-medium">mUSDQ</td>
                    <td className="px-4 py-3 break-all font-mono text-[12px] text-[#c9d4e0]">0x003fafB5126a5296c6edC7C23De55daf2E84B503</td>
                    <td className="px-4 py-3 text-[#8b93a7]">6</td>
                    <td className="px-4 py-3 text-[#8b93a7]">Mock stablecoin — testnet faucet only</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mt-5 space-y-4">
              <Callout tone="info" title="Registry-driven frontend">
                Canonical addresses are compiled into{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">frontend/src/lib/currencies.ts</span>{" "}
                and can be overridden per deployment with{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">NEXT_PUBLIC_USDT_ADDRESS</span> /{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">NEXT_PUBLIC_WQUAI_ADDRESS</span>.
                Every surface (link builder, pay page, checkout, dashboard, analytics) reads from
                this one registry.
              </Callout>

              <Callout tone="warning" title="Tokens must be allowlisted on the contract">
                Registering an order in a token the contract hasn&apos;t accepted reverts with{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">TokenNotAccepted</span>. The
                owner enables assets once with{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">npx hardhat run scripts/allowTokens.js --network cyprus1</span>{" "}
                (USDT + WQUAI are already enabled on mainnet). Optionally set{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">ACCEPTED_TOKENS</span> on the
                backend to mirror the same list for payment-link creation.
              </Callout>

              <Callout tone="success" title="Blip pays every listed asset">
                The &quot;Pay with Blip&quot; flow works for native QUAI and all supported
                tokens alike — balance check, top-up and approve/transferFrom are handled by the
                app.
              </Callout>
            </div>
          </section>

          {/* Step 1 */}
          <section className="mt-16">
            <SectionHeading
              id="register-order"
              kicker="Step 1"
              title="Register the order (from your backend)"
            />

            <div className="mt-5">
              <CodeBlock label="install" code={installQuais} />
            </div>

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              Register every expected payment before the customer pays.
              Broadcast <span className="text-white">from your payout wallet</span> — that
              wallet becomes both your merchant identity and where the money
              lands.
            </p>

            <div className="mt-5">
              <CodeBlock label="registerOrder.ts" code={received} />
            </div>

            <ul className="mt-4 space-y-2 text-sm leading-6 text-[#8b93a7]">
              <li className="flex gap-2.5">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#38bdf8]/6" />
                <span>
                  <span className="font-mono text-[13px] text-[#c9d4e0]">token</span>: an
                  allowlisted ERC-20 address, or{" "}
                  <span className="font-mono text-[13px] text-[#c9d4e0]">address(0)</span>{" "}
                  for native QUAI.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#38bdf8]/6" />
                <span>
                  <span className="font-mono text-[13px] text-[#c9d4e0]">msg.sender</span>{" "}
                  is the <span className="text-white">merchant</span> — the same address
                  customers pass to{" "}
                  <span className="font-mono text-[13px] text-[#c9d4e0]">payOrder(merchant, orderId)</span>.
                  Orders are keyed by{" "}
                  <span className="font-mono text-[13px] text-[#c9d4e0]">
                    orderKey(merchant, orderId)
                  </span>
                  , so a wallet can only see the orders it registered.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#38bdf8]/6" />
                <span>
                  The platform fee (0.3%) is locked into the order automatically
                  here — you don&apos;t pass it.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#38bdf8]/6" />
                <span>
                  <span className="font-mono text-[13px] text-[#c9d4e0]">
                    registerOrderWithPayer(orderId, token, amount, expiry, customerAddress)
                  </span>{" "}
                  restricts settlement to one wallet — prepaid or invoice orders
                  can&apos;t be front-run.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#38bdf8]/6" />
                <span>
                  Full ABI for the functions above:
                </span>
              </li>
            </ul>

            <div className="mt-3">
              <CodeBlock label="paywithquai.abi.js" code={abiSnippet} />
            </div>
          </section>

          {/* Step 2 */}
          <section className="mt-16">
            <SectionHeading
              id="customer-pays"
              kicker="Step 2"
              title="Customer pays"
            />

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              Point the customer at any checkout you own. Payment is always a
              single contract call.
            </p>

            <p className="mt-5 text-sm font-medium text-white">ERC-20 — approve, then pay:</p>
            <div className="mt-3">
              <CodeBlock label="pay.ts" code={erc20Pay} />
            </div>

            <p className="mt-5 text-sm font-medium text-white">Native QUAI — send exact value:</p>
            <div className="mt-3">
              <CodeBlock label="pay.ts" code={nativePay} />
            </div>

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              The <span className="font-mono text-[13px] text-[#c9d4e0]">merchant</span>{" "}
              argument is the payout wallet that registered the order. On the checkout
              page, connect the customer&apos;s wallet like this:
            </p>
            <div className="mt-3">
              <CodeBlock label="connect.ts" code={walletDetect} />
            </div>

            <Callout tone="success" title="One transaction, zero double-fulfillment">
              The contract splits off the fee, forwards the rest to your wallet,
              and marks the order settled — all in one transaction. A second
              payment reverts, so double-fulfillment is impossible.
            </Callout>
          </section>

          {/* Read an order on-chain */}
          <section className="mt-16">
            <SectionHeading
              id="read-order"
              kicker="Checkout"
              title="Read an order on-chain"
            />

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              Every order is a public on-chain record. Build the checkout page
              URL{" "}
              <span className="font-mono text-[13px] text-[#c9d4e0]">
                /checkout/&lt;merchant&gt;/&lt;orderId&gt;
              </span>{" "}
              and render the total, fee and payer restriction{" "}
              <span className="text-white">from the contract</span> — never from a
              client-side cart value.
            </p>

            <div className="mt-5">
              <CodeBlock label="read-order.ts" code={readOrder} />
            </div>

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              <span className="font-mono text-[13px] text-[#c9d4e0]">getOrder</span>{" "}
              is the authoritative source for the checkout UI — it works with a
              read-only provider (no wallet needed). Order states:
            </p>

            <ul className="mt-4 space-y-2 text-sm leading-6 text-[#8b93a7]">
              {[
                "exists = false → show “order not found” (or fall back to GET /v1/orders/... if the registration tx isn't mined yet)",
                "settled = true → show “already paid”, never ask again",
                "expiry > 0 and now > expiry → show “expired”, ask the merchant for a fresh link",
                "expectedPayer ≠ address(0) → only that wallet can pay; payOrder reverts with WrongPayer",
              ].map((item) => (
                <li key={item} className="flex gap-2.5">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#38bdf8]/6" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Payment Links */}
          <section className="mt-16">
            <SectionHeading
              id="payment-links"
              kicker="Shareable Checkouts"
              title="Payment Links"
            />

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              You don&apos;t need to build a custom checkout flow. Once an order is registered, you can simply direct customers to the hosted checkout page using a <strong className="text-white">Payment Link</strong>.
            </p>

            <p className="mt-3 text-[15px] leading-7 text-[#8b93a7]">
              Even simpler: build links in the dashboard (<span className="font-mono text-[13px]">Links → New link</span>) — pick any{" "}
              <Link className="text-[#38bdf8] hover:underline" href="#supported-assets">supported asset</Link>, set a fixed or
              customer-entered amount, and share the short URL. Customers who pay a link can
              leave their name, so your payment history shows{" "}
              <span className="font-medium text-white">who paid and for what</span> — expand any
              row for full details.
            </p>

            <div className="mt-5">
              <CodeBlock
                label="payment-link.ts"
                code={`// Generate a shareable payment link for any registered order
const paymentLink = \`\${ORIGIN}/checkout/\${merchant}/\${orderId}\`;

// Share via email, SMS, or QR code
console.log("Pay here:", paymentLink);`}
              />
            </div>

            <Callout tone="success" title="Zero frontend required">
              Payment Links automatically handle wallet connection, correct network prompting, Blip Pay mobile integration, and transaction execution. You only need to register the order backend and listen for the webhook.
            </Callout>
          </section>

          {/* Mobile Payments (Blip Pay) */}
          <section className="mt-16">
            <SectionHeading
              id="mobile-payments"
              kicker="Blip Pay"
              title="Mobile payments & auth with Blip"
            />

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              TripplePay || Merchants natively supports <span className="font-medium text-white">Blip Pay</span> for merchant auth (onboarding/login) and mobile checkouts. Instead of a standard wallet popup, you can present a QR code or deep link that opens the Blip app (iOS & Android) directly.
            </p>

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              Encode your checkout page URL in a QR code, or deep-link mobile users into Blip&apos;s
              in-app browser. Both paths call <span className="font-mono text-[#c9d4e0]">payOrderNative</span>{" "}
              on PayWithQuai — the merchant dashboard updates via webhook, same as a desktop wallet.
            </p>

            <div className="mt-5">
              <CodeBlock
                label="blip-link.ts"
                code={`const checkoutUrl = \`\${ORIGIN}/checkout/\${merchant}/\${orderId}\`;

// QR — works on any phone (Blip in-app browser or Pelagus / MetaMask in Safari/Chrome)
<QRCode value={checkoutUrl} size={160} />

// Mobile — open checkout inside the Blip app (iOS & Android)
const blipLink = \`https://blippay.me/browser?url=\${encodeURIComponent(checkoutUrl)}\`;`}
              />
            </div>

            <Callout tone="info" title="Inside Blip's browser">
              When the checkout loads inside Blip, <span className="font-mono text-[#c9d4e0]">window.quai</span> is
              injected automatically. The customer taps Pay once — the app signs{" "}
              <span className="font-mono text-[#c9d4e0]">payOrderNative</span> and the relayer POSTs the
              signed webhook to the merchant.
            </Callout>

            <Callout tone="warning" title="Do not use blip://pay for registered orders">
              <span className="font-mono text-[#c9d4e0]">blip://pay?to=…&amp;amount=…</span> sends QUAI
              directly to an address and skips PayWithQuai — no order settlement, no webhook. Always
              route customers through your checkout URL instead.
            </Callout>

            <Callout tone="info" title="Automatic detection">
              When a user browses your checkout, onboarding, or login pages from within the Blip in-app browser, it automatically injects{" "}
              <span className="font-mono text-[13px] text-[#c9d4e0]">window.quai</span>. You can detect it to seamlessly trigger standard EIP-1193 interactions (connecting, signing, or paying) with just a tap!
            </Callout>
          </section>

          {/* Step 3 */}
          <section className="mt-16">
            <SectionHeading
              id="webhook"
              kicker="Step 3"
              title="Receive & verify the webhook"
            />

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              When the payment is final, we POST one webhook to your endpoint:
            </p>

            <Callout tone="info" title="Webhooks are optional">
              Only merchants that need automated fulfillment configure a receiver URL.
              Payment-link sellers without a website don&apos;t need one — every payment is
              verified on-chain and lands directly in the payout wallet, and the dashboard
              shows it as <span className="font-medium text-white">Confirmed</span> regardless.
              The webhook is a convenience channel, never the source of truth for settlement.
            </Callout>

            <div className="mt-5">
              <CodeBlock label="POST payload" code={webhookJson} />
            </div>

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              <span className="font-medium text-white">Always verify the signature</span>{" "}
              before trusting a webhook, then credit{" "}
              <span className="font-mono text-[13px] text-[#c9d4e0]">net</span> to the
              order.
            </p>

            <div className="mt-5">
              <CodeBlock label="verify.ts" code={webhookVerify} />
            </div>

            <Callout tone="warning" title="Endpoint requirements">
              Your endpoint must be <span className="text-white">https</span>, publicly
              reachable, respond <span className="text-white">2xx within 10s</span>, and be{" "}
              <span className="text-white">idempotent</span> — the same payment can arrive
              more than once.
            </Callout>
          </section>

          {/* Confirmation & fulfillment */}
          <section className="mt-16">
            <SectionHeading
              id="confirmation"
              kicker="Fulfillment"
              title="Confirmation & fulfillment"
            />

            <p className="mt-5 text-[15px] leading-7 text-[#8b93a7]">
              The checkout waits for the relayer to confirm the webhook —{" "}
              <span className="text-white">not</span> just on-chain settlement.
              Poll{" "}
              <span className="font-mono text-[13px] text-[#c9d4e0]">
                GET /v1/orders/&lt;merchant&gt;/&lt;orderId&gt;
              </span>{" "}
              until{" "}
              <span className="font-mono text-[13px] text-[#c9d4e0]">
                settled === true &amp;&amp; webhook.status === &quot;delivered&quot;
              </span>{" "}
              (up to ~120s), with an on-chain{" "}
              <span className="font-mono text-[13px] text-[#c9d4e0]">isSettled</span>{" "}
              fallback when the API is unreachable:
            </p>

            <div className="mt-5">
              <CodeBlock label="wait-for-confirmation.ts" code={confirmPoll} />
            </div>

            <Callout tone="info" title="Fulfill on the signed webhook, not a chain read">
              A chain read tells you the customer paid — but{" "}
              <span className="font-mono text-[13px] text-[#c9d4e0]">
                webhook.status === &quot;delivered&quot;
              </span>{" "}
              tells you the signed{" "}
              <span className="font-mono text-[13px] text-[#c9d4e0]">
                payment.confirmed
              </span>{" "}
              event reached <span className="text-white">your</span> endpoint. For
              order fulfillment (shipping, access, credits) treat the signed
              webhook as the receipt of record.
            </Callout>
          </section>

          {/* Quick reference */}
          <section className="mt-16">
            <SectionHeading
              id="quick-reference"
              kicker="Reference"
              title="Quick reference"
            />

            <p className="mt-5 text-sm font-medium text-white">
              Check an order&apos;s status yourself (fallback if you miss a webhook):
            </p>
            <div className="mt-3">
              <CodeBlock
                label="GET"
                code={`GET /v1/orders/0x<merchant>/0x<orderId>
→ {
    merchant, orderId, token, amount, feeBps, expiry, settled,
    webhook: { status: "pending" | "delivered" | "failed", attempts } | null
  }`}
              />
            </div>

            <p className="mt-5 text-sm font-medium text-white">Common reverts to surface to customers:</p>
            <div className="mt-3 overflow-hidden rounded-2xl border border-white/7">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/7 bg-white/2">
                    <th className="px-4 py-3 font-medium text-[#8b93a7]">Revert</th>
                    <th className="px-4 py-3 font-medium text-[#8b93a7]">Meaning</th>
                  </tr>
                </thead>
                <tbody className="text-[#c9d4e0]">
                  {[
                    ["OrderAlreadySettled", "already paid"],
                    ["OrderExpired", "past the expiry timestamp"],
                    [
                      "IncorrectNativeValue",
                      "msg.value ≠ the order amount (native path)",
                    ],
                    [
                      "WrongPaymentPath",
                      "used the ERC-20 call on a native order, or vice-versa",
                    ],
                    ["OrderNotFound", "no such order for that merchant"],
                    [
                      "WrongPayer",
                      "order registered with registerOrderWithPayer and you're not the expected payer",
                    ],
                    [
                      "OrderAlreadyExists",
                      "this orderId is already registered — use a fresh random id",
                    ],
                    ["TokenNotAccepted", "token isn't allowlisted on the contract"],
                    ["ZeroAmount", "order amount was zero"],
                  ].map(([revert, meaning]) => (
                    <tr key={revert} className="border-b border-white/7 last:border-0">
                      <td className="px-4 py-3 font-mono text-[13px] text-[#e0a95e]">
                        {revert}
                      </td>
                      <td className="px-4 py-3 text-[#8b93a7]">{meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-6 text-sm font-medium text-white">
              Environment variables (from the reference frontend):
            </p>
            <div className="mt-3">
              <CodeBlock label=".env" code={envVars} />
            </div>

            <p className="mt-6 text-sm font-medium text-white">
              Managing orders (all from your payout wallet):
            </p>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-[#8b93a7]">
              <li className="flex gap-2.5">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#38bdf8]/6" />
                <span>
                  <span className="font-mono text-[13px] text-[#c9d4e0]">cancelOrder(orderId)</span>{" "}
                  — cancel an unpaid order and free the id.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#38bdf8]/6" />
                <span>
                  <span className="font-mono text-[13px] text-[#c9d4e0]">purgeSettledOrder(orderId)</span>{" "}
                  — reclaim storage 1 day after settlement.
                </span>
              </li>
              <li className="flex gap-2.5">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[#38bdf8]/6" />
                <span>
                  Use a fresh <span className="font-mono text-[13px] text-[#c9d4e0]">orderId</span>{" "}
                  per payment; reusing ids makes status lookups ambiguous.
                </span>
              </li>
            </ul>
          </section>

          {/* Deployment */}
          <section className="mt-16">
            <SectionHeading
              id="testing"
              kicker="Mainnet"
              title="Deployment & local development"
            />

            <div className="mt-5">
              <CodeBlock label="Terminal" code={deployMainnet} />
            </div>

            <Callout tone="info" title="Running the platform locally">
              <span className="mt-1 block">
                Backend relayer (indexer + webhook dispatcher + API):
              </span>
              <span className="mt-1 block font-mono text-[13px] text-[#c9d4e0]">
                {`cd backend && npm install && cp .env.example .env && npm run dev`}
              </span>
              <span className="mt-3 block">
                For local endpoints only, set{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">
                  WEBHOOK_ALLOW_INSECURE_URLS=true
                </span>{" "}
                to allow{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">
                  http://localhost
                </span>{" "}
                webhook targets. A throwaway webhook receiver is included:{" "}
                <span className="font-mono text-[13px] text-[#c9d4e0]">
                  npm run webhook-receiver
                </span>
                .
              </span>
            </Callout>
          </section>

          {/* Bottom CTA */}
          <section className="mt-16 rounded-3xl border border-[#38bdf8]/25 bg-[#38bdf8]/6 p-8">
            <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
              <div>
                <p className="text-lg font-semibold">Ready to accept payments?</p>
                <p className="mt-1 text-sm text-[#8b93a7]">
                  Set up your merchant profile and connect a settlement wallet.
                </p>
              </div>
              <Link
                href="/onboarding"
                className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#38bdf8] px-5 text-sm font-medium text-[#061018] transition hover:bg-[#67d8ff]"
              >
                Get started
                <ArrowRight size={15} />
              </Link>
            </div>
          </section>

          {/* Footer */}
          <footer className="mt-16 flex flex-col gap-4 border-t border-white/7 py-8 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <Logo className="h-6 w-6" />
              <span className="text-sm font-medium text-[#8b93a7]">
                TripplePay || Marchants
              </span>
            </div>
            <div className="flex items-center gap-4 text-xs text-[#4f5868]">
              <Link href="/terms" className="transition hover:text-[#8b93a7]">
                Terms of Service
              </Link>
              <span>·</span>
              <p>Built on Quai Network · Non-custodial payments</p>
            </div>
          </footer>
        </article>
      </div>
    </main>
  );
}