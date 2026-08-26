/**
 * AXE-33 + audit-Sev1 — HTTP destination auth-header expansion.
 *
 * The implementation moved to @axel/shared so the Cloudflare delivery-edge
 * runtime applies the SAME expansion as this Node service (audit critical:
 * edge http deliveries were going out unauthenticated). This file stays as a
 * stable import surface for delivery-service callers + the existing unit tests.
 */

export { buildHttpAuthConfig, isSafeHeaderName, isSafeHeaderValue } from "@axel/shared";
