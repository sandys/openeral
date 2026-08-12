import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Detailed Mocks of Application States
type MockBillingStatus = "unpaid" | "paid" | "none";
type MockUsageStats = {
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
};

type MockGatewayBillingStore = {
  billingStatus: MockBillingStatus;
  stats: MockUsageStats | null;
  apiKeySet: boolean;
  loading: boolean;
  error: string | null;
  showOnboardingModal: boolean;
  userEmail: string;
  userName: string;
};

// Simulation of Gateway Billing State Machine
class GatewayBillingStateMachine {
  private state: MockGatewayBillingStore;
  private history: MockGatewayBillingStore[] = [];

  constructor(initialState: Partial<MockGatewayBillingStore> = {}) {
    this.state = {
      billingStatus: "none",
      stats: null,
      apiKeySet: false,
      loading: false,
      error: null,
      showOnboardingModal: false,
      userEmail: "",
      userName: "",
      ...initialState,
    };
    this.record();
  }

  private record() {
    this.history.push({ ...this.state, stats: this.state.stats ? { ...this.state.stats } : null });
  }

  getState() {
    return this.state;
  }

  getHistory() {
    return this.history;
  }

  // Action: Connect Gateway via OAuth (Simulated Deep Link Callback)
  onOAuthCallback(apiKey: string, email: string, name: string) {
    this.state.loading = true;
    this.record();

    this.state.apiKeySet = true;
    this.state.billingStatus = "unpaid";
    this.state.userEmail = email;
    this.state.userName = name;
    this.state.showOnboardingModal = false;
    this.state.loading = false;
    this.state.error = null;
    this.record();
  }

  // Action: Paste API Key manually
  onPasteApiKey(apiKey: string) {
    this.state.loading = true;
    this.record();

    if (!apiKey.startsWith("sk-openrind-gateway-")) {
      this.state.error = "Invalid API Key prefix";
      this.state.loading = false;
      this.record();
      return false;
    }

    this.state.apiKeySet = true;
    this.state.billingStatus = "unpaid";
    this.state.userEmail = "Custom API Key";
    this.state.userName = "Individual User";
    this.state.showOnboardingModal = false;
    this.state.loading = false;
    this.state.error = null;
    this.record();
    return true;
  }

  // Action: Stripe Checkout completed successfully
  onPaymentSuccess() {
    this.state.loading = true;
    this.record();

    this.state.billingStatus = "paid";
    this.state.loading = false;
    this.state.error = null;
    
    // Seed initial stats upon activation
    this.state.stats = {
      total_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
    };
    this.record();
  }

  // Action: Metering usage update
  onUsageUpdate(requests: number, inputTokens: number, outputTokens: number) {
    if (this.state.billingStatus !== "paid" && this.state.billingStatus !== "unpaid") {
      return; // stats only visible when logged in
    }

    this.state.stats = {
      total_requests: requests,
      total_input_tokens: inputTokens,
      total_output_tokens: outputTokens,
    };
    this.record();
  }

  // Action: 402 Blocked (Payment expired)
  onBillingBlocked() {
    this.state.billingStatus = "unpaid";
    this.state.error = "Failed to fetch stats: 402 Payment Required";
    this.record();
  }

  // Action: Logout
  onLogout() {
    this.state.billingStatus = "none";
    this.state.apiKeySet = false;
    this.state.stats = null;
    this.state.userEmail = "";
    this.state.userName = "";
    this.state.showOnboardingModal = true;
    this.record();
  }
}

describe("Gateway Billing State Machine Integration Permutations", () => {
  test("Transition: Initial -> Onboarding Modal -> Paste Key -> Unpaid -> Paid", () => {
    const fsm = new GatewayBillingStateMachine({ showOnboardingModal: true });
    
    // Initial state check
    expect(fsm.getState().billingStatus).toBe("none");
    expect(fsm.getState().showOnboardingModal).toBe(true);
    expect(fsm.getState().apiKeySet).toBe(false);

    // Try pasting invalid key
    const pasteSuccess1 = fsm.onPasteApiKey("invalid-key-prefix");
    expect(pasteSuccess1).toBe(false);
    expect(fsm.getState().error).toBe("Invalid API Key prefix");
    expect(fsm.getState().apiKeySet).toBe(false);

    // Paste valid key
    const pasteSuccess2 = fsm.onPasteApiKey("sk-openrind-gateway-validkey123");
    expect(pasteSuccess2).toBe(true);
    expect(fsm.getState().billingStatus).toBe("unpaid");
    expect(fsm.getState().apiKeySet).toBe(true);
    expect(fsm.getState().showOnboardingModal).toBe(false);

    // Trigger payment completion
    fsm.onPaymentSuccess();
    expect(fsm.getState().billingStatus).toBe("paid");
    expect(fsm.getState().stats).not.toBeNull();
    expect(fsm.getState().stats!.total_requests).toBe(0);

    // Simulate usage events
    fsm.onUsageUpdate(10, 15000, 5000);
    expect(fsm.getState().stats!.total_requests).toBe(10);
    expect(fsm.getState().stats!.total_input_tokens).toBe(15000);
    expect(fsm.getState().stats!.total_output_tokens).toBe(5000);

    // Logout
    fsm.onLogout();
    expect(fsm.getState().billingStatus).toBe("none");
    expect(fsm.getState().apiKeySet).toBe(false);
    expect(fsm.getState().stats).toBeNull();
    expect(fsm.getState().showOnboardingModal).toBe(true);
  });

  test("Transition: Initial -> OAuth Deep Link -> Unpaid -> 402 Blocked -> Paid", () => {
    const fsm = new GatewayBillingStateMachine({ showOnboardingModal: true });

    // OAuth callback redirects back to app
    fsm.onOAuthCallback("sk-openrind-gateway-oauthkey", "oauth-user@openrind.com", "Oauth User");
    expect(fsm.getState().billingStatus).toBe("unpaid");
    expect(fsm.getState().userEmail).toBe("oauth-user@openrind.com");
    expect(fsm.getState().userName).toBe("Oauth User");
    expect(fsm.getState().apiKeySet).toBe(true);

    // Simulate billing blocked / payment required
    fsm.onBillingBlocked();
    expect(fsm.getState().billingStatus).toBe("unpaid");
    expect(fsm.getState().error).toContain("402");

    // Completes payment checkout
    fsm.onPaymentSuccess();
    expect(fsm.getState().billingStatus).toBe("paid");
    expect(fsm.getState().error).toBeNull();

    // Stats sync successfully
    fsm.onUsageUpdate(5, 5000, 2000);
    expect(fsm.getState().stats!.total_requests).toBe(5);
  });
});

describe("State Transition History Rollback Scenarios", () => {
  test("validates FSM history record stack is fully consistent", () => {
    const fsm = new GatewayBillingStateMachine();
    fsm.onOAuthCallback("sk-openrind-gateway-key", "test@test.com", "Test");
    fsm.onPaymentSuccess();
    fsm.onUsageUpdate(100, 100000, 50000);
    fsm.onLogout();

    const history = fsm.getHistory();
    expect(history.length).toBe(7); // Initial + 6 actions (including loading states)
    
    // Check initial state in history
    expect(history[0].billingStatus).toBe("none");
    expect(history[0].apiKeySet).toBe(false);

    // Check final state in history
    expect(history[history.length - 1].billingStatus).toBe("none");
    expect(history[history.length - 1].apiKeySet).toBe(false);
    expect(history[history.length - 1].showOnboardingModal).toBe(true);
  });
});
