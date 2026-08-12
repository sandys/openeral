/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  deepLinkBridgeEvent,
  drainPendingDeepLinks,
  type DeepLinkBridgeDetail,
} from "../../../app/lib/deep-link-bridge";
import {
  clearDenSession,
  createDenClient,
  DenApiError,
  ensureDenActiveOrganization,
  readDenSettings,
  readDenBootstrapConfig,
  writeDenSettings,
  type DenUser,
} from "../../../app/lib/den";
import { parseGatewayAuthDeepLink } from "../../../app/lib/openrind-desktop-links";
import { isDesktopRuntime } from "../../../app/utils";
import { Button } from "../../design-system/button";

export type BillingStatus = "unpaid" | "paid" | "none";

export type UsageStats = {
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
};

export type GatewayBillingStore = {
  billingStatus: BillingStatus;
  stats: UsageStats | null;
  apiKeySet: boolean;
  loading: boolean;
  error: string | null;
  showOnboardingModal: boolean;
  setShowOnboardingModal: (show: boolean) => void;
  userEmail: string;
  userName: string;
  refreshStats: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  logout: () => Promise<void>;
};

const GatewayBillingContext = createContext<GatewayBillingStore | undefined>(undefined);

type GatewayBillingProviderProps = {
  children: ReactNode;
};

type ElectronBridge = NonNullable<Window["__OPENRIND_DESKTOP_ELECTRON__"]>;

function getBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENRIND_DESKTOP_ELECTRON__ ?? null;
}

async function invoke<T>(command: string, ...args: unknown[]): Promise<T> {
  const bridge = getBridge();
  if (!bridge?.invokeDesktop) {
    throw new Error("Electron desktop bridge is not available.");
  }
  return (await bridge.invokeDesktop(command, ...args)) as T;
}

