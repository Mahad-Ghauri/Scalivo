# Manual test cases: Scalivo booking flows

Use this checklist to test the latest booking-flow changes and the existing
booking behavior they touch. These are **manual cases to run**, not recorded
passes from the automated suite. The implementation's automated results are in
[FEATURES_ADDED.md](FEATURES_ADDED.md).

## How to record results

Replace **Not run** with **Pass**, **Fail**, or **Blocked** after each case. For a
failure, record the case ID, surface, date/time, business timezone, selected
services/staff/resources, steps, and actual result. Attach a screenshot without
verification codes, private customer links, access tokens, or personal phone numbers.

An error message alone is insufficient evidence: also check the calendar and
customer page. A failed booking must not leave a reservation behind; a failed
reschedule must preserve the original appointment.

Use a dedicated test business and numbers you control. Some cases intentionally
send WhatsApp messages, create appointments, change customer statistics, or revoke
links. Cancel test appointments and remove test downtime through the UI afterward.
Use fresh dates/times or clean up between cases so one test does not contaminate another.

## Test setup

Prepare these before starting:

- Owner app, owner web dashboard, public booking site, and linked business WhatsApp.
- Two customer WhatsApp accounts/numbers, **Customer A** and **Customer B**.
- Two separate browser sessions, or one normal and one private window.
- The owner account for **Business A**. For tenant-isolation cases, a second owner
  for **Business B** is required. For role cases, use a staff account if available.
- Firebase and an actual registered device only for the push-delivery case.
- An optional browser's Network/DevTools panel for request replay and invalid-input
  cases. Replay requests only against your own test businesses.

Configure Business A with timezone **Asia/Karachi**, a **15-minute grid**, opening
hours **09:00–18:00**, and a break **13:00–14:00**. Set a booking horizon that includes
your test dates. For ordinary customer cases, choose a start beyond the configured
minimum notice period. Do not change your computer's clock to force expiry cases.

Create this test catalog:

| Item                 | Configuration                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Room A, Room B       | Two separate room resources                                                                                                         |
| Machine 1, Machine 2 | Two portable equipment resources                                                                                                    |
| Fixed Laser          | Equipment fixed to Room A                                                                                                           |
| Staff A, Staff B     | Both qualified for every test service; working hours match the business                                                             |
| QA Facial            | 30-minute treatment, 15-minute cleanup, Rs 1,500; room group A **or** B, equipment group Machine 1 **or** 2; no approval or deposit |
| QA Single Room       | 30-minute treatment, 15-minute cleanup, Rs 1,500; requires Room A; no approval or deposit                                           |
| QA Laser             | 30-minute treatment, 15-minute cleanup, Rs 2,000; requires Fixed Laser; no approval or deposit                                      |
| QA Consultation      | 15-minute treatment, no cleanup, Rs 500; no resource requirements or approval                                                       |
| QA Approval          | 30-minute treatment, 15-minute cleanup, Rs 1,500; requires Room B; owner approval enabled; no deposit                               |
| Sara, Ali            | Appointment holders under Customer A                                                                                                |

**D** below means a future open day within the booking horizon, preferably at least
three days away. Replace it with an actual date when sending WhatsApp messages.
**T** means **15:00 on D**, unless a case specifies another time.

At T, QA Facial ends at **15:30**, and staff/resources remain reserved until
**15:45**. A consecutive second QA Facial starts at **15:45**. Use these values
to check that cleanup is included rather than guessed.

**Surface abbreviations:** App = Flutter owner app; Owner web = owner dashboard;
Public = public booking page; Me = private customer appointment page; WA = WhatsApp.
Where a case lists several surfaces, repeat it on each and record each result.

## Recommended first pass

Run **SM-01, RS-01, RS-05, CP-01, CP-02, CP-04, VE-01, PB-01, FA-03,
AP-01, AP-02, SQ-01, SQ-04, WA-02, WA-04, WA-06, MV-01, MV-02,
OC-01, and SE-01** first. These exercise the main booking path and the most
important safeguards. Then run every remaining case, including the cases requiring
two sessions or waiting. Mark missing prerequisites as Blocked, not Pass.

## A. Startup and existing behavior

| ID    | Surface         | Steps and expected result                                                                                                                                                                             | Result  |
| ----- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| SM-01 | App / Owner web | Sign in with the test owner. Open calendar, services, staff, customers, and settings. Each loads without crashes or endless spinners; the selected business remains correct.                          | Not run |
| SM-02 | App / Owner web | Sign out, then try Back and refresh/reopen a protected owner screen. Owner data must not become accessible without signing in again.                                                                  | Not run |
| SM-03 | App / Owner web | Open an existing appointment created before this rollout. Service, customer, staff, time, and outcome still display correctly.                                                                        | Not run |
| SM-04 | Public          | Open the test business's public booking link on another device. It reaches the customer booking site, not a Flutter preview or a 404. An unpublished business must not expose a bookable public page. | Not run |
| SM-05 | App / Owner web | Create a named walk-in without a phone using QA Consultation. It saves once, appears on the calendar, and does not fail simply because WhatsApp cannot receive a notification.                        | Not run |

