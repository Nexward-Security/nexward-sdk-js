# Nexward SDK for JavaScript and TypeScript

Source of [`@nexward/sdk`](https://www.npmjs.com/package/@nexward/sdk): runtime security for AI
agents. Your code asks Nexward before an agent uses a tool; Nexward answers ALLOW, BLOCK, or
REQUIRE_APPROVAL, and the SDK runs the tool only on ALLOW, at most once.

- Usage: [`packages/sdk/README.md`](packages/sdk/README.md) and <https://nexward.ai/docs/api>
- `packages/sdk`: the SDK. `packages/types`: the API contract schemas it bundles.
- Releases are built and published by GitHub Actions with npm provenance.

This repository is exported from the Nexward platform; pull requests are read but changes are
made upstream. Licensed under the Apache License 2.0 (see `LICENSE` and `NOTICE`).
