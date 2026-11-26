import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/auth_controller.dart';
import '../api/owner_booking_models.dart';
import 'slot_picker_screen.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../state/calendar_controller.dart';
import '../theme.dart';
import '../widgets/follow_up_fields.dart';

/// What the owner can do to one appointment.
///
/// A bottom sheet rather than a screen because every action here is a single
/// decision about something already on screen — pushing a route would lose the
/// day the owner was looking at and make "mark the 11am done" a four-tap job.
///
/// Terminal actions confirm because they change history and cannot be undone.
Future<void> showBookingSheet(
  BuildContext context, {
  required CalendarController controller,
  required CalendarEntry entry,
}) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Sc.paper,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => _BookingSheet(controller: controller, entry: entry),
  );
}

class _BookingSheet extends StatefulWidget {
  const _BookingSheet({required this.controller, required this.entry});

  final CalendarController controller;
  final CalendarEntry entry;

  @override
  State<_BookingSheet> createState() => _BookingSheetState();
}

class _BookingSheetState extends State<_BookingSheet> {
  bool _busy = false;
  Timer? _startTimer;
  @override
  void initState() {
    super.initState();
    if (entry.status == 'confirmed') {
      _startTimer = Timer.periodic(const Duration(seconds: 30), (_) {
        if (mounted) setState(() {});
      });
    }
  }

  @override
  void dispose() {
    _startTimer?.cancel();
    super.dispose();
  }

