"use client";

import { Check, Loader2, Save, ShieldCheck, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { parseError } from "@/lib/utils";

import { DashboardShell } from "@/components/layout/dashboard-shell";
import { WalletSelector } from "@/components/ui/wallet-selector";
import { isLoggedIn } from "@/lib/auth";
import { adminPatch, useRelayerData } from "@/lib/relayer";
import {
  DEFAULT_WEBHOOK_PATH,
  normalizeWebhookInput,
  webhookUrlPreview,
} from "@/lib/webhook";

export default function SettingsPage() {
  const { merchants, loading, error, refresh } = useRelayerData();
  const [address, setAddress] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const merchant = merchants[0] ?? null;

  useEffect(() => {
    if (!merchant || dirty) return;
    const t = setTimeout(() => setWebhookUrl(merchant.webhookUrl), 0);
    return () => clearTimeout(t);
  }, [merchant, dirty]);

  const save = async () => {
    if (!merchant) return;
    // Accept a bare domain ("myshop.com") or a full URL — normalize before sending.
    let url: string;
    try {
      url = normalizeWebhookInput(webhookUrl);
    } catch (err) {
      setSaveError(parseError(err));
      return;
    }
    const parsedProtocol = url.slice(0, url.indexOf(":"));
    if (parsedProtocol !== "https:" && parsedProtocol !== "http:") {
      setSaveError("Webhook URL must start with http(s)://");
      return;
    }
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      // Logged-in merchants update their own profile (cookie/token-authenticated);
      // the demo fallback goes through the server-side admin proxy (no leaked key).
      const path = isLoggedIn()
        ? "/v1/me"
        : `/api/admin/merchants/${merchant.address}`;
      await adminPatch(path, { webhookUrl: url });
      setWebhookUrl(url);
      setDirty(false);
      setSaved(true);
      void refresh();
    } catch (err) {
      setSaveError(parseError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DashboardShell>
      <div className="mx-auto max-w-4xl px-5 py-8 lg:px-8 lg:py-10">
        <div className="mb-8">
          <p className="mb-2 text-sm text-[#38bdf8]">Configuration</p>
          <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-2 text-sm text-[#8b93a7]">
            Merchant profile and settlement wallet, synced with the relayer.
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
            Relayer unreachable: {error}
          </div>
        )}

        <div className="space-y-5">
          <section className="rounded-2xl border border-white/7 bg-[#171717] p-6">
            <div className="mb-6 flex items-start gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#38bdf8]/15 bg-[#38bdf8]/6 text-[#38bdf8]">
                <Wallet size={18} />
              </div>
              <div>
                <h2 className="font-semibold">Merchant profile</h2>
                <p className="mt-1 text-xs text-[#8b93a7]">
                  Registered with the relayer — updates ship via PATCH
                  /v1/merchants.
                </p>
              </div>
            </div>

            {loading ? (
              <p className="text-sm text-[#8b93a7]">Loading…</p>
            ) : merchant ? (
              <div className="space-y-4">
                <div className="space-y-5">
                  <div className="text-sm">
                    <span className="mb-2 block text-[#8b93a7]">
                      Business name
                    </span>
                    <div className="h-11 w-full rounded-xl border border-white/7 bg-[#171717] px-3 py-3 text-white">
                      {merchant.name}
                    </div>
                  </div>

                  <div className="text-sm">
                    <span className="mb-2 block text-[#8b93a7]">
                      Merchant ID
                    </span>
                    <div className="h-11 w-full rounded-xl border border-white/7 bg-[#171717] px-3 py-3 font-mono text-xs text-white">
                      {merchant.merchantId}
                    </div>
                  </div>
                </div>

                <div className="text-sm">
                  <span className="mb-2 block text-[#8b93a7]">Webhook URL</span>
                  <div className="flex h-11 items-center overflow-hidden rounded-xl border border-white/7 bg-[#171717] transition focus-within:border-[#38bdf8]/40">
                    <input
                      type="text"
                      value={webhookUrl}
                      onChange={(e) => {
                        setWebhookUrl(e.target.value);
                        setDirty(true);
                        setSaved(false);
                        setSaveError(null);
                      }}
                      placeholder="yourdomain.com"
                      autoComplete="off"
                      inputMode="url"
                      className="h-full w-full bg-transparent px-3 font-mono text-xs text-white outline-none placeholder:text-[#4f5868]"
                    />
                  </div>
                  <p className="mt-2 text-xs text-[#4f5868]">
                    {webhookUrl.trim() && webhookUrlPreview(webhookUrl) ? (
                      <>
                        Deliveries go to{" "}
                        <span className="break-all text-[#8b93a7]">
                          {webhookUrlPreview(webhookUrl)}
                        </span>
                      </>
                    ) : (
                      <>
                        Your domain is enough — we complete it to{" "}
                        <code>https://yourdomain{DEFAULT_WEBHOOK_PATH}</code>. A
                        full URL also works. HTTPS required (http://localhost is
                        allowed in development).
                      </>
                    )}
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-[#8b93a7]">
                No merchant registered yet — complete onboarding first.
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-white/7 bg-[#171717] p-6">
            <div className="mb-6 flex items-start gap-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/15 bg-emerald-400/6 text-emerald-300">
                <ShieldCheck size={18} />
              </div>
              <div>
                <h2 className="font-semibold">Settlement wallet</h2>
                <p className="mt-1 text-xs text-[#8b93a7]">
                  The wallet that receives your settled payments.
                </p>
              </div>
            </div>

            {address ? (
              <div className="rounded-xl border border-white/7 bg-[#171717] p-4">
                <p className="text-xs text-[#8b93a7]">Connected address</p>
                <p className="mt-2 break-all font-mono text-sm text-white">
                  {address}
                </p>
                <p className="mt-2 text-xs text-emerald-300">
                  This address can receive payments on every chain you create links on — merchants are chain-free.
                </p>
              </div>
            ) : (
              <WalletSelector
                connectedAddress={null}
                onConnected={setAddress}
                label="Connect settlement wallet"
                chain="any"
              />
            )}
          </section>

          <div className="flex items-center justify-end gap-3">
            {saveError && (
              <p className="text-sm text-red-400">{saveError}</p>
            )}
            {saved && !saveError && (
              <p className="flex items-center gap-1.5 text-sm text-emerald-300">
                <Check size={14} />
                Saved
              </p>
            )}
            <button
              onClick={() => void save()}
              disabled={!merchant || !dirty || saving}
              className="inline-flex items-center gap-2 rounded-xl bg-[#38bdf8] px-5 py-2.5 text-sm font-semibold text-[#061018] transition hover:bg-[#67d8ff] disabled:opacity-50"
            >
              {saving ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Save size={16} />
              )}
              Save changes
            </button>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}