export function GatewayBillingProvider({ children }: GatewayBillingProviderProps) {
  const [billingStatus, setBillingStatus] = useState<BillingStatus>("none");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [apiKeySet, setApiKeySet] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [showOnboardingModal, setShowOnboardingModal] = useState<boolean>(false);
  const [pasteMode, setPasteMode] = useState<boolean>(false);
  const [pastedKey, setPastedKey] = useState<string>("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string>("");
  const [userName, setUserName] = useState<string>("");

  const refreshStatus = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      const statusRes = await invoke<any>("openrindCredentialStatus");
      const isSet = statusRes.openrindGatewayApiKey === "set";
      setApiKeySet(isSet);
      if (isSet) {
        const storedStatus = localStorage.getItem("openrind_gateway_billing_status") as BillingStatus;
        setBillingStatus(storedStatus || "unpaid");
        setUserEmail(localStorage.getItem("openrind_gateway_email") || "");
        setUserName(localStorage.getItem("openrind_gateway_name") || "");
      } else {
        setBillingStatus("none");
        setUserEmail("");
        setUserName("");
      }
    } catch (err) {
      console.error("Error refreshing credential status:", err);
    }
  }, []);

  const refreshStats = useCallback(async () => {
    if (!apiKeySet) return;
    try {
      const statsRes = await invoke<UsageStats>("openrindGatewayGetStats");
      setStats(statsRes);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("402")) {
        setBillingStatus("unpaid");
        localStorage.setItem("openrind_gateway_billing_status", "unpaid");
      }
      setError(msg);
    }
  }, [apiKeySet]);

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      await invoke("openrindClearCredential", "openrindGatewayApiKey");
      localStorage.removeItem("openrind_gateway_billing_status");
      localStorage.removeItem("openrind_gateway_email");
      localStorage.removeItem("openrind_gateway_name");
      setBillingStatus("none");
      setApiKeySet(false);
      setStats(null);
      await refreshStatus();
    } catch (err) {
      console.error("Error clearing gateway credentials during logout:", err);
    } finally {
      setLoading(false);
    }
  }, [refreshStatus]);

  // Initial load
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Handle onboarding auto-trigger
  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const dismissed = localStorage.getItem("openrind_gateway_onboarding_dismissed") === "true";
    
    // Only show Gateway onboarding if the user has completed their mandatory Den auth (if required)
    const requireSignin = readDenBootstrapConfig().requireSignin;
    const denSettings = readDenSettings();
    const isDenSignedIn = !requireSignin || !!denSettings.authToken?.trim();

    if (apiKeySet === false && !dismissed && isDenSignedIn) {
      setShowOnboardingModal(true);
    } else {
      setShowOnboardingModal(false);
    }
  }, [apiKeySet]);

  const savePastedKey = async () => {
    if (!pastedKey.trim()) return;
    setLoading(true);
    setPasteError(null);
    try {
      await invoke("openrindSetCredential", {
        key: "openrindGatewayApiKey",
        value: pastedKey.trim(),
      });
      localStorage.setItem("openrind_gateway_billing_status", "unpaid");
      localStorage.setItem("openrind_gateway_email", "Custom API Key");
      localStorage.setItem("openrind_gateway_name", "Individual User");
      setBillingStatus("unpaid");
      setApiKeySet(true);
      setShowOnboardingModal(false);
      setPasteMode(false);
      setPastedKey("");
      await refreshStatus();
      await refreshStats();
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const skipOnboarding = () => {
    localStorage.setItem("openrind_gateway_onboarding_dismissed", "true");
    setShowOnboardingModal(false);
  };

  // Sync stats when API key is set
  useEffect(() => {
    if (apiKeySet) {
      void refreshStats();
      const interval = setInterval(() => {
        void refreshStats();
      }, 15000); // poll stats every 15s
      return () => clearInterval(interval);
    }
  }, [apiKeySet, refreshStats]);

  // Listen to deep links
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleUrls = async (urls: readonly string[]) => {
      const remaining: string[] = [];
      const matched: string[] = [];

      for (const rawUrl of urls) {
        const parsed = parseGatewayAuthDeepLink(rawUrl);
        if (parsed) {
          matched.push(rawUrl);

          // P1 Protection: Ask for explicit user confirmation before silently replacing their credentials
          const confirmReplace = window.confirm(
            `An API Key from Openrind Gateway was received (${parsed.email || "No email"}). Would you like to connect this key to your local shell application?`
          );
          if (!confirmReplace) {
            continue;
          }

          try {
            await invoke("openrindSetCredential", {
              key: "openrindGatewayApiKey",
              value: parsed.apiKey,
            });
            const effectiveStatus = parsed.status === "trialing" || parsed.status === "expired" ? "unpaid" : parsed.status;
            localStorage.setItem("openrind_gateway_billing_status", effectiveStatus);
            if (parsed.email) localStorage.setItem("openrind_gateway_email", parsed.email);
            if (parsed.name) localStorage.setItem("openrind_gateway_name", parsed.name);
            setBillingStatus(effectiveStatus as BillingStatus);
            setApiKeySet(true);
            await refreshStatus();
            await refreshStats();
          } catch (err) {
            console.error("Failed to save deep linked API key:", err);
          }
        } else {
          remaining.push(rawUrl);
        }
      }

      // G1 Protection: Preserve non-matching deep links back to global state so other providers (like Den) can consume them
      if (window.__OPENRIND_DESKTOP__ && remaining.length > 0) {
        const existingPending = window.__OPENRIND_DESKTOP__.deepLinks ?? [];
        window.__OPENRIND_DESKTOP__.deepLinks = [...existingPending, ...remaining];
      }
    };

    void handleUrls(drainPendingDeepLinks(window));
    const handleDeepLink = (event: Event) => {
      handleUrls(((event as CustomEvent<DeepLinkBridgeDetail>).detail?.urls ?? []) as string[]);
    };

    window.addEventListener(deepLinkBridgeEvent, handleDeepLink);
    return () => window.removeEventListener(deepLinkBridgeEvent, handleDeepLink);
  }, [refreshStatus, refreshStats]);

  const value = useMemo<GatewayBillingStore>(
    () => ({
      billingStatus,
      stats,
      apiKeySet,
      loading,
      error,
      showOnboardingModal,
      setShowOnboardingModal,
      userEmail,
      userName,
      refreshStats,
      refreshStatus,
      logout,
    }),
    [billingStatus, stats, apiKeySet, loading, error, showOnboardingModal, userEmail, userName, refreshStats, refreshStatus, logout]
  );

  const connectGateway = () => {
    if (typeof window === "undefined") return;
    const gatewayUrl = "https://app.openrind.com";
    window.open(`${gatewayUrl}/sign-in?intent=shell`, "_blank");
  };

  return (
    <GatewayBillingContext.Provider value={value}>
      {children}
      
      {/* Onboarding Modal Overlay */}
      {showOnboardingModal && (
        <div className="fixed inset-0 z-[100] bg-gray-1/70 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-gray-2 border border-gray-6/80 w-full max-w-lg rounded-3xl shadow-2xl p-6 space-y-6 text-gray-12">
            <div className="text-center space-y-2">
              <h3 className="text-xl font-bold tracking-tight">Welcome to Openrind Cost Monitoring</h3>
              <p className="text-xs text-gray-10 max-w-md mx-auto">
                Connect your Openrind Gateway account to track API costs, manage token limits, and view cost analytics natively. Subscription is $10/month.
              </p>
            </div>

            {!pasteMode ? (
              <div className="flex flex-col gap-3">
                <Button
                  variant="primary"
                  className="w-full h-11 rounded-full text-sm font-semibold bg-[var(--dls-accent)] hover:bg-[var(--dls-accent-hover)] text-white"
                  onClick={connectGateway}
                >
                  Sign Up / Sign In
                </Button>
                <Button
                  variant="outline"
                  className="w-full h-11 rounded-full text-sm font-semibold border-dls-border hover:bg-gray-3/50 text-gray-11"
                  onClick={() => setPasteMode(true)}
                >
                  Already have an API Key
                </Button>
                <button
                  type="button"
                  className="text-xs text-gray-9 hover:text-gray-11 transition-colors mt-2"
                  onClick={skipOnboarding}
                >
                  Not Now, Skip Onboarding
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-11">Paste your Gateway API Key</label>
                  <input
                    type="password"
                    placeholder="sk-openrind-gateway-..."
                    className="w-full h-10 px-3 rounded-lg border border-dls-border bg-dls-surface font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                    value={pastedKey}
                    onChange={(e) => setPastedKey(e.target.value)}
                  />
                  {pasteError && <p className="text-xs text-red-11 mt-1 font-mono">{pasteError}</p>}
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="outline"
                    className="h-9 rounded-full px-4 text-xs"
                    onClick={() => { setPasteMode(false); setPasteError(null); }}
                  >
                    Back
                  </Button>
                  <Button
                    variant="primary"
                    className="h-9 rounded-full px-4 text-xs bg-[var(--dls-accent)] text-white"
                    onClick={savePastedKey}
                    disabled={!pastedKey.trim() || loading}
                  >
                    Save Key
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </GatewayBillingContext.Provider>
  );
}

export function useGatewayBilling(): GatewayBillingStore {
  const context = useContext(GatewayBillingContext);
  if (!context) {
    throw new Error("useGatewayBilling must be used within a GatewayBillingProvider");
  }
  return context;
}