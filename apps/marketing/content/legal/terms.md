---
title: Terms of Service (Master Subscription Agreement)
slug: terms
version: "1.0"
effectiveDate: "2026-06-04"
lastUpdated: "2026-07-31"
summary: The master contract governing your subscription to and use of Axel, the webhook-ingestion and event-delivery service operated by rolln, Inc.
---

# Terms of Service (Master Subscription Agreement)

**Version 1.0 — Effective 2026-06-04. Last updated 2026-07-31.**

These Terms of Service, together with any ordering documents, plan selections, and the policies incorporated by reference below (collectively, this **"Agreement"** or these **"Terms"**), form a binding legal contract between you and **rolln, Inc.** governing your access to and use of Axel. **Please read them carefully.** By clicking to accept, by creating a Workspace, or by accessing or using the Service, you agree to be bound by this Agreement.

---

## 1. Agreement and Acceptance

### 1.1 Parties

This Agreement is between **rolln, Inc.**, a Delaware corporation (**"rolln"**, **"we"**, **"us"**, or **"our"**), and the organization or individual that accepts this Agreement (**"Customer"**, **"you"**, or **"your"**). rolln operates and provides the Axel webhook-ingestion and event-delivery platform and related websites, dashboards, APIs, and documentation (collectively, the **"Service"** or **"Axel"**).

### 1.2 How the Agreement Is Formed (Clickwrap)

