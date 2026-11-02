# Roadmap

This roadmap reflects current intent, not a promise. Priorities may shift based on feedback — open an issue or discussion if something matters to you.

Task numbers refer to the implementation plan in [`.kiro/specs/real-estate-platform/tasks.md`](.kiro/specs/real-estate-platform/tasks.md).

## v0.1 — Foundation

- [ ] Monorepo scaffold (`packages/*`, `infra/`), TypeScript strict, lint, test setup (task 1)
- [ ] Shared `Listing` model, API types and error codes (task 1)
- [ ] `ConfigProvider` with fail-fast validation, `RunLogger` (task 2)
- [ ] Listing validator and normalizer (task 3)
- [ ] CI pipeline (lint, test, build) on GitHub Actions

## v0.2 — Agent-first Search API

- [ ] `SearchProvider` abstraction with in-memory and DynamoDB implementations (task 4)
- [ ] Input validation, search/listing services, response serializer (task 6)
- [ ] Lambdas: `GET /listings`, `GET /listings/{id}`, `GET /openapi.json` (task 7)
- [ ] CDK stacks: DynamoDB, API Gateway with request validation (task 13.1)

## v0.3 — Connectors

- [ ] Connector interface, registry and framework (task 8)
- [ ] Reference connectors: relational DB, external REST API
- [ ] Scheduled ingestion via EventBridge Scheduler + Step Functions (task 13.2)

## v0.4 — Compliance-first Crawler

- [ ] Compliance checker: allow-list, `robots.txt`, path rules (task 10.1)
- [ ] Crawler connector with per-site rate limiting and audit log (task 10.4)

## v0.5 — White-label Frontend

- [ ] Runtime theme loading via `theme-config.json` (task 11.1)
- [ ] Search form, result list, listing detail (task 11)
- [ ] S3 + CloudFront hosting stack (task 13.3)

## v1.0 — Production-ready

- [ ] Optional OpenSearch provider (task 4.7)
- [ ] Config wiring via SSM / Secrets Manager, downstream timeouts (task 13.4)
- [ ] Installation, API, connector and theming docs (task 14)
- [ ] One-command deploy into an empty AWS account, verified end to end
- [ ] Semantic versioning and published releases

## Ideas / later

Not planned yet, but likely useful. Upvote or discuss in issues.

- MCP server exposing the search API as agent tools
- Geo search (radius / bounding box) and map view in the frontend
- Frontend i18n (multiple languages from config)
- API authentication options (API keys, Cognito) and usage plans
- Listing images and media storage
- Terraform module as an alternative to CDK
- Additional connector packages maintained by the community
