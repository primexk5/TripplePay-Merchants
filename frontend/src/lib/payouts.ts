"use client";

/**
 * The merchant's per-chain payout addresses (GET /v1/me/payouts).
 *
 * Kept in its own module rather than folded into useRelayerData: that hook also polls deliveries
 * and admin data on an 8s timer, and the payout map changes only when the merchant edits it.
 */
import { useCallback, useEffect, useState } from "react";

import { backendFetch } from "@/lib/payment";
import type { PayoutAddress } from "@/lib/relayer";

export function usePayouts(): PayoutAddress[] {
  const [payouts, setPayouts] = useState<PayoutAddress[]>([]);

  const refresh = useCallback(async () => {
    try {
      // backendFetch proxies /v1/* through Next.js in the browser, so this is same-origin.
      const res = await backendFetch("/v1/me/payouts", { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const body = (await res.json()) as { payouts?: PayoutAddress[] };
      setPayouts(body.payouts ?? []);
    } catch {
      // Not signed in, or the relayer is briefly unreachable. The link form still works for
      // merchants who have never set a payout (their sign-in address is the destination); we
      // simply cannot pre-announce the address in that case.
    }
  }, []);

  useEffect(() => {
    // Deferred on a timer, matching useRelayerData: the setState lands in the fetch's async
    // continuation rather than during the effect itself.
    const initial = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(initial);
  }, [refresh]);

  return payouts;
}
