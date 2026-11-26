import 'dart:convert';
import 'dart:math';

import 'appointment_holders_screen.dart';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../state/auth_controller.dart';
import '../api/owner_booking_models.dart';
import 'slot_picker_screen.dart';
import 'client_picker_screen.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../state/calendar_controller.dart';
import '../widgets/follow_up_fields.dart';
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
    backgroundColor: Sc.paper,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
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
  final _followUpDays = TextEditingController(text: '21');
  final _followUpNote = TextEditingController();
  bool _followUp = false;

  ServiceItem? _service;
  StaffSummary? _staff;
  late DateTime _startsAt = startOfToday(
    timezone: context.read<AuthController>().business!.timezone,
  );
  bool _busy = false;
  bool _selectedTime = false;
  ClientRow? _client;
  AppointmentHolderItem? _holder;
  final List<({ServiceItem? service, StaffSummary? staff})> _additional = [];
  String? _requestId;
  List<SequenceAppointment> _planned = const [];
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
    _followUpDays.dispose();
    _followUpNote.dispose();
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
      if (widget.controller.services.length == 1) {
        _service = widget.controller.services.first;
      }
      final eligible = widget.controller.staffList
          .where((s) => _service != null && s.serviceIds.contains(_service!.id))
          .toList();
      if (eligible.length == 1) _staff = eligible.first;
    });
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
                  fontSize: 26,
                  fontWeight: FontWeight.w500,
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
                  child: Center(
                    child: CircularProgressIndicator(color: Sc.teal),
                  ),
                )
              else if (controller.services.isEmpty ||
                  controller.staffList.isEmpty)
                _needsSetup(controller)
              else ...[
                ScDropdown<ServiceItem>(
                  label: 'Service',
                  value: _service,
                  items: controller.services,
                  itemLabel: (s) =>
                      '${s.name} — ${duration(s.durationMinutes)}, ${money(s.priceMinor)}',
                  onChanged: _busy
                      ? null
                      : (s) => setState(() {
                          _service = s;
                          // Pre-filled from the service's default, and
                          // switched on when the service has one.
                          _followUp = s?.followUpDays != null;
                          _followUpDays.text = '${s?.followUpDays ?? 21}';
                          _followUpNote.text = s?.followUpNote ?? '';
                          _selectedTime = false;
                          _requestId = null;
                          _staff = null;
                        }),
                ),
                const SizedBox(height: 18),
                ScDropdown<StaffSummary>(
                  key: ValueKey('${_service?.id}:${_staff?.id}'),
                  label: 'With',
                  value: _staff,
                  items: controller.staffList
                      .where(
                        (s) =>
                            _service == null ||
                            s.serviceIds.contains(_service!.id),
                      )
                      .toList(),
                  itemLabel: (s) => s.name,
                  onChanged: _busy
                      ? null
                      : (s) => setState(() {
                          _staff = s;
                          _selectedTime = false;
                          _requestId = null;
                        }),
                ),
                const SizedBox(height: 18),
                for (var index = 0; index < _additional.length; index++) ...[
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Treatment ${index + 2}',
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Remove treatment',
                        onPressed: _busy
                            ? null
                            : () => setState(() {
                                _additional.removeAt(index);
                                _requestId = null;
                                _selectedTime = false;
                              }),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                  ScDropdown<ServiceItem>(
                    label: 'Service',
                    value: _additional[index].service,
                    items: controller.services,
                    itemLabel: (service) =>
                        '${service.name} — ${duration(service.durationMinutes)}',
                    onChanged: _busy
                        ? null
                        : (service) => setState(() {
                            _additional[index] = (
                              service: service,
                              staff: null,
                            );
                            _requestId = null;
                            _selectedTime = false;
                          }),
                  ),
                  const SizedBox(height: 12),
                  ScDropdown<StaffSummary>(
                    key: ValueKey(
                      'extra:$index:${_additional[index].service?.id}:${_additional[index].staff?.id}',
                    ),
                    label: 'With',
                    value: _additional[index].staff,
                    items: controller.staffList
                        .where(
                          (staff) =>
                              _additional[index].service != null &&
                              staff.serviceIds.contains(
                                _additional[index].service!.id,
                              ),
                        )
                        .toList(),
                    itemLabel: (staff) => staff.name,
                    onChanged: _busy
                        ? null
                        : (staff) => setState(() {
                            _additional[index] = (
                              service: _additional[index].service,
                              staff: staff,
                            );
                            _requestId = null;
                            _selectedTime = false;
                          }),
                  ),
                  const SizedBox(height: 18),
                ],
                if (_additional.length < 4)
                  TextButton.icon(
                    onPressed: _busy
                        ? null
                        : () => setState(() {
                            _additional.add((service: null, staff: null));
                            _selectedTime = false;
                            _requestId = null;
                          }),
                    icon: const Icon(Icons.add),
                    label: const Text('Add consecutive treatment'),
                  ),
                if (_additional.isNotEmpty)
                  const Text(
                    'Treatments run in this order with cleanup gaps included. All staff, rooms and equipment must be available; either the whole visit is booked or nothing is.',
                    style: TextStyle(color: Sc.slate, height: 1.5),
                  ),
                const SizedBox(height: 18),
                _timeRow(),
                if (_selectedTime && _additional.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  for (final appointment in _planned)
                    Text(
                      '${controller.services.firstWhere((service) => service.id == appointment.serviceId).name} with ${controller.staffList.firstWhere((member) => member.id == appointment.staffId).name} · ${hhmm(businessTime(appointment.startsAt, timezone: context.read<AuthController>().business!.timezone))}',
                      style: const TextStyle(color: Sc.slate, height: 1.5),
                    ),
                ],
                const SizedBox(height: 18),
                TextButton.icon(
                  onPressed: _busy ? null : _chooseClient,
                  icon: const Icon(Icons.person_search_outlined),
                  label: Text(
                    _client == null
                        ? 'Choose existing customer'
                        : 'Change customer',
                  ),
                ),
                if (_client != null)
                  TextButton(
                    onPressed: _busy
                        ? null
                        : () => setState(() {
                            _client = null;
                            _holder = null;
                            _name.clear();
                            _phone.clear();
                          }),
                    child: const Text('Enter a new customer'),
                  ),
                if (_client != null)
                  TextButton.icon(
                    onPressed: _busy ? null : _chooseHolder,
                    icon: const Icon(Icons.people_outline),
                    label: Text(
                      'Appointment for: ${_holder?.name ?? _client!.displayName ?? 'Customer themselves'}',
                    ),
                  ),
                ScField(
                  label: 'Name',
                  maxLength: 120,
                  controller: _name,
                  hint: 'Who is it for?',
                  enabled: !_busy && _client == null,
                  textCapitalization: TextCapitalization.words,
                ),
                const SizedBox(height: 18),
                ScField(
                  label: 'Phone',
                  maxLength: 32,
                  controller: _phone,
                  hint: '0320 926 3011',
                  helper:
                      'Optional — but without it they get no confirmation, no '
                      'reminder, and a separate profile from their WhatsApp history.',
                  enabled: !_busy && _client == null,
                  keyboardType: TextInputType.phone,
                ),
                const SizedBox(height: 18),
                FollowUpFields(
                  enabled: _followUp,
                  busy: _busy,
                  onToggle: (on) => setState(() => _followUp = on),
                  days: _followUpDays,
                  note: _followUpNote,
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
    final missing = controller.services.isEmpty
        ? 'a service'
        : 'a staff member';
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
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w500,
            color: Sc.slate,
          ),
        ),
        const SizedBox(height: 8),
        InkWell(
          onTap: _busy ? null : _pickTime,
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
                    _selectedTime
                        ? '${relativeDay(_startsAt)}, ${hhmm(_startsAt)}'
                        : 'Choose an available time',
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

  Future<void> _pickTime() async {
    if (_service == null) {
      setState(() => _formError = 'Choose a service first.');
      return;
    }
    if (_additional.any((step) => step.service == null || step.staff == null)) {
      setState(
        () => _formError =
            'Choose a service and professional for every treatment first.',
      );
      return;
    }
    final slot = await Navigator.of(context).push<AvailableSlot>(
      MaterialPageRoute(
        builder: (_) => SlotPickerScreen(
          serviceId: _service!.id,
          staff: widget.controller.staffList,
          date: _startsAt,
          staffId: _staff?.id,
          additionalServices: [
            for (final step in _additional)
              {'serviceId': step.service!.id, 'staffId': step.staff!.id},
          ],
        ),
      ),
    );
    if (slot == null || !mounted) return;
    setState(() {
      _requestId = null;
      _startsAt = businessTime(
        slot.startsAt,
        timezone: context.read<AuthController>().business!.timezone,
      );
      _staff = widget.controller.staffList.firstWhere(
        (s) => s.id == slot.staffId,
      );
      _selectedTime = true;
      _planned = slot.appointments;
    });
  }

  Future<void> _chooseClient() async {
    final client = await Navigator.of(context).push<ClientRow>(
      MaterialPageRoute(builder: (_) => const ClientPickerScreen()),
    );
    if (client == null || !mounted) return;
    setState(() {
      _client = client;
      _holder = null;
      _requestId = null;
      _name.text = client.displayName ?? '';
      _phone.text = client.phone ?? '';
    });
  }

  Future<void> _chooseHolder() async {
    final client = _client;
    if (client == null) return;
    final holder = await Navigator.of(context).push<AppointmentHolderItem>(
      MaterialPageRoute(
        builder: (_) =>
            AppointmentHoldersScreen(clientId: client.clientId, select: true),
      ),
    );
    if (!mounted || holder == null) return;
    setState(() {
      _holder = holder.id.isEmpty ? null : holder;
      _requestId = null;
    });
  }

  Future<void> _submit() async {
    final name = _name.text.trim();
    final phone = _phone.text.trim();

    if (_service == null || _staff == null) {
      setState(() => _formError = 'Pick a service and who is doing it.');
      return;
    }
    if (_additional.any((step) => step.service == null || step.staff == null)) {
      setState(
        () => _formError =
            'Choose a service and staff member for every treatment.',
      );
      return;
    }
    // Mirrors the backend's own refusal rather than trusting it: a nameless,
    // numberless walk-in is not a customer, it is an empty row.
    if (!_selectedTime || name.length > 120 || phone.length > 32) {
      setState(
        () =>
            _formError = 'Choose an available time and check customer details.',
      );
      return;
    }
    if (_client == null && name.isEmpty && phone.isEmpty) {
      setState(
        () => _formError =
            'A name or a phone number — we need something to call them.',
      );
      return;
    }

    final followUpDays = _followUp
        ? FollowUpFields.parseDays(_followUpDays.text)
        : null;
    if (_followUp && followUpDays == null) {
      setState(() => _formError = 'Follow-up days must be a whole number from 1 to 365.');
      return;
    }

    setState(() {
      _busy = true;
      _formError = null;
    });

    final random = Random.secure();
    if (_additional.isNotEmpty) {
      _requestId ??= base64UrlEncode(
        List<int>.generate(24, (_) => random.nextInt(256)),
      ).replaceAll('=', '');
    }
    final result = await widget.controller.walkIn(
      serviceId: _service!.id,
      staffId: _staff!.id,
      startsAt: _startsAt,
      name: _client == null ? name : null,
      phone: _client == null ? phone : null,
      clientId: _client?.clientId,
      appointmentHolderId: _holder?.id,
      additionalServices: [
        for (final step in _additional)
          {'serviceId': step.service!.id, 'staffId': step.staff!.id},
      ],
      requestId: _additional.isEmpty ? null : _requestId,
      followUpDays: followUpDays,
      followUpNote: _followUp ? FollowUpFields.cleanNote(_followUpNote.text) : null,
    );
    final failure = result.error;

    if (!mounted) return;
    setState(() => _busy = false);

    if (failure != null) {
      setState(() {
        _formError = _explain(failure);
        _selectedTime = false;
      });
      return;
    }

    if (result.followUpError != null) {
      // Booked either way — say so, and where to add the follow-up instead.
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          content: Text(
            "Booked, but the follow-up wasn't saved: "
            '${result.followUpError!.message}. Add it from the appointment.',
          ),
        ),
      );
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
