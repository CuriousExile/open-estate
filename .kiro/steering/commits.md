# Commit Workflow

- Commit after every completed task (spec sub-task or top-level task), not in one batch at the end.
- One logical change per commit; stage files explicitly, never `git add -A`.
- Conventional Commits: `feat(<package>): …`, `fix(<package>): …`, `docs: …`, `test: …`, `chore: …`.
- Run `npm run lint` and the affected tests before committing; never skip hooks.
- Use the identity from the local git config. Do not push unless asked.
