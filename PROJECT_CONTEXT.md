# Scalivo — Project Context

_Snapshot as of 26 Nov 2026 (last commit `70d5fbf`, 24 Nov 2026). Verified against the code, not only the docs._

> ⚠️ `docs/SCALIVO_IMPLEMENTATION_STATUS.md` is **stale**. It lists Retention, Grow, AI Agent,
> Customer PWA and Free-text booking as "missing", but all of them have since been built
> (see git log). Trust this file or the code over that doc.

## 1. What it is

WhatsApp-native booking, CRM, retention and marketplace for service SMEs (salons, clinics, gyms).
Final-year project, Air University Multan. Customers book over WhatsApp (via self-hosted OpenWA) or the web;
owners manage everything from a Flutter app and a Next.js dashboard.

## 2. Repo layout & stack

| Path | What | Stack |
|---|---|---|
| `shared/` | API contract: types + constants used by backend & web | TypeScript |
| `backend/` | The single API all clients call | Node 22, Express, Mongoose (Mongo replica set), Redis, Postgres, Luxon, Vitest |
| `web/` | Marketplace, business profiles, owner dashboard, customer `/me` page, `/pay` | Next.js (App Router, RSC, server actions) |
| `app/` | Owner/staff mobile app | Flutter + Firebase (FCM) |
| `docs/` | Plan, feature spec, execution plan, FSM design, booking-flow notes (**git-ignored, private**) | — |
| `../open-wa/` | OpenWA WhatsApp gateway spike: docker stack, scripts, findings (`NOTES.md`) | NestJS (upstream) |

Monorepo: pnpm workspaces. CI: `.github/workflows` (backend-ci runs Mongo/Redis/Postgres + tests in two TZs; app-ci runs `flutter analyze/test`).

**Run locally**
```sh
pnpm install
pnpm infra:up                          # mongo (rs0) + redis + postgres
cp backend/.env.example backend/.env   # fill in (incl. GEMINI_API_KEY, OPENWA_BASE_URL)
pnpm --filter @scalivo/shared build
pnpm dev                               # backend :3000
```
Backend scripts: `seed`, `link-session`, `evaluate`, `me-link` (customer magic-link token), `*:local` variants.

## 3. Core architecture decisions (don't break these)

- **Double-booking arbiter = `SlotOccupancy`** (one row per 15-min grid cell, unique `{businessId, staffId, slotStart}`), written in a Mongo transaction with the `Booking`. Redis `SET NX EX` holds reserve slots during confirmation. Resources/rooms use `CapacityOccupancy`.
- **Mongo must be a replica set**: transactions fail on standalone and the backend refuses to boot.
- **Messaging is behind a `MessagingProvider` interface**: `OpenWAProvider` (real), `MetaCloudProvider` (intentional stub), `FakeProvider` (tests).
- **Identity**: inbound WhatsApp gives an opaque `@lid`, and phone only arrives with `RESOLVE_LID_TO_PHONE=true`. Store LID + phone.
- **Webhooks** are HMAC-verified, at-least-once, deduped on `X-OpenWA-Idempotency-Key`, processed via an inbound queue.
- **Session Health**: an unsolicited `qr_ready` means the session dropped. Outbound messages buffer in Redis and the owner gets an FCM alert. "Sent" ≠ delivered; only an ack does.
- **Multi-tenancy**: `requireTenant()` scopes every query to `businessId`.
- Money in integer minor units; time stored UTC, converted at the edges per `business.timezone`.
- Gemini is only ever phrasing/parsing; everything **degrades to templates/menu FSM** if it is unavailable.

## 4. Data models (`backend/src/models/`)
User, Business, Client (global), ClientProfile (per-tenant CRM), Staff, Service, Resource, AppointmentHolder,
Booking, BookingAudit, SlotOccupancy, CapacityOccupancy, BlockedTime, SessionEvent, Notification,
Review, Campaign, FunnelDay, Briefing, FlowRun.

## 5. ✅ Implemented

**Phase 0 — Foundation**
- JWT auth + RBAC + tenant isolation (`backend/src/auth`), auth rate limiting, security headers
- Time utils, messaging abstraction, HMAC webhooks, inbound queue, contact address resolution
- Per-business gateway keys; WhatsApp session provisioning/registration, QR pairing

**Phase 1 — Booking loop**
- WhatsApp conversation FSM (`backend/src/whatsapp`): interceptors (global commands, pending prompts), Redis state + conversation locking, FlowRun records
- Session Health: monitor, history, FCM alert, reconcile cron, outbound queue (`backend/src/session-health`)
- Availability, holds, atomic create; reschedule (single path), cancel, rebook after cancel
- Services/staff/resources catalog with buffers/cleanup; whole-room vs bed/chair exclusivity enforced
- Onboarding provisioning + readiness checklist; register flow; add another business for an existing owner
- Self-populating CRM, tags, CSV bulk import, client detail
- Owner calendar, walk-ins, block time, change notifications
- Reminders/confirmations with deduped `Notification` claims
- Flutter app: login/register (animated), calendar, appointments, booking sheet, slot & client pickers, walk-in, block time, QR re-link, services, staff, resources, holders, clients + import, business profile, analytics, reviews, grow, poster, campaigns, briefings, push

