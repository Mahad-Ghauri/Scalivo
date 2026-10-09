import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/sc_button.dart';
import '../widgets/sc_field.dart';

/// What the business sells.
///
/// Until this screen existed the catalogue could only be set during onboarding,
/// which meant a salon that added a treatment in month two had no way to say so
/// — and a service nobody can add is a booking nobody can make.
///
/// **Nothing here hard-deletes.** A Booking stores its serviceId, so removing the row
/// would turn finished appointments into blanks in a client's visit history.
/// Retiring hides a service from the menu and leaves the past intact, which is
/// why retired rows stay visible here: retiring is the only delete this system
/// has, so un-retiring is the only undo, and a list that hid them would offer no
/// way back.
class ServicesScreen extends StatefulWidget {
  const ServicesScreen({super.key});

  @override
  State<ServicesScreen> createState() => _ServicesScreenState();
}

class _ServicesScreenState extends State<ServicesScreen> {
  late final ApiClient _api = context.read<AuthController>().api;
  late final String _businessId = context.read<AuthController>().business!.id;

  List<ServiceItem> _services = const [];
  ApiException? _error;
  bool _loading = true;
  int _loadVersion = 0;
  final Set<String> _updating = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final version = ++_loadVersion;
    setState(() => _loading = true);
    try {
      final services = await _api.allServices(_businessId);
      if (!mounted || version != _loadVersion) return;
      setState(() {
        _services = services;
        _error = null;
        _loading = false;
      });
    } on ApiException catch (err) {
      if (!mounted || version != _loadVersion) return;
      setState(() {
        _error = err;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final live = _services.where((s) => s.active).toList();
    final retired = _services.where((s) => !s.active).toList();

    return Scaffold(
      backgroundColor: Sc.paper,
      appBar: AppBar(
        backgroundColor: Sc.paper,
        surfaceTintColor: Sc.paper,
        elevation: 0,
        iconTheme: const IconThemeData(color: Sc.ink),
        title: const Text(
          'Services',
          style: TextStyle(
            fontSize: 21,
            fontWeight: FontWeight.w500,
            color: Sc.ink,
          ),
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _edit(null),
        backgroundColor: Sc.teal,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        elevation: 0,
        icon: const Icon(Icons.add_rounded, size: 22),
        label: const Text('Add service'),
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
                  if (_error != null) _errorNote(_error!),
                  if (live.isEmpty && retired.isEmpty) _empty(),
                  for (final service in live) _row(service),
                  if (retired.isNotEmpty) ...[
                    const SizedBox(height: 26),
                    const Text(
                      'RETIRED',
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.8,
                        color: Sc.slateLight,
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'Hidden from customers. Past bookings still show them.',
                      style: TextStyle(fontSize: 12, color: Sc.slate),
                    ),
                    const SizedBox(height: 10),
                    for (final service in retired) _row(service),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _errorNote(ApiException err) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Text(
        err.message,
        style: const TextStyle(fontSize: 13, color: Sc.dangerText),
      ),
    );
  }

  Widget _empty() {
    return const Padding(
      padding: EdgeInsets.only(top: 60),
      child: Column(
        children: [
          Icon(Icons.local_offer_outlined, size: 32, color: Sc.slateFaint),
          SizedBox(height: 14),
          Text(
            'No services yet',
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: Sc.inkMuted,
            ),
          ),
          SizedBox(height: 7),
          Text(
            'Nothing can be booked until the business knows what it sells.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13, color: Sc.slate, height: 1.5),
          ),
        ],
      ),
    );
  }

  Widget _row(ServiceItem service) {
    return Opacity(
      opacity: service.active ? 1 : 0.55,
      child: InkWell(
        onTap: _updating.contains(service.id) ? null : () => _edit(service),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 13),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      service.name,
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: Sc.ink,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      [
                        duration(service.durationMinutes),
                        if (service.bufferMinutes > 0)
                          '+${service.bufferMinutes} min turnaround',
                      ].join(' · '),
                      style: const TextStyle(fontSize: 12.5, color: Sc.slate),
                    ),
                  ],
                ),
              ),
              Text(
                money(service.priceMinor),
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: Sc.inkMuted,
                ),
              ),
              const SizedBox(width: 6),
              PopupMenuButton<String>(
                tooltip: 'Service actions',
                enabled: !_updating.contains(service.id),
                onSelected: (action) {
                  if (action == 'edit') {
                    _edit(service);
                  } else {
                    _toggleActive(service);
                  }
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(
                    value: 'edit',
                    child: Text('Edit service'),
                  ),
                  PopupMenuItem(
                    value: 'active',
                    child: Text(
                      service.active ? 'Delete service' : 'Restore service',
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _toggleActive(ServiceItem service) async {
    if (_updating.contains(service.id)) return;
    setState(() => _updating.add(service.id));
    if (service.active) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text('Delete ${service.name}?'),
          content: const Text(
            'This service will be hidden from new bookings. Existing appointments and history are kept. You can restore it later.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('Keep service'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('Delete service'),
            ),
          ],
        ),
      );
      if (!mounted) return;
      if (confirmed != true) {
        setState(() => _updating.remove(service.id));
        return;
      }
    }
    try {
      await _api.setServiceActive(_businessId, service.id, !service.active);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            service.active ? 'Service deleted' : 'Service restored',
          ),
        ),
      );
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
    if (!mounted) return;
    setState(() => _updating.remove(service.id));
    await _load();
  }

  Future<void> _edit(ServiceItem? service) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      backgroundColor: Sc.paper,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (_) =>
          _ServiceSheet(api: _api, businessId: _businessId, service: service),
    );
    if (mounted && saved == true) await _load();
  }
}

