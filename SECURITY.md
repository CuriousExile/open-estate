# Security Policy

## Supported versions

OpenEstate is pre-1.0. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

**Please do not report security issues in public issues, discussions or pull requests.**

Use GitHub's [private vulnerability reporting](https://github.com/CuriousExile/open-estate/security/advisories/new) instead. Include:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected component (API, connector, crawler, frontend, infrastructure) and version/commit.

You can expect an acknowledgement within 7 days. We will keep you informed while we work on a fix and credit you in the advisory unless you prefer to stay anonymous.

## Scope notes

- The public search API is read-only and unauthenticated by default. Deployers who need access control should enable API Gateway authorization or usage plans.
- Credentials for data sources belong in AWS Secrets Manager, never in configuration files or the repository.
- A crawler that ignores `robots.txt`, the allow-list or rate limits is treated as a security bug.
