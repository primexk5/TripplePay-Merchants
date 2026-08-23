import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Compact, copy-friendly dump of an unknown thrown value — used by the error UI's
 *  "details" section, because wallet bridges (Blip included) reject with shapes that
 *  parseError can't always classify and there are no devtools inside Blip's browser. */
export function rawErrorText(err: unknown): string {
  const parts: string[] = [];
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (e.code !== undefined) parts.push(`code: ${String(e.code)}`);
    for (const key of ["message", "shortMessage", "reason"] as const) {
      if (typeof e[key] === "string") parts.push(`${key}: ${e[key]}`);
    }
    const nested = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<string, unknown>;
    if (typeof nested.message === "string") parts.push(`data.message: ${nested.message}`);
    else if (typeof e.data === "string") parts.push(`data: ${e.data.slice(0, 300)}`);
    if (!parts.length) {
      try {
        parts.push(JSON.stringify(err));
      } catch {
        parts.push(String(err));
      }
    }
  } else {
    parts.push(String(err));
  }
  const text = parts.join(" | ");
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

export function parseError(err: unknown): string {
  const e = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  const nested = (typeof e.error === "object" && e.error !== null ? e.error : undefined) as
    | Record<string, unknown>
    | undefined;
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof e.message === "string"
          ? e.message
          : "";

  // quais/ethers v6 wraps rich errors: shortMessage (human text), reason (revert string),
  // code (machine type). Dig them out before falling back to the raw message.
  const shortMessage = typeof e.shortMessage === "string" ? e.shortMessage : "";
  const reason =
    typeof e.reason === "string" ? e.reason : typeof nested?.reason === "string" ? nested.reason : "";
  const nestedMessage =
    typeof nested?.message === "string"
      ? nested.message
      : typeof nested?.data === "object" && nested.data !== null &&
          typeof (nested.data as { message?: unknown }).message === "string"
        ? (nested.data as { message: string }).message
        : "";
  const code = typeof e.code === "string" ? e.code : "";

  const message = reason || shortMessage || nestedMessage || raw;
  const lowerMsg = message.toLowerCase();

  if (
    lowerMsg.includes("user rejected") ||
    lowerMsg.includes("quais-user-denied") ||
    lowerMsg.includes("action_rejected") ||
    code === "ACTION_REJECTED"
  ) {
    return "User rejected the request in the wallet.";
  }
  if (
    code === "INSUFFICIENT_FUNDS" ||
    lowerMsg.includes("insufficient funds") ||
    lowerMsg.includes("insufficient_funds")
  ) {
    return "Insufficient funds to complete this transaction.";
  }
  if (lowerMsg.includes("transaction underpriced") || code === "REPLACEMENT_UNDERPRICED") {
    return "Transaction underpriced. Please try with a higher gas price.";
  }
  if (lowerMsg.includes("nonce too low") || code === "NONCE_EXPIRED") {
    return "Transaction nonce too low. Please reset your wallet or try again.";
  }
  if (code === "UNPREDICTABLE_GAS_LIMIT" || lowerMsg.includes("unpredictable gas limit")) {
    return "Could not estimate gas — the order may be expired or already settled.";
  }
  if (code === "CALL_EXCEPTION" || lowerMsg.includes("execution reverted") || lowerMsg.includes("reverted")) {
    // Decoded custom errors (e.g. "OrderExpired", "IncorrectNativeValue") become friendly text.
    const known = {
      ordernotfound: "The order was not found on-chain — it may not be registered for this link yet.",
      orderalreadysettled: "This order was already paid.",
      orderexpired: "This payment link has expired.",
      wrongpayer: "This order is reserved for a different wallet.",
      wrongpaymentpath: "Payment method doesn't match the order's currency.",
      incorrectnativevalue: "The amount sent doesn't match the order amount.",
      nativetransferfailed: "The network rejected the payout transfer — please try again.",
    };
    for (const [key, text] of Object.entries(known)) {
      if (lowerMsg.includes(key)) return text;
    }
    const why = reason || shortMessage;
    return why ? `Transaction reverted: ${why}` : "Transaction reverted by the contract.";
  }
  if (
    code === "SERVER_ERROR" ||
    code === "TIMEOUT" ||
    lowerMsg.includes("network_error") ||
    lowerMsg.includes("disconnected") ||
    lowerMsg.includes("timed out")
  ) {
    return "Network error. Please check your connection to the network.";
  }

  // Long RPC/JSON blobs with no recognizable cause — keep it short instead of dumping raw JSON.
  if (message.length > 200) {
    return "Transaction failed due to an unknown error. Please try again.";
  }

  return message || "An unknown error occurred.";
}