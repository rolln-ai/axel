// The dashboard suite models the cloud deployment: Stripe is configured, so
// plan gates and the free-tier cap are enforced (plan-state.ts deriveGate).
// Self-hosted (Stripe-less) behavior is covered explicitly in
// billing-self-hosted.test.ts, which clears this variable per test.
process.env.STRIPE_SECRET_KEY ??= "sk_test_vitest_fixture";
