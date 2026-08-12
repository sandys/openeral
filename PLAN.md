# Implementation Plan: Individual User Billing & Onboarding Flow

## 1. Overview & Goals
The goal of this feature is to seamlessly onboard individual users into the Openrind Shell (`openeral`) without exposing them to the comprehensive Organization/Gateway UI (`stringcost`). 
The flow provides:
1. **Frictionless Sign-Up**: OAuth via web, deep-linked back to the Shell.
2. **7-Day Trial & $10/mo Subscription**: Enforced at the presign level.
3. **Embedded Payments**: Stripe Elements integrated directly into the Openrind Shell for a native feel.
4. **In-App Analytics**: Usage and cost stats displayed natively within the Shell.
5. **Upgrade Path**: Easy transition to Org mode if the user logs directly into the Gateway web dashboard.

---

## 2. Gateway (`stringcost`) Backend Adjustments

### 2.1. Individual Organization Provisioning & Org Detection
When a user signs up via the Openrind Shell, the Gateway must determine if they are a new individual user or an existing organizational user.
- **Auth Flow update (`web/app/auth`)**:
  - Accept a query parameter `intent=shell` (e.g., `https://app.openrind.com/login?intent=shell`).
  - Upon successful Google/GitHub OAuth, detect this intent.
  - **Logic**: 
    1. Check if the user already has an existing `organization` of type `team/standard`.
    2. **If they already have a standard organization**: Stop the individual onboarding flow. Redirect them immediately to their existing organization's API Key management page (`/dashboard/api-keys`) with a toast message instructing them to generate or copy a key for the Openrind Shell.
    3. **If they are a new user or only have an individual profile**: Create a new `organization` (add a `type` column or flag `is_individual = true`).
    4. Set `trial_ends_at = NOW() + INTERVAL '7 days'`.
    5. Generate a standard Gateway API Key tied to this individual organization in the `api_clients` table.
    6. Redirect back to the Shell via deep link: `openrind://auth?api_key=<KEY>&status=trialing`.

### 2.2. Presign Guardrails (Trial & Subscription Enforcement)
The Gateway's presign endpoint needs to act as the gatekeeper for the Openrind Shell.
- **Endpoint**: `POST /v1/presign` (in `apps/control-plane`)
- **Validation Logic**:
  1. Retrieve `organization` via the `api_key`.
  2. If `organization.type === 'individual'`:
     - Check the subscription status (from `billing_info` or Stripe cache). If `active`, **ALLOW**.
     - If not active, check `trial_ends_at`. If `NOW() > trial_ends_at`, return `402 Payment Required`.
     - Else (still in trial), **ALLOW**.

### 2.3. Stripe Payment Endpoints
To support the "in-app" payment feel without violating PCI compliance, we must serve Stripe Intents to the Shell.
- **Endpoints** (`apps/control-plane/src/stripe`):
  - `POST /v1/billing/individual/setup`: Creates and returns a Stripe `SetupIntent` or `PaymentIntent` client secret.
  - `POST /v1/billing/individual/subscribe`: Attaches the payment method (tokenized by the Shell) to the Stripe Customer and provisions the $10/mo flat-fee subscription.
- **Ledger Integration**: The $10/mo flat fee will be mapped into the SAP-inspired billing architecture by inserting a contract condition into `pricing_condition_records` with valid temporal bounds (`valid_from`, `valid_to`).

### 2.4. In-App Usage API
Provide the Shell with the data it needs to render stats.
- **Endpoint**: `GET /v1/usage/individual/stats` (in `apps/control-plane`)
- **Logic**: Authenticated via the API Key. Queries `ledger_events` for the authenticated individual organization.
- **Response**: Returns aggregated requests, token counts, and estimated raw costs for the current billing period.

### 2.5. Web Dashboard: Upgrade to Org Mode
If the individual user visits `app.openrind.com` directly:
- **Dashboard UI (`web/app/(dashboard)`)**:
  - Detect `is_individual === true`.
  - Hide complex team settings, routing, and provider configs.
  - Display a simplified usage view and a persistent CTA: **"Switch to Organization Mode"**.
  - Clicking this provisions a standard Organization workspace, granting them full access to standard Gateway features.

---

## 3. Shell (`openeral`) Frontend Adjustments

### 3.1. Sign-Up UI & Deep Linking
- **Onboarding UI (`openrind-desktop`)**:
  - Add a "Sign In with Openrind Gateway" button.
  - This opens the system browser to the login URL with `?intent=shell`.
- **Deep Link Handler**:
  - Register the `openrind://` protocol client in Electron.
  - Capture the `openrind://auth?api_key=...` redirect.
  - Save the API Key securely (using `safeStorage` or standard keychain integrations).
  - Automatically configure the Shell to route requests through the Openrind Gateway.

### 3.2. Native-Feeling Payment Flow (Stripe Elements)
The user requires credit card details to be "stored in the application itself". To remain secure and PCI-compliant, this means using embedded Stripe Elements.
- **Billing Modal UI**:
  - Display a banner indicating trial status (e.g., "5 Days Left in Free Trial").
  - Provide a "Pay $10/mo to Continue" button.
- **Integration**:
  - Import `@stripe/react-stripe-js` into the React frontend.
  - Fetch the `client_secret` from the Gateway (`/v1/billing/individual/setup`).
  - Render the embedded Stripe `<CardElement />`.
  - Upon submission, Stripe tokenizes the card. The Shell sends the token to `/v1/billing/individual/subscribe`.
  - Visually, the user never leaves the Openrind Shell to pay, fulfilling the "stored in the app" requirement.

### 3.3. Usage & Stats Dashboard
Since the user shouldn't need to visit the Gateway dashboard, bring the dashboard to them.
- **Usage Widget**:
  - Add a "Usage & Billing" sidebar tab or settings section in the Shell.
  - Poll the `GET /v1/usage/individual/stats` endpoint.
  - Display beautifully rendered charts or metric cards showing token usage, request volume, and billing status.

---

## 4. Phased Implementation Plan

### Phase 1: Database & Backend Auth (Gateway)
1. Add `type` (enum) and `trial_ends_at` (timestamp) to `organizations` table.
2. Update the Next.js auth callback in `stringcost/web` to detect `intent=shell`, provision the individual org, generate an API key, and redirect to `openrind://`.

### Phase 2: Desktop Deep Linking & Trial Guardrails (Shell + Gateway)
1. Implement the deep link listener in `openrind-desktop` to capture and store the API key.
2. Update `apps/control-plane/src/server.ts` presign logic to enforce the 7-day trial guardrail using the `trial_ends_at` field.
3. Test trial expiration behavior (verify 402 responses are handled gracefully by the Shell).

### Phase 3: Stripe Elements & Native Payments (Shell + Gateway)
1. Build the `/v1/billing/individual/setup` and `/subscribe` routes in the control plane.
2. Ensure double-entry ledger hooks capture the $10/mo subscription.
3. Implement the Stripe Elements React components inside `openrind-desktop`.
4. Connect the submit action to the new billing endpoints.

### Phase 4: Usage Stats & Org Switcher (Shell + Gateway)
1. Build the `/v1/usage/individual/stats` aggregation endpoint.
2. Create the "Usage & Billing" UI in the Openrind Shell.
3. Update the `stringcost/web` dashboard to detect individual orgs and present the "Upgrade to Organization Mode" button.
