/** Qi amount helpers for the checkout surfaces. Qi's native subunit is the qit: 1000 qits = 1 Qi.
 *  Amounts received from the backend are decimal qits strings to stay JSON-safe (qits can be
 *  far beyond 2^53 for large orders; bigint avoids rounding). */

export const QITS_PER_QI = 1000n;

function asBigInt(qits: bigint | string): bigint {
  return typeof qits === "string" ? BigInt(qits) : qits;
}

/** Format a qits amount as Qi, keeping up to 3 fractional places (1000 qits = 1 Qi), e.g.
 *  "1250" → "1.25 Qi", "2000" → "2 Qi". Fractional trailing zeros are trimmed. */
export function qitsToQi(qits: bigint | string): string {
  const v = asBigInt(qits);
  const qi = v / QITS_PER_QI;
  const rem = v % QITS_PER_QI;
  if (rem === 0n) return qi.toString();
  return `${qi.toString()}.${rem.toString().padStart(3, "0").replace(/0+$/, "")}`;
}

/** "Qi" unit with the QITS_PER_QI suffix for copy surfaces: "1 Qi (1000 qits)". */
export function formatQits(qits: bigint | string): string {
  const v = asBigInt(qits);
  return `${qitsToQi(v)} Qi (${v.toLocaleString("en-US")} qits)`;
}