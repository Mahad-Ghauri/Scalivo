import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../state/auth_controller.dart';
import '../theme.dart';

class AppointmentHoldersScreen extends StatefulWidget {
  const AppointmentHoldersScreen({
    super.key,
    required this.clientId,
    this.select = false,
  });
  final String clientId;
  final bool select;
  @override
  State<AppointmentHoldersScreen> createState() =>
      _AppointmentHoldersScreenState();
}

class _AppointmentHoldersScreenState extends State<AppointmentHoldersScreen> {
  late final _auth = context.read<AuthController>();
  List<AppointmentHolderItem> _holders = const [];
  bool _loading = true;
  bool _busy = false;
  String? _error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final holders = await _auth.api.appointmentHolders(
        _auth.business!.id,
        widget.clientId,
      );
      if (mounted) {
        setState(() {
          _holders = holders;
          _loading = false;
          _error = null;
        });
      }
    } on ApiException catch (error) {
      if (mounted) {
        setState(() {
          _loading = false;
          _error = error.message;
        });
      }
    }
  }

  Future<void> _save(
    AppointmentHolderItem? holder, {
    bool retire = false,
  }) async {
    if (_busy) return;
    String name = holder?.name ?? '';
    String? validation;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (dialog) => StatefulBuilder(
        builder: (context, update) => AlertDialog(
          title: Text(
            retire
                ? 'Remove ${holder!.name}?'
                : holder == null
                ? 'Add appointment holder'
                : 'Edit appointment holder',
          ),
          content: retire
              ? const Text(
                  'Future appointments must be moved or cancelled first. History is kept.',
                )
              : TextFormField(
                  initialValue: name,
                  onChanged: (value) => name = value,
                  maxLength: 80,
                  decoration: InputDecoration(
                    labelText: 'Person receiving treatment',
                    errorText: validation,
                  ),
                ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog, false),
              child: const Text('Keep'),
            ),
            TextButton(
              onPressed: () {
                if (name.trim().isEmpty) {
                  update(() => validation = 'Enter a name');
                  return;
                }
                Navigator.pop(dialog, true);
              },
              child: Text(retire ? 'Remove' : 'Save'),
            ),
          ],
        ),
      ),
    );
    final value = name.trim();
    if (!mounted || accepted != true) return;
    setState(() => _busy = true);
    try {
      await _auth.api.saveAppointmentHolder(
        _auth.business!.id,
        widget.clientId,
        value,
        holderId: holder?.id,
        active: !retire,
      );
      await _load();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Sc.paper,
    appBar: AppBar(
      title: const Text('Appointment holders'),
      backgroundColor: Sc.paper,
    ),
    floatingActionButton: FloatingActionButton.extended(
      onPressed: _busy || _holders.length >= 20 ? null : () => _save(null),
      backgroundColor: Sc.teal,
      foregroundColor: Colors.white,
      icon: const Icon(Icons.person_add_outlined),
      label: const Text('Add person'),
    ),
    body: _loading
        ? const Center(child: CircularProgressIndicator(color: Sc.teal))
        : RefreshIndicator(
            onRefresh: _load,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(22, 12, 22, 100),
              children: [
                const Text(
                  'The contact receives WhatsApp messages. Each person receiving treatment has separate appointment availability.',
                  style: TextStyle(color: Sc.slate, height: 1.5),
                ),
                if (_error != null) ...[
                  Text(_error!, style: const TextStyle(color: Sc.dangerText)),
                  TextButton(onPressed: _load, child: const Text('Try again')),
                ],
                if (widget.select)
                  ListTile(
                    title: const Text('The contact themselves'),
                    onTap: _busy
                        ? null
                        : () => Navigator.pop(
                            context,
                            const AppointmentHolderItem(
                              id: '',
                              name: 'The contact themselves',
                            ),
                          ),
                  ),
                if (_holders.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 22),
                    child: Text('No family members added yet.'),
                  ),
                for (final holder in _holders)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(holder.name),
                    leading: const Icon(Icons.person_outline, color: Sc.teal),
                    onTap: _busy
                        ? null
                        : () => widget.select
                              ? Navigator.pop(context, holder)
                              : _save(holder),
                    trailing: PopupMenuButton<String>(
                      enabled: !_busy,
                      tooltip: 'Person actions',
                      onSelected: (action) =>
                          _save(holder, retire: action == 'remove'),
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'edit', child: Text('Edit name')),
                        PopupMenuItem(value: 'remove', child: Text('Remove')),
                      ],
                    ),
                  ),
              ],
            ),
          ),
  );
}
