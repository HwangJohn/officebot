# Contributing

Use synthetic fixtures only. Do not submit private conversations, logs, databases, screenshots, identifiers, credentials, or real business records. Explain the behavior and the reason for your change in an issue or pull request; keep changes focused.

Install and check locally with `npm ci --ignore-scripts`, `npm run build`, `npm test`, and `npm run typecheck`. Describe the checks you ran and any limitations. See the [privacy checklist](docs/2026-10-28--officebot--privacy.md) before sharing a fork.

Real business integrations are a possible future project, not shipped capability. An approximately four-week planning horizon would need explicit decisions about scoped permissions, consent, data retention, authentication, and safe shared effects before implementation.