## B. Resource management and service setup

| ID    | Surface                               | Steps and expected result                                                                                                                                                                                                                                                                                                                                                     | Result  |
| ----- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| RS-01 | App / Owner web                       | Add an unused room and portable machine, then reload. Their names, types, and active state persist.                                                                                                                                                                                                                                                                           | Not run |
| RS-02 | App / Owner web                       | Rename an unused resource. Reload the other owner surface. The new name appears there too; a second resource is not created.                                                                                                                                                                                                                                                  | Not run |
| RS-03 | App / Owner web                       | Save a blank/space-only resource name; then test over 80 characters. Input is prevented or rejected with usable feedback; no invalid resource is saved.                                                                                                                                                                                                                       | Not run |
| RS-04 | App / Owner web                       | Create another resource with exactly the same name in the same business. It is rejected without a crash or duplicate entry.                                                                                                                                                                                                                                                   | Not run |
| RS-05 | App / Owner web                       | Edit QA Facial: put Room A/B together in one requirement, and Machine 1/2 together in another. Save and reopen. The two separate requirements and their alternatives persist.                                                                                                                                                                                                 | Not run |
| RS-06 | App / Owner web                       | Add a requirement but select no resources, then save. It must be rejected or explicitly removed before saving; no unusable empty group is silently stored.                                                                                                                                                                                                                    | Not run |
| RS-07 | App / Owner web                       | Require Room B and Fixed Laser together. The incompatible combination is rejected because the laser is fixed in Room A; previous service settings remain unchanged.                                                                                                                                                                                                           | Not run |
| RS-08 | App / Owner web                       | Retire an unused resource, confirm, reload, then restore it. Its active/retired state persists; it is not offered as an active alternative while retired.                                                                                                                                                                                                                     | Not run |
| RS-09 | App / Owner web                       | Try to retire Room A while an active service references it; then try moving Fixed Laser while it is in use. Unsafe changes fail with an explanation. References and existing bookings remain intact.                                                                                                                                                                          | Not run |
| RS-10 | App / Owner web                       | Try adding a fifth requirement or fifth alternative in one group. The UI prevents it or the server rejects it. Existing valid selections remain intact.                                                                                                                                                                                                                       | Not run |
| RS-11 | App / Owner web / API                 | Select Room A in a requirement, then attempt to select Machine 1 in that same requirement. Equipment must be disabled. A replayed mixed-group create/update request is rejected without changing the service or configuration revision. Use two separate requirements when both units are needed.                                                                             | Not run |
| RS-12 | App / Owner web / API; legacy fixture | Open an existing service with Room A OR Machine 1 in one group. The editor warns and refuses saving until corrected. New bookings are unavailable; old appointments remain intact. Separate the units into two requirements on an unused fixture and verify persistence. With conflicting upcoming bookings, correction must roll back until those appointments are resolved. | Not run |

## C. Staff, resource, and cleanup capacity

| ID    | Surface                     | Steps and expected result                                                                                                                                                                                                                                                               | Result  |
| ----- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| CP-01 | Public / WA / Owner booking | Book QA Single Room with Staff A for Customer A at T. Customer B requests the same service with Staff B at T. It is unavailable despite Staff B being free: Room A is occupied.                                                                                                         | Not run |
| CP-02 | Public / WA / Owner booking | On a fresh slot, book QA Facial with Staff A for Customer A and Staff B for Customer B at the same time. Both can succeed because there are two rooms and two machines.                                                                                                                 | Not run |
| CP-03 | Public / WA                 | Repeat CP-02 with Machine 2 blocked for that time. Only one facial can succeed: spare rooms do not create another machine. Remove the block afterward.                                                                                                                                  | Not run |
| CP-04 | Public / WA / Owner booking | Book QA Single Room at 15:00. Try a different customer/staff at 15:15 and 15:30. Both conflict; 15:30 is still cleanup. A start at 15:45 is allowed if otherwise free.                                                                                                                  | Not run |
| CP-05 | Public / WA                 | Book QA Consultation with Staff A at T. Request another service with the same Staff A at T even if its room/machine is free. It must not double-book the staff member.                                                                                                                  | Not run |
| CP-06 | Public / WA                 | Book QA Laser with Staff A at T, then QA Single Room with Staff B at T. The room booking conflicts because Fixed Laser implicitly reserves Room A.                                                                                                                                      | Not run |
| CP-07 | Public / WA                 | Leave Room B free, but block both portable machines at T. QA Facial must have no offer at T: every requirement group needs an available unit.                                                                                                                                           | Not run |
| CP-08 | Public / WA                 | Request QA Facial at 12:45 on D. Its treatment would cross the 13:00 break and must be rejected. Request 14:00 instead; it can be offered when otherwise free.                                                                                                                          | Not run |
| CP-09 | Public / WA                 | Request QA Facial at 17:45 on D. It would finish after closing and must be rejected. A 17:30 treatment can fit; cleanup may extend past closing under the existing policy.                                                                                                              | Not run |
| CP-10 | Public / WA                 | Request 15:07, a past time, a start inside minimum notice, and a date beyond the booking horizon. These must not create a customer booking. Test these through customer surfaces; owner walk-ins have existing override behavior.                                                       | Not run |
| CP-11 | Two customer sessions       | Customer A and B attempt the last QA Single Room slot together, using different staff. At most one booking succeeds. After refresh, only one appointment owns that capacity.                                                                                                            | Not run |
| CP-12 | Public / WA / Owner booking | Configure one room AND one Hydrafacial pen in two separate requirements. Request two customers with two different staff at 09:00 on D. At most one booking succeeds and it claims both resources through treatment and cleanup. Existing extra rooms do not make another pen available. | Not run |

