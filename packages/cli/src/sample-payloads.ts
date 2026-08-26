/**
 * Sample payloads for `axel trigger <provider> <event_type>` and
 * `axel send <provider> <event_type>`. Mirrors the dashboard's
 * `apps/dashboard/lib/test-payloads.ts` in spirit but keyed by the
 * `provider/event_type` shape the CLI's positional args use.
 *
 * 30+ provider event types so a developer can fire `axel trigger`
 * once per type and watch the source's Data Contract grow to 25+
 * distinct shapes.
 */

export interface SamplePayload {
  provider: string;
  event_type: string;
  body: unknown;
  /**
   * Suggested headers a real provider would send. The CLI passes
   * these through to the test-trigger endpoint so dashboard
   * inspectors render a faithful preview.
   */
  headers: Record<string, string>;
}

const NOW_S = () => Math.floor(Date.now() / 1000);
const NOW_ISO = () => new Date().toISOString();

function stripeEnvelope(type: string, object: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `evt_test_${Math.random().toString(36).slice(2, 12)}`,
    object: "event",
    api_version: "2025-04-30",
    created: NOW_S(),
    type,
    data: { object },
    livemode: false,
  };
}

const STRIPE_HEADERS = { "content-type": "application/json", "stripe-signature": "t=0,v1=cli-sample" };
const GITHUB_HEADERS = (event: string) => ({ "content-type": "application/json", "x-github-event": event });
const SHOPIFY_HEADERS = (topic: string) => ({ "content-type": "application/json", "x-shopify-topic": topic });
const LINEAR_HEADERS = { "content-type": "application/json", "linear-event": "true" };
const SLACK_HEADERS = { "content-type": "application/json", "x-slack-signature": "v0=cli-sample" };
const TWILIO_HEADERS = { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "cli-sample" };
const SENDGRID_HEADERS = { "content-type": "application/json" };
const CHARGEBEE_HEADERS = { "content-type": "application/json" };

