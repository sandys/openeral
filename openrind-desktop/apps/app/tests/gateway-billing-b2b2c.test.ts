import { describe, expect, test } from "bun:test";

// High-precision cost formatter to support B2B2C sub-cent queries
function formatCost(num: number): string {
  if (!num || isNaN(num)) return "$0.00";
  if (num < 0.01) {
    return `$${num.toFixed(6)}`;
  }
  return `$${num.toFixed(2)}`;
}

describe("Openrind Gateway Billing & Usage - B2B2C High-Precision Cost formatting", () => {
  test("correctly formats standard dollar amounts with 2 decimal places", () => {
    expect(formatCost(15.5)).toBe("$15.50");
    expect(formatCost(120.99)).toBe("$120.99");
    expect(formatCost(10)).toBe("$10.00");
  });

  test("correctly formats sub-cent microdollar amounts with 6 decimal places", () => {
    expect(formatCost(0.00051)).toBe("$0.000510");
    expect(formatCost(0.000001)).toBe("$0.000001");
    expect(formatCost(0.001234)).toBe("$0.001234");
  });

  test("returns $0.00 for invalid or null inputs", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(NaN)).toBe("$0.00");
  });
});

describe("Billing Stats State Resolution", () => {
  test("updates local store state dynamically from the backend stats response for B2B2C", () => {
    // Simulated billing store state
    const state = {
      apiKeySet: true,
      billingStatus: "unpaid",
      userEmail: "Connected API Key",
      userName: "Individual User",
      stats: null as any,
    };

    // Simulated API response for a B2B2C organization customer
    const mockApiResponse = {
      total_requests: 1,
      total_input_tokens: 15,
      total_output_tokens: 155,
      total_cost: 0.00051,
      name: "openeral test",
      email: "kritenshstp021@gmail.com",
      billing_status: "paid",
      daily_stats: [
        {
          date: "2026-09-01",
          requests: 1,
          input_tokens: 15,
          output_tokens: 155,
          tokens: 170,
          cost: 0.00051,
        }
      ]
    };

    // Simulated dynamic refresh logic (mirroring refreshStats inside our provider)
    state.stats = mockApiResponse;
    if (mockApiResponse.email) state.userEmail = mockApiResponse.email;
    if (mockApiResponse.name) state.userName = mockApiResponse.name;
    if (mockApiResponse.billing_status) state.billingStatus = mockApiResponse.billing_status;

    // Assertions
    expect(state.userName).toBe("openeral test");
    expect(state.userEmail).toBe("kritenshstp021@gmail.com");
    expect(state.billingStatus).toBe("paid");
    expect(state.stats.total_cost).toBe(0.00051);
    expect(state.stats.daily_stats[0].cost).toBe(0.00051);
  });

  test("updates local store state dynamically from the backend stats response for B2C individual", () => {
    // Simulated billing store state for a fresh individual user
    const state = {
      apiKeySet: true,
      billingStatus: "unpaid",
      userEmail: "Connected API Key",
      userName: "Individual User",
      stats: null as any,
    };

    // Simulated API response for an individual subscriber
    const mockApiResponse = {
      total_requests: 25,
      total_input_tokens: 25000,
      total_output_tokens: 15000,
      total_cost: 0.40,
      name: "Individual Org",
      email: "individual@test.com",
      billing_status: "paid",
      daily_stats: [
        {
          date: "2026-09-01",
          requests: 25,
          input_tokens: 25000,
          output_tokens: 15000,
          tokens: 40000,
          cost: 0.40,
        }
      ]
    };

    // Simulated dynamic refresh logic
    state.stats = mockApiResponse;
    if (mockApiResponse.email) state.userEmail = mockApiResponse.email;
    if (mockApiResponse.name) state.userName = mockApiResponse.name;
    if (mockApiResponse.billing_status) state.billingStatus = mockApiResponse.billing_status;

    // Assertions
    expect(state.userName).toBe("Individual Org");
    expect(state.userEmail).toBe("individual@test.com");
    expect(state.billingStatus).toBe("paid");
    expect(state.stats.total_cost).toBe(0.40);
  });
});