## D. Downtime and changes affecting existing appointments

| ID    | Surface         | Steps and expected result                                                                                                                                                                                                                             | Result  |
| ----- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| DT-01 | App / Owner web | Block Room A from 15:00–16:00 on D. QA Single Room/QA Laser lose those starts. QA Facial may still use Room B with available equipment.                                                                                                               | Not run |
| DT-02 | App / Owner web | Enter an end before/equal to the start, an invalid date, or an excessively long interval. The UI/server rejects the invalid block; no downtime is created.                                                                                            | Not run |
| DT-03 | App / Owner web | Book QA Single Room at T, then block Room A over that booking. The affected booking is identified and remains present; it is not silently cancelled or moved.                                                                                         | Not run |
| DT-04 | App / Owner web | Remove downtime, first dismissing the confirmation and then confirming. Dismissal preserves it; confirmation releases availability if nothing else occupies the resource.                                                                             | Not run |
| DT-05 | App / Owner web | Book two simultaneous QA Consultation appointments with different staff/customers, then attach Room A as a requirement. The incompatible change fails atomically; previous settings/bookings remain unchanged. Use a separate test service if needed. | Not run |
| DT-06 | App / Owner web | On a fresh test service with one upcoming booking, add Room B as a requirement. Saving succeeds if the room is free. A later conflicting booking must now be rejected, proving the existing reservation was accounted for.                            | Not run |

## E. Public contact verification

| ID    | Surface                  | Steps and expected result                                                                                                                                                                                                                                               | Result  |
| ----- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| VE-01 | Public                   | Enter Customer A's real test number, request a code, enter it, then choose a slot. Verification completes and booking can proceed. Verify the actual message on the test phone.                                                                                         | Not run |
| VE-02 | Public                   | Try selecting a time without verification. A clear verification prompt appears; no customer hold/booking is created.                                                                                                                                                    | Not run |
| VE-03 | Public                   | Enter a blank, malformed, too-short, or overlong number. Input is bounded/rejected; no booking is created and no unrelated number receives a message.                                                                                                                   | Not run |
| VE-04 | Public                   | Enter an incorrect code once, then the correct code before expiry. The wrong code does not verify; the correct one works while attempts remain.                                                                                                                         | Not run |
| VE-05 | Public                   | Submit five wrong codes, then the correct code as attempt six. Verification must fail; request a new challenge subject to the cooldown.                                                                                                                                 | Not run |
| VE-06 | Public; wait required    | Request a code, wait more than five minutes, then submit it. It cannot verify. A newly requested valid code works.                                                                                                                                                      | Not run |
| VE-07 | Public; wait required    | Request a second code inside one minute; also request more than five codes within an hour while respecting cooldowns. Requests are limited with recoverable feedback.                                                                                                   | Not run |
| VE-08 | Public; wait required    | Verify, wait more than 15 minutes, then submit a booking. Fresh verification is required; no unauthorized booking is saved.                                                                                                                                             | Not run |
| VE-09 | Public / WA; conditional | If direct code delivery is unavailable and the fallback link exists, send its verification message from the intended customer's WhatsApp and check verification on the site. That contact verifies; a different sender must not prove ownership of the intended number. | Not run |

## F. Public booking and receipts

