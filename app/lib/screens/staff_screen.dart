import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/sc_button.dart';
import '../widgets/sc_field.dart';

/// Who works, on what, and when.
///
/// Two things on this screen decide whether anything can be booked at all, and
/// both fail SILENTLY when they are wrong — availability simply returns an empty
/// list, which is indistinguishable from a fully booked day:
///
///   - **No services ticked.** The person exists, the diary is open, and nothing
///     can be booked with them, because availability filters staff by the
///     service asked for.
///   - **No working days.** Same outcome, different cause.
///
/// So both are called out on the row rather than left for the owner to deduce
/// from an empty calendar a week later.
class StaffScreen extends StatefulWidget {
  const StaffScreen({super.key});

  @override
  State<StaffScreen> createState() => _StaffScreenState();
}

class _StaffScreenState extends State<StaffScreen> {
  late final ApiClient _api = context.read<AuthController>().api;
  late final String _businessId = context.read<AuthController>().business!.id;

  List<StaffMember> _staff = const [];
  List<ServiceItem> _services = const [];
  ApiException? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final loaded = await Future.wait([
        _api.allStaff(_businessId),
        _api.allServices(_businessId),
      ]);
      if (!mounted) return;
      setState(() {
        _staff = loaded[0] as List<StaffMember>;
        _services = loaded[1] as List<ServiceItem>;
        _error = null;
        _loading = false;
      });
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final live = _staff.where((s) => s.active).toList();
    final gone = _staff.where((s) => !s.active).toList();

    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        elevation: 0,
        iconTheme: const IconThemeData(color: Sc.ink),
        title: const Text(
          'Staff',
          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: Sc.ink),
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _services.isEmpty ? null : () => _edit(null),
        backgroundColor: _services.isEmpty ? Sc.tealDisabled : Sc.teal,
        foregroundColor: Colors.white,
        shape: const CircleBorder(),
        child: const Icon(Icons.add_rounded, size: 26),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Sc.teal))
          : RefreshIndicator(
              color: Sc.teal,
              onRefresh: _load,
              child: ListView(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(22, 4, 22, 90),
                children: [
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: Text(
                        _error!.message,
                        style: const TextStyle(fontSize: 13, color: Sc.dangerText),
                      ),
                    ),
                  // Staff cannot be added before services exist: the form's
                  // service list would be empty, and a staff member with nothing
                  // ticked is a person nobody can book.
                  if (_services.isEmpty) _servicesFirst(),
                  if (_services.isNotEmpty && live.isEmpty && gone.isEmpty) _empty(),
                  for (final member in live) _row(member),
                  if (gone.isNotEmpty) ...[
                    const SizedBox(height: 26),
                    const Text(
                      'NO LONGER WORKING HERE',
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.8,
                        color: Sc.slateLight,
                      ),
                    ),
                    const SizedBox(height: 10),
                    for (final member in gone) _row(member),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _servicesFirst() {
    return Container(
      decoration: BoxDecoration(color: Sc.warnBg, borderRadius: BorderRadius.circular(14)),
      padding: const EdgeInsets.fromLTRB(16, 15, 16, 15),
      child: const Text(
        'Add a service first. A staff member is defined by what they can do, and '
        'somebody with nothing ticked cannot be booked for anything.',
        style: TextStyle(fontSize: 13, color: Sc.warnBody, height: 1.5),
      ),
    );
  }

  Widget _empty() {
    return const Padding(
      padding: EdgeInsets.only(top: 60),
      child: Column(
        children: [
          Icon(Icons.badge_outlined, size: 32, color: Sc.slateFaint),
          SizedBox(height: 14),
          Text(
            'No staff yet',
            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Sc.inkMuted),
          ),
          SizedBox(height: 7),
          Text(
            'Add yourself if you work alone — the diary needs somebody to book against.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13, color: Sc.slate, height: 1.5),
          ),
        ],
      ),
    );
  }

  Widget _row(StaffMember member) {
    final names = _services
        .where((s) => member.serviceIds.contains(s.id))
        .map((s) => s.name)
        .toList();

    // Either gap means nothing can be booked, and neither produces an error
    // anywhere — just an empty calendar the owner has no way to explain.
    final warning = switch ((member.serviceIds.isEmpty, member.workingHours.isEmpty)) {
      (true, _) => 'No services — nothing can be booked with them',
      (_, true) => 'No working days set — nothing can be booked with them',
      _ => null,
    };

    return Opacity(
      opacity: member.active ? 1 : 0.55,
      child: InkWell(
        onTap: () => _edit(member),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 13),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      member.name,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: Sc.ink,
                      ),
                    ),
                    const SizedBox(height: 3),
                    if (warning != null)
                      Text(
                        warning,
                        style: const TextStyle(fontSize: 12.5, color: Sc.dangerText),
                      )
                    else
                      Text(
                        '${names.length == _services.where((s) => s.active).length ? 'Everything' : names.join(', ')}'
                        ' · ${member.workingHours.length} ${member.workingHours.length == 1 ? 'day' : 'days'} a week',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12.5, color: Sc.slate),
                      ),
                  ],
                ),
              ),
              IconButton(
                tooltip: member.active ? 'Remove' : 'Bring back',
                visualDensity: VisualDensity.compact,
                onPressed: () => _toggleActive(member),
                icon: Icon(
                  member.active ? Icons.person_remove_outlined : Icons.person_add_alt_1_outlined,
                  size: 18,
                  color: Sc.slateLight,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _toggleActive(StaffMember member) async {
    if (member.active) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          backgroundColor: Colors.white,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
          title: Text(
            'Remove ${member.name}?',
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: Sc.ink),
          ),
          content: const Text(
            // The honest warning: deactivating does not touch their diary, and
            // an owner who assumes otherwise leaves customers with appointments
            // nobody is coming to.
            'They stop appearing for new bookings. Appointments already in their '
            'diary stay exactly where they are — you will need to move or cancel '
            'those yourself.',
            style: TextStyle(fontSize: 13.5, color: Sc.inkMuted, height: 1.5),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('KEEP', style: TextStyle(color: Sc.slate, fontSize: 12.5)),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text(
                'REMOVE',
                style: TextStyle(color: Sc.danger, fontSize: 12.5, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      );
      if (ok != true) return;
    }

    try {
      await _api.setStaffActive(_businessId, member.id, !member.active);
    } on ApiException catch (err) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          backgroundColor: Sc.dangerTitle,
          content: Text(err.message),
        ),
      );
    }
    await _load();
  }

  Future<void> _edit(StaffMember? member) async {
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(
        builder: (_) => StaffEditScreen(
          api: _api,
          businessId: _businessId,
          services: _services.where((s) => s.active).toList(),
          member: member,
        ),
      ),
    );
    if (saved == true) await _load();
  }
}