export const SAMPLE_PAYLOADS: Record<string, SamplePayload> = {
  // ── Stripe (10) ─────────────────────────────────────────────────────
  "stripe/payment_intent.succeeded": {
    provider: "stripe",
    event_type: "payment_intent.succeeded",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("payment_intent.succeeded", {
      id: "pi_3OkTestSucceeded",
      amount: 1999,
      currency: "usd",
      status: "succeeded",
      customer: "cus_test_a1",
    }),
  },
  "stripe/payment_intent.payment_failed": {
    provider: "stripe",
    event_type: "payment_intent.payment_failed",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("payment_intent.payment_failed", {
      id: "pi_3OkTestFailed",
      amount: 2999,
      currency: "usd",
      status: "requires_payment_method",
      last_payment_error: { code: "card_declined", message: "Your card was declined." },
    }),
  },
  "stripe/charge.succeeded": {
    provider: "stripe",
    event_type: "charge.succeeded",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("charge.succeeded", {
      id: "ch_3OkTestCharge",
      amount: 1999,
      currency: "usd",
      status: "succeeded",
      paid: true,
      payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
    }),
  },
  "stripe/charge.failed": {
    provider: "stripe",
    event_type: "charge.failed",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("charge.failed", {
      id: "ch_3OkTestChargeFail",
      amount: 4200,
      currency: "usd",
      status: "failed",
      failure_message: "Your card was declined.",
    }),
  },
  "stripe/charge.refunded": {
    provider: "stripe",
    event_type: "charge.refunded",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("charge.refunded", {
      id: "ch_3OkTestCharge",
      amount: 1999,
      amount_refunded: 1999,
      currency: "usd",
      refunded: true,
    }),
  },
  "stripe/invoice.paid": {
    provider: "stripe",
    event_type: "invoice.paid",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("invoice.paid", {
      id: "in_1Test",
      amount_paid: 4999,
      currency: "usd",
      status: "paid",
      customer: "cus_test_a1",
      subscription: "sub_test_42",
    }),
  },
  "stripe/invoice.payment_failed": {
    provider: "stripe",
    event_type: "invoice.payment_failed",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("invoice.payment_failed", {
      id: "in_2Test",
      amount_due: 4999,
      currency: "usd",
      status: "open",
      attempt_count: 2,
    }),
  },
  "stripe/customer.created": {
    provider: "stripe",
    event_type: "customer.created",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("customer.created", {
      id: "cus_test_a1",
      email: "ada@example.com",
      name: "Ada Lovelace",
    }),
  },
  "stripe/customer.subscription.created": {
    provider: "stripe",
    event_type: "customer.subscription.created",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("customer.subscription.created", {
      id: "sub_test_42",
      customer: "cus_test_a1",
      status: "active",
      items: { data: [{ price: { id: "price_test_pro", unit_amount: 4900, currency: "usd" } }] },
    }),
  },
  "stripe/customer.subscription.deleted": {
    provider: "stripe",
    event_type: "customer.subscription.deleted",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("customer.subscription.deleted", {
      id: "sub_test_42",
      customer: "cus_test_a1",
      status: "canceled",
      canceled_at: NOW_S(),
    }),
  },
  "stripe/checkout.session.completed": {
    provider: "stripe",
    event_type: "checkout.session.completed",
    headers: STRIPE_HEADERS,
    body: stripeEnvelope("checkout.session.completed", {
      id: "cs_test_x",
      payment_status: "paid",
      amount_total: 4900,
      currency: "usd",
      customer_email: "shopper@example.com",
    }),
  },

  // ── GitHub (8) ──────────────────────────────────────────────────────
  "github/push": {
    provider: "github",
    event_type: "push",
    headers: GITHUB_HEADERS("push"),
    body: {
      ref: "refs/heads/main",
      before: "0000000000000000000000000000000000000000",
      after: "1a2b3c4d5e6f7081920304a5b6c7d8e9f0010203",
      repository: { id: 123, full_name: "acme/app", private: false },
      pusher: { name: "octocat", email: "octocat@example.com" },
      commits: [{ id: "1a2b3c4d", message: "feat: ship inbox", author: { name: "Octocat" } }],
    },
  },
  "github/pull_request": {
    provider: "github",
    event_type: "pull_request",
    headers: GITHUB_HEADERS("pull_request"),
    body: {
      action: "opened",
      number: 1042,
      pull_request: {
        title: "feat: ship the inbox",
        user: { login: "octocat" },
        head: { ref: "feature/inbox" },
        base: { ref: "main" },
      },
      repository: { full_name: "acme/app" },
    },
  },
  "github/pull_request_closed": {
    provider: "github",
    event_type: "pull_request_closed",
    headers: GITHUB_HEADERS("pull_request"),
    body: {
      action: "closed",
      number: 1042,
      pull_request: {
        title: "feat: ship the inbox",
        merged: true,
        merged_by: { login: "octocat" },
      },
      repository: { full_name: "acme/app" },
    },
  },
  "github/issues": {
    provider: "github",
    event_type: "issues",
    headers: GITHUB_HEADERS("issues"),
    body: {
      action: "opened",
      issue: {
        number: 7,
        title: "Inbox row drag-select",
        user: { login: "octocat" },
        labels: [{ name: "ux" }],
      },
      repository: { full_name: "acme/app" },
    },
  },
  "github/issue_comment": {
    provider: "github",
    event_type: "issue_comment",
    headers: GITHUB_HEADERS("issue_comment"),
    body: {
      action: "created",
      issue: { number: 7, title: "Inbox row drag-select" },
      comment: { body: "+1, this would be huge.", user: { login: "jordan" } },
      repository: { full_name: "acme/app" },
    },
  },
  "github/workflow_run": {
    provider: "github",
    event_type: "workflow_run",
    headers: GITHUB_HEADERS("workflow_run"),
    body: {
      action: "completed",
      workflow_run: {
        id: 9001,
        name: "CI",
        status: "completed",
        conclusion: "success",
        head_branch: "main",
      },
      repository: { full_name: "acme/app" },
    },
  },
  "github/release": {
    provider: "github",
    event_type: "release",
    headers: GITHUB_HEADERS("release"),
    body: {
      action: "published",
      release: {
        tag_name: "v1.4.0",
        name: "Inbox + AI Explainer",
        author: { login: "octocat" },
        body: "Ships /inbox.",
      },
      repository: { full_name: "acme/app" },
    },
  },
  "github/check_run": {
    provider: "github",
    event_type: "check_run",
    headers: GITHUB_HEADERS("check_run"),
    body: {
      action: "completed",
      check_run: {
        id: 1234,
        name: "vitest",
        status: "completed",
        conclusion: "success",
        head_sha: "1a2b3c4d",
      },
      repository: { full_name: "acme/app" },
    },
  },

  // ── Shopify (6) ─────────────────────────────────────────────────────
  "shopify/orders/create": {
    provider: "shopify",
    event_type: "orders/create",
    headers: SHOPIFY_HEADERS("orders/create"),
    body: {
      id: 999000111,
      order_number: 1042,
      email: "shopper@example.com",
      total_price: "49.99",
      currency: "USD",
      financial_status: "paid",
      line_items: [{ title: "Sample Hoodie", quantity: 1, price: "49.99" }],
      created_at: NOW_ISO(),
    },
  },
  "shopify/orders/paid": {
    provider: "shopify",
    event_type: "orders/paid",
    headers: SHOPIFY_HEADERS("orders/paid"),
    body: {
      id: 999000111,
      order_number: 1042,
      email: "shopper@example.com",
      total_price: "49.99",
      currency: "USD",
      financial_status: "paid",
      processed_at: NOW_ISO(),
    },
  },
  "shopify/orders/fulfilled": {
    provider: "shopify",
    event_type: "orders/fulfilled",
    headers: SHOPIFY_HEADERS("orders/fulfilled"),
    body: {
      id: 999000111,
      fulfillment_status: "fulfilled",
      fulfillments: [
        { id: 1, status: "success", tracking_number: "1Z999AA10123456784", tracking_company: "UPS" },
      ],
    },
  },
  "shopify/orders/cancelled": {
    provider: "shopify",
    event_type: "orders/cancelled",
    headers: SHOPIFY_HEADERS("orders/cancelled"),
    body: {
      id: 999000112,
      cancelled_at: NOW_ISO(),
      cancel_reason: "customer",
      financial_status: "refunded",
    },
  },
  "shopify/customers/create": {
    provider: "shopify",
    event_type: "customers/create",
    headers: SHOPIFY_HEADERS("customers/create"),
    body: {
      id: 555000111,
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      orders_count: 0,
      total_spent: "0.00",
      created_at: NOW_ISO(),
    },
  },
  "shopify/products/update": {
    provider: "shopify",
    event_type: "products/update",
    headers: SHOPIFY_HEADERS("products/update"),
    body: {
      id: 333000111,
      title: "Sample Hoodie",
      product_type: "apparel",
      status: "active",
      variants: [{ id: 1, price: "49.99", inventory_quantity: 22 }],
      updated_at: NOW_ISO(),
    },
  },

  // ── Linear (3) ──────────────────────────────────────────────────────
  "linear/Issue": {
    provider: "linear",
    event_type: "Issue",
    headers: LINEAR_HEADERS,
    body: {
      action: "create",
      type: "Issue",
      data: {
        id: "abc-123",
        identifier: "AXE-99",
        title: "Acme: ship sample inventory",
        priority: 2,
        state: { id: "state_todo", name: "Todo", type: "unstarted" },
        assignee: { id: "user_jordan", email: "jordan@example.com" },
      },
      url: "https://linear.app/axelapp/issue/AXE-99",
    },
  },
  "linear/Comment": {
    provider: "linear",
    event_type: "Comment",
    headers: LINEAR_HEADERS,
    body: {
      action: "create",
      type: "Comment",
      data: {
        id: "cmt-1",
        body: "Looks good — shipping it.",
        user: { id: "user_jordan", email: "jordan@example.com" },
        issue: { id: "abc-123", identifier: "AXE-99" },
      },
    },
  },
  "linear/Project": {
    provider: "linear",
    event_type: "Project",
    headers: LINEAR_HEADERS,
    body: {
      action: "update",
      type: "Project",
      data: {
        id: "proj-axel",
        name: "Webhook Platform Competitive Gaps",
        progress: 0.42,
        targetDate: "2026-06-30",
      },
    },
  },

  // ── Slack (2) ───────────────────────────────────────────────────────
  "slack/url_verification": {
    provider: "slack",
    event_type: "url_verification",
    headers: SLACK_HEADERS,
    body: {
      type: "url_verification",
      // Synthetic placeholders modelled on Slack's url_verification doc
      // example. Not real tokens; scrambled to keep secret-scanners
      // from false-positive matching.
      token: "EXAMPLE-slack-verify-tok",
      challenge: "EXAMPLE-slack-challenge-xyz",
    },
  },
  "slack/event_callback": {
    provider: "slack",
    event_type: "event_callback",
    headers: SLACK_HEADERS,
    body: {
      type: "event_callback",
      team_id: "T012345",
      event: {
        type: "message",
        channel: "C0LAN2Q65",
        user: "U061F7AUR",
        text: "Hello from #engineering",
        ts: `${NOW_S()}.000200`,
      },
    },
  },

  // ── Twilio (2) ──────────────────────────────────────────────────────
  "twilio/message_status": {
    provider: "twilio",
    event_type: "message_status",
    headers: TWILIO_HEADERS,
    body: {
      MessageSid: "SM" + "a".repeat(32),
      AccountSid: "AC" + "0".repeat(32),
      MessagingServiceSid: "MG" + "1".repeat(32),
      MessageStatus: "delivered",
      To: "+15551234567",
      From: "+15557654321",
    },
  },
  "twilio/inbound_message": {
    provider: "twilio",
    event_type: "inbound_message",
    headers: TWILIO_HEADERS,
    body: {
      MessageSid: "SM" + "b".repeat(32),
      AccountSid: "AC" + "0".repeat(32),
      From: "+15551234567",
      To: "+15557654321",
      Body: "STOP",
      NumSegments: "1",
    },
  },

  // ── SendGrid (2) ────────────────────────────────────────────────────
  "sendgrid/delivered": {
    provider: "sendgrid",
    event_type: "delivered",
    headers: SENDGRID_HEADERS,
    body: [
      {
        email: "shopper@example.com",
        timestamp: NOW_S(),
        "smtp-id": "<14c5d75ce93.dfd.64b469@ismtpd-555>",
        event: "delivered",
        category: ["transactional"],
        sg_event_id: "rbtnWrG1DVDGGGFHFQun8R8a3X",
        sg_message_id: "14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0",
      },
    ],
  },
  "sendgrid/bounce": {
    provider: "sendgrid",
    event_type: "bounce",
    headers: SENDGRID_HEADERS,
    body: [
      {
        email: "ghost@example.com",
        timestamp: NOW_S(),
        event: "bounce",
        reason: "550 5.1.1 The email account that you tried to reach does not exist.",
        type: "bounce",
        sg_event_id: "rbtnWrG1DVDGGGFHFQun8R8a3Y",
      },
    ],
  },

  // ── Chargebee (2) ───────────────────────────────────────────────────
  "chargebee/invoice_generated": {
    provider: "chargebee",
    event_type: "invoice_generated",
    headers: CHARGEBEE_HEADERS,
    body: {
      id: "ev_invoice_gen_1",
      event_type: "invoice_generated",
      occurred_at: NOW_S(),
      content: {
        invoice: {
          id: "inv_test",
          customer_id: "cus_test",
          status: "payment_due",
          total: 1000,
          amount_due: 1000,
        },
      },
    },
  },
  "chargebee/subscription_created": {
    provider: "chargebee",
    event_type: "subscription_created",
    headers: CHARGEBEE_HEADERS,
    body: {
      id: "ev_sub_create_1",
      event_type: "subscription_created",
      occurred_at: NOW_S(),
      content: {
        subscription: {
          id: "sub_test",
          customer_id: "cus_test",
          plan_id: "pro-monthly",
          status: "active",
        },
      },
    },
  },
};

export function listProviders(): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(SAMPLE_PAYLOADS)) {
    const slash = key.indexOf("/");
    if (slash > 0) out.add(key.slice(0, slash));
  }
  return Array.from(out).sort();
}

export function listEventTypesFor(provider: string): string[] {
  const out: string[] = [];
  for (const key of Object.keys(SAMPLE_PAYLOADS)) {
    const [p, ...rest] = key.split("/");
    if (p === provider) out.push(rest.join("/"));
  }
  return out.sort();
}