| ID    | Surface                       | Steps and expected result                                                                                                                                                                                                            | Result  |
| ----- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| PB-01 | Public                        | Verify Customer A, choose QA Facial, staff, D, T, and a usable name; submit once. Exactly one appointment appears with the server's duration, price, staff, and local time. Check owner calendar and Me page.                        | Not run |
| PB-02 | Public                        | Submit a blank, numeric-only, control-character, or URL-like name. The request is rejected with visible feedback; no appointment is created. Use DevTools if a character cannot be entered normally.                                 | Not run |
| PB-03 | Public                        | Choose Any professional for a single treatment. The receipt identifies a real qualified professional whose capacity was reserved.                                                                                                    | Not run |
| PB-04 | Public                        | Select a time, then change service, staff, or date. The old selection is cleared/released. Confirmation must apply to the new selections, never quietly to the old time.                                                             | Not run |
| PB-05 | Public; two sessions          | Choose a time, wait for its hold countdown to expire, then have Customer B book it. Customer A's stale submission cannot create a conflicting appointment and gets recovery guidance.                                                | Not run |
| PB-06 | Public; DevTools              | Replay the same successful single-slot booking request using the same hold/customer/selection. It returns the existing matching appointment; calendar counts and CRM booking history do not duplicate.                               | Not run |
| PB-07 | Public; messaging unavailable | In a controlled test environment where outbound messaging is unavailable, create a booking. Check whether it actually saved and read the receipt: a delivery failure must not falsely imply that a saved appointment does not exist. | Not run |

## G. Family recipients

| ID    | Surface              | Steps and expected result                                                                                                                                                                    | Result  |
| ----- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| FA-01 | App / Owner web / Me | Add Sara under Customer A, rename to Sara QA, and reload. The change persists in that customer's recipient list; Customer B's list is unaffected. Me changes require fresh verification.     | Not run |
| FA-02 | App / Owner web / Me | Add a blank/numeric-only/URL-like or over-80-character recipient name. It is prevented or rejected; no invalid person is saved.                                                              | Not run |
| FA-03 | App / Owner web / WA | Book an appointment for Sara under Customer A. Calendar/receipt/message identify Sara as the treatment recipient, while WhatsApp notification goes to Customer A's contact.                  | Not run |
| FA-04 | App / Owner web / WA | Give Sara QA Facial at T. Try another simultaneous service for Sara with different staff and independent resources. It is rejected because the person is already receiving treatment.        | Not run |
| FA-05 | App / Owner web / WA | Book Sara and Ali simultaneously with different staff and enough resources. Both can succeed even though their notifications share Customer A's contact.                                     | Not run |
| FA-06 | App / Owner web / Me | Try removing Sara while she has a nonterminal appointment. Removal is refused. Move/cancel her appointments, then remove her; she disappears from active selections without erasing history. | Not run |
| FA-07 | App / Owner web / Me | Reach 20 active recipients, then add number 21. It is blocked. Retire one eligible recipient, then add another; the limit counts active people, not lifetime additions.                      | Not run |
| FA-08 | App / Owner web      | Pick Customer A and Sara, then switch the booking contact to Customer B. Sara's selection is cleared; an old holder must not carry into another customer's booking.                          | Not run |

## H. Owner approval

| ID    | Surface                           | Steps and expected result                                                                                                                                                                                      | Result  |
| ----- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| AP-01 | Public / WA → App / Owner web     | Customer A books QA Approval at T. Customer and owner views say Awaiting approval, not confirmed. Another customer cannot use its reserved room/staff while the request is active.                             | Not run |
| AP-02 | App / Owner web                   | Accept AP-01 before expiry. After reload it is confirmed everywhere, and the customer receives a confirmation when messaging is healthy.                                                                       | Not run |
| AP-03 | App / Owner web; two sessions     | Open the same request in both sessions and accept nearly together. One status transition occurs; a second acceptance must not duplicate appointments or confirmation messages.                                 | Not run |
| AP-04 | App / Owner web                   | Cancel an awaiting-approval request. It becomes cancelled and releases capacity; it cannot subsequently be accepted from a stale screen.                                                                       | Not run |
| AP-05 | All; wait required                | Leave a QA Approval request untouched past its deadline, then allow roughly another minute for the expiry job and refresh. It becomes cancelled/expired, releases capacity, and cannot be accepted late.       | Not run |
| AP-06 | App / Owner web                   | Toggle approval on a test service, save, reopen it, and make a new customer booking. The policy persists and controls the new request. Ordinary no-approval services retain their usual confirmation behavior. | Not run |
| AP-07 | Physical app; configured Firebase | Create a customer approval request while the owner app is backgrounded. The registered owner receives a generic push and can open the request. Mark Blocked if Firebase/device registration is missing.        | Not run |

## I. Consecutive treatments

