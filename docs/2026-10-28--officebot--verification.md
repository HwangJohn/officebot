# 2026-10-28 | Officebot verification | Public export

The public export was checked on Windows with Node.js 24.8.0 and npm 11.6.0. The following checks passed after the dependency update:

- `npm install --ignore-scripts` for the updated dependencies; `npm run typecheck` and `npm run build`.
- `npm test`: 180 passed, none failed or skipped. This includes offline privacy-audit regression tests.
- `npm run privacy:audit`: passed the pre-initialization source scan. The tests also simulate standalone Git index cases.
- `npm audit --json` and `npm audit --omit=dev --json`: zero reported vulnerabilities in each result at the time of the check.
- Discord startup with an empty process environment, and with synthetic scope but no credentials, returned the expected missing-configuration errors without contacting Discord.

The controller independently checked a synthetic browser flow: the corrected deadline was 2026-10-29, the quote had a 12% discount, and the draft was saved. Two approvals were pending with no effects before approval; GUI approval returned HTTP 200 and produced one mock effect, leaving one approval pending. Desktop (1440 px) and mobile (390 px) had no overflow, page errors, or failed responses; the local SVG route returned HTTP 200.

The controller reviewed the 100 staged source files for original Discord identifiers, private paths, credential literals, and private email addresses and found none. The publisher must scan and review the exact release commit and its history as a release gate. These checks are heuristic, not proof that a release contains no sensitive information. Live OpenAI and Discord connections were not retested. See the [CI workflow](https://github.com/HwangJohn/officebot/actions/workflows/ci.yml) for its current status; a GitHub CI result is not yet available.