**Phase 2 — Payments, retention, analytics, marketplace**
- Deposits + sandbox payments (JazzCash + simulated, ledger, settle) and web `/pay/[token]`
- Review requests/collection + dashboard
- Retention engine (`backend/src/retention`): audience, eligibility, caps/throttle, nudges, campaigns, attribution, report
- Grow module (`backend/src/grow`): QR poster, boost, funnel tracking
- Analytics report + dashboard
- Public marketplace: `/search`, `/[business]` profiles + story, JSON-LD, sitemap, robots, OG image
- Web dashboard: overview, calendar, appointments, customers, services, staff, campaigns, grow, reviews, briefings, analytics, settings, whatsapp, new business

**Phase 3 — AI & advanced (partially)**
- AI agent (`backend/src/agent`): facts → thresholds → Gemini phrasing w/ template fallback; daily briefing + Monday weekly summary; delivered over WhatsApp + push; Briefings screens
- Free-text booking via Gemini (`backend/src/whatsapp/fsm/intent.ts`) with menu FSM fallback
- Customer `/me/[token]` page (magic link, upcoming/past appts, one-tap rebook, loyalty points display, web manifest, noindex)
- Evaluation pipeline (`backend/src/evaluation`: metrics, uptime, report + `evaluate` script)

**Quality**: ~37 backend test files; last recorded run **799/799 passing** in UTC and America/New_York (21 Oct 2026, `TEST_RESULTS.md`). Lint, type checks and web prod build passed.

## 6. 🟡 Partial / unverified

- **Loyalty**: points are only *derived* (`shared/types/me.ts`, spend ÷ rate) and displayed. There are no owner-configurable milestones and no automatic rewards (3.5 DoD not met).
- **Multi-branch (3.7)**: an owner can hold multiple businesses. There is no true branch model (one business → many locations/staff).
- **Agent learning layer (3.4)**: no engagement tracking or adaptive frequency found.
- **Phase 1.9 Uxelerate live acceptance**: code exists, but every evidence row in `docs/phase-1.9-acceptance.md` is still **Pending** (real registration, dedicated number, real booking, unlink→alert→recovery, queued reminder ack, restart without rescan).
- Unverified per `FEATURES_ADDED.md`: interactive live WhatsApp booking conversations, physical-device push delivery, production load.
- Hosted GitHub Actions run not confirmed (changes not pushed at the time).
- `MetaCloudProvider` is a deliberate stub.

## 7. ❌ Not started / left

**Features**
- Google Calendar / iCal two-way sync (3.6)
- Stripe international cards (3.8, optional)
- **Calendar export / rollback story** (a Phase 5 gate requirement)
- Service/business image uploads & media storage
- Password / email recovery
- Treatment stages, partial equipment release, deposits for treatment sequences

**Phase 4 — Hardening**
- Load/perf testing of booking + session paths
- Formal security & privacy review (OpenWA scoped key + IP restriction, message-log privacy doc)
- SEO verification pass (most metadata/sitemaps are already in place)

**Phase 5 — Pilot & write-up** (gate: 1 month clean Uxelerate run, **two-session isolation proof**, 2 weeks correct reminders incl. one queued-through-outage, rollback/export)
- Pilot #1 Skinare, Pilot #2 CrossFit (PT + aerobics)
- Final acceptance re-run, data collection via `evaluate`, evaluation chapter, thesis + proposal chapter updates

## 8. Suggested next steps (priority)
1. Run Phase 1.9 live acceptance on Uxelerate and fill the evidence table.
2. Build the calendar export (cheap, and it blocks Phase 5).
3. Prove two-session isolation on one OpenWA instance.
4. Loyalty milestones/rewards → agent learning → multi-branch (if time).
5. Phase 4 load test + security review.
6. Update the stale `docs/SCALIVO_IMPLEMENTATION_STATUS.md`.

## 9. Key docs
`README.md` (gotchas) · `FEATURES_ADDED.md` · `TEST_RESULTS.md` · `MANUAL_TEST_CASES.md` ·
`docs/SCALIVO_EXECUTION_PLAN.md` (phases + DoDs) · `docs/SCALIVO_FEATURE_SPEC.md` · `docs/fsm-design.md` ·
`docs/booking-flow.md` · `docs/phase-1.9-acceptance.md` · `../open-wa/NOTES.md` · `graphify-out/GRAPH_REPORT.md`