| ID    | Surface                              | Steps and expected result                                                                                                                                                                                             | Result  |
| ----- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| SQ-01 | App / Owner web / Public / WA        | Request QA Facial with Staff A then QA Laser with Staff B at T. Preview must show 15:00 and 15:45. Confirm and verify exactly two appointments, correct recipients, and both reservations.                            | Not run |
| SQ-02 | App / Owner web / Public             | Add an extra treatment but leave its service/professional incomplete. Guidance appears and whole-visit saving is prevented; missing choices are not treated as genuine no-availability.                               | Not run |
| SQ-03 | App / Owner web / Public / WA        | Try an unqualified professional for the second treatment. They are not offered or the server rejects the request; the first treatment is not saved alone.                                                             | Not run |
| SQ-04 | App / Owner web / Public / WA        | Reserve Staff B at 15:45 with another customer's QA Consultation. Request the sequence from SQ-01 at 15:00. The start is not offered or confirmation fails; neither sequence leg is created.                          | Not run |
| SQ-05 | App / Owner web / Public / WA        | Keep staff free but block Room A/Fixed Laser during the second leg. The entire sequence becomes unavailable; the engine must not check only the first service.                                                        | Not run |
| SQ-06 | Public / WA                          | Request two QA Facial treatments starting at 12:15 or 17:15. A later treatment crosses the break/closing, so the whole visit is rejected despite the first treatment fitting.                                         | Not run |
| SQ-07 | App / Owner web / Public             | Build five treatments, then try adding a sixth. Five is the maximum; no hidden sixth appointment is saved. Remove a treatment and check that times/preview recalculate.                                               | Not run |
| SQ-08 | Public; existing deposit service     | Inspect/add a service requiring a deposit to a customer sequence. It is excluded or rejected. Existing single-service deposit behavior is not changed by this rollout. Do not make a real payment for this test.      | Not run |
| SQ-09 | App / Owner web / Public; DevTools   | Replay a successful consecutive request with its original request ID and identical details. The existing visit is returned; no additional appointments are created.                                                   | Not run |
| SQ-10 | Two sessions                         | Let A view a valid sequence, then B commit a conflicting second-leg booking before A confirms. A's confirmation fails without leaving the first leg booked. A can choose a new valid whole-visit time.                | Not run |
| SQ-11 | App / Owner web / Me                 | Cancel just one appointment from a saved two-treatment visit. Only that appointment changes. This version deliberately manages saved appointments individually, rather than cancelling the whole visit automatically. | Not run |
| SQ-12 | Public / WA; existing legacy service | Use a service that existed before the new resource/approval fields were introduced in a consecutive visit. Offers and booking work without a server error. Mark Blocked if no such fixture exists.                    | Not run |

## J. WhatsApp conversation and the earlier time bugs

Use the actual catalog names. Replace D with an actual date. Compare meaning and
saved data rather than exact greeting punctuation. A clarification is acceptable;
a fabricated time, silent change, or unintended booking is not.

| ID    | Steps                                                                                                                                  | Expected result                                                                                                                                                                        | Result  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| WA-01 | Send `hey`, then ask `What slots are available?` in a fresh booking conversation.                                                      | It collects the missing service/day before giving appropriate availability; it does not invent a booking. Names and natural booking requests must work alongside any number shortcuts. | Not run |
| WA-02 | Send `Book QA Facial with Staff A on D at 3:00 PM`.                                                                                    | It resolves the explicit clock correctly, checks availability, and previews 15:00. There is no appointment until explicit confirmation.                                                | Not run |
| WA-03 | From a displayed available-times list, reply exactly `3:00 PM`.                                                                        | It recognizes one explicit time, rather than incorrectly asking to specify AM/PM again. The preview matches 15:00.                                                                     | Not run |
| WA-04 | Temporarily set a fresh test day's closing time to 17:00. Ask `Book QA Facial with Staff A on D at 5:30`.                              | Both 05:30 and 17:30 are invalid; it explains unavailability/offers alternatives instead of asking a useless AM/PM question or booking either. Restore hours afterward.                | Not run |
| WA-05 | Under the normal fixture hours, ask for `5:30` when 17:30 is genuinely free and 05:30 is closed.                                       | It may resolve the available interpretation or ask a useful clarification, but must not book before confirmation. The resulting time must be genuinely available.                      | Not run |
| WA-06 | Reach a confirmation preview, then send `What other slots are available?`.                                                             | It shows alternatives for the relevant service/day. It does not demand numbers from a missing menu or commit the previewed appointment.                                                | Not run |
| WA-07 | Preview 15:00, then ask for an unavailable 17:45, then send `YES`.                                                                     | It must not use the old 15:00 consent or create the invalid 17:45 booking. Any new valid selection needs an accurate confirmation preview.                                             | Not run |
| WA-08 | At confirmation send `maybe`, a blank/unsupported message if possible, and unrelated text.                                             | No booking is created. A useful clarification/recovery response appears; it does not pretend that an ambiguous message means YES.                                                      | Not run |
| WA-09 | Send `QA Facial then QA Laser on D`; choose professionals when asked.                                                                  | It preserves both treatments, checks the complete visit, previews both starts, and saves both only after confirmation.                                                                 | Not run |
| WA-10 | In a booking conversation send `APPOINTMENT FOR Sara`, then choose a valid time. In another conversation use `APPOINTMENT FOR MYSELF`. | The first identifies Sara; the second returns to the contact themselves. Recipient selection survives later availability questions and matches the saved booking.                      | Not run |
| WA-11 | Use a test customer whose stored name is missing or numeric, then try booking and confirming.                                          | The conversation asks for a usable name before committing; it must not save a numeric placeholder as the intended customer name.                                                       | Not run |
| WA-12 | Complete a booking, then send a cancellation/reschedule request in natural language or use `CANCEL`/`RESCHEDULE`.                      | It identifies the relevant appointment and obtains appropriate confirmation. A failed move preserves the original booking.                                                             | Not run |
| WA-13 | Let a confirmation hold expire, then send YES while its time remains free. Repeat after another customer has taken the time.           | A free time may be rechecked and booked; a taken time is rejected/re-offered. Neither scenario creates duplicates or conflicts.                                                        | Not run |
| WA-14 | Ask for a nonexistent service or send unrelated/non-booking text.                                                                      | It does not invent a catalog item or create an appointment. It asks for clarification, presents supported services, or directs the customer appropriately.                             | Not run |

