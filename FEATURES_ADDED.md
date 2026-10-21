# Features added: booking-flow improvements

This guide covers the latest booking-flow rollout for Scalivo. Scalivo lets service
businesses manage appointments through the Flutter owner app and web dashboard,
while customers book through WhatsApp or the public booking site.

For hands-on validation, use the [manual test checklist](MANUAL_TEST_CASES.md),
including setup, steps, expected results, and a place to record each outcome.
The latest executed checks and remaining manual gaps are recorded in
[TEST_RESULTS.md](TEST_RESULTS.md).

These changes extend the existing booking engine. They do not introduce another
booking system or add new dependencies. The interfaces follow the existing app
and dashboard components.

## What changed and where to find it

| Feature                               | Owner app                                                                                   | Owner web dashboard                             | Customer experience                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| Rooms and equipment                   | Settings → Rooms & equipment                                                                | Services page                                   | Availability accounts for physical capacity                      |
| Resources required by a service       | Service editor                                                                              | Service editor                                  | A time is offered only when the required resources are available |
| Resource downtime                     | Rooms & equipment                                                                           | Resource manager on Services                    | Unavailable resources stop affected new bookings                 |
| Owner approval                        | Enable in service editor; accept from appointment details                                   | Service editor and calendar appointment actions | Requests can await approval rather than immediately confirm      |
| Family recipients                     | Customer profile → More → Appointment holders; select during an existing customer's booking | Customer details and booking form               | Verified customer page; WhatsApp `APPOINTMENT FOR <name>`        |
| Consecutive treatments                | Booking form → Add consecutive treatment                                                    | Owner booking form                              | Public booking form and WhatsApp                                 |
| Customer-link revocation              | Customer profile → More → Revoke customer link                                              | Customer details                                | Verified customers can replace their own private link            |
| Attendance safeguards and corrections | Appointment details                                                                         | Calendar appointment actions                    | More accurate visit history and appointment status               |

## 1. Rooms, equipment, and parallel bookings

Owners can add, edit, and retire rooms, beds, chairs, and equipment. Each entry has
a **quantity from 1 to 20**. For example, “Hydrafacial pens, quantity 2” makes two
interchangeable pens available without creating two entries. Services sharing
those pens must reference the same inventory. Existing entries default to quantity 1.

Name each room separately with **quantity 1** when placing beds, chairs, or fixed
equipment inside it. Add the beds/chairs as another entry, choose their room, and
set their quantity. Beds/chairs require a room; equipment can be portable or fixed
in a named room. A room pool with quantity 2 is supported for interchangeable
exclusive rooms, but cannot contain stations or fixed equipment. Inventory is
limited to 200 physical units, including retired entries.

A service can require several groups of resources. Every group is required, but
the booking engine chooses one available alternative from each group. For example:

- Whole-room requirement: Treatment Room A **or** Treatment Room B, or a room pool
  with quantity 2.
- Equipment requirement: Hydrafacial pens with quantity 2, or Facial Machine 1
  **or** Facial Machine 2.

Different resource types cannot be alternatives in the same group. The app and web
editors explain **station/room AND machine = separate requirements**, disable mixed
selections, and the API enforces the same rule. Legacy mixed groups stop offering new bookings
until corrected, even if one alternative is retired; existing appointments are
preserved. A correction that cannot accommodate existing appointments rolls back,
so resolve the overlapping appointments before changing the requirements.

That treatment needs both a room and a machine. For shared rooms, replace the
whole-room requirement with a bed or chair requirement:

1. Add **Treatment Room A**, type Whole room, quantity 1.
2. Add **Facial beds**, type Bed, quantity 2, room Treatment Room A.
3. Add **Hydrafacial pens**, type Equipment, quantity 2; select the room if fixed.
4. Set Hydrafacial to require **Facial beds AND Hydrafacial pens**, in separate groups.

With two qualified, available staff, two customers can book 09:00. Each uses one
bed and one pen. A third booking is unavailable until the treatment and cleanup
finish. A single pen still limits capacity to one treatment even when both beds
are free. For beds in different rooms, select those bed entries as alternatives;
fixed equipment must be in the selected station's room.

A bed/chair booking reserves only its station and required equipment. A
**whole-room booking is exclusive**: it blocks every station and fixed item in
that room, and an occupied station blocks a whole-room booking. Do not require
both the whole room and a station for the same treatment. Fixed equipment without
a bed/chair requirement continues to reserve its whole room; incompatible room
combinations are rejected.

Both service editors explain and reject whole-room AND bed/chair selection before
saving. The API enforces the same rule. Expected save conflicts return useful
messages on the production website, retaining the form for correction; unexpected
server/network failures show generic retry feedback without internal details.