/// A full screen rather than a sheet: the working-hours editor is seven rows of
/// two time pickers and it does not fit anywhere smaller without scrolling under
/// the keyboard.
class StaffEditScreen extends StatefulWidget {
  const StaffEditScreen({
    super.key,
    required this.api,
    required this.businessId,
    required this.services,
    this.member,
  });

  final ApiClient api;
  final String businessId;
  final List<ServiceItem> services;
  final StaffMember? member;

  @override
  State<StaffEditScreen> createState() => _StaffEditScreenState();
}

class _StaffEditScreenState extends State<StaffEditScreen> {
  /// Monday first, because a working week reads that way — but the VALUE is
  /// dayOfWeek with 0 = Sunday, which is what the backend's availability uses.
  static const _week = [
    (1, 'Monday'),
    (2, 'Tuesday'),
    (3, 'Wednesday'),
    (4, 'Thursday'),
    (5, 'Friday'),
    (6, 'Saturday'),
    (0, 'Sunday'),
  ];

  late final _name = TextEditingController(text: widget.member?.name ?? '');
  late final Set<String> _serviceIds = {...?widget.member?.serviceIds};

  /// Keyed by dayOfWeek. A day absent from the map is a day off — there is no
  /// `closed` flag on the wire, and inventing one here would mean sending the
  /// backend something its schema does not have.
  late final Map<int, WorkingDay> _days = {
    for (final day in widget.member?.workingHours ?? const <WorkingDay>[]) day.dayOfWeek: day,
  };

