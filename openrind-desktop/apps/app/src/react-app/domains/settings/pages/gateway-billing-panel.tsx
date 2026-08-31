/** @jsxImportSource react */
import { useState, useCallback, useMemo } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  CreditCard,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

import {
  useGatewayBilling,
  type TimeSeriesDataPoint,
} from "../../cloud/gateway-billing-provider";
import { Button } from "../../../design-system/button";
import { TextInput } from "../../../design-system/text-input";
import { isDesktopRuntime } from "../../../../app/utils";

const settingsPanelClass =
  "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";

function formatNumber(num: number): string {
  if (!num || isNaN(num)) return "0";
  return new Intl.NumberFormat().format(num);
}

function formatCompactTokens(num: number): string {
  if (!num || isNaN(num)) return "0";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return num.toString();
}

function formatDateTick(val: string): string {
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return val;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return val;
  }
}

type ChartMetric = "tokens" | "requests";

export function GatewayBillingPanel() {
  const {
    billingStatus,
    stats,
    apiKeySet,
    loading,
    error,
    userName,
    userEmail,
    refreshStats,
    refreshStatus,
    logout,
  } = useGatewayBilling();

  const [busy, setBusy] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pastedKey, setPastedKey] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("tokens");

  const connectGateway = () => {
    if (typeof window === "undefined") return;
    const gatewayUrl = "https://app.openrind.com";
    window.open(`${gatewayUrl}/sign-in?intent=shell`, "_blank");
  };

  const openPortal = () => {
    if (typeof window === "undefined") return;
    window.open("https://app.openrind.com", "_blank");
  };

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([refreshStatus(), refreshStats()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [refreshStatus, refreshStats]);

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

  const totalInputTokens = stats?.total_input_tokens || 0;
  const totalOutputTokens = stats?.total_output_tokens || 0;
  const totalRequests = stats?.total_requests || 0;
  const totalTokens = totalInputTokens + totalOutputTokens;
  const inputRatio = totalTokens > 0 ? (totalInputTokens / totalTokens) * 100 : 0;
  const outputRatio = totalTokens > 0 ? (totalOutputTokens / totalTokens) * 100 : 0;

  // Resolve time-series data from backend daily_stats
  const chartData = useMemo(() => {
    const rawSeries =
      stats?.daily_stats ||
      stats?.daily_usage ||
      stats?.history ||
      stats?.time_series ||
      [];

    if (Array.isArray(rawSeries) && rawSeries.length > 0) {
      return rawSeries.map((item: TimeSeriesDataPoint) => {
        const inputTokens = Number(item.input_tokens ?? (item as any).inputTokens ?? 0);
        const outputTokens = Number(item.output_tokens ?? (item as any).outputTokens ?? 0);
        const totalTokens = Number(
          item.total_tokens ??
          (item as any).totalTokens ??
          (inputTokens + outputTokens)
        );
        const requests = Number(item.requests ?? 0);
        return {
          date: String(item.date),
          inputTokens,
          outputTokens,
          totalTokens,
          requests,
        };
      });
    }

    // Default point based on active telemetry totals
    const today = new Date().toISOString().split("T")[0];
    return [
      {
        date: today,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalTokens,
        requests: totalRequests,
      },
    ];
  }, [stats, totalInputTokens, totalOutputTokens, totalTokens, totalRequests]);

  return (
    <div className="space-y-6">
      {/* Error notice if present */}
      {error ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="font-mono">{error}</span>
        </div>
      ) : null}

      {/* Not Connected State */}
      {!apiKeySet ? (
        !pasteMode ? (
          <div className={`${settingsPanelClass} space-y-4`}>
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-dls-text">
                Connect Openrind Gateway
              </h3>
              <p className="text-xs text-dls-secondary leading-relaxed">
                Enable real-time AI telemetry, automated cost control, and unified token tracking across models.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-2">
              <Button
                variant="primary"
                className="h-8 rounded-lg px-4 text-xs font-semibold"
                onClick={connectGateway}
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
                <span>Connect with Browser</span>
              </Button>
              <Button
                variant="outline"
                className="h-8 rounded-lg px-3.5 text-xs text-dls-secondary hover:text-dls-text"
                onClick={() => setPasteMode(true)}
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Enter API Key Manually</span>
              </Button>
            </div>
          </div>
        ) : (
          <div className={`${settingsPanelClass} space-y-4`}>
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-dls-text">
                Manual Gateway API Key
              </h3>
              <p className="text-xs text-dls-secondary">
                Enter your <code className="font-mono text-dls-text">sk-openrind-gateway-...</code> key to link telemetry and subscription status on this device.
              </p>
            </div>

            <div className="space-y-1.5">
              <TextInput
                type="password"
                placeholder="sk-openrind-gateway-..."
                className="font-mono text-xs"
                value={pastedKey}
                onChange={(e) => setPastedKey(e.target.value)}
                autoFocus
              />
              {pasteError ? (
                <p className="text-xs text-red-400 font-mono mt-1">
                  {pasteError}
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                variant="outline"
                className="h-8 rounded-lg px-3 text-xs"
                onClick={() => {
                  setPasteMode(false);
                  setPasteError(null);
                  setPastedKey("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                className="h-8 rounded-lg px-4 text-xs font-semibold"
                onClick={saveKey}
                disabled={!pastedKey.trim()}
              >
                Save Credential
              </Button>
            </div>
          </div>
        )
      ) : (
        /* Connected State */
        <div className="space-y-6">
          {/* Plan & Subscription Card */}
          <div className={`${settingsPanelClass} p-4 md:p-5`}>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-dls-text">
                  Openrind Gateway
                </h3>
                <p className="text-xs text-dls-secondary">
                  {billingStatus === "paid"
                    ? "Your gateway subscription is active. AI usage metering and routing are enabled."
                    : billingStatus === "unpaid"
                      ? "Please complete your subscription to activate full gateway routing and telemetry."
                      : "Connected with custom Gateway credentials."}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="outline"
                  className="h-8 rounded-lg px-2.5 text-xs text-dls-secondary hover:text-dls-text"
                  onClick={handleRefresh}
                  disabled={loading || isRefreshing}
                  title="Refresh usage telemetry"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${isRefreshing || loading ? "animate-spin" : ""}`}
                  />
                  <span>Refresh</span>
                </Button>
                {billingStatus === "unpaid" ? (
                  <Button
                    variant="primary"
                    className="h-8 rounded-lg px-3.5 text-xs font-semibold"
                    onClick={payNow}
                    disabled={busy}
                  >
                    {busy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CreditCard className="h-3.5 w-3.5" />
                    )}
                    <span>Subscribe ($10/mo)</span>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    className="h-8 rounded-lg px-3 text-xs text-dls-secondary hover:text-dls-text"
                    onClick={openPortal}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span>Manage Plan</span>
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Usage Telemetry Graph Card */}
          <div className={`${settingsPanelClass} p-4 md:p-5 space-y-4`}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5">
                <h4 className="text-sm font-semibold text-dls-text">
                  Usage Telemetry
                </h4>
                <p className="text-xs text-dls-secondary">
                  Time-series telemetry for prompts, completions, and requests.
                </p>
              </div>

              <div className="flex items-center rounded-lg border border-dls-border bg-dls-hover/50 p-0.5 text-xs">
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                    chartMetric === "tokens"
                      ? "bg-dls-surface text-dls-text shadow-sm"
                      : "text-dls-secondary hover:text-dls-text"
                  }`}
                  onClick={() => setChartMetric("tokens")}
                >
                  Tokens
                </button>
                <button
                  type="button"
                  className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                    chartMetric === "requests"
                      ? "bg-dls-surface text-dls-text shadow-sm"
                      : "text-dls-secondary hover:text-dls-text"
                  }`}
                  onClick={() => setChartMetric("requests")}
                >
                  Requests
                </button>
              </div>
            </div>

            <div className="h-64 w-full pt-1">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={chartData}
                  margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="promptGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#34d399" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#34d399" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="compGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#c084fc" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#c084fc" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="reqGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#60a5fa" stopOpacity={0} />
                    </linearGradient>
                  </defs>

                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(255, 255, 255, 0.07)"
                    vertical={false}
                  />

                  <XAxis
                    dataKey="date"
                    tickFormatter={formatDateTick}
                    stroke="#71717a"
                    fontSize={11}
                    tickLine={false}
                    axisLine={{ stroke: "rgba(255, 255, 255, 0.1)" }}
                  />

                  <YAxis
                    tickFormatter={formatCompactTokens}
                    stroke="#71717a"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />

                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="rounded-xl border border-dls-border bg-[#18181b] p-3 text-xs shadow-2xl space-y-1.5 min-w-35">
                          <div className="font-semibold text-dls-text border-b border-dls-border/60 pb-1">
                            {formatDateTick(String(label))}
                          </div>
                          {chartMetric === "tokens" ? (
                            <div className="space-y-1 pt-0.5">
                              <div className="flex items-center justify-between gap-3 text-emerald-400">
                                <span>Prompt:</span>
                                <span className="font-mono font-medium tabular-nums">
                                  {formatNumber(Number(payload[0]?.value || 0))}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-3 text-purple-400">
                                <span>Completion:</span>
                                <span className="font-mono font-medium tabular-nums">
                                  {formatNumber(Number(payload[1]?.value || 0))}
                                </span>
                              </div>
                              <div className="flex items-center justify-between gap-3 text-dls-text border-t border-dls-border/60 pt-1 font-semibold">
                                <span>Total:</span>
                                <span className="font-mono tabular-nums">
                                  {formatNumber(
                                    Number(payload[0]?.value || 0) +
                                      Number(payload[1]?.value || 0),
                                  )}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between gap-3 text-blue-400 pt-0.5">
                              <span>Requests:</span>
                              <span className="font-mono font-medium tabular-nums">
                                {formatNumber(Number(payload[0]?.value || 0))}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />

                  {chartMetric === "tokens" ? (
                    <>
                      <Area
                        type="monotone"
                        dataKey="inputTokens"
                        stroke="#34d399"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#promptGrad)"
                        name="Prompt Tokens"
                      />
                      <Area
                        type="monotone"
                        dataKey="outputTokens"
                        stroke="#c084fc"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#compGrad)"
                        name="Completion Tokens"
                      />
                    </>
                  ) : (
                    <Area
                      type="monotone"
                      dataKey="requests"
                      stroke="#60a5fa"
                      strokeWidth={2}
                      fillOpacity={1}
                      fill="url(#reqGrad)"
                      name="Requests"
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Compact small inline legends below graph */}
            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-dls-border/60 pt-3 text-xs">
              {chartMetric === "tokens" ? (
                <>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0" />
                    <span className="text-dls-secondary">Prompt Tokens:</span>
                    <span className="font-semibold text-dls-text tabular-nums">
                      {formatNumber(totalInputTokens)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-purple-400 shrink-0" />
                    <span className="text-dls-secondary">Completion Tokens:</span>
                    <span className="font-semibold text-dls-text tabular-nums">
                      {formatNumber(totalOutputTokens)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-gray-400 shrink-0" />
                    <span className="text-dls-secondary">Total Tokens:</span>
                    <span className="font-semibold text-dls-text tabular-nums">
                      {formatNumber(totalTokens)}
                    </span>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-blue-400 shrink-0" />
                  <span className="text-dls-secondary">Total Requests:</span>
                  <span className="font-semibold text-dls-text tabular-nums">
                    {formatNumber(totalRequests)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Account & Connection Details Card */}
          <div className={`${settingsPanelClass} p-4 space-y-4`}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
              <div className="space-y-0.5">
                <span className="text-[11px] font-medium text-dls-secondary">
                  User / Organization
                </span>
                <div className="font-medium text-dls-text">
                  {userName || "Individual User"}
                </div>
              </div>
              <div className="space-y-0.5">
                <span className="text-[11px] font-medium text-dls-secondary">
                  Account Email
                </span>
                <div className="font-medium text-dls-text">
                  {userEmail || "Connected API Key"}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-start border-t border-dls-border/60 pt-3">
              <Button
                variant="outline"
                className="h-8 rounded-lg border-red-500/30 px-3 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300"
                onClick={logout}
                disabled={loading}
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Disconnect Gateway</span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