## K. Customer links, cancellation, and rescheduling

| ID    | Surface                   | Steps and expected result                                                                                                                                                                                                                   | Result  |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| MV-01 | App / Owner web / Me / WA | Move a future appointment to a free time. It keeps its booking identity/history, reserves the new capacity, releases the old capacity, and agrees across refreshed surfaces. Me requires fresh verification.                                | Not run |
| MV-02 | App / Owner web / Me / WA | Attempt a move into another appointment's resource/staff capacity. The move fails and the original appointment/time remain usable; no second appointment is created.                                                                        | Not run |
| MV-03 | App / Owner web / Me      | Open rescheduling for a booking that owns a room. Check offers around its existing span. Its own staff/resource reservation must not incorrectly hide every otherwise valid overlapping move. Other customers' occupancy still blocks.      | Not run |
| MV-04 | Me                        | Open the private link and attempt cancel, move, rebook, or recipient changes without fresh verification. Actions are blocked until the correct contact verifies; merely possessing the link does not authorize these mutations.             | Not run |
| MV-05 | Me                        | Verify, cancel a future booking, and confirm. It becomes cancelled and its capacity can be booked again. Dismissing the confirmation must preserve the appointment.                                                                         | Not run |
| MV-06 | App / Owner web           | Revoke Customer A's link, then reopen the old link on another device. It no longer exposes appointments. Customer B's link remains valid.                                                                                                   | Not run |
| MV-07 | Me                        | After verification, replace the private link. The new link works; the old link and its installed shortcut stop working. Save the replacement before leaving the page.                                                                       | Not run |
| MV-08 | Me                        | Open a completed/no-show/cancelled appointment and a past appointment. Do not expect ordinary future-booking move/cancel actions to revive it. Customer mutations must not bypass status/time restrictions.                                 | Not run |
| MV-09 | Me                        | Use a deliberately malformed link, or an expired test link if an existing fixture is available. It returns a safe unavailable/not-found state, with no other customer's data. Expiry itself needs a controlled fixture, not a 180-day wait. | Not run |

## L. Attendance, corrections, and CRM

For timing cases, create separate appointments starting soon within valid owner
walk-in rules. Use the real passage of time. Record start and end before testing.

| ID    | Surface                               | Steps and expected result                                                                                                                                                                            | Result  |
| ----- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| OC-01 | App / Owner web                       | Open a confirmed future appointment. Normal Complete and No-show actions must not allow marking attendance before their eligible times.                                                              | Not run |
| OC-02 | App / Owner web; wait required        | Keep a confirmed booking open until after its treatment end. Complete becomes available (the app may take up to its 30-second refresh tick). Mark once; CRM visits/spend increase once.              | Not run |
| OC-03 | App / Owner web; wait required        | After start but before end, record early completion with a meaningful reason. It succeeds with an audit reason. Before start, early completion must not be possible.                                 | Not run |
| OC-04 | App / Owner web                       | Submit empty, under-five-character, and over-200-character correction/early-completion reasons. They are prevented or rejected without changing the outcome.                                         | Not run |
| OC-05 | App / Owner web; wait required        | Try No-show before start + 10 minutes, then after the grace period. Only the latter succeeds. The missed time remains occupied under the existing no-show policy.                                    | Not run |
| OC-06 | App / Owner web                       | Correct a past no-show to Completed with a reason; reload customer history/statistics. Outcome, visits, no-shows, and spending agree with the corrected bookings, without double-counting.           | Not run |
| OC-07 | App / Owner web; two sessions         | Open the same terminal booking twice. Correct it in one session, then submit a conflicting stale correction from the other. The stale update is rejected; it cannot silently overwrite the first.    | Not run |
| OC-08 | App / Owner web / Public; conditional | On a past completed booking with a published review, correct the outcome away from Completed. That review is withdrawn; customer totals update, and old confirmation/review messages are not resent. | Not run |
| OC-09 | App / Owner web                       | Cancel a future appointment, then try correcting it to Completed or No-show before those times become eligible. It must not fabricate future attendance.                                             | Not run |

