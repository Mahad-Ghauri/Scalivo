import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../api/owner_booking_models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../widgets/owner_report_widgets.dart';
import '../widgets/sc_dropdown.dart';

class SlotPickerScreen extends StatefulWidget {
  const SlotPickerScreen({
    super.key,
    required this.serviceId,
    required this.staff,
    required this.date,
    this.staffId,
  });
  final String serviceId;
  final List<StaffSummary> staff;
  final DateTime date;
  final String? staffId;
  @override
  State<SlotPickerScreen> createState() => _SlotPickerScreenState();
}

class _SlotPickerScreenState extends State<SlotPickerScreen> {
  late DateTime _date;
  String? _staffId;
  List<AvailableSlot> _slots = const [];
  bool _loading = false;
  ApiException? _error;
  int _version = 0;
  List<StaffSummary> get _staff => widget.staff
      .where((s) => s.serviceIds.contains(widget.serviceId))
      .toList();
  @override
  void initState() {
    super.initState();
    final today = startOfToday(
      timezone: context.read<AuthController>().business!.timezone,
    );
    _date = widget.date.isBefore(today) ? today : widget.date;
    _staffId = _staff.any((s) => s.id == widget.staffId)
        ? widget.staffId
        : _staff.firstOrNull?.id;
    _load();
  }

  Future<void> _load() async {
    if (_loading) return;
    final version = ++_version;
    setState(() {
      _loading = true;
      _error = null;
      _slots = const [];
    });
    if (_staffId == null) {
      setState(() => _loading = false);
      return;
    }
    final auth = context.read<AuthController>();
    try {
      final slots = await auth.api.availability(
        auth.business!.id,
        serviceId: widget.serviceId,
        date: isoDate(_date),
        staffId: _staffId!,
      );
      if (!mounted || version != _version) return;
      setState(() {
        _slots = slots;
        _loading = false;
      });
    } on ApiException catch (err) {
      if (!mounted || version != _version) return;
      setState(() {
        _error = err;
        _loading = false;
      });
    }
  }

  Future<void> _pickDate() async {
    final today = startOfToday(
      timezone: context.read<AuthController>().business!.timezone,
    );
    final last = today.add(const Duration(days: 365));
    final date = await showDatePicker(
      context: context,
      initialDate: _date.isAfter(last) ? last : _date,
      firstDate: today,
      lastDate: last,
    );
    if (date == null || !mounted) return;
    setState(() => _date = date);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final zone = context.read<AuthController>().business!.timezone;
    return OwnerReportPage(
      title: 'Choose an available time',
      loading: _loading,
      error: _error,
      onRefresh: _load,
      children: [
        Text('Times in $zone. Availability is checked again when you save.'),
        TextButton.icon(
          onPressed: _loading ? null : _pickDate,
          icon: const Icon(Icons.calendar_month_outlined),
          label: Text(dayLabelLong(_date)),
        ),
        ScDropdown<String>(
          key: ValueKey(_staffId),
          label: 'With',
          value: _staffId,
          items: _staff.map((s) => s.id).toList(),
          itemLabel: (id) => _staff.firstWhere((s) => s.id == id).name,
          onChanged: _loading
              ? null
              : (id) {
                  setState(() => _staffId = id);
                  _load();
                },
        ),
        const SizedBox(height: 20),
        if (!_loading && _error == null && _slots.isEmpty)
          const Text(
            'No available times for this person and day. Choose another person or date.',
          ),
        for (final slot in _slots)
          ListTile(
            title: Text(hhmm(businessTime(slot.startsAt, timezone: zone))),
            trailing: const Icon(Icons.chevron_right),
            onTap: _loading ? null : () => Navigator.of(context).pop(slot),
          ),
      ],
    );
  }
}
