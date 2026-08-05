# ADR-009: Operator shell typography (Inter + JetBrains Mono)

## Status

Accepted — 2026-08-04

## Context

The main-window type stack mixed **Instrument Serif** display with **Plus
Jakarta Sans**, plus a wide utility scale down to 10px. That read as marketing
UI and felt uneven in dense ops surfaces (tables, toolbars, Call Home).

## Decision

1. **Main window (signed-in shell):**
   - UI: **Inter** (optical size axis when available)
   - Data: **JetBrains Mono**
   - `--font-display` **aliases** `--font-ui` (no serif in shell)
2. **Login gate only:** `--font-login` may keep Instrument Serif for the welcome
   line; body copy on the gate still uses Inter.
3. **Semantic scale** (16px root, floor 12px):

   | Role | Size | Use |
   |------|------|-----|
   | caption | 12px | chips, table headers, meta |
   | label | 13px | form labels, overlines (uppercase) |
   | body-sm | 14px | secondary, dense lists |
   | body | 16px | default |
   | title-sm | 15px | panel / card titles |
   | title | 18px | section titles |
   | page | 22px | topbar page title |
   | metric | 26px | KPIs; tabular-nums; Inter medium/semibold |

4. Prefer **weight + color + decoration** for hierarchy and active state; do not
   enlarge type to emphasize selection.
5. Classes: `.type-caption` … `.type-metric`. Legacy `.t-*` aliases map onto
   the same tokens (no sub-12px).

## Consequences

- One sans across chrome and content; mono reserved for IDs, keys, logs.
- Less dramatic scale → denser, more even ops feel.
- Login remains slightly atmospheric without polluting the tool UI.