You accept this Agreement, and it becomes a binding contract, at the earliest of when you: (a) check the box or click the button indicating acceptance of these Terms; (b) create a Workspace or an account; or (c) otherwise access or use the Service. By checking that box (or otherwise assenting), you agree to be bound by these Terms and, as incorporated into and forming part of this Agreement, the [Acceptable Use Policy](https://axelapp.ai/acceptable-use) and the [Privacy Policy](https://axelapp.ai/privacy) (and, where applicable to your processing of Personal Data, the [Data Processing Addendum](https://axelapp.ai/dpa)). The signup acceptance checkbox enumerates and links to these documents by name, and your assent at the checkbox extends to each of them. If you do not agree to this Agreement, including those incorporated documents, you must not access or use the Service.

To evidence your acceptance, the Service may record and retain acceptance metadata, including the identity of the accepting account, the date and time of acceptance, the version of this Agreement accepted, and the method of assent (and, where available, the originating IP address). You agree that such records are admissible to prove the formation and terms of this Agreement and that an electronic acceptance has the same legal effect as a handwritten signature.

### 1.3 Who May Accept; Authority to Bind

You may accept this Agreement only if you are at least 18 years of age and have the legal capacity to enter into a contract. If you are accepting on behalf of an organization (for example, your employer or another legal entity), you represent and warrant that: (a) you have full legal authority to bind that organization to this Agreement; and (b) you have read and understood this Agreement. In that case, **"Customer"**, **"you"**, and **"your"** refer to that organization. If you do not have such authority, you must not accept this Agreement or use the Service on the organization's behalf.

### 1.4 Eligibility; Business Use; Not a Consumer

The Service is a business-to-business offering. You represent and warrant that you are acquiring and using the Service solely for business, commercial, or professional purposes, and not for personal, family, household, or consumer purposes, and that you are not a "consumer" under any consumer-protection statute. The Service is not directed to children. To the maximum extent permitted by law, you agree that consumer-protection statutes and any related non-waivable consumer remedies do not apply to this Agreement, and you waive any right to assert them; nothing in this Section purports to waive rights that cannot lawfully be waived (see Section 12.3). You may not use the Service if you are barred from doing so under applicable law, including U.S. export-control and sanctions laws (see Section 19.10).

---

## 2. Definitions

Capitalized terms have the meanings given where first defined, or as set out below. These defined terms are used consistently across the Axel legal documents.

- **"Axel"** or **"Service"** — the Axel platform and service, including the edge ingest endpoints, dashboard, APIs, connectors, routing and delivery engine, and related documentation.
- **"rolln"**, **"we"**, **"us"**, **"our"** — the provider, rolln, Inc.
- **"Customer"**, **"you"**, **"your"** — the organization or person that has entered into this Agreement.
- **"Authorized User"** — a person whom the Customer permits to access and use the Service on the Customer's behalf, including any member of the Customer's Workspace.
- **"End User"** — the Customer's own end users or data subjects whose data flows through the Service.
- **"Customer Data"** — data that the Customer (or its Authorized Users or End Users) sends to, processes in, or receives from the Service, including webhook payloads, event data, routes, filters, transforms, destinations, and configuration.
- **"Personal Data"** — personal data (or personal information) contained within Customer Data and processed by Axel on the Customer's behalf. The Data Processing Addendum governs Personal Data, under which the Customer is the controller (or business) and Axel is the processor (or service provider).
- **"Sub-processor"** — a third party that Axel uses to process Personal Data, as listed at the Sub-processors page referenced in Section 16.
- **"Workspace"** — the Customer's tenant within the Service, within which the Customer's accounts, sources, routes, destinations, and data are isolated.
- **"Order"** — an online plan selection, order form, statement of work, or other ordering document under which the Customer subscribes to the Service.
- **"Documentation"** — the user guides, security descriptions, and technical materials that rolln makes generally available for the Service.

---

## 3. The Service; License to Use It; Intellectual Property

### 3.1 The Service

Axel is a self-serve, multi-tenant webhook-ingestion and event-pipeline platform. In general terms, the Service lets you: register **sources** (inbound webhook endpoints and pull connectors such as Stripe, Shopify, Chargebee, Postgres, MongoDB, and BigQuery); define **routes, filters, and transforms**; and configure **destinations** (such as MongoDB, Postgres, Cloudflare R2, or an HTTP endpoint with HMAC signing). Axel accepts inbound payloads at a network edge, stores the original payload before acknowledging acceptance, queues it, evaluates your declarative route, filter, and transform configuration, and fans out deliveries to your chosen destinations.

### 3.2 License to Customer

Subject to your compliance with this Agreement and payment of applicable fees, rolln grants you a limited, non-exclusive, non-transferable, non-sublicensable, revocable right during the term to access and use the Service for your internal business purposes, and to permit your Authorized Users to do so.

### 3.3 rolln Intellectual Property

As between the parties, rolln and its licensors own and retain all right, title, and interest in and to the Service, including all software, technology, the edge ingest, route-evaluation, and delivery engines, the dashboard, APIs, Documentation, and all related intellectual property rights, and including any improvements, modifications, and derivative works. Except for the limited rights expressly granted in Section 3.2, no rights are granted to you by implication, estoppel, or otherwise. The Axel and rolln names, logos, and product names are trademarks of rolln; you may not use them except as expressly permitted in writing.

### 3.4 Restrictions

You will not, and will not permit any Authorized User or third party to: (a) copy, modify, or create derivative works of the Service; (b) reverse engineer, decompile, or disassemble the Service, or attempt to discover its source code, except to the extent this restriction is prohibited by applicable law; (c) resell, sublicense, time-share, or provide the Service to third parties as a service bureau except as expressly permitted; (d) circumvent or interfere with the Service's security, tenant-isolation, rate-limiting, body-size, depth, or route-evaluation controls; (e) use the Service to build a competing product or copy its features or interface; (f) access the Service to benchmark it, or publish any benchmark or performance results about the Service, without rolln's prior written consent; or (g) remove or obscure any proprietary notices. The restrictions in this Section 3.4 apply to rolln's Service, software, and technology, and do **not** apply to your own routes, filter and transform configurations, and other Customer Data, which remain yours under Section 5.1. Additional use restrictions appear in the Acceptable Use Policy (see Section 6).

### 3.5 Feedback

If you or your Authorized Users provide suggestions, ideas, enhancement requests, or other feedback about the Service (**"Feedback"**), you grant rolln a perpetual, irrevocable, worldwide, royalty-free, fully paid-up, transferable, and sublicensable license to use, reproduce, modify, and exploit such Feedback for any purpose, without restriction or obligation to you. Feedback is provided voluntarily and is not Confidential Information of the Customer.

---

## 4. Accounts, Authorized Users, and Credentials

### 4.1 Workspace and Accounts

To use the Service you must create a Workspace and one or more accounts. You are responsible for providing accurate, current, and complete registration information and for keeping it up to date.

### 4.2 Authorized Users

You may invite Authorized Users to your Workspace and assign roles. You are responsible for: (a) ensuring each Authorized User is bound by terms at least as protective as this Agreement; (b) the acts and omissions of your Authorized Users as if they were your own; and (c) promptly deactivating access for Authorized Users who should no longer have it. Privileged actions (such as Workspace creation, member invitations, role changes, and source or destination mutations) are recorded in an append-only audit log.

### 4.3 Credentials and Source Ingest Tokens

You are responsible for maintaining the confidentiality of all account credentials, API keys, and source ingest tokens associated with your Workspace, and for all activity that occurs under them. Source ingest tokens are stored by the Service as SHA-256 hashes, are validated using constant-time comparison, and are never logged in plaintext; however, you remain responsible for safeguarding the token values in your own systems and for rotating them when appropriate. You will notify us promptly at **security@axelapp.ai** if you become aware of any unauthorized access to or use of your Workspace, credentials, or tokens.

### 4.4 Responsibility for Use

You are responsible for all use of the Service under your Workspace, whether or not authorized by you, except to the extent caused by rolln's breach of this Agreement.

---

## 5. Customer Data

### 5.1 Ownership

As between the parties, you retain all right, title, and interest in and to Customer Data. rolln does not acquire any ownership interest in Customer Data.

### 5.2 License to rolln

You grant rolln a non-exclusive, worldwide, royalty-free license to host, store, transmit, process, route, transform, cache, copy, display, and otherwise use Customer Data solely as necessary to: (a) provide, maintain, secure, and improve the Service; (b) perform deliveries to the destinations you configure; (c) prevent or address technical, security, or fraud issues; and (d) comply with law or this Agreement. Where Customer Data includes Personal Data, this license is further limited and governed by the Data Processing Addendum (see Section 16).

### 5.3 Customer Responsibility for Customer Data

You are solely responsible for Customer Data, including its content, accuracy, and legality, and for the configuration of your sources, routes, filters, transforms, and destinations. You represent and warrant that: (a) you have all rights, consents, permissions, and lawful bases necessary to send Customer Data (including any End User personal data) to the Service and to have it processed and delivered as you configure; (b) Customer Data and its processing through the Service do not and will not violate this Agreement, the Acceptable Use Policy, any applicable law, or any third party's rights; and (c) you are responsible for the legality of the route, filter, and transform configurations you author and apply through the Service.

### 5.4 Prohibited and Regulated Data

Unless you and rolln agree otherwise in a separate written agreement that expressly permits it, you must **not** submit to the Service: (a) protected health information subject to HIPAA or comparable health-privacy laws; (b) cardholder data or primary account numbers (PAN) subject to the PCI DSS; (c) government-issued identifiers used as the basis for regulated processing where prohibited; or (d) other special-category, sensitive, or regulated data for which the Service is not designed and for which heightened legal obligations would otherwise apply to rolln. The Service is not, by default, configured or certified for such data. You acknowledge that webhook traffic you route through Axel may itself carry sensitive events (for example, payment events, identity changes, or access grants), and you remain responsible for ensuring you have a lawful basis to transmit such Customer Data.

### 5.5 Backups

You are responsible for maintaining your own backups of Customer Data. The Service's retention behavior (including raw-payload, log, dead-letter, replay, and audit retention) is described in the Privacy Policy and Documentation and summarized in Section 10.6; it is operational retention and is not a backup or archival service.

### 5.6 Aggregated and De-identified Data

rolln may create aggregated, anonymized, statistical, and de-identified data and metrics derived from Customer Data and from the operation of the Service (collectively, **"Aggregated Data"**). rolln owns all Aggregated Data and may use, retain, and disclose it perpetually and irrevocably for any lawful business purpose, including operating, securing, analyzing, benchmarking, improving, and developing the Service and rolln's other products and services, and producing usage and performance analytics. rolln will ensure that Aggregated Data is maintained and disclosed only in a de-identified and aggregated form that does not identify, and is not used in a manner that identifies, you, any Authorized User, or any End User, and rolln will not attempt to re-identify any individual from Aggregated Data. This Section 5.6 is consistent with, and subject to, the Privacy Policy and the Data Processing Addendum, including any de-identification standard required by applicable data-protection law. rolln does not use Customer Data or de-identified Aggregated Data to train or develop machine-learning models for the benefit of other customers. rolln does not use the content of Customer Data to train machine-learning models for the benefit of other customers except as expressly permitted by this Section 5.6.

---

## 6. Acceptable Use

Your use of the Service is subject to the [Acceptable Use Policy](https://axelapp.ai/acceptable-use), which is incorporated into this Agreement by reference and which you agree to comply with and to ensure your Authorized Users comply with. A violation of the Acceptable Use Policy is a material breach of this Agreement and is grounds for suspension or termination under Section 10. You may report suspected abuse to **abuse@axelapp.ai**.

### 6.1 Removal of Specific Customer Data; Legal Complaints

In addition to its suspension and termination rights under Section 10, rolln may remove, disable, block, or quarantine specific Customer Data, sources, routes, or destinations (rather than only suspending an entire Workspace) where rolln reasonably believes the relevant Customer Data or configuration violates this Agreement or the Acceptable Use Policy, infringes a third party's rights, or is the subject of a credible legal complaint, subpoena, or other legal process. rolln will use reasonable efforts to notify you where permitted by law.

### 6.2 Copyright; Notice-and-Takedown (DMCA)

rolln respects intellectual-property rights and responds to clear notices of alleged copyright infringement concerning content transmitted through the Service. If you believe content processed through the Service infringes your copyright, you may send a notice that complies with the U.S. Digital Millennium Copyright Act ("DMCA"), 17 U.S.C. § 512, to rolln's designated agent at **legal@axelapp.ai** (with a copy to **abuse@axelapp.ai**). A valid notice must include the information required by § 512(c)(3), including identification of the work and the allegedly infringing material, your contact information, a good-faith statement, and your physical or electronic signature. rolln may remove or disable access to allegedly infringing material and may terminate, in appropriate circumstances, the accounts of repeat infringers.

---

## 7. Third-Party Destinations, Connectors, and Services

The Service connects to, ingests from, and delivers to third-party services that **you** select and configure, including source connectors (such as Stripe, Shopify, Chargebee, Postgres, MongoDB, and BigQuery) and destinations (such as MongoDB, Postgres, Cloudflare R2, and any HTTP endpoint). Those third parties are not controlled by rolln. You are solely responsible for: (a) your relationships with, and compliance with the terms of, those third parties; (b) the credentials, endpoints, and access you provide to or through the Service; and (c) the consequences of delivering Customer Data to the destinations you configure. rolln is not responsible for any third-party service, for its availability, security, or acts or omissions, or for any data once it is delivered to a destination you specified. Your use of any third-party service is governed by that third party's terms, not by this Agreement.

---

## 8. Fees, Billing, and Taxes

### 8.1 Plans and Fees

The Service is offered through self-serve plan tiers, which may include a free tier, paid plans, and Scale/Enterprise plans. Plan names, included usage, features, and prices are described on the pricing page and in the Service, as described on our pricing page at https://axelapp.ai/pricing. By selecting a paid plan, you agree to pay the fees for that plan, including any recurring subscription fees and any usage-based charges that exceed your plan's included usage.

### 8.2 Billing and Payment Authorization

Paid plans are billed through our payment processor, **Stripe, Inc.** rolln does not store full payment card numbers; payment-method details are held by Stripe. By providing a payment method, you authorize rolln (through Stripe) to charge that payment method for all fees as they become due, including recurring subscription fees, usage-based charges, and applicable taxes. Enterprise or complimentary accounts may instead be billed offline by invoice under an Order.

### 8.3 Auto-Renewal

Paid subscriptions automatically renew for successive periods equal to the then-current term unless cancelled before the end of the then-current period, in accordance with Section 10. Renewal will be at the then-current fees and plan terms.

### 8.4 Usage-Based Charges

Where your plan includes usage-based components (for example, events ingested or delivered above an included allowance), you agree to pay for such usage as metered by the Service. Our measurement of usage is determinative absent manifest error.

### 8.5 Taxes

Fees are exclusive of taxes. You are responsible for all sales, use, value-added, goods-and-services, withholding, and other taxes and duties associated with your purchase, excluding taxes based on rolln's net income. If rolln is required to collect taxes, they will be added to your charges. You will provide accurate tax-related information and any applicable exemption certificates.

### 8.6 Late or Failed Payment

If a charge fails or a payment is overdue, rolln may, in addition to its other remedies: (a) retry the charge; (b) assess interest on overdue amounts at the lower of 1.5% per month or the maximum rate permitted by law; (c) charge reasonable costs of collection; and (d) suspend or downgrade the Service in accordance with Section 10.2. rolln may apply any payments received to the oldest outstanding amounts first. Suspension for non-payment does not pause the accrual of recurring fees, extend or toll the subscription term, or relieve you of fees that accrue during the suspension; fees continue to accrue during any such suspension, and you remain responsible for all fees accrued before, during, and after suspension. rolln may require payment of all past-due amounts as a condition of restoring access.

### 8.7 Price Changes

rolln may change fees and introduce new charges. For changes that increase recurring fees applicable to your plan, or that increase the usage-based or overage rates under Section 8.4, rolln will provide notice at least **30 days** before the change takes effect, and the change will apply at your next renewal (or, for usage-based rates, to usage incurred after the notice period). Your continued use of the Service after a price change takes effect constitutes acceptance; if you do not agree, you may cancel before the change takes effect.

### 8.8 No Refunds; Downgrades

Except as required by applicable law or as expressly stated in this Agreement, all fees are non-refundable and are payable in full, and no credits are given for partial periods or unused capacity. If you downgrade a plan, the downgrade and any associated reduction in features, usage allowances, or retention caps take effect as described at the time of the change, and you may lose access to data or features that exceed the lower plan's limits.

### 8.9 Currency

All fees are stated and payable in **U.S. dollars** unless otherwise stated in an Order.

---

## 9. Free, Trial, and Beta Features

rolln may make free-tier access, trials, evaluation accounts, previews, and beta or early-access features (collectively, **"Free and Beta Offerings"**) available to you. Notwithstanding anything else in this Agreement, Free and Beta Offerings are provided **"AS IS"** and **"AS AVAILABLE"**, without warranty of any kind, and without any service-level or support commitment. rolln may modify, limit, suspend, or discontinue any Free and Beta Offering at any time, with or without notice, and such offerings may be subject to additional terms. To the maximum extent permitted by law, and notwithstanding the cap in Section 13.2, rolln's total aggregate liability arising out of or related to any Free and Beta Offering, or to any use of the Service for which you have paid no fees, will not exceed **US$100**. This Section 9 governs the liability cap for no-fee usage in place of the general fee-based cap in Section 13.2.

---

## 10. Term, Suspension, and Termination

### 10.1 Term

This Agreement begins when you accept it (Section 1.2) and continues until all Workspaces and subscriptions are terminated as set out below. Each subscription continues for the period stated in your plan or Order and renews under Section 8.3.

### 10.2 Suspension

rolln may suspend or restrict your or any Authorized User's access to the Service, in whole or in part, where: (a) you breach the Acceptable Use Policy or Section 5.4; (b) your payment is overdue (Section 8.6); (c) rolln reasonably determines that suspension is necessary to prevent material harm to the Service, other customers, third parties, or rolln, or to respond to a security, legal, or fraud risk; or (d) required by law or legal process. rolln will give you notice and an opportunity to remediate where practicable; however, rolln may suspend immediately and without prior notice where it reasonably determines that immediate suspension is necessary (for example, an active security threat, ongoing abuse, or legal compulsion). rolln will restore access promptly once the grounds for suspension are resolved.

### 10.3 Termination by Customer

You may terminate this Agreement and stop using the Service at any time by cancelling your subscription and closing your Workspace through the Service or by contacting us. Unless required by law, termination by you does not entitle you to a refund of pre-paid fees, and you remain responsible for fees accrued through the end of the then-current period.

### 10.4 Termination by rolln

rolln may terminate this Agreement or any subscription: (a) for cause, if you materially breach this Agreement (including the Acceptable Use Policy or a payment obligation) and fail to cure the breach within **fifteen (15) days** after notice (or immediately, where the breach is incapable of cure or involves Section 5.4, security, or unlawful conduct); or (b) for convenience, on **thirty (30) days'** notice, in which case rolln will refund any pre-paid fees for the terminated portion of the then-current period for paid plans.

### 10.5 Effect of Termination

On termination or expiration: (a) all rights and licenses granted to you under this Agreement immediately cease, and you must stop using the Service; (b) any fees accrued before termination become immediately due; and (c) provisions that by their nature should survive will survive in accordance with Section 19.14.

### 10.6 Data Export and Deletion

After termination or expiration, for a period of **thirty (30) days** (the **"Export Window"**) rolln will make available, through the Service's then-available self-service export tooling, the Customer Data that then exists in the Service. Export is limited to Customer Data that still exists in the Service at the time of export (that is, data that has not already been deleted in the ordinary course under the retention periods below) and is provided in rolln's then-standard format(s). rolln has no obligation to recreate, restore, reconstruct, or export Customer Data that has already been deleted, expired, or de-identified in the ordinary course, including raw payloads, logs, and other records past their retention period. Where self-service export tooling is unavailable for particular data, rolln may, in its discretion and on a reasonable-efforts basis (and for paid plans), provide assistance with export; rolln is not otherwise obligated to perform manual exports. After the Export Window, rolln may delete Customer Data.

This Section 10.6 is the operative, precedence-controlling provision governing the post-termination export and deletion of Customer Data, and the related windows are sequenced so that they do not conflict. Specifically: (a) rolln will **not** delete Customer Data that exists at termination before the Export Window closes (subject only to ordinary-course retention expiry under the periods described below and to deletions required by law); (b) the processor-deletion window under the [DPA](https://axelapp.ai/dpa) (DPA Sections 12.1–12.2) begins to run at, and not before, the close of the Export Window, so that the Customer's election to have Personal Data returned or deleted is honored only after the Export Window has ended; and (c) where rolln retains any Customer Data for which it acts as a controller (for example, account, billing, and audit records described in the [Privacy Policy](https://axelapp.ai/privacy) (Privacy Policy Section 8)), that controller wind-down period likewise runs from the close of the Export Window and does not cause Customer Data otherwise exportable under this Section 10.6 to be deleted before the Export Window ends. In the event of any inconsistency among these provisions as to the timing of export or deletion of Customer Data, this Section 10.6 controls.

Customer Data is deleted or de-identified in the ordinary course in accordance with the Service's retention behavior, which by default includes: raw payloads in object storage retained approximately 30 days (configurable from 0 to 30 days); delivery and event logs retained approximately 30 days; dead-letter records retained approximately 90 days (configurable from 1 to 365 days); replay-request records retained approximately 30 days (configurable from 1 to 90 days); and audit-log records retained approximately 365 days (configurable from 30 to 3,650 days) for legal, security, and compliance purposes. Deletion from backups and ephemeral caches occurs on rolling cycles. Where Personal Data is involved, deletion is further governed by the Data Processing Addendum. rolln may retain Customer Data as required by law or to enforce this Agreement.

---

## 11. Confidentiality

### 11.1 Definition

**"Confidential Information"** means non-public information disclosed by one party (the **"Discloser"**) to the other (the **"Recipient"**) that is designated as confidential or that reasonably should be understood to be confidential given its nature and the circumstances of disclosure, including the Service's non-public features, security and architecture details, pricing not publicly listed, and Customer Data. Confidential Information does not include information that the Recipient can show: (a) is or becomes public through no fault of the Recipient; (b) was rightfully known to it without confidentiality obligation before disclosure; (c) is rightfully obtained from a third party without restriction; or (d) is independently developed without use of the Discloser's Confidential Information.

### 11.2 Obligations

The Recipient will: (a) use the Discloser's Confidential Information only to perform under or exercise its rights under this Agreement; (b) protect it using at least reasonable care; and (c) not disclose it except to its employees, contractors, advisors, and Sub-processors who need to know it and are bound by confidentiality obligations at least as protective as this Section. The Recipient may disclose Confidential Information if required by law or legal process, provided that, where legally permitted, it gives the Discloser reasonable prior notice and cooperates in any effort to limit or contest the disclosure.

---

## 12. Warranty Disclaimer

### 12.1 "AS IS"

EXCEPT AS EXPRESSLY STATED IN THIS AGREEMENT, THE SERVICE, INCLUDING ALL FREE AND BETA OFFERINGS, IS PROVIDED **"AS IS"** AND **"AS AVAILABLE"**, WITH ALL FAULTS. TO THE MAXIMUM EXTENT PERMITTED BY LAW, ROLLN AND ITS LICENSORS AND SUPPLIERS DISCLAIM ALL WARRANTIES, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, AND ANY WARRANTIES ARISING FROM COURSE OF DEALING OR USAGE OF TRADE.

### 12.2 Security Descriptions Are Measures, Not Guarantees

rolln implements a range of security and reliability measures, and describes them on its security page, in its Documentation, and in marketing materials (for example, controls relating to ingest-token hashing and constant-time validation, TLS in transit, encryption of stored objects at rest, eval-free declarative route evaluation, tenant isolation keyed by Workspace, append-only audit logging, rate limits, body-size and depth caps, and stable delivery identifiers). **These statements describe measures that rolln implements; they are not warranties, guarantees, or commitments that any specific result or outcome will be achieved.** rolln does not warrant that the Service will be uninterrupted, timely, error-free, or completely secure, that all defects will be corrected, that the Service will meet your requirements, or that it will be free from loss, corruption, attack, viruses, interference, hacking, or other security intrusion. Statements about planned or roadmap features are descriptions of intent and are not commitments. No advice or information, whether oral or written, obtained from rolln or through the Service creates any warranty not expressly stated in this Agreement.

### 12.3 Consumer Rights

Some jurisdictions do not allow the exclusion of certain warranties or the limitation of certain rights. To the extent any such non-excludable rights apply to you, the disclaimers in this Section apply to the fullest extent permitted by applicable law, and nothing in this Agreement limits rights that cannot lawfully be limited.

---

## 13. Limitation of Liability

### 13.1 Exclusion of Indirect Damages

TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE LIABLE TO THE OTHER FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL, SPECIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, GOODWILL, BUSINESS, OR ANTICIPATED SAVINGS, OR FOR ANY LOSS, CORRUPTION, OR INACCURACY OF DATA OR COST OF SUBSTITUTE SERVICES, ARISING OUT OF OR RELATED TO THIS AGREEMENT OR THE SERVICE, WHETHER IN CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR OTHERWISE, AND WHETHER OR NOT THE PARTY WAS ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

### 13.2 General Liability Cap

TO THE MAXIMUM EXTENT PERMITTED BY LAW, AND SUBJECT TO SECTIONS 13.3 AND 13.4, ROLLN'S TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THIS AGREEMENT OR THE SERVICE WILL NOT EXCEED THE TOTAL FEES PAID OR PAYABLE BY THE CUSTOMER TO ROLLN FOR THE SERVICE IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT FIRST GIVING RISE TO THE LIABILITY. WHERE THE CUSTOMER HAS PAID NO FEES TO ROLLN (INCLUDING FREE-TIER, TRIAL, AND BETA USE), ROLLN'S TOTAL AGGREGATE LIABILITY IS GOVERNED BY SECTION 9 (NO-FEE LIABILITY FLOOR OF **US$100**) AND NOT BY THIS SECTION 13.2. THE CUSTOMER'S TOTAL AGGREGATE LIABILITY UNDER THIS AGREEMENT IS LIKEWISE CAPPED AT THE AMOUNT IN THE FIRST SENTENCE OF THIS SECTION 13.2, EXCEPT FOR THE LIABILITIES CARVED OUT IN SECTION 13.4. The cap in this Section 13.2 is an aggregate cap across all claims and does not reset per claim.

### 13.3 Enhanced Cap for Confidentiality and Data-Protection Breaches

TO THE MAXIMUM EXTENT PERMITTED BY LAW, EACH PARTY'S TOTAL AGGREGATE LIABILITY FOR (A) BREACH OF ITS CONFIDENTIALITY OBLIGATIONS UNDER SECTION 11 AND (B) BREACH OF ITS DATA-PROTECTION OR DATA-SECURITY OBLIGATIONS UNDER THIS AGREEMENT OR THE DPA — INCLUDING LIABILITY ARISING FROM A SECURITY INCIDENT OR UNAUTHORIZED ACCESS TO, OR DISCLOSURE OF, CUSTOMER DATA OR PERSONAL DATA — WILL NOT EXCEED THE GREATER OF (i) **TWO (2) TIMES** THE TOTAL FEES PAID OR PAYABLE BY THE CUSTOMER TO ROLLN FOR THE SERVICE IN THE TWELVE (12) MONTHS IMMEDIATELY PRECEDING THE EVENT FIRST GIVING RISE TO THE LIABILITY, OR (ii) **US$50,000**. This enhanced "super cap" replaces, and does not stack on top of, the general cap in Section 13.2 for the matters it covers. **For the avoidance of doubt, except for the liabilities expressly excluded from all caps under Section 13.4, ALL OTHER liability — including liability for security incidents, data breaches, and breaches of confidentiality — REMAINS subject to the cap in this Section 13.3 or, where this Section 13.3 does not apply, the general cap in Section 13.2, and does not escape the caps.**

### 13.4 Carve-Outs From the Caps

The cap in Section 13.2, and (except as stated below) the cap in Section 13.3, do not apply to: (a) the Customer's obligation to pay fees due under Section 8; (b) the Customer's indemnification obligations under Section 14.1; (c) either party's liability for fraud, gross negligence, or willful misconduct; (d) the Customer's infringement or misappropriation of rolln's intellectual-property rights or breach of the license restrictions in Section 3.4; and (e) any liability that cannot be limited or excluded under applicable law. The liabilities in clauses (a)–(d) are not subject to any cap in this Section 13, except that liability under any rolln IP indemnity in Section 14.2 (if offered) is subject to, and does not exceed, the general cap in Section 13.2. The exclusion of indirect and consequential damages in Section 13.1 continues to apply to all claims except those in clauses (c) and (e) above and except to the extent it cannot lawfully be applied.

### 13.5 Allocation of Risk

The parties agree that the disclaimers and limitations in Sections 12 and 13 reflect a reasonable allocation of risk, are reflected in the fees, and are an essential basis of the bargain between them, and that they apply even if a limited remedy fails of its essential purpose.

---

## 14. Indemnification

### 14.1 By Customer

You will defend, indemnify, and hold harmless rolln and its officers, directors, employees, and agents from and against any third-party claims, demands, suits, or proceedings, and any resulting losses, damages, liabilities, costs, and expenses (including reasonable attorneys' fees), arising out of or related to: (a) Customer Data, including its content and processing, and any End User personal data you submit; (b) your or your Authorized Users' use or misuse of the Service; (c) your breach of this Agreement, including the Acceptable Use Policy and Section 5; (d) your violation of any applicable law or any third party's rights (including privacy, intellectual-property, and data-protection rights); or (e) the destinations and third-party services you configure.

### 14.2 By rolln (Intellectual-Property Indemnity)

rolln will defend you against third-party claims alleging that the Service, as provided by rolln and used in accordance with this Agreement, infringes that third party's patent, copyright, or trademark, or misappropriates that third party's trade secret, and will indemnify you for amounts finally awarded against you or agreed by rolln in settlement, subject to customary exclusions (for example, claims arising from Customer Data, your route/filter/transform configurations, combinations of the Service with non-rolln products or services, modifications not made by rolln, or use after rolln has provided a non-infringing alternative). If the Service is or may become the subject of such a claim, rolln may, at its option and expense: (a) procure the right for you to continue using the Service; (b) modify or replace the Service so it is non-infringing while materially preserving its functionality; or (c) terminate the affected use and refund any pre-paid, unused fees for the terminated portion. **THIS SECTION 14.2 STATES ROLLN'S ENTIRE LIABILITY, AND YOUR SOLE AND EXCLUSIVE REMEDY, FOR ANY CLAIM THAT THE SERVICE INFRINGES OR MISAPPROPRIATES ANY THIRD PARTY'S INTELLECTUAL-PROPERTY RIGHTS.** rolln's liability under this Section 14.2 is subject to the general cap in Section 13.2 (see Section 13.4).

### 14.3 Procedure

The indemnified party will: (a) promptly notify the indemnifying party of the claim (a delay in notice does not relieve the indemnifying party except to the extent it is prejudiced); (b) give the indemnifying party sole control of the defense and settlement (provided that any settlement that imposes a non-monetary obligation on or admits fault by the indemnified party requires that party's consent, not to be unreasonably withheld); and (c) provide reasonable cooperation at the indemnifying party's expense.

---

## 15. Service Levels and Support

rolln does not commit to any specific uptime, availability, or response time unless expressly agreed in a separate written service-level agreement (an **"SLA"**). Support is provided through the channels and at the levels described for your plan, by email to founders@axelapp.ai and through in-product support, at the level applicable to your plan. General inquiries may be directed to **founders@axelapp.ai**. Free and Beta Offerings are provided without any SLA or support commitment.

---

## 16. Privacy and Data Protection

Our handling of personal information is described in the [Privacy Policy](https://axelapp.ai/privacy), which is incorporated into this Agreement by reference. Where rolln processes Personal Data within Customer Data on your behalf, such processing is governed by the [Data Processing Addendum](https://axelapp.ai/dpa) (the **"DPA"**), under which you are the controller (or business) and rolln is the processor (or service provider). The DPA is incorporated into and forms part of this Agreement and applies automatically where required by applicable data-protection law; it is also available on request. The DPA identifies the Sub-processors rolln uses, which are listed and kept current at the [Sub-processors page](https://axelapp.ai/subprocessors). To the extent of any conflict between the DPA and these Terms regarding the processing of Personal Data, the DPA controls (see Section 19.6).

rolln's obligations with respect to security incidents affecting Personal Data — including any obligation to notify you of, and to investigate and respond to, such incidents — are set out in the DPA. Nothing in the Service's security descriptions (see Section 12.2), the Documentation, or rolln's security page constitutes a guarantee against security incidents or a warranty of a particular security outcome.

### 16.1 U.S. State Privacy Laws (CCPA/CPRA and Similar)

Where the California Consumer Privacy Act, as amended by the California Privacy Rights Act (together, the **"CCPA"**), or another U.S. state privacy law applies to Personal Data that rolln processes on your behalf, rolln acts as a "service provider" (or "processor"/"contractor," as applicable) under that law. rolln does not "sell" or "share" (as those terms are defined under the CCPA) Personal Data, and does not retain, use, or disclose Personal Data for any purpose other than the business purposes of providing the Service specified in this Agreement and the DPA, or as otherwise permitted by applicable law. The detailed service-provider/contractor commitments required by Cal. Civ. Code § 1798.140 and related provisions are set out in the **DPA**, which controls over this Section 16.1 with respect to the processing of Personal Data.

---

## 17. Changes to the Service and to These Terms

### 17.1 Changes to the Service

rolln may modify, update, enhance, or discontinue features or components of the Service from time to time. rolln will not materially decrease the core functionality of the Service for a paid plan during a paid period without making reasonable efforts to provide notice; however, rolln may make changes required for security, legal, or operational reasons at any time.

### 17.2 Changes to These Terms

rolln may update this Agreement from time to time. For material changes, rolln will provide notice by a reasonable means (for example, by email to your account contact or by an in-Service notice) at least **30 days** before the changes take effect, except that changes required for legal or security reasons may take effect sooner. The updated Agreement will state its effective date. Your continued use of the Service after the changes take effect constitutes acceptance. If you do not agree to a material change, your remedy is to stop using and terminate the Service before the change takes effect, in accordance with Section 10.3.

---

## 18. Governing Law and Dispute Resolution

### 18.1 Governing Law

This Agreement and any dispute arising out of or related to it or the Service are governed by the laws of the **State of Delaware, U.S.A.**, without regard to its conflict-of-laws rules. The U.N. Convention on Contracts for the International Sale of Goods does not apply.

### 18.2 Informal Resolution First

Before initiating any formal proceeding, the parties will attempt in good faith to resolve any dispute informally by providing written notice of the dispute to the other party (to rolln at **legal@axelapp.ai**) and negotiating for at least **thirty (30) days** after such notice.

### 18.3 Choice of Forum

**The operative dispute-resolution regime is litigation in Delaware courts, as set out below. This is the only forum clause in effect.** The parties submit to the exclusive jurisdiction of the state and federal courts located in **New Castle County, State of Delaware**, and waive any objection to personal jurisdiction, venue, or inconvenient forum in those courts, for any dispute arising out of or related to this Agreement or the Service that is not resolved informally under Section 18.2. Either party may seek injunctive or other equitable relief in those courts to protect its intellectual property or Confidential Information.

### 18.4 Time Limit to Bring Claims

To the maximum extent permitted by law, any claim arising out of or related to this Agreement or the Service must be brought within **one (1) year** after the claim arose, or it is permanently barred. This one-year limitation does **not** apply to, and the otherwise-applicable statutory limitations period continues to govern: (a) claims by rolln for nonpayment of fees; (b) either party's indemnification claims under Section 14; and (c) claims for breach of confidentiality (Section 11) or for infringement or misappropriation of intellectual-property rights.

---

## 19. General

### 19.1 Assignment

You may not assign or transfer this Agreement or any rights or obligations under it, by operation of law or otherwise, without rolln's prior written consent. rolln may assign this Agreement in connection with a merger, acquisition, reorganization, or sale of all or substantially all of its assets. Any prohibited assignment is void. Subject to this Section, this Agreement binds and benefits the parties' permitted successors and assigns.

### 19.2 Subcontractors and Sub-processors

rolln may use affiliates, contractors, and Sub-processors to provide the Service. rolln remains responsible for their performance of rolln's obligations under this Agreement. Sub-processors that process Personal Data are governed by the DPA and listed on the Sub-processors page.

### 19.3 Force Majeure

Neither party is liable for any delay or failure to perform (other than payment obligations) caused by events beyond its reasonable control, including acts of God, natural disasters, war, terrorism, civil unrest, labor disputes, governmental action, internet or utility failures, denial-of-service attacks, or failures or acts of third-party service providers, hosting providers, or networks.

### 19.4 Severability

If any provision of this Agreement is held unenforceable, that provision will be modified to the minimum extent necessary to make it enforceable, or if it cannot be, severed, and the remaining provisions will remain in full force and effect.

### 19.5 No Waiver

A party's failure to enforce any provision is not a waiver of its right to do so later. Any waiver must be in writing to be effective.

### 19.6 Entire Agreement; Order of Precedence

This Agreement (including the policies and documents incorporated by reference) is the entire agreement between the parties regarding the Service and supersedes all prior or contemporaneous agreements and understandings on that subject. In the event of a conflict, the following order of precedence applies (highest first): (1) an applicable **Order** signed by both parties; (2) the **Data Processing Addendum**; (3) these **Terms**; and (4) the other incorporated **policies** (including the Acceptable Use Policy, Privacy Policy, Cookie Policy, and Sub-processors page). Any conflicting or additional terms in your purchase order or vendor-onboarding documents are rejected and have no effect unless expressly agreed in writing signed by rolln.

### 19.7 Notices

rolln may provide notices to you by email to your account contact, by posting in the Service, or by other reasonable means; such notices are effective when sent or posted. You must send legal notices to rolln at **legal@axelapp.ai** and, where required, by mail to **rolln, Inc., Delaware, United States (for our current postal address, contact legal@axelapp.ai)**. You consent to receive communications from us electronically, and you agree that electronic communications satisfy any legal requirement that communications be in writing.

### 19.8 Independent Contractors

The parties are independent contractors. This Agreement does not create any partnership, joint venture, agency, fiduciary, or employment relationship, and neither party may bind the other.

### 19.9 No Third-Party Beneficiaries

Except as expressly stated (for example, indemnified parties under Section 14), there are no third-party beneficiaries to this Agreement.

### 19.10 Export Controls and Sanctions

You will comply with all applicable U.S. and other export-control and economic-sanctions laws and regulations. You represent that you and your Authorized Users are not located in, organized under the laws of, or ordinarily resident in any country or territory subject to comprehensive sanctions, and are not a person identified on any U.S. government restricted-party or sanctions list. You will not use or permit the export or re-export of the Service in violation of such laws.

### 19.11 U.S. Government End Users

The Service is "commercial computer software" and related "commercial computer software documentation" as those terms are used under applicable U.S. Federal Acquisition Regulation and agency supplements. Any use, modification, reproduction, or disclosure by or for the U.S. Government is subject solely to the terms of this Agreement.

### 19.12 Anti-Corruption

Each party will comply with applicable anti-bribery and anti-corruption laws, including the U.S. Foreign Corrupt Practices Act. Neither party has received or been offered any illegal or improper bribe, kickback, or other improper payment in connection with this Agreement.

### 19.13 Publicity and Logo Use

Unless you opt out by notifying us at **legal@axelapp.ai**, rolln may identify you as a customer and use your name and logo in customer lists and marketing materials, in accordance with your trademark-usage guidelines where provided. Neither party may otherwise issue a press release referencing the other without its prior written consent.

### 19.14 Survival

The provisions that by their nature should survive termination or expiration will survive, including Sections 3.3–3.5 (IP, Restrictions, Feedback), 5 (Customer Data, including responsibilities and Section 5.6 (Aggregated and De-identified Data)), 6.1–6.2 (Content Removal; DMCA), 8 (accrued Fees), 10.5–10.6 (Effect of Termination; Data Export and Deletion), 11 (Confidentiality), 12 (Warranty Disclaimer), 13 (Limitation of Liability), 14 (Indemnification, including Section 14.1 and, if offered, Section 14.2), 16 (Privacy and Data Protection, to the extent applicable), 18 (Governing Law and Dispute Resolution), and 19 (General). If rolln does not offer the IP indemnity in Section 14.2, the reference to Section 14.2 in this Section and in Section 13.4 has no effect.

---

## 20. Contact and Notices

**rolln, Inc.** (operator of Axel)

- General / founders: **founders@axelapp.ai**
- Security and vulnerability reports: **security@axelapp.ai**
- Legal notices: **legal@axelapp.ai**
- Privacy and data-subject requests: **privacy@axelapp.ai**
- Abuse reports: **abuse@axelapp.ai**
- Mailing address for legal notice: **rolln, Inc., Delaware, United States (for our current postal address, contact legal@axelapp.ai)**

Related documents incorporated into or referenced by this Agreement:

- **Acceptable Use Policy** — https://axelapp.ai/acceptable-use
- **Privacy Policy** — https://axelapp.ai/privacy
- **Data Processing Addendum** — https://axelapp.ai/dpa
- **Sub-processors** — https://axelapp.ai/subprocessors
- **Cookie Policy** — https://axelapp.ai/cookies
