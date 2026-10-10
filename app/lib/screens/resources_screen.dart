import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/sc_button.dart';
import '../widgets/sc_field.dart';
import '../state/calendar_controller.dart';
import 'block_time_sheet.dart';
import '../format.dart';

class ResourcesScreen extends StatefulWidget {
  const ResourcesScreen({super.key, required this.controller});
  final CalendarController controller;
  @override
  State<ResourcesScreen> createState() => _ResourcesScreenState();
}

class _ResourcesScreenState extends State<ResourcesScreen> {
  late final _auth = context.read<AuthController>();
  List<ResourceItem> _resources = const [];
  List<CalendarBlock> _blocks = const [];
  bool _loading = true;
  String? _error;
  int _version = 0;
  final Set<String> _busy = {};
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final version = ++_version;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final result = await Future.wait<Object>([
        _auth.api.resources(_auth.business!.id),
        _auth.api.resourceBlocks(_auth.business!.id),
      ]);
      if (!mounted || version != _version) return;
      setState(() {
        _resources = result[0] as List<ResourceItem>;
        _blocks = result[1] as List<CalendarBlock>;
        _loading = false;
      });
    } on ApiException catch (error) {
      if (!mounted || version != _version) return;
      setState(() {
        _error = error.message;
        _loading = false;
      });
    }
  }

  Future<void> _edit(ResourceItem? resource) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Sc.paper,
      builder: (_) => _ResourceSheet(
        api: _auth.api,
        businessId: _auth.business!.id,
        resources: _resources,
        resource: resource,
      ),
    );
    if (mounted && saved == true) await _load();
  }

  Future<void> _toggle(ResourceItem resource) async {
    if (!_busy.add(resource.id)) return;
    setState(() {});
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(
          resource.active
              ? 'Retire ${resource.name}?'
              : 'Restore ${resource.name}?',
        ),
        content: const Text(
          'Resources used by services or upcoming appointments cannot be retired. Update those first. Use downtime for a temporary closure.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Keep'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Confirm'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    if (confirmed == true) {
      try {
        await _auth.api.setResourceActive(
          _auth.business!.id,
          resource.id,
          !resource.active,
        );
      } on ApiException catch (error) {
        if (mounted && context.mounted)
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
    if (!mounted) return;
    setState(() => _busy.remove(resource.id));
    await _load();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Sc.paper,
    appBar: AppBar(
      title: const Text('Rooms & equipment'),
      backgroundColor: Sc.paper,
    ),
    floatingActionButton: FloatingActionButton.extended(
      onPressed: () => _edit(null),
      backgroundColor: Sc.teal,
      foregroundColor: Colors.white,
      icon: const Icon(Icons.add),
      label: const Text('Add resource'),
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
                  'Add your rooms, then their beds/chairs and equipment. Quantity is the number of interchangeable units. A bed/chair booking shares its room; a whole-room booking keeps every station private. Services must reference the same inventory to share it.',
                  style: TextStyle(color: Sc.slate, height: 1.5),
                ),
                const SizedBox(height: 18),
                if (_error != null) ...[
                  Text(_error!, style: const TextStyle(color: Sc.dangerText)),
                  TextButton(onPressed: _load, child: const Text('Try again')),
                ],
                if (_resources.isEmpty && _error == null)
                  const Text(
                    'No resources yet. Existing services use staff availability until you add resource requirements.',
                  ),
                for (final asset in _resources)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(
                      asset.kind == 'room'
                          ? Icons.meeting_room_outlined
                          : asset.kind == 'bed'
                          ? Icons.bed_outlined
                          : asset.kind == 'chair'
                          ? Icons.chair_outlined
                          : Icons.medical_services_outlined,
                      color: asset.active ? Sc.teal : Sc.slate,
                    ),
                    title: Text(asset.name),
                    subtitle: Text(
                      '${asset.kindLabel} · Quantity ${asset.quantity}${asset.active ? '' : ' · Retired'}${asset.fixedRoomId == null ? '' : ' · ${_resources.where((room) => room.id == asset.fixedRoomId).firstOrNull?.name ?? 'Room'}'}',
                    ),
                    onTap: () => _edit(asset),
                    trailing: PopupMenuButton<String>(
                      enabled: !_busy.contains(asset.id),
                      tooltip: 'Resource actions',
                      onSelected: (action) async {
                        if (action == 'edit') {
                          await _edit(asset);
                        } else if (action == 'downtime') {
                          if (await showBlockTimeSheet(
                                context,
                                controller: widget.controller,
                                resource: asset,
                              ) &&
                              mounted)
                            await _load();
                        } else {
                          await _toggle(asset);
                        }
                      },
                      itemBuilder: (_) => [
                        const PopupMenuItem(value: 'edit', child: Text('Edit')),
                        if (asset.active)
                          const PopupMenuItem(
                            value: 'downtime',
                            child: Text('Block downtime'),
                          ),
                        PopupMenuItem(
                          value: 'active',
                          child: Text(asset.active ? 'Retire' : 'Restore'),
                        ),
                      ],
                    ),
                  ),
                if (_blocks.isNotEmpty) ...[
                  const SizedBox(height: 24),
                  const Text(
                    'Upcoming downtime',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                  for (final block in _blocks)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(
                        _resources
                                .where(
                                  (resource) => resource.id == block.resourceId,
                                )
                                .firstOrNull
                                ?.name ??
                            'Resource',
                      ),
                      subtitle: Text(
                        '${relativeDay(block.startsAt)} ${hhmm(block.startsAt)} – ${relativeDay(block.endsAt)} ${hhmm(block.endsAt)}${block.reason == null ? '' : '\n${block.reason}'}',
                      ),
                      trailing: IconButton(
                        tooltip: 'Remove downtime',
                        icon: const Icon(Icons.delete_outline),
                        onPressed: _busy.contains(block.id)
                            ? null
                            : () async {
                                final remove = await showDialog<bool>(
                                  context: context,
                                  builder: (dialog) => AlertDialog(
                                    title: const Text('Remove this downtime?'),
                                    content: const Text(
                                      'New bookings may use this resource during the released time.',
                                    ),
                                    actions: [
                                      TextButton(
                                        onPressed: () =>
                                            Navigator.pop(dialog, false),
                                        child: const Text('Keep'),
                                      ),
                                      TextButton(
                                        onPressed: () =>
                                            Navigator.pop(dialog, true),
                                        child: const Text('Remove'),
                                      ),
                                    ],
                                  ),
                                );
                                if (remove != true || !mounted) return;
                                setState(() => _busy.add(block.id));
                                try {
                                  await _auth.api.deleteBlock(
                                    _auth.business!.id,
                                    block.id,
                                  );
                                } on ApiException catch (error) {
                                  if (mounted && context.mounted)
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(content: Text(error.message)),
                                    );
                                }
                                if (!mounted) return;
                                setState(() => _busy.remove(block.id));
                                await _load();
                              },
                      ),
                    ),
                ],
              ],
            ),
          ),
  );
}