Different customers can book simultaneously when their qualified staff and
required resources are independently available. Having two available staff does
not allow two treatments to use the same room or machine at once.

Staff and allocated resource units are reserved for the treatment **plus cleanup**. This
version does not release individual resources partway through a treatment.

## 2. Downtime and safe configuration changes

Owners can block a resource temporarily for maintenance, closure, or another
reason. The interface identifies affected appointments. It does **not** silently
cancel those appointments; the owner must contact customers and move or cancel
them as appropriate.

Resources in use cannot be silently retired or moved. When requirements are added
to a service, the backend checks existing upcoming appointments and assigns
capacity where possible. If the appointments cannot fit, the change fails without
partially updating the service.

Increasing quantity adds capacity. Reducing it is refused while any removed unit
has a current or future reservation. A room's downtime also blocks its beds,
chairs, and fixed equipment and reports their affected appointments. Equipment
downtime blocks every unit in that equipment entry. Existing business inventory
and appointments are not silently rewritten into a new setup.

## 3. WhatsApp contact verification for public booking

Customers booking through the public website must verify their WhatsApp contact
before reserving a time or saving an appointment. This prevents someone booking
with another person's number. A code expires after five minutes, with a limited
number of attempts and rate limits on requesting more codes.

When available, a fallback link lets the customer send the verification message
to the business on WhatsApp. After verification, the proof lasts 15 minutes and
works only for that business and contact.

This extra public-site verification is separate from WhatsApp chat, where the
authenticated inbound message already identifies the sender. It is not an OTP
requirement for owner-created walk-ins.

## 4. Names and the person receiving treatment

A WhatsApp customer with a missing or numeric name must provide a usable name
before a booking is created. The contact receiving messages and the person
receiving treatment can be different.

Owners and verified customers can manage up to **20 active appointment holders**:
for example, a parent and their children. They can add, rename, and retire these
recipients. A person with an unfinished appointment cannot be retired until those
appointments are moved or cancelled.

In WhatsApp, use `APPOINTMENT FOR Sara` to identify another recipient, or
`APPOINTMENT FOR MYSELF` to return to the contact themselves. The confirmation-stage recipient switch is also covered by regression tests,
including switching from a family recipient back to yourself. The system checks
recipient availability so the same named person cannot receive overlapping
treatments. Notifications continue to go to the booking contact.

## 5. Optional owner approval

Owners can enable **Owner approval required** for a service. Requests for that
service reserve capacity while awaiting a decision. The owner can accept the
request from appointment details, or cancel it through the existing controls.

The default approval window is 30 minutes, capped by the appointment start time.
An expired request releases capacity and cannot be accepted afterward. Services
without this option continue through the existing confirmation process.

Owner push alerts use the project's existing Firebase setup and registered owner
devices. Push delivery requires that configuration to be present.

The private customer page includes requests awaiting owner approval in upcoming
appointments. Both the next appointment and later requests explicitly say they
are not confirmed yet. Upcoming reads return the nearest 100 appointments, remain
scoped to the verified link's business/customer relationship, and do not expose
another customer's requests.

The owner website now edits cleanup time in the service form, using the same
backend field as the app. Cleanup accepts whole minutes from 0 to 1440; new
services default to 0 and existing services retain their saved value when opened.
Staff and required resources remain reserved throughout that cleanup interval.

## 6. Consecutive treatments in one visit

A visit can contain **two to five treatments**, with a qualified professional for
each. The forms show the treatment order and individual start times before saving.
Cleanup gaps are included between treatments and aligned to the booking grid.

Availability checks the entire visit: all staff, rooms, equipment, working hours,
breaks, and downtime must fit. Confirmation saves every appointment together or
saves none. A conflict in the last treatment therefore cannot leave the first
treatment booked on its own.

On WhatsApp, customers can name catalog services together, such as
`Hydrafacial then Laser session`. The conversation collects the necessary
professionals, offers times for the whole visit, and asks for confirmation.

After creation, each appointment retains its own approval, cancellation, and
rescheduling controls. This version does not move or cancel a whole visit as one
package. Customer sequences exclude services requiring deposits; existing
single-service deposit behavior is preserved.

## 7. Protected customer appointment pages

Private customer links expire after 180 days. Existing links receive an expiry
when they are next read or reissued. Owners can revoke a link from customer
details. Customers can replace their own link after verification.

Cancellation, rescheduling, rebooking, and family-recipient changes on the private
page require fresh WhatsApp verification. Private responses disable caching and
referrer disclosure to reduce accidental exposure of the link.

## 8. Accurate attendance and reasoned corrections

