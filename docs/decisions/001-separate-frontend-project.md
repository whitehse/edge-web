# ADR-001: Separate edge-web frontend project

## Status

Accepted

## Date

2026-07-28

## Context

The operator UI lived under `edgehost/spa/`, mixed with server code, ADRs, and
SQL. Browser interaction redesign needs its own documentation and decision
log without overloading the edgehost track. Data-exchange rules (CPE ↔ DB ↔
browser) were scattered across guides.

## Decision

1. Create sibling repo **`edge-web`** with document root **`public/`**
   (contents formerly `edgehost/spa/`).
2. edgehost serves the tree via existing **`spa.root`** (lab default
   `../edge-web/public`).
3. Product/UI ADRs live in **`edge-web/docs/decisions/`**.
4. Data-exchange contracts live in **`edge-web/docs/interfaces/`**, with a
   server-side mirror/index under **`edgehost/docs/interfaces/`**.
5. Wire implementation (C handlers, SQL DDL) remains in **edgehost** and
   **netforensics**.

## Consequences

- UI redesign can proceed with clear ownership and docs.
- Lab scripts must resolve `EDGE_WEB_ROOT` / `spa.root` to the sibling tree.
- Deploy installs static files from edge-web (or a release artifact), not from
  inside the edgehost git tree.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Keep SPA inside edgehost | Couples browser redesign to server release narrative |
| npm monorepo with bundler now | Unnecessary for current static lab; optional later ADR |
| Separate CDN-only host | Still need edgehost for auth + WS in lab/prod topology |
