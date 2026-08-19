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

/**
 * SECURITY FIX: Exchange secure one-time token for actual API key
 * 
 * This function contacts the web API to retrieve the encrypted API key
 * using a one-time exchange token. The token:
 * - Is cryptographically secure (32 bytes random)
 * - Expires after 5 minutes
 * - Is deleted after retrieval (one-time use)
 * - Never exposes the actual API key in URLs
 */
async function exchangeTokenForApiKey(token: string): Promise<{
  success: boolean;
  apiKey?: string;
  status?: string;
  error?: string;
}> {
  try {
    const response = await fetch('https://app.openrind.com/api/auth/key-exchange', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      return {
        success: false,
        error: errorData.error || `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      apiKey: data.apiKey,
      status: data.status,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const inFlightTokens = new Set<string>();

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
        // Don't immediately set to unpaid if we just saved credentials
        // Check if status was recently set to "paid" (within last 30 seconds)
        const storedStatus = localStorage.getItem("openrind_gateway_billing_status");
        const statusSetTime = localStorage.getItem("openrind_gateway_billing_status_set_at");
        const timeSinceSet = statusSetTime ? Date.now() - parseInt(statusSetTime) : Infinity;
        
        // Only reset to unpaid if the "paid" status is older than 30 seconds
        // This prevents race conditions where stats API returns 402 before backend syncs subscription
        if (storedStatus !== "paid" || timeSinceSet > 30000) {
          setBillingStatus("unpaid");
          localStorage.setItem("openrind_gateway_billing_status", "unpaid");
        }
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

  // Listen to deep links - SECURITY FIX: Handle secure token exchange
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Persistent token tracking using localStorage to prevent duplicate exchanges across page loads
    const PROCESSED_TOKENS_KEY = 'openrind_processed_auth_tokens';
    const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
    
    const getProcessedTokens = (): Map<string, number> => {
      try {
        const stored = localStorage.getItem(PROCESSED_TOKENS_KEY);
        if (!stored) return new Map();
        
        const parsed = JSON.parse(stored) as [string, number][];
        const now = Date.now();
        
        // Filter out expired entries (older than 10 minutes)
        const valid = parsed.filter(([, timestamp]) => now - timestamp < TOKEN_EXPIRY_MS);
        return new Map(valid);
      } catch {
        return new Map();
      }
    };
    
    const markTokenProcessed = (token: string): void => {
      try {
        const processed = getProcessedTokens();
        processed.set(token, Date.now());
        localStorage.setItem(PROCESSED_TOKENS_KEY, JSON.stringify([...processed]));
      } catch {
        // Ignore localStorage errors
      }
    };
    
    const isTokenProcessed = (token: string): boolean => {
      return getProcessedTokens().has(token);
    };

    const handleUrls = async (urls: readonly string[]) => {
      const remaining: string[] = [];
      const matched: string[] = [];

      for (const rawUrl of urls) {
        const parsed = parseGatewayAuthDeepLink(rawUrl);
        if (parsed) {
          matched.push(rawUrl);

          // SECURITY: Determine if this is secure token flow or legacy api_key flow
          const isSecureFlow = !!parsed.token;
          const isLegacyFlow = !!parsed.apiKey;

          // Allow status updates even if credentials exist (after payment completion)
          // Only skip if we're trying to set the SAME token again (duplicate prevention)
          if (isSecureFlow && apiKeySet) {
            console.log("[Gateway Auth] Credentials already set, but checking if this is a status update...");
            
            // If status changed from unpaid to paid, allow the update through
            const currentStatus = localStorage.getItem("openrind_gateway_billing_status");
            if (currentStatus === "unpaid" && parsed.status === "paid") {
              console.log("[Gateway Auth] Status update detected: unpaid → paid, processing...");
              // Continue with token exchange to verify and update status
            } else if (currentStatus === parsed.status) {
              console.log("[Gateway Auth] Status unchanged, ignoring duplicate auth deep link");
              continue;
            }
          }

          // Prevent duplicate processing of one-time tokens (persists across page loads)
          if (isSecureFlow && isTokenProcessed(parsed.token)) {
            console.log("[Gateway Auth] Token already processed, skipping duplicate");
            continue;
          }

          let finalApiKey: string;
          let effectiveStatus: string = parsed.status;
          let isNewAccount = false;

          if (isSecureFlow) {
            // Check in-flight to prevent concurrent duplicate processing
            if (inFlightTokens.has(parsed.token)) {
              console.log("[Gateway Auth] Token already in flight, skipping duplicate");
              continue;
            }
            inFlightTokens.add(parsed.token);
            
            // NEW SECURE FLOW: Exchange token for API key via Main process
            console.log("[Gateway Auth] Secure token flow detected, invoking token exchange via main process...");
            
            try {
              const exchangeResult = await invoke<{
                success: boolean;
                apiKey: string;
                organizationId: number;
                status: string;
                isNewAccount: boolean;
              }>("openrindGatewayExchangeToken", { token: parsed.token });
              
              finalApiKey = exchangeResult.apiKey;
              effectiveStatus = exchangeResult.status || parsed.status;
              isNewAccount = exchangeResult.isNewAccount;
              
              // Persist processed token ONLY after success!
              markTokenProcessed(parsed.token);
              console.log("[Gateway Auth] Token exchange successful, status:", effectiveStatus, "isNewAccount:", isNewAccount);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error("[Gateway Auth] Token exchange failed:", msg);
              
              // Clear in-flight token on network/server failures to allow retries
              inFlightTokens.delete(parsed.token);
              
              window.alert(
                `Failed to retrieve secure credentials: ${msg}. Please try logging in again.`
              );
              continue;
            }
          } else if (isLegacyFlow) {
            // LEGACY FLOW: Direct API key in URL (DEPRECATED but supported)
            console.warn("[Gateway Auth] Legacy plaintext API key detected in URL (insecure)");
            finalApiKey = parsed.apiKey!;
            isNewAccount = true; // Always save/prompt for legacy keys
          } else {
            console.error("[Gateway Auth] No valid authentication method found");
            continue;
          }

          // P1 Protection: Ask for explicit user confirmation before silently replacing their credentials
          // BUT: Don't ask if we're just updating status (it's the same account)
          if (isNewAccount) {
            const confirmReplace = window.confirm(
              `An API Key from Openrind Gateway was received${parsed.email ? ` for ${parsed.email}` : ""}. Would you like to connect this key to your local shell application?`
            );
            if (!confirmReplace) {
              console.log("[Gateway Auth] User declined credential replacement");
              continue;
            }

            // Persist legacy key if accepted
            if (isLegacyFlow) {
              await invoke("openrindSetCredential", {
                key: "openrindGatewayApiKey",
                value: finalApiKey,
              });
            }
          } else {
            console.log("[Gateway Auth] Updating existing credentials with new status");
          }

          try {
            // Normalize status: backend returns "active"/"trialing"/"unpaid", desktop expects "paid"/"unpaid"/"none"
            const normalizedStatus = (effectiveStatus === "active" || effectiveStatus === "trialing") 
              ? "paid" 
              : "unpaid";
            
            console.log("[Gateway Auth] Updating status to:", normalizedStatus);
            localStorage.setItem("openrind_gateway_billing_status", normalizedStatus);
            localStorage.setItem("openrind_gateway_billing_status_set_at", Date.now().toString());
            if (parsed.email) localStorage.setItem("openrind_gateway_email", parsed.email);
            if (parsed.name) localStorage.setItem("openrind_gateway_name", parsed.name);
            
            setBillingStatus(normalizedStatus as BillingStatus);
            
            // Update apiKeySet state if this was a new account (main process saved the key)
            if (isNewAccount) {
              setApiKeySet(true);
            }
            
            await refreshStatus();
            // Don't call refreshStats() immediately - wait for backend to sync subscription
            // Stats will be fetched by the polling interval after subscription is active
            
            console.log("[Gateway Auth] Status update complete");
            
            // Emit event to trigger Settings page credential status refresh
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("openrind-shell-credentials-changed"));
            }
          } catch (err) {
            console.error("Failed to process auth deep link:", err);
            window.alert(`Failed to update credentials: ${err instanceof Error ? err.message : String(err)}`);
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
