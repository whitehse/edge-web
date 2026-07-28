# ADR-005: Browser auth UX (multi-page)

## Status

Accepted

## Date

2026-07-28

## Context

edgehost supports three auth modes (ADR-013): `open`, `lab_password`, and
`proxy_headers`. The SPA is multi-page static HTML. Operators were unclear
where to sign in and whether each page had its own session.

## Decision

1. **Single sign-in surface:** only **Home** (`/`) shows a lab password form.
2. **All other app-shell pages** call `EdgeShell.requireAuth()`:
   - If `GET /auth/me` succeeds → proceed.
   - Else redirect to `/?next=<return-path>` (absolute path only).
3. **Map** (`/map/`) uses the same rule in `map_boot.js` (no app-shell).
4. **Modes:**
   | Mode | Browser behavior |
   |------|------------------|
   | `lab_password` | Cookie `edge_session` after Home login; protected APIs need cookie |
   | `proxy_headers` | No password UI; identity from signed proxy headers; `/auth/me` works when proxy is correct |
   | `open` | Lab only; `/auth/me` succeeds without cookie; gate skipped |
5. **Do not** duplicate login cards on telemetry pages (shell hides legacy ones).
6. Session cookie is HttpOnly/server-side; SPA only probes `/auth/me`.

## Consequences

- Deep links to `/graphs/?router_id=…` survive via `next=` after login.
- Production IdP terminates at reverse proxy; SPA stays mode-agnostic.
- Mobile / ecoec clients may use the same `/auth/me` contract later.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Login form on every page | Fragmented UX; harder to theme |
| SPA-only client token store | Duplicates edgehost cookie security model |
| Always require lab_password in UI | Breaks `open` and `proxy_headers` labs |
