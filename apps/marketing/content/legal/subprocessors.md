---
title: Sub-processors
slug: subprocessors
version: "1.1"
effectiveDate: "2026-06-04"
lastUpdated: "2026-07-11"
summary: The list of third-party Sub-processors Axel engages to provide the Service, what they do, and the data they process on your behalf.
---

# Sub-processors

**Version 1.1 — Effective 2026-06-04. Last updated 2026-07-11.**

This page lists the third-party Sub-processors that rolln, Inc. ("rolln", "we", "us", "our") engages to help provide the Axel service ("Axel" or the "Service"). It is referenced by, and forms part of, our [Data Processing Addendum](https://axelapp.ai/dpa) and our [Privacy Policy](https://axelapp.ai/privacy).

## Status of this page

This page is provided for transparency. It is incorporated into the [Data Processing Addendum](https://axelapp.ai/dpa) but is descriptive in nature. To the extent of any conflict between this page and the DPA or the [Terms of Service / Master Subscription Agreement](https://axelapp.ai/terms), the DPA and the Terms control. This page does not create warranties or representations beyond those expressly set out in the DPA and the Terms.

## What is a Sub-processor?

This page lists, in one place, the third parties we engage to help deliver the Service that process Personal Data. They fall into two categories:

- **(a) Sub-processors that process Personal Data within Customer Data** under our [Data Processing Addendum](https://axelapp.ai/dpa). For this Personal Data, the Customer is the controller of Personal Data flowing through Axel, rolln acts as the Customer's processor, and each such Sub-processor acts as our sub-processor. A "Sub-processor" in this sense is a third party we engage to process Personal Data within Customer Data on your behalf in order to deliver the Service.
- **(b) Service providers/processors that process controller-side Personal Data** under our [Privacy Policy](https://axelapp.ai/privacy) — that is, Personal Data for which rolln itself is the controller, such as account and billing contact details, recipient email addresses, account/session data, error and performance diagnostics, and dashboard usage data.

Some of the vendors listed below fall in category (a), some in category (b), and some in both. The [Data Processing Addendum](https://axelapp.ai/dpa) and its Annex III are scoped to category (a) — Personal Data within Customer Data — while this page is broader and also covers the controller-side processing described in the Privacy Policy. We list all of these vendors together here for transparency, even though not every listed vendor processes Customer Data.

We engage Sub-processors only where they are needed to operate, secure, scale, support, or improve the Service. Before a Sub-processor processes Personal Data, we enter into a written agreement requiring it to implement data-protection obligations consistent with applicable law and substantially similar to those we owe you under the [Data Processing Addendum](https://axelapp.ai/dpa), including obligations of confidentiality, appropriate technical and organizational security measures, and, where applicable, a valid mechanism for any cross-border transfer of Personal Data. The precise flow-down obligations we require of each Sub-processor are set out in, and governed by, the DPA.

For purposes of the CCPA/CPRA and similar US state privacy laws, rolln acts as a service provider (or processor) to the Customer, and the Sub-processors listed below act as our service providers or contractors. We do not sell or share Personal Data within the meaning of those laws. See our [Privacy Policy](https://axelapp.ai/privacy) for further detail.

Our primary processing and data-storage operations are located in the United States. Cloudflare operates a global edge network, and inbound requests may be received at the edge location nearest the sender before being processed in the United States. Our Cloudflare R2 storage and Cloudflare Queues are configured so that payload storage and processing occur in the United States.

## Current Sub-processors

The following Sub-processors are engaged across all Workspaces to provide the core Service. Categories of data reflect what each Sub-processor may process; the actual contents depend on the webhook payloads and configuration you choose to send to Axel.

| Sub-processor | Purpose / Service | Categories of data processed | Location |
| --- | --- | --- | --- |
| Cloudflare, Inc. | Edge ingestion of inbound webhooks, raw payload object storage (R2), and message queuing for asynchronous processing. | Full inbound webhook payloads stored as raw objects in R2 and queued for processing (which may contain Personal Data and sensitive events such as payment, identity, and access-grant events) and associated request metadata. | United States / global edge network |
| Render (Render Services, Inc.) | Application compute for routing and delivery services (including outbound fan-out of payloads to your chosen destinations), the PostgreSQL control database, and the self-hosted ClickHouse analytics/log database. | Account and configuration data, delivery and event logs, payload-derived metadata, and webhook payload contents processed in transit during outbound delivery. | United States |
| Vercel Inc. | Hosting for the customer dashboard and the marketing website. | Account and session data and request metadata. | United States |
| Stripe, Inc. | Subscription billing and payment processing. | Billing contact details and payment method information (held by Stripe; Axel does not store payment card numbers). | United States |
| Resend (Plus Five Five, Inc.) | Transactional email delivery (e.g., invitations, password resets, and Service notifications). | Recipient email address and email content. | United States |
| Sentry (Functional Software, Inc.) | Application error and performance monitoring. | Error and performance diagnostics, which may incidentally include request metadata. | United States |
| PostHog (PostHog Inc.) | Product analytics for the customer dashboard (feature-usage measurement and product improvement). | Authorized User account identifiers (email, name), Workspace identifier, dashboard usage/event data, device/analytics identifier, and request metadata. | United States |

## Optional feature Sub-processors

The following Sub-processor is engaged only for optional, feature-specific functionality, and only where a Workspace uses that functionality and the capability is enabled for the Service. It is not engaged to provide the core Service, and no Customer Data is sent to it unless you use the applicable feature.

| Sub-processor | Purpose / Service | Categories of data processed | Location |
| --- | --- | --- | --- |
| OpenRouter (OpenRouter, Inc.) | Optional AI-assisted features only: explaining delivery failures ("Fix with AI") and inferring data-contract schemas. OpenRouter acts as a gateway that routes the request to a third-party large-language-model provider to generate the response. | Bounded excerpts of event payloads and delivery-error details supplied as prompt context. Before transmission, Axel redacts values under secret-bearing and header fields, common credential formats, signed URL values, email addresses, and long digit sequences. Ordinary free text may still contain Personal Data. | United States (OpenRouter routes prompts to model providers that may process in the United States or other regions) |

## Infrastructure and CDN providers

We treat the providers above — including Cloudflare in its role storing and queuing the raw webhook payloads you send to Axel — as Sub-processors because they may process Customer Data, including Personal Data, on our behalf.

A vendor is treated as infrastructure (not a Sub-processor) only where it transmits Customer Data in transit without storing it and without accessing payload contents for any independent purpose — for example, network-level content delivery, edge routing, and DDoS mitigation. Cloudflare is listed above because it stores and queues raw payloads. We do not rely on the infrastructure category to exclude any vendor that stores, or has access to the content of, Customer Data. If any such vendor begins processing Personal Data on our behalf, we will add it to the table above and notify Customers in accordance with the section below.

## How we notify of changes

We may add, replace, or remove Sub-processors as the Service evolves. When we do, we will update this page and revise the "Last updated" date.

We will provide notice of new or replacement Sub-processors in accordance with our [Data Processing Addendum](https://axelapp.ai/dpa). As set out in Section 5.3 of the DPA, we will give notice at least 30 days before a new or replacement Sub-processor begins processing Personal Data (that is, pre-engagement). The notice period, notification method, and your objection rights are governed by the DPA, which is the controlling source for these figures.

Until a subscription mechanism is available, we will notify the primary account/billing contact of each Workspace by email of new or replacement Sub-processors, and we will update this page. This default applies except where the DPA specifies otherwise, in which case the DPA controls.

Your rights to object to a new or replacement Sub-processor, and the process and timing for raising and resolving an objection, are governed by the [Data Processing Addendum](https://axelapp.ai/dpa). Please refer to the DPA for the controlling terms.

If you have questions about this page or our use of Sub-processors, contact us at **privacy@axelapp.ai**.
