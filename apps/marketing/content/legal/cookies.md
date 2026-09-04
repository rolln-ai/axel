---
title: Cookie Policy
slug: cookies
version: "1.1"
effectiveDate: "2026-06-04"
lastUpdated: "2026-08-27"
summary: Axel uses only the cookies and browser storage needed for sign-in, security, routing, and interface state. Axel does not load product-analytics or advertising trackers.
---

# Cookie Policy

**Version 1.1. Effective 2026-06-04. Last updated 2026-08-27.**

This Cookie Policy explains how rolln, Inc. ("rolln", "we", "us", or "our") uses cookies and similar technologies when you visit our marketing website or sign in to and use the Axel platform (the "Service"). It supplements, and should be read together with, our [Privacy Policy](https://axelapp.ai/privacy), which describes more broadly how we handle Personal Data and other personal information, and is provided for information; it is subject to our [Terms of Service](https://axelapp.ai/terms) (the binding agreement governing your use of the Service).

In this document, "Customer", "you", and "your" refer to the organization or person using or visiting the Service, and "Authorized User" refers to a person permitted to use the Service on a Customer's behalf. Where we refer to "Personal Data", we use that term as defined in our [Privacy Policy](https://axelapp.ai/privacy); references in this policy to "personal information" carry the meaning given under applicable US state privacy law.

## 1. What Cookies and Similar Technologies Are

A "cookie" is a small text file that a website places on your device when you visit it. The cookie is sent back to the website on subsequent requests, allowing the site to recognize your browser, keep you signed in, and operate securely. Cookies set by the website you are visiting are called "first-party" cookies; cookies set by a different domain are called "third-party" cookies.

"Similar technologies" refers to other mechanisms that perform comparable functions, including:

- **Local storage and session storage** — browser storage the application may use to hold non-sensitive interface state on your device.
- **Tokens** — short strings exchanged between your browser and our servers to keep your session authenticated.
- **Pixels / web beacons** — small markers sometimes embedded in pages or emails to detect activity. (See Section 3 for which, if any, we use.)

In this policy, we use the word "cookies" to refer to cookies and these similar technologies (including local/session storage) collectively, unless we say otherwise.

Cookies can also be grouped by how long they last:

- **Session cookies** are temporary and are deleted when you close your browser or when your session ends.
- **Persistent cookies** remain on your device for a set period or until you delete them.

## 2. How Axel Uses Cookies — Overview

Axel is a self-serve, business-to-business webhook ingestion and event-pipeline product. We use **strictly-necessary cookies** to operate the Service securely and keep Authorized Users signed in to the dashboard.

In particular:

- **We use a strictly-necessary authentication/session cookie** so that, once you sign in to the dashboard, you stay signed in across pages. The Axel application uses **server-side sessions** — your session data lives on our servers, and the cookie in your browser holds only an opaque session identifier (not your password, and not the contents of your session).
- **We rely on strictly-necessary security and load-balancing cookies set by our infrastructure providers** (Cloudflare and Vercel) to route traffic, balance load, and protect the Service against abuse and automated attacks.
- **We do not load product-analytics, advertising, cross-site behavioral-advertising, or ad-network tracking scripts.** We do not sell or share personal information for cross-context behavioral advertising.

## 3. Cookies Axel Uses

The table below lists the cookies and similar technologies we use, grouped by category. Exact cookie names, the precise set of provider security cookies, and their durations are configured by us and by our third-party providers and may change over time.

| Cookie / Category | Purpose | Type | Duration |
|---|---|---|---|
| Axel session cookie (e.g., `axel_session`) | Keeps an Authorized User signed in to the dashboard after authentication. Stores only an opaque server-side session identifier; the session data itself is held on our servers. Without it, sign-in does not work. | Essential | Session, or up to 30 days for persistent sessions; cleared on sign-out. |
| Cross-site request forgery (CSRF) protection (no dedicated cookie) | Protects authenticated dashboard actions against cross-site request forgery. We do not set a dedicated CSRF cookie; CSRF protection relies on the `SameSite=Lax` session cookie and framework-level server-action protections rather than a separate cookie. | Essential | Session |
| Cloudflare security cookies (e.g., `__cf_bm`, and `cf_clearance` where applicable) | Set by our edge provider, Cloudflare, to distinguish humans from bots, mitigate abuse, and protect the Service. Strictly necessary for security. | Essential | `__cf_bm`: ~30 minutes; `cf_clearance`: provider-defined, up to ~1 year. |
| Vercel load-balancing / routing cookies (where set) | Set by our hosting provider, Vercel, to route requests and balance load for the marketing site and dashboard. Strictly necessary for delivery of the Service. | Essential | Session or provider-defined. |
| Local/session storage (interface state) | Holds non-sensitive dashboard interface state (such as layout or view preferences) on your device. Not a cookie, but a similar technology. | Functional / Essential | Until cleared by you or by the application |

We do not control the internal behavior of cookies set by Cloudflare and Vercel; those providers act as our sub-processors. For more on these providers and what data they handle, see our [Privacy Policy](https://axelapp.ai/privacy) and the [Sub-processors](https://axelapp.ai/subprocessors) page.

The cookie names, durations, and provider behaviors described above are provided for transparency. They are configured by us and by our third-party providers and may change without notice as those configurations change; any specific value is illustrative and current as of the "Last updated" date. This Cookie Policy is provided for information, is subject to the [Terms of Service](https://axelapp.ai/terms), and does not create any warranty or representation as to the accuracy, completeness, or continued applicability of provider-set cookie details.

## 4. Why the Essential Cookies Are Necessary

The authentication/session cookie and the provider security/load cookies are **strictly necessary** to provide the Service you have asked for:

- Without the session cookie, the dashboard cannot keep you authenticated, and you would effectively be signed out on every page load. Sign-in would not function.
- Without the provider security and load-balancing cookies, we could not reliably protect the Service against bots and abuse or route your traffic correctly.

Because these cookies are essential to operating the Service and to security, they are always active when you use the Service and cannot be switched off through an in-product cookie control without breaking core functionality.

## 5. Legal Basis and Consent

How cookies are regulated depends on your location.

- **Strictly-necessary (essential) cookies** — In the EU, UK, and most comparable jurisdictions, cookies that are strictly necessary to provide a service the user has explicitly requested (such as keeping you signed in, or protecting the Service against attack) are **exempt from prior consent**. We therefore set the essential cookies described above without asking for consent, and rely, where applicable, on our legitimate interests and on the necessity of operating the Service you requested. We still describe them transparently here.
- **United States** — We do not use cross-site behavioral-advertising or targeted-advertising cookies, and we do not sell or share personal information for cross-context behavioral advertising. If our practices change, we will update this policy and provide any opt-out mechanism the law requires.

## 6. How to Control Cookies

You can control and delete cookies through your browser, and through your device and account settings.

- **Browser controls.** Most browsers let you view the cookies stored on your device, delete them, and block cookies (either all cookies or third-party cookies). These controls are usually found under the browser's "Privacy", "Security", or "Site settings" menus. The major browser vendors publish step-by-step guides for managing cookies; consult your browser's help documentation.
- **Clearing site data.** You can clear cookies and local/session storage for our domains at any time from your browser. Doing so will sign you out of the dashboard and reset locally stored interface state.
- **Signing out.** Using the in-product "Sign out" control ends your session and clears the relevant session cookie.
- **"Do Not Track" and Global Privacy Control (GPC).** Axel does not load cross-site tracking or advertising scripts, so there is no tracker behavior for these signals to disable.

**Important — disabling essential cookies breaks sign-in.** If you block or delete the strictly-necessary session and security cookies, you will not be able to sign in to or use the Axel dashboard, and parts of the Service may not function correctly. These cookies do not track you across other websites; they exist to operate the Service securely.

## 7. Changes to This Cookie Policy

This Cookie Policy is a notice, not a contract; the binding agreement governing your use of the Service is our [Terms of Service](https://axelapp.ai/terms), which this policy does not modify. We may update this Cookie Policy from time to time, for example if we add or remove cookies or change providers. When we do, we will update the "Last updated" date at the top of this page and, where the change is material, surface it through reasonable means such as a dashboard notice. We will set any newly introduced non-essential cookie only after obtaining consent where the law requires it.

## 8. Contact

If you have questions about this Cookie Policy or our use of cookies, contact us at:

- **Privacy / data-subject requests:** privacy@axelapp.ai
- **Legal notices:** legal@axelapp.ai
- **Mailing address:** rolln, Inc., Delaware, United States (for our current postal address, contact legal@axelapp.ai)

For more detail on how we handle personal information generally, please see our [Privacy Policy](https://axelapp.ai/privacy); for the providers that process data on our behalf, see the [Sub-processors](https://axelapp.ai/subprocessors) page; and for the terms governing your use of the Service, see our [Terms of Service](https://axelapp.ai/terms) and [Acceptable Use Policy](https://axelapp.ai/acceptable-use).
