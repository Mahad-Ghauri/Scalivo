import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../state/auth_controller.dart';
import '../state/clients_controller.dart';
import '../theme.dart';
import '../widgets/sc_button.dart';

class ClientPickerScreen extends StatefulWidget {
  const ClientPickerScreen({super.key});
  @override
  State<ClientPickerScreen> createState() => _ClientPickerScreenState();
}

class _ClientPickerScreenState extends State<ClientPickerScreen> {
  late final ClientsController _clients;
  @override
  void initState() {
    super.initState();
    final auth = context.read<AuthController>();
    _clients = ClientsController(api: auth.api, businessId: auth.business!.id)
      ..addListener(_changed)
      ..load();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _clients.removeListener(_changed);
    _clients.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Sc.paper,
    appBar: AppBar(title: const Text('Choose a customer')),
    body: Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(22),
          child: TextField(
            maxLength: 120,
            decoration: const InputDecoration(
              labelText: 'Search name or phone',
            ),
            onChanged: _clients.search,
          ),
        ),
        if (_clients.error != null)
          Padding(
            padding: const EdgeInsets.all(22),
            child: Column(
              children: [
                Text(_clients.error!.message),
                ScButton(
                  label: 'Try again',
                  onPressed: _clients.loading ? null : () => _clients.load(),
                ),
              ],
            ),
          ),
        if (_clients.loading) const LinearProgressIndicator(),
        if (!_clients.loading &&
            _clients.error == null &&
            _clients.clients.isEmpty)
          const Text(
            'No customers found. You can enter a new customer in the booking form.',
          ),
        Expanded(
          child: ListView.builder(
            itemCount: _clients.clients.length + (_clients.hasMore ? 1 : 0),
            itemBuilder: (context, index) {
              if (index == _clients.clients.length) {
                return TextButton(
                  onPressed: _clients.loading
                      ? null
                      : () => _clients.loadMore(),
                  child: const Text('Load more'),
                );
              }
              final ClientRow row = _clients.clients[index];
              return ListTile(
                title: Text(row.displayName ?? 'Customer'),
                subtitle: row.phone == null ? null : Text(row.phone!),
                onTap: () => Navigator.of(context).pop(row),
              );
            },
          ),
        ),
      ],
    ),
  );
}
