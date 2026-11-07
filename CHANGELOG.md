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

- Dry run of removing a Plattform_Admin could answer `LAST_PLATFORM_ADMIN` for an admin that a concurrent request had just removed; it now re-reads the membership (fast-check seed 713905340).

- `tsc -b` failed on a fresh checkout because `tsconfig.tsbuildinfo` files were committed without their `dist/`; build info now lives in `dist/` and is git-ignored.

### Changed

- Node.js `engines` set to `^22.12.0 || >=24.0.0` (was `>=20.19.0`, which the Angular CLI never supported); `.nvmrc` pins 22.21.0, the version the checks are tested with.
- Frontend on Angular 21.2 (was 22.2) and TypeScript 5.9 (was 6.0): Angular 22 refuses Node below 22.22.3, and Angular 21 needs TypeScript < 6.0. Templates no longer read `private` members.
- Every dependency pinned to a release at least four weeks old and the lockfile regenerated with `npm install --before=2026-10-10`, so `npm ci` works from registry mirrors that lack recent versions.
