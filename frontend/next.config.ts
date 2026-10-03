import type { NextConfig } from "next";
// Relative import, not the "@/*" tsconfig alias: next.config.ts is loaded by Next's own
// bootstrap step, before webpack/the bundler (and its alias resolution) exist — a "@/lib/chains"
// import would type-check fine but fail to resolve at runtime here.
import { listChains } from "./src/lib/chains";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Every configured chain's RPC origin — derived from the SAME table the app itself reads
// (built-ins AND anything added at runtime via NEXT_PUBLIC_CHAINS), so a new chain is allowed
// here automatically. Adding a chain to chains.ts is the only edit needed; there is no second,
// separate CSP entry to remember. Deduplicated since more than one chain can share an RPC host,
// and each chain's own `?? "https://…"` fallback (see chains.ts) is what still guarantees a
// working default here even when its env var is unset — not a second hardcoded copy in this file.
const chainRpcOrigins = [
  ...new Set(
    listChains()
      .map((c) => originOf(c.rpcUrl))
      .filter((o): o is string => o !== null),
  ),
];

// connect-src must allow every configured chain's RPC, the relayer backend(s) and local dev
// receivers. Composed from the same env vars/table the app uses so the CSP doesn't drift from the
// config.
const connectSources = [
  "'self'",
  ...chainRpcOrigins,
  ...(process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8080")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
  // Render-hosted backend (the default deployment target)
  "https://*.onrender.com",
  "ws://localhost:*",
  "http://localhost:*",
]
  .filter(Boolean)
  .join(" ");

// Images a wallet EXTENSION injects into our own DOM (e.g. Pelagus adds its logo to the page it
// is injected into). Content injected by an extension is still fetched under *our* CSP, so these
// origins have to be allowed or the asset is blocked in the console and the wallet's UI renders
// broken. Kept as explicit origins rather than `img-src https:` — a wildcard would undo the point
// of a tight policy. Add an origin here when a supported wallet starts injecting one.
const injectedImageOrigins = ["https://pelaguswallet.io", "https://www.pelaguswallet.io"];

// React's dev-mode debugging (callstack reconstruction) requires eval; production never uses
// it. CSP headers apply to dev and prod alike, so include 'unsafe-eval' only for dev builds.
const scriptSrc = ["'self'", "'unsafe-inline'"];
if (process.env.NODE_ENV !== "production") {
  scriptSrc.push("'unsafe-eval'");
}

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // Browsers request /favicon.ico by default; serve the app icon instead.
      { source: "/favicon.ico", destination: "/icon.png", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              `script-src ${scriptSrc.join(" ")}`,
              "style-src 'self' 'unsafe-inline'", // React inline styles
              `img-src 'self' data: ${injectedImageOrigins.join(" ")}`.trim(),
              "font-src 'self' data:",
              `connect-src ${connectSources}`,
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
