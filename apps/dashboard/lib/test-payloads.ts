/**
 * Client-safe test / sample payloads for AXE-25 and field selection previews.
 *
 * This file contains ONLY plain data (no server-only imports, no process.env,
 * no Cloudflare R2 calls). It can be safely imported from Client Components.
 *
 * The original server-only logic (R2 fetching) lives in sample-payload.ts.
 *
 * 30+ payloads across Stripe (10), GitHub (8), Shopify (6), Linear (3),
 * Slack (2), Twilio (2), SendGrid (2), Chargebee (2). Designed so a
 * developer can fire all of them at a single source and watch the
 * Data Contracts inferer pick up 25+ distinct types.
 */

const NOW_S = () => Math.floor(Date.now() / 1000);
const NOW_ISO = () => new Date().toISOString();

/**
 * Default sample payload shown when:
 *   - no events have been received yet
 *   - R2 fetch is not configured (no CF API token in dashboard env)
 *   - R2 fetch failed
 *
 * Picked to exercise nested paths so the operator can see how dot-paths
 * traverse `customer.email` and `data.object.id`.
 */
export const GENERIC_SAMPLE: unknown = {
  event_id: "019df3b5-440a-7a88-833b-553bba67cc12",
  type: "payment_intent.succeeded",
  customer: { email: "jordan@example.com", id: "cus_42" },
  amount: 1234,
  currency: "usd",
  metadata: { order_id: "4521", traceparent: "00-…" },
  data: {
    object: {
      id: "obj_abc",
      created: 1714838400,
    },
  },
};