class _ResourceSheet extends StatefulWidget {
  const _ResourceSheet({
    required this.api,
    required this.businessId,
    required this.resources,
    this.resource,
  });
  final ApiClient api;
  final String businessId;
  final List<ResourceItem> resources;
  final ResourceItem? resource;
  @override
  State<_ResourceSheet> createState() => _ResourceSheetState();
}

class _ResourceSheetState extends State<_ResourceSheet> {
  late final _name = TextEditingController(text: widget.resource?.name ?? '');
  late final _quantity = TextEditingController(
    text: '${widget.resource?.quantity ?? 1}',
  );
  late String _kind = widget.resource?.kind ?? 'room';
  late String? _room = widget.resource?.fixedRoomId;
  bool _busy = false;
  String? _error;
  @override
  void dispose() {
    _name.dispose();
    _quantity.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_busy) return;
    if (_name.text.trim().isEmpty || _name.text.trim().length > 80) {
      setState(() => _error = 'Use a name of 1–80 characters');
      return;
    }
    final quantity = int.tryParse(_quantity.text.trim());
    if (quantity == null || quantity < 1 || quantity > 20) {
      setState(() => _error = 'Enter a whole quantity from 1 to 20');
      return;
    }
    if ((_kind == 'bed' || _kind == 'chair') && _room == null) {
      setState(
        () => _error = 'Choose the room containing these beds or chairs',
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.saveResource(
        widget.businessId,
        resourceId: widget.resource?.id,
        name: _name.text.trim(),
        kind: _kind,
        fixedRoomId: _kind == 'room' ? null : _room,
        active: widget.resource?.active ?? true,
        quantity: quantity,
      );
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (error) {
      if (mounted)
        setState(() {
          _busy = false;
          _error = error.message;
        });
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(
    top: false,
    child: SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(
        22,
        22,
        22,
        MediaQuery.viewInsetsOf(context).bottom + 22,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            widget.resource == null ? 'New resource' : 'Edit resource',
            style: const TextStyle(fontSize: 26, color: Sc.ink),
          ),
          const SizedBox(height: 20),
          ScField(
            label: 'Name',
            controller: _name,
            hint: 'Treatment room 1',
            enabled: !_busy,
            maxLength: 80,
          ),
          const SizedBox(height: 18),
          DropdownButtonFormField<String>(
            initialValue: _kind,
            decoration: const InputDecoration(labelText: 'Type'),
            items: const [
              DropdownMenuItem(value: 'room', child: Text('Whole room')),
              DropdownMenuItem(value: 'bed', child: Text('Bed')),
              DropdownMenuItem(value: 'chair', child: Text('Chair')),
              DropdownMenuItem(value: 'equipment', child: Text('Equipment')),
            ],
            onChanged: _busy
                ? null
                : (value) => setState(() {
                    _kind = value!;
                    if (_kind == 'room') _room = null;
                  }),
          ),
          const SizedBox(height: 18),
          ScField(
            label: 'Quantity',
            controller: _quantity,
            hint: '1',
            enabled: !_busy,
            keyboardType: TextInputType.number,
            helper: _kind == 'room'
                ? 'Name rooms separately with quantity 1 when adding beds/chairs inside them.'
                : 'Interchangeable units of this item; do not count the same unit twice.',
          ),
          if (_kind != 'room') ...[
            const SizedBox(height: 18),
            DropdownButtonFormField<String>(
              key: ValueKey('room-$_kind'),
              initialValue: _room,
              decoration: const InputDecoration(labelText: 'Room'),
              items: [
                DropdownMenuItem<String>(
                  value: null,
                  child: Text(
                    _kind == 'equipment'
                        ? 'Portable / not fixed'
                        : 'Choose a room',
                  ),
                ),
                for (final room in widget.resources.where(
                  (asset) =>
                      asset.kind == 'room' &&
                      asset.quantity == 1 &&
                      (asset.active || asset.id == _room),
                ))
                  DropdownMenuItem(value: room.id, child: Text(room.name)),
              ],
              onChanged: _busy
                  ? null
                  : (value) => setState(() => _room = value),
            ),
          ],
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Text(
                _error!,
                style: const TextStyle(color: Sc.dangerText),
              ),
            ),
          const SizedBox(height: 22),
          ScButton(
            label: 'Save resource',
            loading: _busy,
            loadingLabel: 'Saving',
            onPressed: _save,
          ),
        ],
      ),
    ),
  );
}
