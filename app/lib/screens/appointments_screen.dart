import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../api/owner_booking_models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../state/calendar_controller.dart';
import '../widgets/owner_report_widgets.dart';
import '../widgets/sc_button.dart';
import '../widgets/sc_dropdown.dart';
import 'booking_sheet.dart';

class AppointmentsScreen extends StatefulWidget {
  const AppointmentsScreen({super.key});
  @override
  State<AppointmentsScreen> createState() => _AppointmentsScreenState();
}

class _AppointmentsScreenState extends State<AppointmentsScreen> {
  final _search = TextEditingController();
  late final AuthController _auth = context.read<AuthController>();
  late final String _businessId = _auth.business!.id;
  late final CalendarController _calendar = CalendarController(
    api: _auth.api,
    businessId: _businessId,
  );
  AppointmentPage? _page;
  List<ServiceItem> _services = const [];
  List<StaffMember> _staff = const [];
  String? _status, _staffId, _serviceId, _from, _to;
  int _skip = 0;
  bool _loading = false, _catalogueLoaded = false;
  ApiException? _error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    _calendar.dispose();
    super.dispose();
  }

  Future<void> _load({bool reset = false}) async {
    if (_loading) return;
    if (reset) _skip = 0;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (!_catalogueLoaded) {
        await Future.wait([
          _auth.api.allServices(_businessId).then((rows) => _services = rows),
          _auth.api.allStaff(_businessId).then((rows) => _staff = rows),
        ]);
        _catalogueLoaded = true;
      }
      final page = await _auth.api.appointments(
        _businessId,
        q: _search.text,
        status: _status,
        staffId: _staffId,
        serviceId: _serviceId,
        from: _from,
        to: _to,
        skip: _skip,
      );
      if (!mounted) return;
      setState(() {
        _page = page;
        _loading = false;
      });
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() {
        _page = null;
        _error = err;
        _loading = false;
      });
    }
  }

  Future<void> _date(bool from) async {
    final value = from ? _from : _to;
    final picked = await showDatePicker(
      context: context,
      initialDate: value == null
          ? startOfToday(timezone: _auth.business!.timezone)
          : parseIsoDate(value),
      firstDate: DateTime(2000),
      lastDate: DateTime(2100),
    );
    if (picked == null || !mounted) return;
    setState(() {
      if (from) {
        _from = isoDate(picked);
      } else {
        _to = isoDate(picked);
      }
    });
    await _load(reset: true);
  }

  Future<void> _open(CalendarEntry entry) async {
    await showBookingSheet(context, controller: _calendar, entry: entry);
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) => OwnerReportPage(
    title: 'Appointments',
    loading: _loading,
    error: _error,
    onRefresh: _load,
    children: [
      TextField(
        controller: _search,
        enabled: !_loading,
        maxLength: 120,
        textInputAction: TextInputAction.search,
        decoration: const InputDecoration(
          labelText: 'Search customer name or phone',
        ),
        onSubmitted: (_) => _load(reset: true),
      ),
      TextButton.icon(
        onPressed: _loading ? null : () => _load(reset: true),
        icon: const Icon(Icons.search),
        label: const Text('Search'),
      ),
      ScDropdown<String>(
        key: ValueKey('status:$_status'),
        label: 'Status',
        value: _status ?? '',
        items: const ['', ...appointmentStatuses],
        itemLabel: (value) =>
            value.isEmpty ? 'All statuses' : value.replaceAll('_', ' '),
        onChanged: _loading
            ? null
            : (value) {
                setState(() => _status = value == '' ? null : value);
                _load(reset: true);
              },
      ),
      const SizedBox(height: 16),
      ScDropdown<String>(
        key: ValueKey('service:$_serviceId'),
        label: 'Service',
        value: _serviceId ?? '',
        items: ['', ..._services.map((s) => s.id)],
        itemLabel: (id) => id.isEmpty
            ? 'All services'
            : _services.firstWhere((s) => s.id == id).name,
        onChanged: _loading
            ? null
            : (value) {
                setState(() => _serviceId = value == '' ? null : value);
                _load(reset: true);
              },
      ),
      const SizedBox(height: 16),
      ScDropdown<String>(
        key: ValueKey('staff:$_staffId'),
        label: 'Staff',
        value: _staffId ?? '',
        items: ['', ..._staff.map((s) => s.id)],
        itemLabel: (id) => id.isEmpty
            ? 'All staff'
            : _staff.firstWhere((s) => s.id == id).name,
        onChanged: _loading
            ? null
            : (value) {
                setState(() => _staffId = value == '' ? null : value);
                _load(reset: true);
              },
      ),
      Wrap(
        spacing: 12,
        children: [
          TextButton(
            onPressed: _loading ? null : () => _date(true),
            child: Text('From: ${_from ?? 'Any date'}'),
          ),
          TextButton(
            onPressed: _loading ? null : () => _date(false),
            child: Text('To: ${_to ?? 'Any date'}'),
          ),
          if (_from != null || _to != null)
            TextButton(
              onPressed: _loading
                  ? null
                  : () {
                      setState(() {
                        _from = null;
                        _to = null;
                      });
                      _load(reset: true);
                    },
              child: const Text('Clear dates'),
            ),
        ],
      ),
      if (_page != null && !_loading) ...[
        Text('${_page!.total} appointments'),
        if (_page!.bookings.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 24),
            child: Text('No appointments match these filters.'),
          ),
        for (final entry in _page!.bookings)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(
              '${entry.clientName ?? 'Walk-in'} · ${entry.serviceName}',
            ),
            subtitle: Text(
              '${dayLabel(entry.startsAt)} · ${hhmm(entry.startsAt)}\n${entry.staffName} · ${entry.status.replaceAll('_', ' ')}',
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _open(entry),
          ),
        Wrap(
          spacing: 16,
          children: [
            if (_skip > 0)
              ScButton(
                label: 'Previous',
                onPressed: () {
                  _skip -= 20;
                  _load();
                },
              ),
            if (_skip + _page!.bookings.length < _page!.total && _skip < 100000)
              ScButton(
                label: 'Next',
                onPressed: () {
                  _skip += 20;
                  _load();
                },
              ),
          ],
        ),
      ],
    ],
  );
}