## M. Authorization and input-boundary checks

These cases use authorized test accounts and, where stated, browser DevTools to
replay requests. A hidden button is not enough: the API must also refuse the action.

| ID    | Surface                                  | Steps and expected result                                                                                                                                                                                                  | Result  |
| ----- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| SE-01 | Owner web; Business B account / DevTools | Sign in as Business B's owner. Request Business A's resources, holders, bookings, or audit information using A's IDs. Requests are rejected and reveal no A data.                                                          | Not run |
| SE-02 | Owner web; staff account / DevTools      | As staff, attempt owner-only resource edits, approvals, link revocation, and outcome corrections. The API rejects the unauthorized role even if a request is replayed manually.                                            | Not run |
| SE-03 | Owner web / Public; DevTools             | Substitute a service/staff/resource/holder ID from another business in a booking/configuration request. It fails; no foreign object is attached and no partial booking is created.                                         | Not run |
| SE-04 | Public; DevTools                         | Verify Customer A, then substitute Customer B's phone when submitting. Also try A's proof for Business B. Neither mismatched contact nor mismatched business can book using that proof.                                    | Not run |
| SE-05 | Owner web / Public / Me; DevTools        | Send malformed IDs, impossible dates, negative revisions, wrong JSON types, oversized names, and more than five sequence legs to the relevant endpoints. They fail safely without server crashes or saved invalid records. | Not run |
| SE-06 | Owner web; DevTools                      | Alter price or duration in a booking submission. The stored appointment uses the server's service values, never the customer's fabricated price/duration.                                                                  | Not run |
| SE-07 | Me; DevTools                             | Use Customer A's verified private session to target Customer B's booking/holder ID. The operation is rejected and B's data is unchanged.                                                                                   | Not run |
| SE-08 | Me; DevTools                             | Inspect private page/API responses. Cache-control and referrer protection are present; navigating to another site must not disclose the private link in the referrer. Do not share raw private URLs in test evidence.      | Not run |

## N. Network recovery, resume, and usability

| ID    | Surface                       | Steps and expected result                                                                                                                                                                                                    | Result  |
| ----- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| RL-01 | App / Owner web / Public      | Disable network before loading resources/availability, then restore it and retry. A visible error/retry appears and recovery works. Public must not label a network failure as genuine no availability.                      | Not run |
| RL-02 | App / Owner web / Public      | Simulate a slow network while saving; tap Save repeatedly. Loading feedback prevents accidental repeated actions. Refresh afterward and check appointment count before attempting another save.                              | Not run |
| RL-03 | Public / Owner web; DevTools  | After the server accepts a consecutive booking, replay the original request to simulate a lost reply. The stable request ID identifies the existing visit; no extra appointments appear.                                     | Not run |
| RL-04 | App                           | Open recipient/correction dialogs repeatedly; save, cancel, navigate Back, and reopen them. There are no disposed-controller errors, lost valid data, or permanently disabled buttons.                                       | Not run |
| RL-05 | App                           | Background the app while a request/time boundary is pending, then resume. Reload as needed. The displayed state agrees with the server; stale confirmation cannot bypass availability or expiry checks.                      | Not run |
| RL-06 | App / Public                  | Navigate away mid-selection, then return. The app remains usable; abandoned holds expire/release. Do not mistake a temporary hold for a permanent appointment.                                                               | Not run |
| UX-01 | App                           | Enable large text (approximately 200%). Check resources, service requirements, holder names, slot selection, and booking actions. Text is readable, important controls remain reachable, and no fatal overflow appears.      | Not run |
| UX-02 | App                           | Use a screen reader. Resource actions, remove downtime, recipient controls, date/time choices, and outcome buttons should have understandable labels and an operable focus order. Record any unlabeled control as a finding. | Not run |
| UX-03 | Public / Owner web            | Use a narrow phone viewport and keyboard navigation. Verification, all treatment selectors, validation messages, previews, and Save remain reachable without lost/off-screen required controls.                              | Not run |
| UX-04 | App / Owner web / Public / WA | Check the same appointment from a device/browser in another timezone. It is consistently represented in the business's timezone; selecting 15:00 must not quietly become 15:00 UTC.                                          | Not run |
| UX-05 | App / Owner web / Public      | Test an empty resource list, a service with no qualified staff, a closed day, and a genuinely full day. Each explains the situation without a crash or an endless loader; recovery/navigation remain possible.               | Not run |
| UX-06 | App / Owner web               | Dismiss cancellation, retirement, downtime removal, and link-revocation confirmations. No destructive change occurs until explicitly confirmed.                                                                              | Not run |

