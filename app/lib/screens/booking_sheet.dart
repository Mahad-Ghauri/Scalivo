import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../state/calendar_controller.dart';
import '../theme.dart';

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
    backgroundColor: Colors.white,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
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

  CalendarEntry get entry => widget.entry;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Padding(
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
            _detail(Icons.schedule_rounded,
                '${relativeDay(entry.startsAt)}, ${hhmm(entry.startsAt)} – ${hhmm(entry.endsAt)}'),
            _detail(Icons.sell_outlined, money(entry.priceMinor)),
            if (entry.clientPhone != null) _detail(Icons.phone_outlined, entry.clientPhone!),
            const SizedBox(height: 18),

            if (entry.isTerminal)
              _settled()
            else ...[
              Row(
                children: [
                  Expanded(
                    child: _action(
                      icon: Icons.check_rounded,
                      label: 'Completed',
                      tone: Sc.teal,
                      onTap: () => _confirmThen(
                        title: 'Mark this visit complete?',
                        message: 'This updates the customer’s visit history and cannot be undone.',
                        confirmLabel: 'MARK COMPLETE',
                        action: () => widget.controller.complete(entry)),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _action(
                      icon: Icons.person_off_outlined,
                      label: 'No-show',
                      tone: Sc.warnIcon,
                      onTap: () => _confirmThen(
                        title: 'Mark as a no-show?',
                        // The slot is NOT freed, and the owner has to know that
                        // before they tap: the time was spent waiting whether or
                        // not anyone arrived.
                        message: 'The time stays booked — it was spent waiting. '
                            "This counts against the customer's profile.",
                        confirmLabel: 'MARK NO-SHOW',
                        action: () => widget.controller.noShow(entry),
                      ),
                    ),
                  ),
                ],
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
                        message: 'The slot is freed for someone else and the '
                            'we will try to notify the customer. This cannot be undone.',
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
                  child: CircularProgressIndicator(strokeWidth: 2.4, color: Sc.teal),
                ),
              ),
            ],
          ],
        ),
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
        borderRadius: BorderRadius.circular(14),
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
              '$what Nothing more to do here.',
              style: const TextStyle(fontSize: 13, color: Sc.inkMuted, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }

  Widget _detail(IconData icon, String text) {
    return Padding(
      padding: const EdgeInsets.only(top: 7),
      child: Row(
        children: [
          Icon(icon, size: 15, color: Sc.slateLight),
          const SizedBox(width: 9),
          Expanded(
            child: Text(text, style: const TextStyle(fontSize: 13.5, color: Sc.inkMuted)),
          ),
        ],
      ),
    );
  }

  Widget _action({
    required IconData icon,
    required String label,
    required Color tone,
    required VoidCallback onTap,
  }) {
    return Material(
      color: Sc.tealSurface,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        onTap: _busy ? null : onTap,
        borderRadius: BorderRadius.circular(14),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: Sc.divider),
          ),
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Column(
            children: [
              Icon(icon, size: 19, color: tone),
              const SizedBox(height: 6),
              Text(
                label,
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: tone),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// A time picker on the same day, or a date picker first if they want another.
  ///
  /// The new time goes through the server's own validation rather than being
  /// pre-filtered here: availability, the notice period and the occupancy grid
  /// all live there, and a client-side guess at them would be wrong the moment
  /// a WhatsApp booking lands between the draw and the tap.
  Future<void> _pickNewTime() async {
    final date = await showDatePicker(
      context: context,
      initialDate: entry.startsAt,
      firstDate: startOfToday(),
      lastDate: startOfToday().add(const Duration(days: 365)),
    );
    if (date == null || !mounted) return;

    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(entry.startsAt),
    );
    if (time == null || !mounted) return;

    final startsAt = DateTime(date.year, date.month, date.day, time.hour, time.minute);

    setState(() => _busy = true);
    final result = await widget.controller.reschedule(entry, startsAt);
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
        backgroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        title: Text(
          title,
          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: Sc.ink),
        ),
        content: Text(
          message,
          style: const TextStyle(fontSize: 13.5, color: Sc.inkMuted, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('KEEP IT', style: TextStyle(color: Sc.slate, fontSize: 12.5)),
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
