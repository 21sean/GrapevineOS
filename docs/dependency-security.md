# Dependency security review

Reviewed for v0.8.0 on 2026-11-08. Audit results describe known dependency
advisories, not a guarantee that the application has no vulnerabilities.

## JavaScript

The release updates the npm lockfile, including patched MCP transports,
redirect handling, request parsing, image processing, command quoting, and
development tooling. The LangChain override matches the updated graph packages.
The minimatch override uses the patched 11.x line; lint, build, and tests must pass
with that override.

The application used the shadcn package only for its stylesheet. That stylesheet
is now vendored with its MIT license, removing the unused CLI and its vulnerable
deepmerge dependency without changing the existing component styles.

Run `npm audit` from the repository root to check the complete lockfile.
The README badge uses Shields.io to display the npm audit workflow status.
A passing check means zero known npm vulnerabilities at the time of that run,
including development dependencies. It runs on pull requests, main pushes, and
daily. It does not claim zero Python advisories or zero application vulnerabilities.

## Python evaluation dependencies

pytest is upgraded to at least 9.0.3 to address
[CVE-2025-71176](https://github.com/advisories/GHSA-6w46-j5rx-g56g).

Two advisories remain in the optional `eval` dependency group. Neither has an
upstream patched version listed at review time; they are not suppressed or
represented as fixed:

- [DiskCache unsafe pickle deserialization](https://github.com/advisories/GHSA-w8v5-vhqr-4h9v)
  affects diskcache 5.6.3, pulled in by Ragas. Exploitation requires writing to a
  cache directory that a victim subsequently reads. Grapevine does not instantiate
  a disk cache or use Ragas's `DiskCacheBackend`.
- [Ragas multimodal SSRF](https://github.com/advisories/GHSA-95ww-475f-pr4f)
  affects the installed Ragas 0.3.9. Grapevine uses only `SingleTurnSample`,
  `IDBasedContextPrecision`, and `IDBasedContextRecall` over reviewed string IDs.
  It does not pass context content to multimodal metrics or load context files or
  URLs. The Python runtime also denies non-loopback sockets before importing
  evaluator dependencies. That network restriction alone does not protect local
  files or loopback services; keeping multimodal evaluation unused is essential.

The retrieval regression test denies all socket connections and disk-cache
construction while scoring IDs, including URL-shaped strings. Enabling disk
caching or multimodal metrics requires revisiting these advisories first.

To reproduce the Python audit, export the frozen lockfile with all groups and
pass it to pip-audit:

```bash
uv export --directory llm --frozen --all-groups --no-hashes --no-emit-project --output-file requirements-audit.txt
uvx pip-audit -r requirements-audit.txt --no-deps --disable-pip
```
