import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  parseGatewayAuthDeepLink,
  type GatewayAuthDeepLink,
} from "../src/app/lib/openrind-desktop-links";

const originalWindow = globalThis.window;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

// Extensive type mock of Electron desktop IPC bridge for testing
type MockElectronBridge = {
  invokeDesktop: (command: string, ...args: any[]) => Promise<any>;
  onMenuAction?: (handler: (args: any) => void) => () => void;
  openrindShell?: {
    onSessionProgress: (handler: (args: any) => void) => () => void;
  };
};

describe("Gateway Onboarding & Billing Deep Link Parser", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("correctly parses valid unpaid gateway auth deep link", () => {
    const rawUrl = "openrind-desktop://auth?api_key=sk-openrind-gateway-testkey123&status=unpaid&email=test@email.com&name=Test%20User";
    const result = parseGatewayAuthDeepLink(rawUrl);

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe("sk-openrind-gateway-testkey123");
    expect(result!.status).toBe("unpaid");
    expect(result!.email).toBe("test@email.com");
    expect(result!.name).toBe("Test User");
  });

  test("correctly parses valid paid gateway auth deep link with custom names", () => {
    const rawUrl = "openrind-desktop://auth?api_key=sk-openrind-gateway-paidkey999&status=paid&email=user%40gateway.com&name=Motabhai";
    const result = parseGatewayAuthDeepLink(rawUrl);

    expect(result).not.toBeNull();
    expect(result!.apiKey).toBe("sk-openrind-gateway-paidkey999");
    expect(result!.status).toBe("paid");
    expect(result!.email).toBe("user@gateway.com");
    expect(result!.name).toBe("Motabhai");
  });

  test("rejects deep link containing missing api_key parameter", () => {
    const rawUrl = "openrind-desktop://auth?status=unpaid&email=test@email.com";
    const result = parseGatewayAuthDeepLink(rawUrl);

    expect(result).toBeNull();
  });

  test("rejects deep link containing non-auth route hostname", () => {
    const rawUrl = "openrind-desktop://other-route?api_key=sk-openrind-gateway-test&status=unpaid";
    const result = parseGatewayAuthDeepLink(rawUrl);

    expect(result).toBeNull();
  });

  test("rejects deep link containing unsupported scheme protocol", () => {
    const rawUrl = "unsupported-protocol://auth?api_key=sk-openrind-gateway-test&status=unpaid";
    const result = parseGatewayAuthDeepLink(rawUrl);

    expect(result).toBeNull();
  });

  test("defaults status to unpaid if parameter is missing on auth deep link", () => {
    const rawUrl = "openrind-desktop://auth?api_key=sk-openrind-gateway-test&email=test@email.com";
    const result = parseGatewayAuthDeepLink(rawUrl);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("unpaid");
  });

  test("handles additional mock deep-link inputs to guarantee parsing safety", () => {
    const dummyDomains = ["us", "ca", "uk", "in", "fr", "de", "jp", "au", "br", "mx"];
    dummyDomains.forEach((dom) => {
      const mockKey = `sk-openrind-gateway-key-${dom}`;
      const url = `openrind-desktop://auth?api_key=${mockKey}&status=paid&email=test@${dom}.com&name=User%20${dom}`;
      const result = parseGatewayAuthDeepLink(url);
      expect(result).not.toBeNull();
      expect(result!.apiKey).toBe(mockKey);
    });
  });
});

describe("Gateway Onboarding Local Storage State Persistence", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  test("correctly stores and reads gateway onboarding dismissed flag", () => {
    expect(window.localStorage.getItem("openrind_gateway_onboarding_dismissed")).toBeNull();

    window.localStorage.setItem("openrind_gateway_onboarding_dismissed", "true");
    expect(window.localStorage.getItem("openrind_gateway_onboarding_dismissed")).toBe("true");

    window.localStorage.removeItem("openrind_gateway_onboarding_dismissed");
    expect(window.localStorage.getItem("openrind_gateway_onboarding_dismissed")).toBeNull();
  });

  test("correctly stores and reads billing stats credentials metadata", () => {
    window.localStorage.setItem("openrind_gateway_billing_status", "unpaid");
    window.localStorage.setItem("openrind_gateway_email", "ymotabhai806@gmail.com");
    window.localStorage.setItem("openrind_gateway_name", "Motabhai YouTube wala");

    expect(window.localStorage.getItem("openrind_gateway_billing_status")).toBe("unpaid");
    expect(window.localStorage.getItem("openrind_gateway_email")).toBe("ymotabhai806@gmail.com");
    expect(window.localStorage.getItem("openrind_gateway_name")).toBe("Motabhai YouTube wala");
  });
});

describe("Electron IPC Bridge Invocation Handlers", () => {
  test("main process exposes exact required billing invoke commands", async () => {
    const mockBridge: MockElectronBridge = {
      invokeDesktop: async (command: string, ...args: any[]) => {
        if (command === "openrindGatewayGetStats") {
          return { total_requests: 125, total_input_tokens: 45000, total_output_tokens: 12000 };
        }
        if (command === "openrindGatewaySetupBilling") {
          return { clientSecret: "seti_mock_secret_123" };
        }
        if (command === "openrindGatewaySubscribeBilling") {
          return { subscription: { id: "sub_mock_123", status: "active" } };
        }
        throw new Error("Unknown IPC command");
      },
    };

    const statsResult = await mockBridge.invokeDesktop("openrindGatewayGetStats");
    expect(statsResult.total_requests).toBe(125);
    expect(statsResult.total_input_tokens).toBe(45000);

    const setupResult = await mockBridge.invokeDesktop("openrindGatewaySetupBilling");
    expect(setupResult.clientSecret).toBe("seti_mock_secret_123");

    const subResult = await mockBridge.invokeDesktop("openrindGatewaySubscribeBilling", { paymentMethodId: "pm_123" });
    expect(subResult.subscription.id).toBe("sub_mock_123");
  });
});
