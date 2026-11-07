# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project specification: requirements, design and implementation plan.
- Open-source project scaffolding: license, roadmap, contribution guidelines, code of conduct, security policy, issue and PR templates.
- Test tiers and areas: `npm test` is a quick tier (no `infra`, property tests capped at 10 runs), `npm run test:full` runs everything (CI), `npm run test:<area>` runs one functional area, `npm run verify` is the final check. `AGENTS.md` for AI coding agents.
- `./run-everything.sh`: one command that installs, lints, type-checks, builds, runs all tests, synthesizes the CDK stacks and smoke-tests the local demo, with a PASS/FAIL/SKIP summary; fetches the pinned Node.js if needed.

### Fixed

- `tsc -b` failed on a fresh checkout because `tsconfig.tsbuildinfo` files were committed without their `dist/`; build info now lives in `dist/` and is git-ignored.

### Changed

- Node.js `engines` raised to `^22.22.3 || ^24.15.0 || >=26.0.0` (Angular CLI); added `.nvmrc`.