class _ServiceSheet extends StatefulWidget {
  const _ServiceSheet({
    required this.api,
    required this.businessId,
    this.service,
  });

  final ApiClient api;
  final String businessId;
  final ServiceItem? service;

  @override
  State<_ServiceSheet> createState() => _ServiceSheetState();
}

class _ServiceSheetState extends State<_ServiceSheet> {
  late final _name = TextEditingController(text: widget.service?.name ?? '');
  late final _duration = TextEditingController(
    text: '${widget.service?.durationMinutes ?? 30}',
  );
  late final _buffer = TextEditingController(
    text: '${widget.service?.bufferMinutes ?? 0}',
  );

  /// Rupees, not paisa. The owner thinks in rupees and the wire is in paisa;
  /// converting here is the only place the two meet.
  late final _price = TextEditingController(
    text: '${(widget.service?.priceMinor ?? 0) ~/ 100}',
  );

  bool _busy = false;
  Map<String, String> _fieldErrors = const {};
  String? _formError;

  @override
  void dispose() {
    _name.dispose();
    _duration.dispose();
    _buffer.dispose();
    _price.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
              Text(
                widget.service == null ? 'New service' : 'Edit service',
                style: const TextStyle(
                  fontSize: 26,
                  fontWeight: FontWeight.w500,
                  color: Sc.ink,
                  letterSpacing: -0.2,
                ),
              ),
              const SizedBox(height: 22),
              ScField(
                label: 'Name',
                controller: _name,
                hint: 'Hydrafacial',
                enabled: !_busy,
                errorText: _fieldErrors['name'],
                textCapitalization: TextCapitalization.words,
              ),
              const SizedBox(height: 18),
              ScField(
                label: 'Minutes',
                controller: _duration,
                hint: '45',
                helper: 'How long the appointment blocks the diary for.',
                enabled: !_busy,
                errorText: _fieldErrors['durationMinutes'],
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 18),
              ScField(
                label: 'Turnaround',
                controller: _buffer,
                hint: '0',
                // The distinction matters and is invisible otherwise: the buffer
                // is held by the grid so nothing can be booked into it, but the
                // appointment is DRAWN at its service length.
                helper:
                    'Extra minutes held after it, for cleaning down. Nobody '
                    'can be booked into this time, and it is not shown on the '
                    'appointment.',
                enabled: !_busy,
                errorText: _fieldErrors['bufferMinutes'],
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 18),
              ScField(
                label: 'Price (Rs)',
                controller: _price,
                hint: '8000',
                enabled: !_busy,
                errorText: _fieldErrors['priceMinor'],
                keyboardType: TextInputType.number,
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
                label: widget.service == null ? 'Add service' : 'Save',
                loadingLabel: 'Saving',
                loading: _busy,
                onPressed: _submit,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _submit() async {
    if (_busy) return;
    final name = _name.text.trim();
    final minutes = int.tryParse(_duration.text.trim());
    final buffer = int.tryParse(_buffer.text.trim());
    final rupees = int.tryParse(_price.text.trim());

    // Checked here so a typo comes back instantly rather than as a round trip,
    // but the server checks the same things — this is courtesy, not the guard.
    final errors = <String, String>{
      if (name.isEmpty || name.length > 80)
        'name': 'Use a name of 1–80 characters',
      if (minutes == null || minutes <= 0 || minutes > 1440)
        'durationMinutes': 'Use 1–1440 minutes',
      if (buffer == null || buffer < 0 || buffer > 1440)
        'bufferMinutes': 'Use 0–1440 minutes',
      if (rupees == null || rupees < 0 || rupees > 90071992547409)
        'priceMinor': 'A price in rupees',
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
      await widget.api.saveService(
        widget.businessId,
        serviceId: widget.service?.id,
        name: name,
        durationMinutes: minutes!,
        bufferMinutes: buffer!,
        priceMinor: rupees! * 100,
      );
      if (!mounted) return;
      Navigator.of(context).pop(true);
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _fieldErrors = err.fieldErrors;
        _formError = err.fieldErrors.isEmpty ? err.message : null;
      });
    }
  }
}
