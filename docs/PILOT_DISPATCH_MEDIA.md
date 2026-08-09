# Pilot Dispatch + Media Runbook

This runbook covers the pilot-usable dispatch and quote/job media flow for MBS.

## 1) Start stack (MinIO + API + Worker + Web)

```bash
cp .env.example .env
# Fill MINIO_ROOT_USER / MINIO_ROOT_PASSWORD / S3_ACCESS_KEY / S3_SECRET_KEY in .env

docker compose up -d --build
npm run db:migrate:deploy
npm run db:seed
```

MinIO services:
- API endpoint: `http://localhost:9000`
- Console: `http://localhost:9001`
- Bucket is auto-created by `minio-init` (`S3_BUCKET`, default `mbs`)

## 2) Dispatch day view

Internal route:
- `/dispatch`

Behavior:
- Time-block rows with INSTALL and SERVICE_ESTIMATE counts
- Capacity = defaults (2/2) or throttle capacity (1/1) based on org settings
- Assignment/reschedule/cancel actions call ToolRegistry-governed API routes

### Dispatch API curls

```bash
# Day snapshot
curl "http://localhost:3001/api/dispatch/day?date=2026-02-22&email=admin@russellcomfort.com"

# Toggle install throttle on
curl -X POST "http://localhost:3001/api/scheduling/settings?email=admin@russellcomfort.com" \
  -H "Content-Type: application/json" \
  -d '{"throttleInstallEnabled":true}'

# Toggle service throttle on
curl -X POST "http://localhost:3001/api/scheduling/settings?email=admin@russellcomfort.com" \
  -H "Content-Type: application/json" \
  -d '{"throttleServiceEnabled":true}'
```

## 3) Media upload/list/share/delete

State-changing calls use ToolRegistry tools:
- `media.photo.upload`
- `media.setPublic`
- `media.delete`
- `admin.media.purgeExpired`

All media writes are audited and outbox-backed.

### Upload photo (quote/job)

```bash
curl -X POST "http://localhost:3001/api/media/photos?email=admin@russellcomfort.com" \
  -F ownerType=QUOTE \
  -F ownerId=<quoteId> \
  -F tag=AFTER \
  -F caption="Post-install photo" \
  -F file=@/absolute/path/to/photo.heic
```

HEIC/HEIF uploads are normalized to JPEG and derivative variants are generated:
- `original.jpg` (normalized)
- `display.jpg` (max 2048)
- `thumb.jpg` (max 512)

Object key pattern:
- `org/<orgId>/<yyyy>/<mm>/<attachmentId>/original.jpg`
- `org/<orgId>/<yyyy>/<mm>/<attachmentId>/display.jpg`
- `org/<orgId>/<yyyy>/<mm>/<attachmentId>/thumb.jpg`

### List quote/job media

```bash
curl "http://localhost:3001/api/quotes/<quoteId>/media?email=admin@russellcomfort.com"
curl "http://localhost:3001/api/jobs/<jobId>/media?email=admin@russellcomfort.com"
```

### Stream media file (auth required)

```bash
curl -L "http://localhost:3001/api/media/<attachmentId>/file?variant=thumb&email=admin@russellcomfort.com" -o thumb.jpg
curl -L "http://localhost:3001/api/media/<attachmentId>/file?variant=display&email=admin@russellcomfort.com" -o display.jpg
curl -L "http://localhost:3001/api/media/<attachmentId>/file?variant=original&email=admin@russellcomfort.com" -o original.jpg
```

### Share/unshare quote media publicly

```bash
curl -X POST "http://localhost:3001/api/media/<attachmentId>/public?email=admin@russellcomfort.com" \
  -H "Content-Type: application/json" \
  -d '{"isPublic":true}'
```

### Delete media

```bash
curl -X DELETE "http://localhost:3001/api/media/<attachmentId>?email=admin@russellcomfort.com" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Removed duplicate photo"}'
```

## 4) Public quote media visibility

Public route:
- `GET /public/quotes/:token`

Public media rule (v1):
- Only attachments where `ownerType=QUOTE` and `isPublic=true` are included
- Job photos are never exposed on quote public page

## 5) Retention + purge

Default retention:
- `expiresAt = createdAt + 365 days` on `media.photo.upload`

Worker:
- Daily purge runs via `admin.media.purgeExpired`
- Deletes storage objects and marks DB rows `deletedAt`
- Emits `media.purged` and `media.purge.daily.completed`

Manual purge:

```bash
curl -X POST "http://localhost:3001/api/admin/media/purge-expired?email=admin@russellcomfort.com" \
  -H "Content-Type: application/json" \
  -d '{"limit":200}'
```

## 6) Test commands

```bash
npm run typecheck
npm run test -w @rcs/tool-registry
npm run test -w @rcs/api
```
