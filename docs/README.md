# Documentation

Guides (planned work: see [ROADMAP](../ROADMAP.md)):

- [`installation.md`](installation.md) — prerequisites, step-by-step deployment to AWS, seed data,
  configuration overrides, troubleshooting
- [`api.md`](api.md) — Search API: base URL, access modes and API keys, rate limiting, languages,
  filters, pagination, error codes, request/response examples per endpoint
- [`mcp.md`](mcp.md) — MCP server for AI agents: tools, transport, errors, JSON-RPC examples,
  client configuration (Claude Code, Claude Desktop, `mcp-remote`, TypeScript SDK)
- [`management-api.md`](management-api.md) — Management API: authentication, permission matrix
  per role and machine access, end-to-end machine-access example, import modes
- [`known-issues.md`](known-issues.md) — open concerns and known gaps of the listing management, to
  review before a release
- [`connectors.md`](connectors.md) — built-in connectors, writing and registering a connector
  (`connectors.json`), secrets, PII allowlist, crawler compliance, run log, troubleshooting
- [`configuration.md`](configuration.md) — theming (`theme-config.json` values, formats, defaults),
  translations and locales, property taxonomy, 3D tour providers

Admin CLI and Admin API: [`packages/admin/README.md`](../packages/admin/README.md). Visual style of
the frontend: [`design/README.md`](design/README.md). The full design lives in the
[specification](../.kiro/specs/real-estate-platform/).
