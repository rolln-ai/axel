---
title: Cookie Policy
slug: cookies
version: "1.0"
effectiveDate: "2026-06-04"
lastUpdated: "2026-06-04"
summary: Axel uses strictly-necessary cookies (a dashboard sign-in session cookie plus platform security cookies) and a product-analytics tool (PostHog) that sets analytics cookies and device storage; it does not use advertising or cross-site behavioral-advertising cookies.
---

# Cookie Policy

**Version 1.0 — Effective 2026-06-04. Last updated 2026-06-04.**

This Cookie Policy explains how rolln, Inc. ("rolln", "we", "us", or "our") uses cookies and similar technologies when you visit our marketing website or sign in to and use the Axel platform (the "Service"). It supplements, and should be read together with, our [Privacy Policy](https://axelapp.ai/privacy), which describes more broadly how we handle Personal Data and other personal information, and is provided for information; it is subject to our [Terms of Service](https://axelapp.ai/terms) (the binding agreement governing your use of the Service).

In this document, "Customer", "you", and "your" refer to the organization or person using or visiting the Service, and "Authorized User" refers to a person permitted to use the Service on a Customer's behalf. Where we refer to "Personal Data", we use that term as defined in our [Privacy Policy](https://axelapp.ai/privacy); references in this policy to "personal information" carry the meaning given under applicable US state privacy law.

## 1. What Cookies and Similar Technologies Are

A "cookie" is a small text file that a website places on your device (computer, phone, or tablet) when you visit it. The cookie is sent back to the website on subsequent requests, allowing the site to recognize your browser, keep you signed in, and operate securely. Cookies set by the website you are visiting are called "first-party" cookies; cookies set by a different domain are called "third-party" cookies. A cookie can still function as a third-party (analytics) tracker even when it is served from our own domain — see the note on reverse-proxied analytics in Section 3.

"Similar technologies" refers to other mechanisms that perform comparable functions, including:

- **Local storage and session storage** — browser storage the application may use to hold non-sensitive interface state, and that our analytics tool uses to hold an analytics identifier, on your device.
- **Tokens** — short strings exchanged between your browser and our servers to keep your session authenticated.
- **Pixels / web beacons** — small markers sometimes embedded in pages or emails to detect activity. (See Section 3 for which, if any, we use.)

In this policy, we use the word "cookies" to refer to cookies and these similar technologies (including local/session storage) collectively, unless we say otherwise.

Cookies can also be grouped by how long they last:

- **Session cookies** are temporary and are deleted when you close your browser or when your session ends.
- **Persistent cookies** remain on your device for a set period or until you delete them.

## 2. How Axel Uses Cookies — Overview

Axel is a self-serve, business-to-business webhook ingestion and event-pipeline product. We take a focused approach to cookies. We use:

- **Strictly-necessary cookies** to operate the Service securely and to keep Authorized Users signed in to the dashboard; and
- **Product-analytics cookies and device storage** (via PostHog) to understand how Authorized Users use the dashboard so we can improve it.

In particular:

- **We use a strictly-necessary authentication/session cookie** so that, once you sign in to the dashboard, you stay signed in across pages. The Axel application uses **server-side sessions** — your session data lives on our servers, and the cookie in your browser holds only an opaque session identifier (not your password, and not the contents of your session).
- **We rely on strictly-necessary security and load-balancing cookies set by our infrastructure providers** (Cloudflare and Vercel) to route traffic, balance load, and protect the Service against abuse and automated attacks.
- **We use PostHog, a product-analytics tool, in the Axel dashboard.** PostHog sets a first-party analytics cookie and uses local/device storage to assign a distinguishing identifier, and — once you sign in — associates dashboard activity with your Authorized User account and Workspace so we can measure feature usage and improve the product. PostHog acts as our analytics sub-processor. To keep analytics working even when an ad blocker would block requests to PostHog's own domain, analytics traffic is reverse-proxied through a same-origin `/ingest` path on our domain before being forwarded to PostHog. We treat these analytics cookies as **non-essential** and, where the law requires it, set them only with your prior consent (see Section 5).
- **We do NOT use third-party advertising cookies, and we do NOT use cross-site behavioral-advertising or ad-network tracking cookies.** We do not sell or share personal information for cross-context behavioral advertising, and we do not embed advertising-network trackers in the Service.

## 3. Cookies Axel Uses

The table below lists the cookies and similar technologies we use, grouped by category. Exact cookie names, the precise set of provider security cookies, and their durations are configured by us and by our third-party providers and may change over time.

| Cookie / Category | Purpose | Type | Duration |
|---|---|---|---|
| Axel session cookie (e.g., `axel_session`) | Keeps an Authorized User signed in to the dashboard after authentication. Stores only an opaque server-side session identifier; the session data itself is held on our servers. Without it, sign-in does not work. | Essential | Session, or up to 30 days for persistent sessions; cleared on sign-out. |
| Cross-site request forgery (CSRF) protection (no dedicated cookie) | Protects authenticated dashboard actions against cross-site request forgery. We do not set a dedicated CSRF cookie; CSRF protection relies on the `SameSite=Lax` session cookie and framework-level server-action protections rather than a separate cookie. | Essential | Session |
| Cloudflare security cookies (e.g., `__cf_bm`, and `cf_clearance` where applicable) | Set by our edge provider, Cloudflare, to distinguish humans from bots, mitigate abuse, and protect the Service. Strictly necessary for security. | Essential | `__cf_bm`: ~30 minutes; `cf_clearance`: provider-defined, up to ~1 year. |
| Vercel load-balancing / routing cookies (where set) | Set by our hosting provider, Vercel, to route requests and balance load for the marketing site and dashboard. Strictly necessary for delivery of the Service. | Essential | Session or provider-defined. |
| Local/session storage (interface state) | Holds non-sensitive dashboard interface state (such as layout or view preferences) on your device. Not a cookie, but a similar technology. | Functional / Essential | Until cleared by you or by the application |
| PostHog product-analytics cookie (e.g., `ph_<project-key>_posthog`) and associated local/device storage | Set by our product-analytics tool, PostHog, to assign a distinguishing/anonymous analytics identifier and measure how the dashboard is used. Once you sign in, dashboard activity is associated with your Authorized User account (email, name) and your Workspace. Served first-party but processed by PostHog as our sub-processor; analytics requests are reverse-proxied through the same-origin `/ingest` path. | Analytics (non-essential) | Persistent — PostHog default up to ~1 year. |

We do not control the internal behavior of cookies set by Cloudflare, Vercel, and PostHog; those providers act as our sub-processors. PostHog (PostHog Inc., US) is listed on our public [Sub-processors](https://axelapp.ai/subprocessors) page. For more on these providers and what data they handle, see our [Privacy Policy](https://axelapp.ai/privacy) and the [Sub-processors](https://axelapp.ai/subprocessors) page.

The cookie names, durations, and provider behaviors described above are provided for transparency. They are configured by us and by our third-party providers and may change without notice as those configurations change; any specific value is illustrative and current as of the "Last updated" date. This Cookie Policy is provided for information, is subject to the [Terms of Service](https://axelapp.ai/terms), and does not create any warranty or representation as to the accuracy, completeness, or continued applicability of provider-set cookie details.

## 4. Why the Essential Cookies Are Necessary

The authentication/session cookie and the provider security/load cookies are **strictly necessary** to provide the Service you have asked for:

- Without the session cookie, the dashboard cannot keep you authenticated, and you would effectively be signed out on every page load. Sign-in would not function.
- Without the provider security and load-balancing cookies, we could not reliably protect the Service against bots and abuse or route your traffic correctly.

Because these cookies are essential to operating the Service and to security, they are always active when you use the Service and cannot be switched off through an in-product cookie control without breaking core functionality.

The PostHog product-analytics cookie and device storage are **not** strictly necessary — the Service functions without them. They are non-essential analytics cookies and are governed by Section 5.

## 5. Legal Basis and Consent

How cookies are regulated depends on your location.

The product-analytics processing described in this policy — including the activity, account (email, name), and Workspace details that PostHog associates with a signed-in Authorized User — is processing of Authorized User Personal Data for which **rolln acts as the controller**. It is therefore governed by our [Privacy Policy](https://axelapp.ai/privacy), and is **not** Customer Data processed by rolln as a processor under the Data Processing Addendum (DPA); see DPA Section 3.4. The legal bases below apply to that controller-side processing.

- **Strictly-necessary (essential) cookies** — In the EU, UK, and most comparable jurisdictions, cookies that are strictly necessary to provide a service the user has explicitly requested (such as keeping you signed in, or protecting the Service against attack) are **exempt from prior consent**. We therefore set the essential cookies described above without asking for consent, and rely, where applicable, on our legitimate interests and on the necessity of operating the Service you requested. We still describe them transparently here.
- **Non-essential cookies (analytics, and any functional or advertising cookies)** — Where the law requires it (notably under the EU ePrivacy Directive / GDPR and the UK PECR), non-essential cookies — including the PostHog product-analytics cookie and its associated device storage — may be placed only with your prior, informed consent. **In jurisdictions that require consent, the analytics cookies described in Section 3 must be set only after such consent is obtained.** Outside jurisdictions that require prior consent, we may rely on legitimate interests for product-improvement analytics and honor applicable opt-out signals (see Section 6).
- **United States** — We do not use cross-site behavioral-advertising or targeted-advertising cookies, and we do not sell or share personal information for cross-context behavioral advertising. We use PostHog only as a first-party product-analytics tool for our own product improvement. We therefore do not believe an opt-out of "sale"/"sharing" is triggered by our cookie use; if our practices change, we will update this policy and provide any opt-out mechanism the law requires.

## 6. How to Control Cookies

You can control and delete cookies through your browser, and through your device and account settings.

- **Browser controls.** Most browsers let you view the cookies stored on your device, delete them, and block cookies (either all cookies or third-party cookies). These controls are usually found under the browser's "Privacy", "Security", or "Site settings" menus. The major browser vendors publish step-by-step guides for managing cookies; consult your browser's help documentation.
- **Analytics consent / opt-out.** Where a consent control is presented (see Section 5), you can decline or withdraw consent to the PostHog analytics cookie and device storage; the Service will continue to function. You can also decline or clear the analytics cookie through your browser settings as described above; where a consent control is presented in the product, you can withdraw consent there.
- **Clearing site data.** You can clear cookies and local/session storage for our domains at any time from your browser. Doing so will sign you out of the dashboard and reset your analytics identifier.
- **Signing out.** Using the in-product "Sign out" control ends your session and clears the relevant session cookie.
- **"Do Not Track" and Global Privacy Control (GPC).** Because we do not use cross-site tracking or advertising cookies, there is generally no cross-site tracking for these signals to disable. Because we do not use the analytics cookie for cross-site tracking or advertising, we do not currently change our behavior based on "Do Not Track" or Global Privacy Control signals; we honor the consent and opt-out choices described above.

**Important — disabling essential cookies breaks sign-in.** If you block or delete the strictly-necessary session and security cookies, you will not be able to sign in to or use the Axel dashboard, and parts of the Service may not function correctly. These cookies do not track you across other websites; they exist to operate the Service securely. Blocking only the analytics cookie does not affect your ability to use the Service.

## 7. Changes to This Cookie Policy

This Cookie Policy is a notice, not a contract; the binding agreement governing your use of the Service is our [Terms of Service](https://axelapp.ai/terms), which this policy does not modify. We may update this Cookie Policy from time to time — for example, if we add or remove cookies, change providers, or change our analytics configuration. When we do, we will update the "Last updated" date at the top of this page and, where the change is material, surface it through reasonable means (such as a notice in the dashboard and/or the updated effective date). We will set any newly introduced non-essential cookie only after obtaining fresh consent where consent is required — never on the basis that your continued use of the Service re-consents to new trackers. We encourage you to review this page periodically.

## 8. Contact

If you have questions about this Cookie Policy or our use of cookies, contact us at:

- **Privacy / data-subject requests:** privacy@axelapp.ai
- **Legal notices:** legal@axelapp.ai
- **Mailing address:** rolln, Inc., Delaware, United States (for our current postal address, contact legal@axelapp.ai)

For more detail on how we handle personal information generally, please see our [Privacy Policy](https://axelapp.ai/privacy); for the providers that process data on our behalf, see the [Sub-processors](https://axelapp.ai/subprocessors) page; and for the terms governing your use of the Service, see our [Terms of Service](https://axelapp.ai/terms) and [Acceptable Use Policy](https://axelapp.ai/acceptable-use).
