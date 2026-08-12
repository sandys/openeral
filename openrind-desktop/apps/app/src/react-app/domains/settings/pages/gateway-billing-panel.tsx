/** @jsxImportSource react */
import { useState } from "react";
import { useGatewayBilling } from "../../cloud/gateway-billing-provider";
import { Button } from "../../../design-system/button";
import { t } from "../../../../i18n";
import { isDesktopRuntime } from "../../../../app/utils";

const settingsPanelClass =
  "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

export function GatewayBillingPanel() {
  const { billingStatus, stats, apiKeySet, loading, error, userName, userEmail, refreshStats, refreshStatus, logout } = useGatewayBilling();
  const [busy, setBusy] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pastedKey, setPastedKey] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  const connectGateway = () => {
    if (typeof window === "undefined") return;
    const gatewayUrl = "https://app.openrind.com"; // Change to configurability if needed
    window.open(`${gatewayUrl}/sign-in?intent=shell`, "_blank");
  };

  const payNow = async () => {
    setBusy(true);
    try {
      const bridge = window.__OPENRIND_DESKTOP_ELECTRON__;
      if (bridge?.invokeDesktop) {
        await bridge.invokeDesktop("openrindGatewayCheckout");
      }
    } catch (err) {
      console.error("Failed to start checkout:", err);
    } finally {
      setBusy(false);
    }
  };

  const formatTokens = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return num.toString();
  };

  const saveKey = async () => {
    if (!pastedKey.trim()) return;
    setPasteError(null);
    try {
      const bridge = window.__OPENRIND_DESKTOP_ELECTRON__;
      if (bridge?.invokeDesktop) {
        await bridge.invokeDesktop("openrindSetCredential", {
          key: "openrindGatewayApiKey",
          value: pastedKey.trim(),
        });
        localStorage.setItem("openrind_gateway_billing_status", "unpaid");
        localStorage.setItem("openrind_gateway_email", "Custom API Key");
        localStorage.setItem("openrind_gateway_name", "Individual User");
        await refreshStatus();
        await refreshStats();
        setPasteMode(false);
        setPastedKey("");
      }
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!isDesktopRuntime()) return null;

  return (
    <div className={`${settingsPanelClass} space-y-4`}>
      <div>
        <div className="text-sm font-medium text-gray-12">Openrind Gateway & Billing</div>
        <div className="text-xs text-gray-10">
          Monitor your AI cost, track usage limits, and manage your billing settings.
        </div>
      </div>

      {!apiKeySet ? (
        !pasteMode ? (
          <div className="rounded-xl border border-dls-border p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="space-y-1">
              <h4 className="text-sm font-medium text-gray-12">Connect Openrind Gateway</h4>
              <p className="text-xs text-gray-9">
                Track costs, get automatic updates, and unlock full cost monitoring features right away.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="outline"
                className="h-8 rounded-full px-3 text-xs"
                onClick={() => setPasteMode(true)}
              >
                Already have a key
              </Button>
              <Button
                variant="primary"
                className="h-8 rounded-full px-4 text-xs font-semibold"
                onClick={connectGateway}
              >
                Connect Gateway
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dls-border p-4 space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-gray-11">Paste your Gateway API Key</label>
              <input
                type="password"
                placeholder="sk-openrind-gateway-..."
                className="w-full h-10 px-3 rounded-lg border border-dls-border bg-dls-surface font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] text-gray-12"
                value={pastedKey}
                onChange={(e) => setPastedKey(e.target.value)}
              />
              {pasteError && <p className="text-xs text-red-11 mt-1 font-mono">{pasteError}</p>}
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                className="h-8 rounded-full px-4 text-xs"
                onClick={() => { setPasteMode(false); setPasteError(null); }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                className="h-8 rounded-full px-4 text-xs bg-[var(--dls-accent)] text-white"
                onClick={saveKey}
                disabled={!pastedKey.trim()}
              >
                Save Key
              </Button>
            </div>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {/* User Account Info */}
          {(userName || userEmail) && (
            <div className="rounded-xl border border-dls-border bg-dls-sidebar p-3 flex justify-between text-xs">
              <div>
                <span className="text-gray-9 block">Name</span>
                <span className="font-semibold text-gray-12">{userName || "User"}</span>
              </div>
              <div className="text-right">
                <span className="text-gray-9 block">Email</span>
                <span className="font-semibold text-gray-12">{userEmail}</span>
              </div>
            </div>
          )}

          {/* Status Alert Banner */}
          {billingStatus === "unpaid" && (
            <div className="rounded-xl border border-red-7/30 bg-red-2/20 p-3 text-xs text-red-12 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <strong className="font-semibold">Subscription Required</strong>
                <p className="text-gray-9 mt-0.5">Please subscribe to activate Openrind Gateway and enable AI cost monitoring.</p>
              </div>
              <Button
                variant="primary"
                className="h-7 shrink-0 rounded-full px-3 text-[11px] font-semibold bg-red-9 hover:bg-red-10 text-white"
                onClick={payNow}
                disabled={busy}
              >
                Subscribe ($10/mo)
              </Button>
            </div>
          )}

          {billingStatus === "paid" && (
            <div className="rounded-xl border border-green-7/30 bg-green-2/20 p-3 text-xs text-green-12">
              <strong className="font-semibold">Subscription Active</strong>
              <p className="text-gray-9 mt-0.5">You are fully subscribed! Thank you for supporting Openrind.</p>
            </div>
          )}

          {/* Metric Cards */}
          {stats && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-xl border border-dls-border bg-dls-sidebar p-3 text-center">
                <span className="text-[10px] uppercase font-bold text-gray-8 tracking-wider">Total Requests</span>
                <div className="text-lg font-bold text-gray-12 mt-1">{stats.total_requests || 0}</div>
              </div>
              <div className="rounded-xl border border-dls-border bg-dls-sidebar p-3 text-center">
                <span className="text-[10px] uppercase font-bold text-gray-8 tracking-wider">Input Tokens</span>
                <div className="text-lg font-bold text-gray-12 mt-1">{formatTokens(stats.total_input_tokens || 0)}</div>
              </div>
              <div className="rounded-xl border border-dls-border bg-dls-sidebar p-3 text-center">
                <span className="text-[10px] uppercase font-bold text-gray-8 tracking-wider">Output Tokens</span>
                <div className="text-lg font-bold text-gray-12 mt-1">{formatTokens(stats.total_output_tokens || 0)}</div>
              </div>
            </div>
          )}

          {error && <div className="text-xs text-red-11 font-mono p-1">{error}</div>}

          <div className="flex justify-between gap-2">
            <Button
              variant="outline"
              className="h-7 rounded-full border-red-7/50 px-3 text-xs text-red-12 hover:bg-red-2/30"
              onClick={logout}
              disabled={loading}
            >
              Logout
            </Button>
            <Button
              variant="outline"
              className="h-7 rounded-full px-3 text-xs font-medium"
              onClick={refreshStats}
              disabled={loading}
            >
              Refresh Stats
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}