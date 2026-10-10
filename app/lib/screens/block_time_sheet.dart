import 'package:flutter/material.dart';

import '../api/models.dart';
import '../format.dart';
import '../state/calendar_controller.dart';
import '../theme.dart';
import '../widgets/sc_button.dart';
import '../widgets/sc_dropdown.dart';
import '../widgets/sc_field.dart';

/// Declaring time off-limits: Eid, a wedding, a supplier visit, a sick afternoon.
///
/// Not a booking, and deliberately not modelled as one. A blocked afternoon has
/// no customer, no service and no price, and forcing it through the booking path
/// would mean inventing all three. It removes future offers and nothing else.
///
/// **It does not refuse to cover existing appointments, and it must not claim
/// to.** The backend returns whatever is already inside the range instead, and
/// this sheet reports that count back rather than swallowing it — an owner
/// blocking Friday for a funeral has not thereby cancelled the three people
/// already in the diary, and telling them so is the whole point.
Future<bool> showBlockTimeSheet(
  BuildContext context, {
  required CalendarController controller,
  ResourceItem? resource,
}) async {
  final created = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: Sc.paper,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
    ),
    builder: (_) => _BlockTimeSheet(controller: controller, resource: resource),
  );
  return created ?? false;
}

/// Sentinel for "the whole business", which the wire spells as a null staffId.
const _everyone = StaffSummary(
  id: '',
  name: 'Everyone — the business is closed',
);

class _BlockTimeSheet extends StatefulWidget {
  const _BlockTimeSheet({required this.controller, this.resource});

  final CalendarController controller;
  final ResourceItem? resource;

  @override
  State<_BlockTimeSheet> createState() => _BlockTimeSheetState();
}

class _BlockTimeSheetState extends State<_BlockTimeSheet> {
  final _reason = TextEditingController();

  StaffSummary _who = _everyone;
  late DateTime _startsAt;
  late DateTime _endsAt;
  bool _busy = false;
  bool _loading = true;
  String? _formError;

  @override
  void initState() {
    super.initState();
    // Defaults to the day the owner is looking at, not to today: they opened
    // this from a calendar showing next Friday because next Friday is the
    // problem.
    final day = widget.controller.selectedDay;
    _startsAt = DateTime(day.year, day.month, day.day, 9);
    _endsAt = DateTime(day.year, day.month, day.day, 18);
    _loadStaff();
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _loadStaff() async {
    await widget.controller.ensureCatalogue();
    if (!mounted) return;
    setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final insets = MediaQuery.of(context).viewInsets.bottom;
    final staff = [_everyone, ...widget.controller.staffList];

    return Padding(
      padding: EdgeInsets.only(bottom: insets),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(22, 14, 22, 20),
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
              const Text(
                'Block time',
                style: TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w500,
                  color: Sc.ink,
                  letterSpacing: -0.2,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Stops new bookings in this window. Nothing already booked is touched.',
                style: TextStyle(fontSize: 13, color: Sc.slate),
              ),
              const SizedBox(height: 22),

              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 40),
                  child: Center(
                    child: CircularProgressIndicator(color: Sc.teal),
                  ),
                )
              else ...[
                if (widget.resource == null)
                  ScDropdown<StaffSummary>(
                    label: 'Who',
                    value: _who,
                    items: staff,
                    itemLabel: (s) => s.name,
                    onChanged: _busy
                        ? null
                        : (s) => setState(() => _who = s ?? _everyone),
                  )
                else
                  Text(
                    'Downtime for ${widget.resource!.name}',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                const SizedBox(height: 18),
                _when(
                  'From',
                  _startsAt,
                  (value) => setState(() {
                    _startsAt = value;
                    // Kept ahead of the start rather than validated after the
                    // fact: an end before its start is not a decision anyone
                    // makes, it is a half-finished edit.
                    if (!_endsAt.isAfter(_startsAt)) {
                      _endsAt = _startsAt.add(const Duration(hours: 1));
                    }
                  }),
                ),
                const SizedBox(height: 18),
                _when(
                  'Until',
                  _endsAt,
                  (value) => setState(() => _endsAt = value),
                ),
                const SizedBox(height: 18),
                ScField(
                  label: 'Reason',
                  controller: _reason,
                  hint: 'Eid, a wedding, a day off',
                  helper:
                      'Optional. Only you see it — it shows on the calendar '
                      'so the gap is not a mystery next week.',
                  enabled: !_busy,
                  textCapitalization: TextCapitalization.sentences,
                ),
                if (_formError != null) ...[
                  const SizedBox(height: 14),
                  Text(
                    _formError!,
                    style: const TextStyle(
                      fontSize: 12.5,
                      color: Sc.dangerText,
                      height: 1.4,
                    ),
                  ),
                ],
                const SizedBox(height: 24),
                ScButton(
                  label: 'Block it',
                  loadingLabel: 'Blocking',
                  loading: _busy,
                  onPressed: _submit,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _when(String label, DateTime value, ValueChanged<DateTime> onPicked) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w500,
            color: Sc.slate,
          ),
        ),
        const SizedBox(height: 8),
        InkWell(
          onTap: _busy ? null : () => _pick(value, onPicked),
          child: Container(
            constraints: const BoxConstraints(minHeight: 48),
            decoration: const BoxDecoration(
              border: Border(
                bottom: BorderSide(color: Sc.hairline, width: 1.5),
              ),
            ),
            padding: const EdgeInsets.only(bottom: 11, top: 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '${relativeDay(value)}, ${hhmm(value)}',
                    style: const TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w500,
                      color: Sc.ink,
                    ),
                  ),
                ),
                const Icon(
                  Icons.schedule_rounded,
                  size: 18,
                  color: Sc.slateLight,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _pick(DateTime current, ValueChanged<DateTime> onPicked) async {
    final date = await showDatePicker(
      context: context,
      initialDate: current,
      firstDate: startOfToday().subtract(const Duration(days: 30)),
      lastDate: startOfToday().add(const Duration(days: 365)),
    );
    if (date == null || !mounted) return;

    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(current),
    );
    if (time == null || !mounted) return;

    onPicked(DateTime(date.year, date.month, date.day, time.hour, time.minute));
  }

  Future<void> _submit() async {
    if (!_endsAt.isAfter(_startsAt)) {
      setState(() => _formError = 'The end has to come after the start.');
      return;
    }

    setState(() {
      _busy = true;
      _formError = null;
    });

    final result = await widget.controller.blockTime(
      // The empty id is this sheet's sentinel for "the business"; the wire wants
      // a null, and the conversion happens here rather than leaking either way.
      staffId: _who.id.isEmpty ? null : _who.id,
      resourceId: widget.resource?.id,
      startsAt: _startsAt,
      endsAt: _endsAt,
      reason: _reason.text.trim(),
    );

    if (!mounted) return;

    if (result.error != null) {
      setState(() {
        _busy = false;
        _formError =
            result.error!.fieldErrors.values.firstOrNull ??
            result.error!.message;
      });
      return;
    }

    Navigator.of(context).pop(true);

    final affected = result.affected;
    if (affected > 0) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          backgroundColor: Sc.warnTitle,
          duration: const Duration(seconds: 6),
          content: Text(
            '$affected ${affected == 1 ? 'appointment is' : 'appointments are'} '
            'already inside this block. They are still booked — move or cancel '
            'them yourself.',
          ),
        ),
      );
    }
  }
}
