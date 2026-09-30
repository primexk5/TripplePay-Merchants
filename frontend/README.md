This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Adding a chain

`src/lib/chains.ts` is the single source of truth for every chain the frontend can point a
wallet/payment at. To add one:

1. Add a `ChainInfo` entry to `NEXT_PUBLIC_CHAINS` (an inline JSON array, see
   `.env.local.example`) — no code change needed for a chain that just needs a chainId, kind
   (`"quai"` or `"evm"`), name, RPC URL, deployed `PayWithQuai` contract address, explorer URL and
   native-currency description. It's merged over the built-in chains (Quai, Robinhood Chain
   testnet) by chainId.
2. If the chain has known ERC-20s a merchant should be able to price a link in (beyond its native
   currency, which needs no extra config), add them to `ERC20S_BY_CHAIN` in `src/lib/currencies.ts`
   — derive decimals from the token contract, never guess.
3. Quai chains must use `kind: "quai"` and stay on the `quais` SDK path (`payment.ts`); every other
   chain uses `kind: "evm"` and goes through the `ethers` v6 path (`evmPayment.ts`). Don't add a
   third chain library — see `CHAIN_AUDIT.md` for why `quais` and `ethers` coexist rather than one
   replacing the other.
4. The backend must also be configured for the same chain (`backend/chains.example.json`) — a
   chain the frontend offers but the backend doesn't know about will fail link creation/claims.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
