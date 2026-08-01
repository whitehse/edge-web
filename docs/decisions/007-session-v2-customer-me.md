# ADR-007: Session v2, customer mint, and /api/v1/me/* projectors

## Status

Accepted

## Date

2026-08-01

## Context

Interface redesign requires customer principals with `account_id` / `router_ids`,
lab e2e without weakening admin lab login, and server-enforced map privacy.

## Decision

1. **Session payload v2** via `edge_auth_session_issue_ex` may carry `account_id`
   and `router_ids[]`. Legacy v1 cookies (sub/roles/exp only) still verify.
2. Cookie / host buffers grow to `EDGE_AUTH_COOKIE_MAX` / `COOKIE_HDR_MAX` (2048).
3. **`GET /auth/me`** is role-generic (roles JSON + account_id + router_ids).
4. **`POST /auth/lab-customer-login`** uses the same lab password but issues
   **customer-only** claims (K11). Default **`POST /auth/lab-login`** remains
   employee + employee_admin.
5. Customer APIs live under **`/api/v1/me/*`**, gated by `features.customer_api`
   (404 FEATURE_DISABLED when off) and RBAC `CUSTOMER_*` resources.
6. Map neighbors are projected at Tap geometry; responses never include other
   members’ GPS, FSAN, account, or raw `tap_id`.

## Consequences

- edge-web member portal (`/portal/`) and mobile can share contracts.
- Inventory fixture needs `tap_id` for multi-neighbor lab demos.
