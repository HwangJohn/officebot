# 2026-10-28 | Officebot privacy | Local data and sharing

The public checkout excludes private runtime artifacts and private history. It excludes existing screenshots, logs, databases, actual identifiers, and `.env` files; `.env.example` is an empty-placeholder reference, and the SVG illustrations are newly created. Original local records are retained separately. Review the exact files and history before sharing; these checks are heuristic and cannot guarantee complete anonymization or the absence of secrets.

Officebot is not an anonymization engine. Runtime users create private local SQLite data that can include identifiers, events, evidence, goals, approvals, and conversations. Protect the machine and data files, and decide your own retention and deletion practices. Offline mode does not require an OpenAI or Discord connection. With OpenAI enabled, relevant inputs and context are sent to OpenAI; with Discord enabled, messages and identifiers are exchanged with Discord and may be stored locally. Discord replies using OpenAI also send relevant context to OpenAI. Use live modes only with consent and data you are authorized to share.

The app is a local single-user prototype, not an authenticated internet-facing SaaS. Keep it on loopback; do not expose the local API to a network. Synthetic Outlook, Teams, Jira, and Confluence connectors cannot access real accounts or send real business changes.

## Before sharing a fork

- Use synthetic fixtures and examples only; review code, documentation, screenshots, and generated files for identifiers and private content.
- Exclude runtime databases, SQLite sidecars, logs, backups, exports, environment files, credentials, conversation history, and local artifacts from the shared tree and its history.
- Inspect the exact files and history being shared; ignore rules alone do not remove already tracked data.
- Run `npm run privacy:audit` as a supplemental heuristic. In a standalone Git repository it examines tracked and staged paths and rejects prohibited runtime paths; before initialization it scans the publishable source allow-list and respects the export's ignore rules. It also scans tests, but cannot prove that a release is free of sensitive data.
- Keep API keys and Discord tokens in process environments, never in committed files or public issues. Check optional integration settings and obtain consent before live use.
- If sensitive material was shared, follow the relevant provider's credential rotation and incident response procedures; deleting a local copy alone does not retract published history.
