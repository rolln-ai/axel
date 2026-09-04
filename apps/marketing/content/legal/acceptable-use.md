---
title: Acceptable Use Policy
slug: acceptable-use
version: "1.1"
effectiveDate: "2026-09-03"
lastUpdated: "2026-09-03"
summary: The rules governing what you may send, process, and deliver through Axel, and the conduct we prohibit to keep the platform, its tenants, and the broader internet safe.
---

# Acceptable Use Policy

**Version 1.1. Effective 2026-09-03.**

This Acceptable Use Policy (the "**AUP**" or "**Policy**") governs your access to and use of the Axel platform and service ("**Axel**" or the "**Service**"), provided by rolln, Inc. ("**rolln**", "**we**", "**us**", or "**our**"). This AUP is incorporated by reference into, and forms part of, the [Terms of Service / Master Subscription Agreement](https://axelapp.ai/terms) (the "**Terms**"). Capitalized terms used but not defined in this AUP have the meanings given to them in the Terms.

This Policy governs use of the hosted Axel Cloud Service. It does not restrict
rights in source code granted by the applicable open-source license included
with that code. Activity that uses the hosted Service remains subject to this
Policy.

You ("**Customer**", "**you**", or "**your**") agree to this Policy when you accept the Terms (which acceptance occurs through the affirmative click-through or order process by which you enter into the Terms), and your continued access to or use of the Service constitutes your ongoing agreement to comply with this Policy. You are responsible for ensuring that everyone who uses the Service through your Workspace complies with it as well. **If you do not agree to this Policy, you may not use the Service.**

A violation of this AUP is a material breach of the Terms and may result in the enforcement actions described in Section 7 below, including throttling, suspension, or termination, in some cases without prior notice.

---

## 1. Purpose & Scope

Axel is a multi-tenant webhook ingestion and event-delivery platform: you register "sources" (inbound webhook endpoints and pull connectors such as Stripe, Shopify, Chargebee, Postgres, MongoDB, and BigQuery), define routes, filters, and transforms, and send the resulting events to "destinations" (MongoDB, Postgres, Cloudflare R2, or any HTTP URL with HMAC request signing). Because that traffic is shared infrastructure carrying many customers' data — including payment events, identity changes, and access grants — the way you use the Service directly affects the security, availability, and reputation of other Workspaces and of the internet endpoints you interact with.

This Policy applies to:

- **You (the Customer)** and your account, billing, and configuration of the Service;
- **Authorized Users** — every person you permit to access or operate your Workspace (workspace members, administrators, integrators, and agents acting on your behalf); and
- **All Customer Data and traffic** that you send to, process in, route through, transform within, or deliver from the Service, including the webhook payloads, route/filter/transform configurations, and destinations you configure.

**Eligibility.** The Service is a business-to-business offering and is not directed to children. Each person who accepts the Terms or this Policy, or who accesses or uses the Service, must be at least 18 years old (or the age of majority in their jurisdiction, if higher) and, where acting for an organization, must have the authority to bind that organization to the Terms and this Policy. You must not knowingly permit any Authorized User or End User who is under the applicable minimum age to use the Service, and you must not knowingly send children's personal data through the Service without a lawful basis and any consents required by applicable law (including, where applicable, the Children's Online Privacy Protection Act (COPPA) and the GDPR). This eligibility requirement supplements, and does not limit, the eligibility provisions of the [Terms of Service](https://axelapp.ai/terms).

**You are responsible for your End Users.** Where the Customer Data you transmit through Axel originates from, relates to, or is delivered to your own end users or data subjects ("**End Users**"), you are solely responsible for that data and for ensuring you have all necessary rights, consents, notices, and lawful bases to transmit it through the Service. We do not have a direct relationship with your End Users, and nothing in this Policy creates one.

**Responsibility for Workspace activity.** You are responsible for all activity that occurs under or through your Workspace and your Authorized User accounts, whether or not you authorized it, except to the extent the activity is caused by our own breach of the Terms. As an additional obligation, you must maintain the security and confidentiality of your credentials, source ingest tokens, API keys, and Authorized User accounts, and you must promptly notify us at **[security@axelapp.ai](mailto:security@axelapp.ai)** if you become aware of any unauthorized use of, or access to, your Workspace.

---

## 2. Prohibited Content

You may not use the Service to send, store, route, transform, deliver, host, or otherwise process any content, data, or material (collectively, "**Content**") that:

- **Is illegal or facilitates illegal activity** — Content that violates, or whose transmission or processing violates, any applicable law, regulation, or governmental order, or that promotes or facilitates illegal acts.
- **Infringes intellectual property** — Content that infringes, misappropriates, or violates any patent, copyright, trademark, trade secret, moral right, or other intellectual property or proprietary right of any party.
- **Is child sexual abuse material (CSAM) or exploits minors** — Any Content that sexually exploits, abuses, endangers, or is harmful to minors, including child sexual abuse material. We report CSAM to the National Center for Missing & Exploited Children (NCMEC) and/or other competent authorities as required by law and cooperate fully with their investigations. There is zero tolerance for this Content.
- **Contains malware or exploit payloads** — Viruses, worms, trojans, ransomware, spyware, rootkits, exploit code, malicious scripts, or any payload designed or likely to disable, damage, surveil, gain unauthorized access to, or interfere with any system, network, data, or the Service itself — including payloads crafted to attack a destination, a third-party API, or another tenant.
- **Violates privacy or publicity rights** — Content that unlawfully discloses another person's personal, private, or sensitive information, or that violates rights of privacy or publicity, including doxxing or the non-consensual disclosure of intimate or identifying information.
- **You lack the rights or consents to transmit** — Content that you do not have the lawful right, authority, consent, or basis to collect, transmit, process, route, transform, or deliver through the Service, including data you obtained in violation of a third party's terms, contract, or applicable law.
- **Is deceptive, fraudulent, or harmful** — Content used to perpetrate fraud, scams, identity theft, market manipulation, or other deceptive or harmful schemes, or that is defamatory, harassing, threatening, or that incites violence or unlawful harm.

You are responsible for evaluating the legality and appropriateness of all Content you transmit through the Service. We do not pre-screen Content, and the absence of action by us with respect to any Content does not constitute endorsement, approval, or a waiver of our rights under this Policy or the Terms.

---

## 3. Prohibited Conduct

You may not, and may not permit any Authorized User or third party to, use the Service to:

**Attack, probe, or gain unauthorized access**

- Access, or attempt to access, any account, Workspace, system, network, data, or portion of the Service that you are not expressly authorized to access, or that belongs to another tenant or to us.
- Probe, scan, penetration-test, fuzz, or test the vulnerability of the Service, our infrastructure, our sub-processors, or any third-party system, except as expressly permitted under Section 6 (Security & Vulnerability Research).
- Use the Service to launch, relay, amplify, coordinate, or stage attacks (including denial-of-service or distributed denial-of-service attacks), intrusions, credential-stuffing, brute-force attempts, or data exfiltration against any system or network, whether ours, a destination's, a third party's, or another tenant's.

**Abuse route evaluation and platform controls**

- Attempt to subvert or otherwise abuse the route-evaluation engine, introduce executable code through declarative route configuration, gain unauthorized network, filesystem, host, or process access, or circumvent resource limits or execution timeouts.
- Author or deploy route/filter/transform configuration that is intended to, or that does, consume excessive resources, interfere with other tenants, or compromise the integrity, isolation, or availability of the Service.
- Circumvent, disable, or attempt to defeat per-source rate limits, body-size or payload-depth caps, fan-out limits, quotas, idempotency controls, tenant isolation, billing or usage metering, or any other technical or contractual restriction or safeguard of the Service.

**Misuse the delivery pipeline**

- Use the Service to send, relay, or facilitate spam, phishing, unsolicited bulk or commercial messages, or any communications in violation of anti-spam, anti-phishing, telemarketing, or electronic-communications laws (including the CAN-SPAM Act, TCPA, GDPR/ePrivacy, CASL, or analogous laws).
- Configure destinations, routes, or fan-out in a manner that overloads, attacks, abuses, or causes denial-of-service against any destination endpoint, third-party API, or other service — including the systems of the very providers you are integrating (e.g., your configured HTTP destinations or pull-connector source APIs).
- Use the Service to mine cryptocurrency, run distributed computation unrelated to legitimate event processing, or otherwise misappropriate the Service's compute, storage, bandwidth, or network resources.

**Misuse the Service generally**

- Reverse engineer, decompile, disassemble, or attempt to derive the source code, underlying ideas, or architecture of the Service, except, and only to the extent, that this restriction is prohibited by applicable law (and then only after providing us prior written notice and a reasonable opportunity to provide an alternative).
- Resell, sublicense, rent, lease, or provide the Service to, or operate it for the benefit of, any third party as a service bureau or on a managed-service basis, except as expressly permitted by your subscription plan or by a separate written agreement with us. **Reselling, white-labeling, or providing the Service to third parties on a managed or agency basis is not permitted without rolln's prior written consent.**
- Misrepresent your identity or affiliation, impersonate any person or entity, forge headers or signatures, or falsify the origin, routing, or contents of any traffic.
- Remove, obscure, or alter any proprietary notices, or use our name, logos, or trademarks except as expressly permitted.
- Use the Service to develop, train, or benchmark a competing product or service, or to copy any feature, function, or interface of the Service for a competing purpose.

---

## 4. Data Restrictions

Axel is a general-purpose, business-to-business event pipeline and is **not** designed, certified, or contractually configured for certain categories of regulated or sensitive data. Unless you have a separate written agreement with us that expressly authorizes it, you may not ingest into, process in, route through, or deliver from the Service:

- **Protected Health Information (PHI) subject to HIPAA** — You may not transmit PHI or use the Service in any manner that would make us a "business associate" under HIPAA unless and until we have entered into a Business Associate Agreement (BAA) with you. **The Service is not HIPAA-eligible by default and no BAA is in place unless separately executed in writing.**
- **Full payment card numbers (PAN)** — You may not transmit full primary account numbers (PAN), magnetic-stripe, chip, or sensitive cardholder authentication data, or otherwise use the Service in a manner that would place Axel within the scope of the Payment Card Industry Data Security Standard (PCI DSS). We do not store card numbers. The fact that tokenized references and standard payment-event metadata from providers such as Stripe may technically transit the Service does not place Axel within PCI DSS scope and is not a representation, warranty, or assurance that the Service is suitable, certified, or configured for any particular cardholder-data use. The Service is not designed for cardholder PAN storage unless separately agreed in writing.
- **Other regulated or special-category data beyond what your plan supports** — Including, where applicable, government-issued identifiers used as the basis for identity fraud, biometric or genetic identifiers, financial account credentials, or "special categories" of personal data under applicable data-protection law, unless your plan and our written agreement (including the [Data Processing Addendum](https://axelapp.ai/dpa)) expressly support them and you have a lawful basis to process them.

In addition, you must **respect the terms, policies, and rate limits of every third-party source and destination** you connect to the Service. When you configure pull connectors or destinations (including Stripe, Shopify, Chargebee, Postgres, MongoDB, BigQuery, R2, or arbitrary HTTP endpoints), you represent that you have all necessary authorizations and credentials, that your use complies with the applicable provider's terms of service and API policies, and that you will not use Axel to circumvent any third party's access controls, scraping prohibitions, or usage limits.

Handling of Personal Data within Customer Data is further governed by the [Data Processing Addendum](https://axelapp.ai/dpa) and the [Privacy Policy](https://axelapp.ai/privacy). Where there is a conflict between this Section and the Data Processing Addendum as to the processing of Personal Data, the Data Processing Addendum controls. This local conflict rule operates within, and does not displace, the master order of precedence set out in Section 19.6 of the [Terms of Service](https://axelapp.ai/terms): your Order and the Data Processing Addendum each take precedence over the Terms, and the Terms take precedence over this AUP and our other policies. This AUP therefore sits below your Order, the Data Processing Addendum, and the Terms in that chain.

---

## 5. Fair Use & Resource Limits

The Service enforces technical limits to protect platform stability and to ensure fair access for all tenants. These include **per-source rate limits, request body-size caps, payload-depth caps, fan-out limits, and idempotency controls**, together with any plan-specific quotas described on the pricing and plan-limits page at **https://axelapp.ai/pricing** or in your order.

You agree that you will not:

- Deliberately exceed, evade, or attempt to evade applicable rate limits, caps, quotas, or fan-out limits, including by sharding traffic across sources or Workspaces to defeat per-source or per-Workspace limits;
- Generate traffic, fan-out, or transform workloads that are abusive, artificial, or designed to degrade, overload, or deny service to the Service, to other tenants, or to any destination or third-party endpoint; or
- Use the Service in a manner that, in our reasonable judgment, places a disproportionate or unsustainable load on shared resources relative to your plan.

We may impose, adjust, throttle, or enforce these limits to protect the integrity, security, and availability of the Service. Where consistent with platform safety, we will endeavor to communicate material, plan-level limit changes in advance, but we may apply rate limiting or throttling immediately to address abuse or instability.

**Descriptions of controls are not warranties.** Any descriptions in this Policy of the Service's technical controls — including eval-free declarative route evaluation and its resource limits and timeouts, tenant isolation, per-source rate limits, body-size and payload-depth caps, stable delivery identifiers, and similar safeguards — describe measures that rolln implements and are provided "AS IS." They are not warranties, representations, or guarantees of any specific security, isolation, or performance outcome, and rolln does not warrant that any such control is or will remain error-free or impossible to circumvent. The "AS IS" warranty disclaimer and the limitation-of-liability provisions of the [Terms of Service](https://axelapp.ai/terms) govern and control over any statement in this Policy.

---

## 6. Security & Vulnerability Research

We welcome good-faith security research and the responsible disclosure of vulnerabilities. If you discover a security vulnerability in the Service, please report it promptly and privately to **[security@axelapp.ai](mailto:security@axelapp.ai)**, and give us a reasonable opportunity to investigate and remediate before any public disclosure.

When conducting security research, you must:

- Limit your testing to **your own Workspace and your own data**, and not access, modify, destroy, or exfiltrate data belonging to other tenants, to us, or to any third party;
- Not perform testing that **degrades, disrupts, or denies service**, including load testing, denial-of-service or stress testing, automated high-volume scanning, or any activity that affects the availability, integrity, or performance of the Service or of other tenants — **without our prior written authorization**;
- Not attempt to defeat route-evaluation controls, tenant isolation, or other safeguards except to the minimum extent necessary to validate a specific vulnerability you intend to report in good faith;
- Not exploit a vulnerability beyond the minimum necessary to demonstrate it, and not retain, use, or disclose any data you encounter; and
- Comply with all applicable laws, this AUP, and the Terms at all times.

Good-faith research conducted strictly in accordance with this Section will not be considered a violation of this Policy or pursued by us as a Terms violation. rolln does not currently operate a formal bug-bounty or safe-harbor program; please report suspected vulnerabilities to security@axelapp.ai, and we will not pursue good-faith security research conducted in accordance with this AUP. Research that exceeds these bounds — particularly anything that affects other tenants or the availability of the Service without authorization — is prohibited and may be treated as a serious violation, including referral to law enforcement.

---

## 7. Enforcement

We take violations of this Policy seriously. **We may investigate suspected violations** and, in our reasonable discretion, take any one or more of the following actions, with or without prior notice depending on the severity and urgency of the violation:

- **Investigate** — Review Workspace configuration, metadata, logs, and, where necessary and lawful, Content, to assess a suspected violation, a report of abuse, or a legal request.
- **Throttle or restrict** — Apply or tighten rate limits, reduce fan-out, disable specific sources, destinations, routes, or transform code, or restrict particular features.
- **Suspend** — Temporarily suspend all or part of your access to the Service, your Workspace, or specific traffic.
- **Terminate** — Terminate your account, Workspace, or the Terms in accordance with the termination provisions of the Terms.

**Emergency action.** Where a violation poses an imminent risk to the security, integrity, availability, or legal standing of the Service, our other customers, our sub-processors, or any third party — including active attacks, malware distribution, CSAM, or conduct that threatens to take down shared infrastructure — we may take immediate action, including suspension or removal of offending Content or traffic, without prior notice. We will endeavor to notify you of emergency action as soon as reasonably practicable, except where notice is prohibited by law or would undermine the protective purpose of the action.

**Cooperation with law enforcement and legal process.** We may, and where required by law will, report violations to, and cooperate with, law enforcement, regulators, and other competent authorities, and we may respond to subpoenas, court orders, and other valid legal process in accordance with the [Privacy Policy](https://axelapp.ai/privacy) and applicable law.

**Preservation.** In connection with a suspected violation, abuse report, legal hold, or legal process, we may preserve relevant Content, logs, and metadata for as long as reasonably necessary, notwithstanding any otherwise-applicable retention period or deletion request, to the extent permitted by law.

**No refunds for enforcement actions.** Except as expressly stated in the Terms, suspension or termination for a violation of this Policy does not entitle you to any refund or credit. **No refund or credit is provided for any suspension or termination resulting from a violation of this AUP.**

**Your responsibility for remediation.** You are responsible for promptly remediating any violation and cooperating with our investigation. Your liability for costs, losses, and damages arising from a violation of this Policy is governed by the indemnification and limitation-of-liability provisions of the [Terms of Service](https://axelapp.ai/terms), and this Policy does not create any cost-recovery or indemnity obligation independent of those provisions.

Our decision not to enforce any provision of this Policy in a particular instance does not waive our right to enforce it in the future.

---

## 8. Reporting Abuse

If you believe Content or activity on the Service violates this Policy — including spam, phishing, malware, infringement, CSAM, attacks, or other abuse — please report it to **[abuse@axelapp.ai](mailto:abuse@axelapp.ai)**. Urgent security issues may also be sent to **[security@axelapp.ai](mailto:security@axelapp.ai)** (or, for non-urgent matters, **[founders@axelapp.ai](mailto:founders@axelapp.ai)**). To help us act quickly, please include:

- A description of the Content or activity and why you believe it violates this Policy;
- Any relevant identifiers (e.g., source endpoint, destination URL, delivery or event IDs, timestamps, originating IPs) sufficient for us to locate it; and
- Your contact information so we can follow up if needed.

Security vulnerabilities should instead be reported to **[security@axelapp.ai](mailto:security@axelapp.ai)** as described in Section 6. Intellectual-property and copyright complaints, and data-subject or privacy requests, are handled as described in the [Terms of Service](https://axelapp.ai/terms) and the [Privacy Policy](https://axelapp.ai/privacy), and may be directed to **[legal@axelapp.ai](mailto:legal@axelapp.ai)** and **[privacy@axelapp.ai](mailto:privacy@axelapp.ai)**, respectively.

We review reports we receive but do not guarantee that we will respond to, investigate, or act on any particular report, and we may decline to disclose the outcome of any investigation.

---

## 9. Changes to this Policy

We may update this Policy from time to time to reflect changes in the Service, our infrastructure, applicable law, or operational and security practices. When we make changes, we will revise the "Last updated" date above. For changes that materially affect your obligations or rights under this Policy, we will provide advance notice in accordance with the notice and change-of-terms provisions of the [Terms of Service](https://axelapp.ai/terms) — for example, by email to your account's designated contact or by an in-product notice — at least **30 days** before the change takes effect, rather than relying on continued use alone.

Changes are effective as of the date stated in the updated Policy, except that changes required to address security, legal, or abuse-related risks may take effect immediately on notice. Your continued use of the Service after the effective date of an updated Policy constitutes your acceptance of the changes. If you do not agree to the updated Policy, you must stop using the Service before the change takes effect, and your sole remedy is to terminate in accordance with the [Terms of Service](https://axelapp.ai/terms).

---

*This Acceptable Use Policy is incorporated into and governed by the [Terms of Service / Master Subscription Agreement](https://axelapp.ai/terms). For how we process Personal Data, see the [Privacy Policy](https://axelapp.ai/privacy) and [Data Processing Addendum](https://axelapp.ai/dpa). For the third parties that help us provide the Service, see the [Sub-processors](https://axelapp.ai/subprocessors) page.*