/** Preset payloads for the AXE-25 test event sender (realistic shapes for common providers). */
export const TEST_PAYLOADS: Record<string, { label: string; payload: unknown }> = {
  generic: { label: "Generic JSON", payload: GENERIC_SAMPLE },

  // ── Stripe (10) ────────────────────────────────────────────────────
  stripe_payment_intent_succeeded: {
    label: "Stripe — payment_intent.succeeded",
    payload: stripeEnvelope("payment_intent.succeeded", {
      id: "pi_3OkTestSucceeded",
      amount: 1999,
      currency: "usd",
      status: "succeeded",
      customer: "cus_test_a1",
    }),
  },
  stripe_payment_intent_failed: {
    label: "Stripe — payment_intent.payment_failed",
    payload: stripeEnvelope("payment_intent.payment_failed", {
      id: "pi_3OkTestFailed",
      amount: 2999,
      currency: "usd",
      status: "requires_payment_method",
      last_payment_error: { code: "card_declined", message: "Your card was declined." },
    }),
  },
  stripe_charge_succeeded: {
    label: "Stripe — charge.succeeded",
    payload: stripeEnvelope("charge.succeeded", {
      id: "ch_3OkTestCharge",
      amount: 1999,
      currency: "usd",
      status: "succeeded",
      paid: true,
      payment_method_details: { type: "card", card: { brand: "visa", last4: "4242" } },
    }),
  },
  stripe_charge_refunded: {
    label: "Stripe — charge.refunded",
    payload: stripeEnvelope("charge.refunded", {
      id: "ch_3OkTestCharge",
      amount: 1999,
      amount_refunded: 1999,
      currency: "usd",
      refunded: true,
    }),
  },
  stripe_invoice_paid: {
    label: "Stripe — invoice.paid",
    payload: stripeEnvelope("invoice.paid", {
      id: "in_1Test",
      amount_paid: 4999,
      amount_remaining: 0,
      currency: "usd",
      status: "paid",
      customer: "cus_test_a1",
      subscription: "sub_test_42",
    }),
  },
  stripe_invoice_payment_failed: {
    label: "Stripe — invoice.payment_failed",
    payload: stripeEnvelope("invoice.payment_failed", {
      id: "in_2Test",
      amount_due: 4999,
      currency: "usd",
      status: "open",
      attempt_count: 2,
      next_payment_attempt: NOW_S() + 86400,
    }),
  },
  stripe_customer_created: {
    label: "Stripe — customer.created",
    payload: stripeEnvelope("customer.created", {
      id: "cus_test_a1",
      email: "ada@example.com",
      name: "Ada Lovelace",
      created: NOW_S(),
    }),
  },
  stripe_customer_subscription_created: {
    label: "Stripe — customer.subscription.created",
    payload: stripeEnvelope("customer.subscription.created", {
      id: "sub_test_42",
      customer: "cus_test_a1",
      status: "active",
      items: { data: [{ price: { id: "price_test_pro", unit_amount: 4900, currency: "usd" } }] },
    }),
  },
  stripe_customer_subscription_deleted: {
    label: "Stripe — customer.subscription.deleted",
    payload: stripeEnvelope("customer.subscription.deleted", {
      id: "sub_test_42",
      customer: "cus_test_a1",
      status: "canceled",
      canceled_at: NOW_S(),
    }),
  },
  stripe_checkout_session_completed: {
    label: "Stripe — checkout.session.completed",
    payload: stripeEnvelope("checkout.session.completed", {
      id: "cs_test_x",
      payment_status: "paid",
      amount_total: 4900,
      currency: "usd",
      customer_email: "shopper@example.com",
    }),
  },

  // ── GitHub (8) ─────────────────────────────────────────────────────
  github_push: {
    label: "GitHub — push",
    payload: {
      ref: "refs/heads/main",
      before: "0000000000000000000000000000000000000000",
      after: "1a2b3c4d5e6f7081920304a5b6c7d8e9f0010203",
      repository: { id: 123, full_name: "acme/app", private: false },
      pusher: { name: "octocat", email: "octocat@example.com" },
      commits: [
        { id: "1a2b3c4d", message: "feat: ship inbox", author: { name: "Octocat" } },
      ],
    },
  },
  github_pull_request_opened: {
    label: "GitHub — pull_request (opened)",
    payload: {
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
  github_pull_request_closed: {
    label: "GitHub — pull_request (closed/merged)",
    payload: {
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
  github_issues_opened: {
    label: "GitHub — issues (opened)",
    payload: {
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
  github_issue_comment_created: {
    label: "GitHub — issue_comment (created)",
    payload: {
      action: "created",
      issue: { number: 7, title: "Inbox row drag-select" },
      comment: { body: "+1, this would be huge.", user: { login: "jordan" } },
      repository: { full_name: "acme/app" },
    },
  },
  github_workflow_run_completed: {
    label: "GitHub — workflow_run (completed)",
    payload: {
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
  github_release_published: {
    label: "GitHub — release (published)",
    payload: {
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
  github_check_run_completed: {
    label: "GitHub — check_run (completed)",
    payload: {
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

  // ── Shopify (6) ────────────────────────────────────────────────────
  shopify_orders_create: {
    label: "Shopify — orders/create",
    payload: {
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
  shopify_orders_paid: {
    label: "Shopify — orders/paid",
    payload: {
      id: 999000111,
      order_number: 1042,
      email: "shopper@example.com",
      total_price: "49.99",
      currency: "USD",
      financial_status: "paid",
      processed_at: NOW_ISO(),
    },
  },
  shopify_orders_fulfilled: {
    label: "Shopify — orders/fulfilled",
    payload: {
      id: 999000111,
      fulfillment_status: "fulfilled",
      fulfillments: [
        { id: 1, status: "success", tracking_number: "1Z999AA10123456784", tracking_company: "UPS" },
      ],
    },
  },
  shopify_orders_cancelled: {
    label: "Shopify — orders/cancelled",
    payload: {
      id: 999000112,
      cancelled_at: NOW_ISO(),
      cancel_reason: "customer",
      financial_status: "refunded",
    },
  },
  shopify_customers_create: {
    label: "Shopify — customers/create",
    payload: {
      id: 555000111,
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      orders_count: 0,
      total_spent: "0.00",
      created_at: NOW_ISO(),
    },
  },
  shopify_products_update: {
    label: "Shopify — products/update",
    payload: {
      id: 333000111,
      title: "Sample Hoodie",
      product_type: "apparel",
      status: "active",
      variants: [{ id: 1, price: "49.99", inventory_quantity: 22 }],
      updated_at: NOW_ISO(),
    },
  },

  // ── Linear (3) ─────────────────────────────────────────────────────
  linear_issue_create: {
    label: "Linear — Issue (create)",
    payload: {
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
  linear_comment_create: {
    label: "Linear — Comment (create)",
    payload: {
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
  linear_project_update: {
    label: "Linear — Project (update)",
    payload: {
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

  // ── Slack (2) ──────────────────────────────────────────────────────
  slack_url_verification: {
    label: "Slack — url_verification",
    payload: {
      type: "url_verification",
      // Synthetic placeholders modelled on Slack's url_verification doc
      // example. Not real tokens; scrambled to keep secret-scanners
      // from false-positive matching.
      token: "EXAMPLE-slack-verify-tok",
      challenge: "EXAMPLE-slack-challenge-xyz",
    },
  },
  slack_event_message: {
    label: "Slack — event_callback (message)",
    payload: {
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

  // ── Twilio (2) ─────────────────────────────────────────────────────
  twilio_message_status: {
    label: "Twilio — message status (delivered)",
    payload: {
      MessageSid: "SM" + "a".repeat(32),
      AccountSid: "AC" + "0".repeat(32),
      MessagingServiceSid: "MG" + "1".repeat(32),
      MessageStatus: "delivered",
      To: "+15551234567",
      From: "+15557654321",
    },
  },
  twilio_inbound_message: {
    label: "Twilio — inbound SMS",
    payload: {
      MessageSid: "SM" + "b".repeat(32),
      AccountSid: "AC" + "0".repeat(32),
      From: "+15551234567",
      To: "+15557654321",
      Body: "STOP",
      NumSegments: "1",
    },
  },

  // ── SendGrid (2) ───────────────────────────────────────────────────
  sendgrid_delivered: {
    label: "SendGrid — delivered",
    payload: [
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
  sendgrid_bounce: {
    label: "SendGrid — bounce",
    payload: [
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

  // ── Chargebee (2) ──────────────────────────────────────────────────
  chargebee_invoice_generated: {
    label: "Chargebee — invoice_generated",
    payload: {
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
  chargebee_subscription_created: {
    label: "Chargebee — subscription_created",
    payload: {
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

/**
 * Stripe Event envelope: a real Stripe webhook is `{id, object: "event",
 * type, created, data: { object: <resource> }}`. Keeping the envelope in
 * one place means each per-event preset only specifies the resource.
 */
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