  bool _busy = false;
  Map<String, String> _fieldErrors = const {};
  String? _formError;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        elevation: 0,
        iconTheme: const IconThemeData(color: Sc.ink),
        title: Text(
          widget.member == null ? 'New staff member' : widget.member!.name,
          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: Sc.ink),
        ),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(22, 8, 22, 40),
        children: [
          ScField(
            label: 'Name',
            controller: _name,
            hint: 'Ayesha',
            enabled: !_busy,
            errorText: _fieldErrors['name'],
            textCapitalization: TextCapitalization.words,
          ),
          const SizedBox(height: 26),
          _sectionTitle('Can do', _fieldErrors['serviceIds']),
          const SizedBox(height: 4),
          for (final service in widget.services) _serviceToggle(service),
          const SizedBox(height: 26),
          _sectionTitle('Works', _fieldErrors['workingHours']),
          const SizedBox(height: 4),
          const Text(
            'Switch a day on and set the hours. Customers are only ever offered '
            'times inside these.',
            style: TextStyle(fontSize: 12.5, color: Sc.slate, height: 1.5),
          ),
          const SizedBox(height: 10),
          for (final (value, label) in _week) _dayRow(value, label),
          if (_formError != null) ...[
            const SizedBox(height: 18),
            Text(
              _formError!,
              style: const TextStyle(fontSize: 12.5, color: Sc.dangerText, height: 1.4),
            ),
          ],
          const SizedBox(height: 28),
          ScButton(
            label: widget.member == null ? 'Add' : 'Save',
            loadingLabel: 'Saving',
            loading: _busy,
            onPressed: _submit,
          ),
          const SizedBox(height: 12),
          if (_days.isNotEmpty)
            TextButton(
              onPressed: _busy ? null : _copyMondayToAll,
              child: const Text(
                'COPY THE FIRST OPEN DAY TO ALL OPEN DAYS',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.6,
                  color: Sc.teal,
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _sectionTitle(String text, String? error) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        Text(
          text,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Sc.ink),
        ),
        if (error != null) ...[
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              error,
              style: const TextStyle(fontSize: 12, color: Sc.dangerText),
            ),
          ),
        ],
      ],
    );
  }

  Widget _serviceToggle(ServiceItem service) {
    final on = _serviceIds.contains(service.id);

    return InkWell(
      onTap: _busy
          ? null
          : () => setState(() => on ? _serviceIds.remove(service.id) : _serviceIds.add(service.id)),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 9),
        child: Row(
          children: [
            Icon(
              on ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded,
              size: 20,
              color: on ? Sc.teal : Sc.slateFaint,
            ),
            const SizedBox(width: 11),
            Expanded(
              child: Text(
                service.name,
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: on ? FontWeight.w600 : FontWeight.w400,
                  color: on ? Sc.ink : Sc.inkMuted,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _dayRow(int dayOfWeek, String label) {
    final day = _days[dayOfWeek];
    final open = day != null;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 92,
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13.5,
                fontWeight: open ? FontWeight.w600 : FontWeight.w400,
                color: open ? Sc.ink : Sc.slateLight,
              ),
            ),
          ),
          Switch(
            value: open,
            activeThumbColor: Colors.white,
            activeTrackColor: Sc.teal,
            onChanged: _busy ? null : (on) => _toggleDay(dayOfWeek, on),
          ),
          const SizedBox(width: 4),
          if (open)
            Expanded(
              child: Row(
                children: [
                  _timeButton(day.opensAt, (t) => _setDay(dayOfWeek, day.copyWith(opensAt: t))),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 6),
                    child: Text('–', style: TextStyle(fontSize: 13, color: Sc.slateLight)),
                  ),
                  _timeButton(day.closesAt, (t) => _setDay(dayOfWeek, day.copyWith(closesAt: t))),
                ],
              ),
            )
          else
            const Expanded(
              child: Text('Closed', style: TextStyle(fontSize: 13, color: Sc.slateFaint)),
            ),
        ],
      ),
    );
  }

  Widget _timeButton(String value, ValueChanged<String> onPicked) {
    return Material(
      color: Sc.tealSurface,
      borderRadius: BorderRadius.circular(9),
      child: InkWell(
        onTap: _busy ? null : () => _pickTime(value, onPicked),
        borderRadius: BorderRadius.circular(9),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: Sc.divider),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
          child: Text(
            value,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: Sc.ink,
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _pickTime(String current, ValueChanged<String> onPicked) async {
    final parts = current.split(':');
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1])),
    );
    if (picked == null) return;

    // 'HH:MM', zero-padded, 24-hour — the only form the backend's regex accepts.
    onPicked('${picked.hour.toString().padLeft(2, '0')}:'
        '${picked.minute.toString().padLeft(2, '0')}');
  }

  void _toggleDay(int dayOfWeek, bool on) {
    setState(() {
      if (!on) {
        _days.remove(dayOfWeek);
        return;
      }
      // Seeded from an existing day rather than a constant, so switching Saturday
      // on in a 9-to-6 shop gives 9 to 6 rather than something to correct.
      final template = _days.values.firstOrNull;
      _days[dayOfWeek] = WorkingDay(
        dayOfWeek: dayOfWeek,
        opensAt: template?.opensAt ?? '09:00',
        closesAt: template?.closesAt ?? '18:00',
        breaks: template?.breaks ?? const [],
      );
    });
  }

  void _setDay(int dayOfWeek, WorkingDay day) => setState(() => _days[dayOfWeek] = day);

  void _copyMondayToAll() {
    final template = _days[_week.map((d) => d.$1).firstWhere(_days.containsKey)];
    if (template == null) return;
    setState(() {
      for (final key in _days.keys.toList()) {
        _days[key] = _days[key]!.copyWith(
          opensAt: template.opensAt,
          closesAt: template.closesAt,
          breaks: template.breaks,
        );
      }
    });
  }

  Future<void> _submit() async {
    final name = _name.text.trim();

    final errors = <String, String>{
      if (name.isEmpty) 'name': 'Give them a name',
      // Not fatal on the server, but it produces a person nobody can book and
      // no error anywhere — so it is refused here, where it can be explained.
      if (_serviceIds.isEmpty) 'serviceIds': 'pick at least one',
      if (_days.isEmpty) 'workingHours': 'pick at least one day',
    };

    if (errors.isNotEmpty) {
      setState(() => _fieldErrors = errors);
      return;
    }

    setState(() {
      _busy = true;
      _fieldErrors = const {};
      _formError = null;
    });

    try {
      await widget.api.saveStaff(
        widget.businessId,
        staffId: widget.member?.id,
        name: name,
        serviceIds: _serviceIds.toList(),
        // Sent in week order for readability on the wire. The backend does not
        // care, but a human reading the document should not have to sort it.
        workingHours: [for (final (value, _) in _week) ?_days[value]],
      );
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        // The hours schema keys its errors by array index ('0.closesAt'), which
        // means nothing on a form laid out by weekday — so those are surfaced as
        // one message rather than pinned to the wrong row.
        _fieldErrors = {
          for (final entry in err.fieldErrors.entries)
            if (!entry.key.contains('.')) entry.key: entry.value,
        };
        _formError = _fieldErrors.isEmpty
            ? (err.fieldErrors.values.firstOrNull ?? err.message)
            : null;
      });
    }
  }
}
