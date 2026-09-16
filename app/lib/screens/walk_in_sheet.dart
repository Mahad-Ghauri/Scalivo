import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../state/calendar_controller.dart';
import '../theme.dart';
import '../widgets/sc_button.dart';
import '../widgets/sc_dropdown.dart';
import '../widgets/sc_field.dart';

/// Someone is standing at the desk.
///
/// The form asks for as little as the backend will accept: a service, a person
/// to do it, a time, and *either* a name or a phone number. Nothing else is
/// required, because the owner is typing this while a customer waits — and
/// because the CRM builds the rest of the profile itself from the booking.
///
/// The phone number is optional but heavily worth having, and the helper text
/// says why rather than just marking it optional: it is what links this walk-in
/// to the WhatsApp history of the same person, and it is the only way they get
/// a confirmation or a reminder at all.
Future<bool> showWalkInSheet(
  BuildContext context, {
  required CalendarController controller,
}) async {
  final created = await showModalBottomSheet<bool>(
    context: context,
    backgroundColor: Colors.white,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
    ),
    builder: (_) => _WalkInSheet(controller: controller),
  );
  return created ?? false;
}

class _WalkInSheet extends StatefulWidget {
  const _WalkInSheet({required this.controller});

  final CalendarController controller;

  @override
  State<_WalkInSheet> createState() => _WalkInSheetState();
}

class _WalkInSheetState extends State<_WalkInSheet> {
  final _name = TextEditingController();
  final _phone = TextEditingController();

  ServiceItem? _service;
  StaffSummary? _staff;
  late DateTime _startsAt = _nextQuarterHour();
  bool _busy = false;
  bool _loading = true;
  String? _formError;