## Quantity inventory and shared rooms

Use a dedicated test business. Create **Treatment Room A** (Whole room, quantity
1), **Facial beds** (Bed, quantity 2, room A), and **Hydrafacial pens** (Equipment,
quantity 2). Configure a 30-minute Hydrafacial with 15-minute cleanup, two qualified
staff working 09:00–18:00, and separate **bed AND pen** requirements. Use two
different customers on an open future day. Repeat editor cases on app and owner web.

| ID    | Surface                       | Steps and expected result                                                                                                                                                                                                                                                  | Result  |
| ----- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| QY-01 | App / Owner web               | Add a room, two beds in it, and a pen pool with quantity 2. Refresh/reopen. Type, quantity, and containing room remain correct. Add chairs in the same way.                                                                                                                | Not run |
| QY-02 | App / Owner web; API          | Try quantity 0, 21, a fraction, or a blank; try a bed/chair without a room. No invalid inventory saves. A parent must be an active room belonging to this business with quantity 1.                                                                                        | Not run |
| QY-03 | App / Owner web / Public / WA | Book Customer A at 09:00 with Staff A. Customer B should still see and book 09:00 with Staff B. Both reservations require separate beds and pens through 09:45.                                                                                                            | Not run |
| QY-04 | App / Owner web / Public / WA | Repeat with two beds but only one pen. After the first reservation, the second customer cannot reserve an overlapping treatment, despite free staff and a bed.                                                                                                             | Not run |
| QY-05 | App / Owner web / Public / WA | With an occupied bed, attempt a service requiring the whole room using another staff member. It is unavailable. Cancel the bed booking: the whole-room time becomes available. Reverse the order; a whole-room hold/booking blocks every station.                          | Not run |
| QY-06 | App / Owner web               | Block room A for maintenance across the test appointments. The affected list includes both bed bookings and new station availability is blocked. Remove downtime, then block pens: every pen unit is unavailable. Existing appointments are retained for owner resolution. | Not run |
| QY-07 | App / Owner web               | While the second bed/pen is reserved, reduce that pool from 2 to 1. It is refused without changing quantity. Cancel/move that appointment and retry: reduction succeeds, while the first unit's booking remains valid.                                                     | Not run |
| QY-08 | App / Owner web               | Increase a portable pen pool from 1 to 2: the additional capacity becomes bookable. Try increasing a room containing stations above 1: refused. Add a bed to a pooled room with quantity 2: refused.                                                                       | Not run |
| QY-09 | App / Owner web               | Move Customer B's second-unit booking to another available time. Customer A's reservation remains protected; capacity at the old time is released only for B. Cancellation similarly releases only the cancelled booking's units.                                          | Not run |
| QY-10 | App / Owner web; API          | Configure beds in Room A and fixed equipment in Room B without a compatible alternative: service save fails. A whole-room AND bed/chair requirement also fails; different resource types cannot substitute in one group.                                                   | Not run |
| QY-11 | App / Owner web / Public / WA | Use an exclusive room pool with quantity 2 and a portable pen pool with quantity 2, without child stations. Two different staff/customers can book 09:00 using separate units. Existing entries without quantity continue to provide one unit.                             | Not run |
| QY-12 | API / concurrent sessions     | Race whole-room and station requests. At most one conflicting reservation succeeds. Retry stale holds after quantity changes; they cannot bypass the updated capacity. Verify cleanup remains occupied and no failed request leaves a partial booking.                     | Not run |

These cases extend the previous 130-case checklist; executed evidence for this
extension is reported separately in [TEST_RESULTS.md](TEST_RESULTS.md).

## Finish and assess coverage

1. Review every case result. Investigate every Fail; explain each Blocked prerequisite.
2. For each successful booking, compare calendar, customer page, WhatsApp recipient,
   local time, and appointment count. For every failed booking, check for leftovers.
3. Cancel remaining test appointments, remove test downtime, and restore any hours
   or service settings changed for boundary cases. Keep historical test records
   identifiable rather than deleting live data directly.
4. Repeat the failed case after a fix and rerun the relevant neighboring cases
   (for example, a capacity fix needs parallel, cleanup, sequence, and reschedule checks).

This checklist covers the current booking rollout and its connected regression
flows. It does not claim exhaustive mathematical coverage or replace automated
race/security tests. Treatment stages, image storage, new deposit features, and
production load testing are outside this rollout. Long-term link expiry and rare
infrastructure failures require controlled fixtures or an isolated environment.