Ordinary **Completed** marking becomes available when the treatment ends.
**No-show** marking becomes available ten minutes after its start. A treatment
that finishes early can be completed after it starts if the owner supplies a reason.

Owners can correct a terminal outcome, such as an accidental no-show. Corrections
require a reason and reject stale edits if another update happened first. The
audit record stores who changed the outcome, the previous and new statuses, and
the reason.

Customer visit totals are updated consistently with the booking. Correcting a
completed appointment to a different outcome withdraws its published review.
Corrections do not replay old notifications or review requests.

## 9. Safer retries, rescheduling, and clearer feedback

- Concurrent bookings cannot both claim the same staff, resource, or recipient.
- Retrying a successful single-slot request returns the matching existing booking.
- Owner and public consecutive bookings use request IDs to recognize retries
  after a successful save.
- Rescheduling changes the reservation atomically while keeping the booking ID;
  a failed move leaves the existing reservation intact.
- Authorized rescheduling availability excludes the appointment's own occupancy,
  so it does not block itself.
- Receipts distinguish an appointment being saved from its WhatsApp message being
  delivered. They also distinguish confirmation from awaiting owner approval.
- Incomplete treatment selections show guidance. Failed public availability
  requests show a retry state instead of incorrectly claiming no times remain.
- Services created before these new fields existed remain compatible with
  consecutive-treatment availability and booking.

## Owner setup checklist

1. Add named rooms, their beds/chairs, and equipment under **Rooms & equipment**.
   Use quantity for interchangeable units; each room containing stations has quantity 1.
2. Attach separate required groups to each service. Choose a bed/chair for sharing
   or a whole room for privacy. Associate fixed equipment with its actual room.
3. Check treatment duration and cleanup time, staff qualifications, and working hours.
4. Enable owner approval only for services that need it.
5. Enter resource downtime when equipment or a room becomes unavailable, then
   resolve any affected existing appointments.
6. When booking for an existing customer, select the actual treatment recipient.

Resources are owner configured. An unconfigured resource cannot protect physical
capacity: a service with no requirements continues to use its staff availability.

## Validation completed

The latest resource-fix regression results are below. Per-case manual coverage and
remaining gaps are recorded in [TEST_RESULTS.md](TEST_RESULTS.md).

| Check                                            | Result                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Backend regression suite                         | 799 tests passed in UTC and again in America/New_York, with CI infrastructure enforcement enabled                              |
| Flutter test suite                               | Last recorded run: 123 passed on 10 October 2026; not rerun in the 21 October backend/web-only update                          |
| Backend, shared, test, and web TypeScript checks | Passed                                                                                                                         |
| Repository lint                                  | Passed                                                                                                                         |
| Flutter analysis                                 | No errors or warnings; 20 existing informational brace-style notices                                                           |
| Production web build                             | Passed                                                                                                                         |
| Browser regression checks                        | Owner web resource CRUD, app/web requirement controls, public verification gate, break/closing offers and network retry passed |

Quantity/shared-room regressions include independent unit allocation, exhausted
equipment, room/station exclusion at both Redis and transactional database layers,
downtime, quantity changes, rescheduling, legacy records, and inventory bounds.
The maximum room-inventory/full-day hold also passes without exceeding
JavaScript's command-argument limit.

Integration tests used isolated databases and fake messaging providers. Browser
checks used a temporary QA business and real resource/availability API calls; the
Flutter browser login used a scoped authentication fixture. Two live verification
messages were sent during the earlier rollout through the existing Web Preview
WhatsApp session and the user confirmed receipt on both test phones. No new live
WhatsApp messages were sent for the quantity update. Existing customer appointments
were unchanged.

The tests cover concurrent booking, resource and cleanup conflicts, tenant and
role restrictions, verification failures, recipient limits, sequence rollback,
approval expiry, rescheduling, cancellation, and outcome corrections. These
results are regression evidence, not a claim that every possible production
scenario has been tested.

Backend CI starts the existing MongoDB replica set, Redis, and PostgreSQL Compose
services and waits for health checks before running the suites. It type-checks
tests, runs both timezones, and fails if a required datastore is unavailable.
Temporary Redis/PostgreSQL probes close even on failure. Local development can
still skip infrastructure-dependent suites when those services are stopped.

## Deferred and unverified areas

- Treatment stages and releasing equipment for only part of a treatment.
- New deposit features and deposits for customer treatment sequences.
- Service/business image uploads and storage.
- Interactive live WhatsApp booking conversations, physical-device push delivery,
  and production load remain unverified. Outbound test-message receipt was confirmed.

The local engineering notes are in `docs/booking-flow.md`. The project's `docs/`
directory is private and ignored by Git; this root-level guide can travel with
the code changes.