  @override
  void initState() {
    super.initState();
    _loadCatalogue();
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _loadCatalogue() async {
    await widget.controller.ensureCatalogue();
    if (!mounted) return;
    setState(() {
      _loading = false;
      // Pre-selected when there is only one real answer. A single-service,
      // single-staff salon should not be asked two questions it cannot get
      // wrong — and pre-selecting the first of many would be a guess.
      if (widget.controller.services.length == 1) _service = widget.controller.services.first;
      if (widget.controller.staffList.length == 1) _staff = widget.controller.staffList.first;
    });
  }

  /// Now, rounded up to the grid the booking system actually works on.
  ///
  /// An off-grid start is refused by the server — occupancy rows would land on
  /// points a genuinely overlapping booking never touches — so offering 14:07
  /// would be offering a time that cannot be booked.
  static DateTime _nextQuarterHour() {
    final now = DateTime.now();
    final rounded = DateTime(now.year, now.month, now.day, now.hour, (now.minute ~/ 15) * 15);
    return rounded.isBefore(now) ? rounded.add(const Duration(minutes: 15)) : rounded;
  }

  @override
  Widget build(BuildContext context) {
    final controller = widget.controller;
    final insets = MediaQuery.of(context).viewInsets.bottom;

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
                'Walk-in',
                style: TextStyle(
                  fontSize: 21,
                  fontWeight: FontWeight.w700,
                  color: Sc.ink,
                  letterSpacing: -0.2,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Books the same way WhatsApp does, so the slot is really held.',
                style: TextStyle(fontSize: 13, color: Sc.slate),
              ),
              const SizedBox(height: 22),

              if (_loading)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 40),
                  child: Center(child: CircularProgressIndicator(color: Sc.teal)),
                )
              else if (controller.services.isEmpty || controller.staffList.isEmpty)
                _needsSetup(controller)
              else ...[
                ScDropdown<ServiceItem>(
                  label: 'Service',
                  value: _service,
                  items: controller.services,
                  itemLabel: (s) => '${s.name} — ${duration(s.durationMinutes)}, ${money(s.priceMinor)}',
                  onChanged: _busy ? null : (s) => setState(() => _service = s),
                ),
                const SizedBox(height: 18),
                ScDropdown<StaffSummary>(
                  label: 'With',
                  value: _staff,
                  items: controller.staffList,
                  itemLabel: (s) => s.name,
                  onChanged: _busy ? null : (s) => setState(() => _staff = s),
                ),
                const SizedBox(height: 18),
                _timeRow(),
                const SizedBox(height: 18),
                ScField(
                  label: 'Name',
                  controller: _name,
                  hint: 'Who is it for?',
                  enabled: !_busy,
                  textCapitalization: TextCapitalization.words,
                ),
                const SizedBox(height: 18),
                ScField(
                  label: 'Phone',
                  controller: _phone,
                  hint: '0320 926 3011',
                  helper: 'Optional — but without it they get no confirmation, no '
                      'reminder, and a separate profile from their WhatsApp history.',
                  enabled: !_busy,
                  keyboardType: TextInputType.phone,
                ),
                if (_formError != null) ...[
                  const SizedBox(height: 14),
                  Text(
                    _formError!,
                    style: const TextStyle(fontSize: 12.5, color: Sc.dangerText, height: 1.4),
                  ),
                ],
                const SizedBox(height: 24),
                ScButton(
                  label: 'Book it',
                  loadingLabel: 'Booking',
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

  Widget _needsSetup(CalendarController controller) {
    final missing = controller.services.isEmpty ? 'a service' : 'a staff member';
    return Container(
      decoration: BoxDecoration(
        color: Sc.warnBg,
        borderRadius: BorderRadius.circular(14),
      ),
      padding: const EdgeInsets.fromLTRB(16, 15, 16, 15),
      child: Text(
        'Add $missing before booking anyone in. Nothing can be booked until the '
        'business knows what it sells and who does it.',
        style: const TextStyle(fontSize: 13, color: Sc.warnBody, height: 1.5),
      ),
    );
  }

  Widget _timeRow() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Starts',
          style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500, color: Sc.slate),
        ),
        const SizedBox(height: 8),
        InkWell(
          onTap: _busy ? null : _pickTime,
          child: Container(
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: Sc.hairline, width: 1.5)),
            ),
            padding: const EdgeInsets.only(bottom: 11, top: 4),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    '${relativeDay(_startsAt)}, ${hhmm(_startsAt)}',
                    style: const TextStyle(
                      fontSize: 15.5,
                      fontWeight: FontWeight.w500,
                      color: Sc.ink,
                    ),
                  ),
                ),
                const Icon(Icons.schedule_rounded, size: 18, color: Sc.slateLight),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _pickTime() async {
    final date = await showDatePicker(
      context: context,
      initialDate: _startsAt,
      firstDate: startOfToday(),
      lastDate: startOfToday().add(const Duration(days: 365)),
    );
    if (date == null || !mounted) return;

    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_startsAt),
    );
    if (time == null || !mounted) return;

    setState(() {
      _startsAt = DateTime(date.year, date.month, date.day, time.hour, time.minute);
    });
  }

  Future<void> _submit() async {
    final name = _name.text.trim();
    final phone = _phone.text.trim();

    if (_service == null || _staff == null) {
      setState(() => _formError = 'Pick a service and who is doing it.');
      return;
    }
    // Mirrors the backend's own refusal rather than trusting it: a nameless,
    // numberless walk-in is not a customer, it is an empty row.
    if (name.isEmpty && phone.isEmpty) {
      setState(() => _formError = 'A name or a phone number — we need something to call them.');
      return;
    }

    setState(() {
      _busy = true;
      _formError = null;
    });

    final failure = await widget.controller.walkIn(
      serviceId: _service!.id,
      staffId: _staff!.id,
      startsAt: _startsAt,
      name: name,
      phone: phone,
    );

    if (!mounted) return;
    setState(() => _busy = false);

    if (failure != null) {
      setState(() => _formError = _explain(failure));
      return;
    }

    Navigator.of(context).pop(true);
  }

  /// The server's reasons, in the owner's words.
  ///
  /// `slot_taken` is the one that matters: it is not a mistake the owner made,
  /// it is two people booking the same chair, and the day underneath has already
  /// been refreshed to show why.
  String _explain(ApiException err) {
    if (err.kind == ApiErrorKind.conflict) {
      return 'That time just went — check the day and pick another.';
    }
    if (err.kind == ApiErrorKind.network) return err.message;
    return err.fieldErrors.values.firstOrNull ?? err.message;
  }
}
