# 2026-10-28 | Officebot quickstart | A synthetic proposal

## Offline first

Use Node.js 24 (tested with 24.8.0) and npm. Vite 7 requires Node.js 20.19+ or 22.12+; Node 24 is recommended for this app and its `node:sqlite` use. Git and npm are needed for bounded improvement checks. From the release directory:

```sh
npm ci --ignore-scripts
npm run build
npm start
```

Visit [http://localhost:4317](http://localhost:4317). The interface labels are currently Korean. Open **데모 시나리오** → **샘플 업무 열기**. The sample gathers the request, quote wait, policy, mock Jira item, and a correction from Friday to Thursday. The first draft waits for a quote. Select **6. 견적 도착**, then **목표 한 단계 진행**. Review the updated draft and pending actions in **승인함**. Approval produces only local mock effects.

```sh
npm test
npm run typecheck
npm run privacy:audit
```

The app stores runtime data locally in SQLite. Stop the app before handling its data files. `.env.example` is a reference only and is not loaded automatically; set values in the relevant process environment. See [privacy](2026-10-28--officebot--privacy.md) before sharing anything.

## Optional OpenAI

With informed consent for the data you enter, set `OPENAI_API_KEY` and `WORK_ASSISTANT_ENGINE=openai` in the app process environment, then run `npm start`. Alternatively, set the key and run `npm run start:openai`. Set secrets in your process environment, never in committed files. This mode sends relevant inputs and context to OpenAI and may incur charges. Agent tracing is disabled by default; `OPENAI_AGENTS_TRACING=1` changes that setting. Shared actions remain mock.

## Optional Discord

Discord connects to a real service. Configure `DISCORD_BOT_TOKEN`, `DISCORD_BOT_ID`, `WORK_ASSISTANT_DISCORD_OWNER_ID`, `WORK_ASSISTANT_DISCORD_GUILD_ID`, `WORK_ASSISTANT_DISCORD_CHANNEL_ID`, and `WORK_ASSISTANT_DISCORD_BRIDGE_TOKEN` (at least 32 characters). The bot also requires `OPENAI_API_KEY`. Configure matching scope and bridge values in both app and bot processes, keeping tokens and keys private, and start the app before `npm run discord`. Configure the bot and its access separately in Discord. Messages and identifiers may be sent to or stored by Discord and locally; replies also send relevant context to OpenAI.

Startup catch-up is disabled by default. Set `WORK_ASSISTANT_DISCORD_CATCHUP=1` in the bot process to opt in to bounded recent-message catch-up. Missing or invalid scope produces `discord_scope_missing_or_invalid`; missing bot or OpenAI credentials produces `discord_credentials_missing`. Use only a dedicated, consented test scope and synthetic content.
