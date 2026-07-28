# Data-exchange interfaces

These documents define **how data moves** between the CPE agent, databases,
edgehost, and the browser. They are the contracts the UI redesign should
assume; change them deliberately (and update edgehost / cpe_agent when the
wire changes).

| Doc | Scope |
|-----|--------|
| [OVERVIEW.md](OVERVIEW.md) | End-to-end plane, ports, principles |
| [cpe-agent.md](cpe-agent.md) | CPE agent ↔ ClickHouse / Postgres (via proxies) |
| [postgres-notify.md](postgres-notify.md) | Postgres current state + NOTIFY → browser |
| [clickhouse-subscribe.md](clickhouse-subscribe.md) | ClickHouse history/series → periodic browser updates |
| [browser-api.md](browser-api.md) | REST + WebSocket surface the SPA uses |

**Principle:** the browser never opens database ports. All subscribe/notify
traffic uses **WebSockets** to edgehost. REST is for bootstrap, one-shots, and
commands.
