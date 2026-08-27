# Scalivo

WhatsApp-native booking, CRM, retention, and marketplace for service SMEs.

Team: Muhammad Mahad Ghauri (233523) · Mahateer Muhammad (233539)
Supervisor: Sir Rashaf Jamil · Air University Multan Campus

## Getting started

```sh
pnpm install
pnpm infra:up                          # mongo (rs0) + redis + postgres
cp backend/.env.example backend/.env   # then fill it in
pnpm --filter @scalivo/shared build
pnpm dev                               # backend on :3000
curl localhost:3000/health
```

`pnpm infra:up` starts Mongo as a **single-node replica set**. That is not
cosmetic: booking writes use transactions, and a standalone mongod fails every
one of them. The backend refuses to boot without it.

WhatsApp itself is not in this compose file. OpenWA is stateful and lives on the
VPS; for local work, run the spike stack in `../open-wa` and point
`OPENWA_BASE_URL` at it.

## Layout

| Path | What |
|---|---|
| `shared/` | The API contract — types and constants imported by backend and web |
| `backend/` | Node.js + Express. All clients call this one API |
| `web/` | Next.js — marketplace, business profiles, customer PWA (Phase 2) |
| `app/` | Flutter owner/staff app (scaffolded Phase 1.1) |
| `docs/` | Project plan, feature spec, execution plan, FSM design, data model |

## Things that will bite you

These are measured findings from the OpenWA spike (`../open-wa/NOTES.md`), not
theory. Each one contradicts something a reasonable person would assume.

1. **Inbound messages carry no phone number.** `data.from` is an opaque `@lid`.
   The phone comes from `data.senderPhone`, which only exists when OpenWA runs
   with `RESOLVE_LID_TO_PHONE=true`. Always store the LID alongside.
2. **A phone-side unlink never emits `disconnected`.** It goes straight to
   `qr_ready`. Session Health alarms on an *unsolicited* `qr_ready` — see
   `shared/constants/session-status.ts`.
3. **A successful send response does not mean delivered.** Only a `message.ack`
   reaching `delivered` does.
4. **Webhook delivery is at-least-once.** Dedupe on the
   `X-OpenWA-Idempotency-Key` header, never on `deliveryId`.
5. **The booking arbiter is `slotOccupancy`, not `bookings`.** One row per grid
   increment. A unique index on start time alone misses overlaps.

## Development plan

Phase 0 (foundation) and Phase 1 (booking loop) are planned in detail; see
`docs/`. Build order within Phase 1 is deliberate: **Session Health before
booking, slot locking before the FSM.**
