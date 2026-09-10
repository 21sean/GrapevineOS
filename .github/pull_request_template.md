## Why

What a reviewer should believe after reading this, in a sentence or two. Link the issue if there is one.

## What changed

-

## How I checked

CI runs typecheck, lint, format, tests, the contract check, and the five offline eval suites. Call out anything that is not covered by that, or any suite you ran by hand.

- [ ] `npm test` (or the CI job) is green
- [ ] New behavior has a unit test or an offline eval case when it is deterministic
- [ ] Generated files were rebuilt (`npm run contracts:gen` / `npm run db:types -w server`) if a contract or migration changed
- [ ] Docs match the code that exists (README, `docs/setup.md`, `docs/agent-architecture.md`)

## Risk

Migrations, auth, secrets, the admin gate, or a change in what leaves the machine. Write "none" if none of those moved.
