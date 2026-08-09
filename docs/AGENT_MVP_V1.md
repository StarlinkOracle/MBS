# Master Agent MVP v1 Runbook

This runbook covers the communications-first Master Agent MVP for MBS.

## What v1 does

- Ingests iMessage history from macOS `chat.db`.
- Ingests Gmail threads/messages (read-only sync).
- Links threads to CRM entities using deterministic phone/email rules.
- Creates governed outbound drafts.
- Requires human approval before send (`comms.draft.approveAndSend`).
- Supports inbox + draft workflows in internal web UI.

## Governance guarantees

- All state-changing operations run through `ToolRegistry.execute()` tools.
- Outbound send is never autonomous in v1.
- Approval queue is required before actual send.
- Existing policy + kill switch + audit + outbox remain enforced.

## Required macOS permissions (iMessage)

The process running API/worker/agent must have Full Disk Access to read:

- `~/Library/Messages/chat.db`

Steps:

1. Open `System Settings` -> `Privacy & Security` -> `Full Disk Access`.
2. Add the terminal/app that runs MBS (Terminal, iTerm, or your service launcher).
3. Restart the process after granting access.

If not granted, iMessage sync will fail with sqlite read errors.

## Gmail setup

v1 supports token loading by priority:

1. `GMAIL_ACCESS_TOKEN` env var.
2. `CommsAccount.syncCursor.accessToken` (if already persisted).
3. macOS Keychain lookup:
   - service: `GMAIL_KEYCHAIN_SERVICE` (default `mbs-gmail-oauth`)
   - account: `CommsAccount.externalAccountId`

Recommended: store OAuth token in Keychain for Mac mini runtime.

## Environment variables

Add to local `.env` (examples):

```bash
# iMessage
IMESSAGE_CHAT_DB_PATH=$HOME/Library/Messages/chat.db
IMESSAGE_SYNC_BATCH_SIZE=500
IMESSAGE_ACCOUNT_ID=owner-imessage
IMESSAGE_SEND_SHORTCUT_NAME=Send Message

# Gmail
GMAIL_ACCOUNT_ID=owner@russellcomfort.com
GMAIL_ACCESS_TOKEN=<oauth-access-token>
GMAIL_KEYCHAIN_SERVICE=mbs-gmail-oauth

# Agent/worker scheduling
COMMS_SYNC_INTERVAL_MS=300000
COMMS_AGENT_POLL_MS=20000
COMMS_MAX_PER_CONTACT_PER_DAY=5

# Local testing shortcuts
COMMS_SEND_STUB=true
COMMS_SKIP_TIME_WINDOW=true
```

## Running locally

```bash
docker compose up -d --build
npm run db:migrate:deploy
npm run db:seed
npm run dev
```

Start communications agent loop:

```bash
npm run start -w @rcs/agent -- comms-agent --org russell-comfort
```

## API quick checks

```bash
# iMessage sync (manual)
curl -X POST "http://localhost:3001/api/comms/sync/imessage?email=admin@russellcomfort.com" \
  -H "Content-Type: application/json" \
  -d '{"fullSync":true}'

# Gmail sync (manual)
curl -X POST "http://localhost:3001/api/comms/sync/gmail?email=admin@russellcomfort.com" \
  -H "Content-Type: application/json" \
  -d '{"fullSync":false}'

# List inbox threads
curl "http://localhost:3001/api/comms/threads?filter=NEEDS_TRIAGE&email=admin@russellcomfort.com"

# Create draft
curl -X POST "http://localhost:3001/api/comms/drafts?email=admin@russellcomfort.com" \
  -H "Content-Type: application/json" \
  -d '{"threadId":"<threadId>","channel":"EMAIL","to":[{"email":"customer@example.com"}],"bodyText":"Thanks for reaching out."}'

# Queue approval + send
curl -X POST "http://localhost:3001/api/comms/drafts/<draftId>/approve-send?email=admin@russellcomfort.com" \
  -H "Content-Type: application/json" \
  -d '{}'
```

## Internal UI

- Inbox: `/inbox`
  - filter: needs triage / linked / all
  - auto-link thread
  - create lead + link
  - create draft
- Drafts: `/drafts`
  - edit draft text
  - submit approval/send

## Troubleshooting

- `sqlite3: unable to open database file`:
  - confirm `IMESSAGE_CHAT_DB_PATH`
  - confirm Full Disk Access
- Gmail 401/403:
  - refresh OAuth token
  - verify account + token match
- Draft send blocked:
  - check time window/business hours
  - check per-day org and per-contact limits
  - check kill switch mode and policy decisions in execution logs