  CalendarEntry get entry => widget.entry;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 14, 22, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(
                  color: Sc.hairline,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 20),
            Text(
              entry.clientName ?? 'Walk-in',
              style: const TextStyle(
                fontSize: 19,
                fontWeight: FontWeight.w700,
                color: Sc.ink,
                letterSpacing: -0.2,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              '${entry.serviceName} · ${entry.staffName}',
              style: const TextStyle(fontSize: 13.5, color: Sc.slate),
            ),
            const SizedBox(height: 14),
            _detail(
              Icons.schedule_rounded,
              '${relativeDay(entry.startsAt)}, ${hhmm(entry.startsAt)} – ${hhmm(entry.endsAt)}',
            ),
            _detail(Icons.sell_outlined, money(entry.priceMinor)),
            if (entry.clientPhone != null)
              _detail(Icons.phone_outlined, entry.clientPhone!),
            if (entry.status != 'cancelled' && entry.status != 'no_show')
              _followUpRow(),
            const SizedBox(height: 18),

            if (entry.isTerminal)
              _settled()
            else ...[
              if (entry.status == 'awaiting_approval') ...[
                const Text(
                  'Awaiting your approval. Capacity is reserved until the request expires.',
                  style: TextStyle(color: Sc.slate),
                ),
                const SizedBox(height: 10),
                _action(
                  icon: Icons.check,
                  label: 'Accept request',
                  tone: Sc.teal,
                  onTap: () => _confirmThen(
                    title: 'Accept this appointment?',
                    message: 'The customer will receive a confirmation.',
                    confirmLabel: 'ACCEPT',
                    action: () => widget.controller.approve(entry),
                  ),
                ),
                const SizedBox(height: 10),
              ],
              if (entry.canMarkOutcomeAt(DateTime.now()))
                Row(
                  children: [
                    Expanded(
                      child: _action(
                        icon: Icons.check_rounded,
                        label: 'Completed',
                        tone: Sc.teal,
                        onTap: entry.canCompleteAt(DateTime.now())
                            ? () => _confirmThen(
                                title: 'Mark this visit complete?',
                                message: 'This updates the customer’s visit history. Corrections require an audit reason.',
                                confirmLabel: 'MARK COMPLETE',
                                action: _completeThenAskFollowUp,
                              )
                            : null,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _action(
                        icon: Icons.person_off_outlined,
                        label: 'No-show',
                        tone: Sc.warnIcon,
                        onTap: entry.canNoShowAt(DateTime.now())
                            ? () => _confirmThen(
                                title: 'Mark as a no-show?',
                                // The slot is NOT freed, and the owner has to know that
                                // before they tap: the time was spent waiting whether or
                                // not anyone arrived.
                                message:
                                    'The time stays booked — it was spent waiting. '
                                    "This counts against the customer's profile.",
                                confirmLabel: 'MARK NO-SHOW',
                                action: () => widget.controller.noShow(entry),
                              )
                            : null,
                      ),
                    ),
                  ],
                ),
              if (!entry.canMarkOutcomeAt(DateTime.now()))
                const Padding(
                  padding: EdgeInsets.only(bottom: 10),
                  child: Text(
                    'Complete is available at the appointment’s end. No-show is available ten minutes after its start.',
                    style: TextStyle(color: Sc.slate),
                  ),
                ),
              if (entry.status == 'confirmed' &&
                  !entry.startsAt.isAfter(DateTime.now()) &&
                  !entry.canCompleteAt(DateTime.now()))
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => _correctOutcome(earlyCompletion: true),
                  child: const Text(
                    'Treatment finished early? Record completion with a reason',
                  ),
                ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: _action(
                      icon: Icons.event_repeat_rounded,
                      label: 'Reschedule',
                      tone: Sc.inkMuted,
                      onTap: _pickNewTime,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _action(
                      icon: Icons.close_rounded,
                      label: 'Cancel',
                      tone: Sc.danger,
                      onTap: () => _confirmThen(
                        title: 'Cancel this appointment?',
                        message:
                            'The slot is freed for someone else. '
                            'We will try to notify the customer. This cannot be undone.',
                        confirmLabel: 'CANCEL BOOKING',
                        danger: true,
                        action: () => widget.controller.cancel(entry),
                      ),
                    ),
                  ),
                ],
              ),
            ],
            if (_busy) ...[
              const SizedBox(height: 16),
              const Center(
                child: SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.4,
                    color: Sc.teal,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  /// Complete, then ask the one question the owner can only answer now:
  /// does this customer need to come back? Skipped when one is already set.
  Future<ApiException?> _completeThenAskFollowUp() async {
    final failure = await widget.controller.complete(entry);
    if (failure != null || !mounted) return failure;
    if (entry.followUp?.active ?? false) return null;
    final choice = await _followUpDialog(
      title: 'Does this customer need to come back?',
      cancelLabel: 'NO FOLLOW-UP',
    );
    if (choice == null || !mounted) return null;
    final saved = await widget.controller.setFollowUp(
      entry,
      afterDays: choice.days,
      note: choice.note,
    );
    // The visit IS complete; a follow-up failure is reported, not returned —
    // returning it would keep the sheet open as if completing had failed.
    if (saved != null && mounted) _report(saved);
    return null;
  }

  ServiceItem? get _service => widget.controller.services
      .where((s) => s.id == entry.serviceId)
      .firstOrNull;

  Future<({int days, String? note})?> _followUpDialog({
    required String title,
    String cancelLabel = 'CANCEL',
  }) {
    final existing = entry.followUp?.active ?? false ? entry.followUp : null;
    final days = TextEditingController(
      text: existing != null
          ? '${existing.dueAt.difference(entry.startsAt).inDays.clamp(1, 365)}'
          : '${_service?.followUpDays ?? 21}',
    );
    final note = TextEditingController(
      text: existing?.note ?? _service?.followUpNote ?? '',
    );
    String? error;
    return showDialog<({int days, String? note})>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (dialog, update) => AlertDialog(
          backgroundColor: Sc.paper,
          title: Text(title, style: const TextStyle(fontSize: 19, color: Sc.ink)),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              FollowUpFields(
                enabled: true,
                showToggle: false,
                onToggle: (_) {},
                days: days,
                note: note,
              ),
              if (error != null)
                Text(error!, style: const TextStyle(color: Sc.dangerText, fontSize: 12.5)),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog),
              child: Text(cancelLabel, style: const TextStyle(color: Sc.slate)),
            ),
            TextButton(
              onPressed: () {
                final n = FollowUpFields.parseDays(days.text);
                if (n == null) {
                  update(() => error = 'Enter a whole number of days from 1 to 365.');
                  return;
                }
                Navigator.pop(dialog, (days: n, note: FollowUpFields.cleanNote(note.text)));
              },
              child: const Text('SAVE FOLLOW-UP'),
            ),
          ],
        ),
      ),
    ).whenComplete(() {
      days.dispose();
      note.dispose();
    });
  }

  static const _followUpLabel = {
    'scheduled': 'scheduled',
    'offered': 'customer messaged',
    'nudged': 'reminded once',
    'booked': 'booked ✅',
    'declined': 'customer said not now',
    'lapsed': 'needs a call',
  };

  Widget _followUpRow() {
    final f = entry.followUp?.active ?? false ? entry.followUp : null;
    if (f == null) {
      return Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          onPressed: _busy ? null : _editFollowUp,
          icon: const Icon(Icons.event_repeat_rounded, size: 16),
          label: const Text('Add follow-up'),
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(top: 7),
      child: Row(
        children: [
          const Icon(Icons.event_repeat_rounded, size: 15, color: Sc.slateLight),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              'Follow-up ${relativeDay(f.dueAt)} · ${_followUpLabel[f.status] ?? f.status}'
              '${f.note != null ? '\n${f.note}' : ''}',
              style: const TextStyle(fontSize: 13.5, color: Sc.inkMuted),
            ),
          ),
          if (f.editable) ...[
            TextButton(
              onPressed: _busy ? null : _editFollowUp,
              child: const Text('Edit'),
            ),
            TextButton(
              onPressed: _busy
                  ? null
                  : () => _run(() => widget.controller.clearFollowUp(entry)),
              child: const Text('Remove', style: TextStyle(color: Sc.dangerText)),
            ),
          ],
        ],
      ),
    );
  }

  Future<void> _editFollowUp() async {
    final choice = await _followUpDialog(title: 'Follow-up');
    if (choice == null || !mounted) return;
    await _run(
      () => widget.controller.setFollowUp(
        entry,
        afterDays: choice.days,
        note: choice.note,
      ),
    );
  }

  Widget _settled() {
    final what = switch (entry.status) {
      'completed' => 'This visit is marked complete.',
      'no_show' => 'Marked as a no-show.',
      _ => 'This appointment was cancelled.',
    };

    return Container(
      decoration: BoxDecoration(
        color: Sc.tealSurface,
        borderRadius: BorderRadius.circular(6),
      ),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Row(
        children: [
          const Icon(Icons.lock_outline_rounded, size: 16, color: Sc.slate),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              // Terminal is terminal, on the app as on the server. Offering an
              // action the backend will refuse is worse than offering none.
              '$what Corrections require a reason and are recorded in the audit history.',
              style: const TextStyle(
                fontSize: 13,
                color: Sc.inkMuted,
                height: 1.4,
              ),
            ),
          ),
          IconButton(
            tooltip: 'Correct outcome',
            onPressed: _busy ? null : _correctOutcome,
            icon: const Icon(Icons.edit_note, color: Sc.teal),
          ),
        ],
      ),
    );
  }

  Future<void> _correctOutcome({bool earlyCompletion = false}) async {
    String reason = '';
    String status = earlyCompletion ? 'completed' : entry.status;
    String? error;
    final choice = await showDialog<({String status, String reason})>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (context, update) => AlertDialog(
          title: Text(
            earlyCompletion
                ? 'Record early completion'
                : 'Correct appointment outcome',
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (!earlyCompletion)
                DropdownButtonFormField<String>(
                  initialValue: status,
                  decoration: const InputDecoration(
                    labelText: 'Correct outcome',
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: 'completed',
                      child: Text('Completed'),
                    ),
                    DropdownMenuItem(value: 'no_show', child: Text('No-show')),
                    DropdownMenuItem(
                      value: 'cancelled',
                      child: Text('Cancelled'),
                    ),
                  ],
                  onChanged: (value) => update(() => status = value!),
                ),
              TextField(
                onChanged: (value) => reason = value,
                maxLength: 200,
                decoration: InputDecoration(
                  labelText: 'Reason',
                  errorText: error,
                ),
              ),
              const Text(
                'This changes customer history and reports. It does not send another confirmation.',
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog),
              child: const Text('Keep outcome'),
            ),
            TextButton(
              onPressed: () {
                if ((!earlyCompletion && status == entry.status) ||
                    reason.trim().length < 5) {
                  update(
                    () =>
                        error = 'Choose a different outcome and give a reason',
                  );
                  return;
                }
                Navigator.pop(dialog, (status: status, reason: reason.trim()));
              },
              child: const Text('Record correction'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || choice == null) return;
    setState(() => _busy = true);
    final failure = earlyCompletion
        ? await widget.controller.complete(
            entry,
            earlyCompletionReason: choice.reason,
          )
        : await widget.controller.correct(entry, choice.status, choice.reason);
    if (!mounted) return;
    setState(() => _busy = false);
    if (failure != null) {
      _report(failure);
      return;
    }
    Navigator.pop(context);
  }

  Widget _detail(IconData icon, String text) {
    return Padding(
      padding: const EdgeInsets.only(top: 7),
      child: Row(
        children: [
          Icon(icon, size: 15, color: Sc.slateLight),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(fontSize: 13.5, color: Sc.inkMuted),
            ),
          ),
        ],
      ),
    );
  }

  Widget _action({
    required IconData icon,
    required String label,
    required Color tone,
    required VoidCallback? onTap,
  }) {
    return Material(
      color: Sc.tealSurface,
      borderRadius: BorderRadius.circular(6),
      child: InkWell(
        onTap: _busy ? null : onTap,
        borderRadius: BorderRadius.circular(6),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: Sc.divider),
          ),
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Column(
            children: [
              Icon(icon, size: 19, color: onTap == null ? Sc.slateLight : tone),
              const SizedBox(height: 6),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: onTap == null ? Sc.slateLight : tone,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _pickNewTime() async {
    await widget.controller.ensureCatalogue();
    if (!mounted) return;
    final slot = await Navigator.of(context).push<AvailableSlot>(
      MaterialPageRoute(
        builder: (_) => SlotPickerScreen(
          serviceId: entry.serviceId,
          staff: widget.controller.staffList,
          date: entry.startsAt,
          staffId: entry.staffId,
          bookingId: entry.id,
        ),
      ),
    );
    if (slot == null || !mounted) return;
    final startsAt = businessTime(
      slot.startsAt,
      timezone: context.read<AuthController>().business!.timezone,
    );

    setState(() => _busy = true);
    final result = await widget.controller.reschedule(
      entry,
      startsAt,
      staffId: slot.staffId,
    );
    if (!mounted) return;
    setState(() => _busy = false);

    if (result.error != null) {
      _report(result.error!);
      return;
    }

    Navigator.of(context).pop();
    _toast(
      result.notified
          ? 'Moved to ${relativeDay(startsAt).toLowerCase()}, ${hhmm(startsAt)}. The customer has been told.'
          : 'Moved — but we could not message the customer. Give them a call.',
      warn: !result.notified,
    );
  }

  Future<void> _confirmThen({
    required String title,
    required String message,
    required String confirmLabel,
    required Future<ApiException?> Function() action,
    bool danger = false,
  }) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        backgroundColor: Sc.paper,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Text(
          title,
          style: const TextStyle(
            fontSize: 21,
            fontWeight: FontWeight.w500,
            color: Sc.ink,
          ),
        ),
        content: Text(
          message,
          style: const TextStyle(
            fontSize: 13.5,
            color: Sc.inkMuted,
            height: 1.5,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text(
              'KEEP IT',
              style: TextStyle(color: Sc.slate, fontSize: 12.5),
            ),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(
              confirmLabel,
              style: TextStyle(
                color: danger ? Sc.danger : Sc.teal,
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );

    if (ok != true) return;
    await _run(action);
  }

  Future<void> _run(Future<ApiException?> Function() action) async {
    setState(() => _busy = true);
    final failure = await action();
    if (!mounted) return;
    setState(() => _busy = false);

    if (failure != null) {
      _report(failure);
      return;
    }
    Navigator.of(context).pop();
  }

  void _report(ApiException err) {
    // A 409 is the ordinary "someone got there first" outcome, not an error the
    // owner did anything wrong — the calendar has already reloaded underneath.
    _toast(
      err.kind == ApiErrorKind.conflict
          ? '${err.message}. The day has been refreshed.'
          : err.message,
      warn: true,
    );
  }

  void _toast(String message, {bool warn = false}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: warn ? Sc.dangerTitle : Sc.teal900,
        content: Text(message),
      ),
    );
  }
}
