import 'appointment_holders_screen.dart';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/client_tag.dart';

/// One customer, assembled from their bookings.
///
/// Everything on this screen except the notes is derived — counters, tags, the
/// average gap, the next expected visit. That is the point of the CRM and it is
/// the thing the screen has to make obvious, so nothing here is editable except
/// the one field a human is allowed to write.
///
/// The counters are a cache of what the bookings already record, and the backend
/// can rebuild them. That is why "Recalculate" is offered rather than hidden: a
/// cache with no visible repair is just a second source of truth nobody can
/// check.
class ClientProfileScreen extends StatefulWidget {
  const ClientProfileScreen({
    super.key,
    required this.clientId,
    this.fallbackName,
  });

  final String clientId;

  /// Shown in the header while the profile loads, so the owner can see they
  /// opened the right person before the network answers.
  final String? fallbackName;

  @override
  State<ClientProfileScreen> createState() => _ClientProfileScreenState();
}

class _ClientProfileScreenState extends State<ClientProfileScreen> {
  late final ApiClient _api = context.read<AuthController>().api;
  late final String _businessId = context.read<AuthController>().business!.id;

  final _notes = TextEditingController();

  ClientProfileDetail? _profile;
  ApiException? _error;
  bool _loading = true;
  bool _savingNotes = false;
  String _savedNotes = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final profile = await _api.clientProfile(_businessId, widget.clientId);
      if (!mounted) return;
      setState(() {
        _profile = profile;
        _savedNotes = profile.notes;
        _notes.text = profile.notes;
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

  Future<void> _revokeLink() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Revoke customer link?'),
        content: const Text(
          'The old link will stop working. The customer can request a new one through WhatsApp.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep link'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Revoke'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await _api.revokeCustomerLink(_businessId, widget.clientId);
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Customer link revoked.')));
    } on ApiException catch (error) {
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final profile = _profile;
    final name =
        profile?.displayName ??
        widget.fallbackName ??
        profile?.phone ??
        'Client';

    return Scaffold(
      backgroundColor: Sc.paper,
      appBar: AppBar(
        backgroundColor: Sc.paper,
        surfaceTintColor: Sc.paper,
        elevation: 0,
        iconTheme: const IconThemeData(color: Sc.ink),
        title: Text(
          name,
          style: const TextStyle(
            fontSize: 21,
            fontWeight: FontWeight.w500,
            color: Sc.ink,
          ),
        ),
        actions: [
          if (profile != null)
            PopupMenuButton<String>(
              tooltip: 'More',
              color: Colors.white,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
              onSelected: (value) {
                if (value == 'recompute') _recompute();
                if (value == 'holders')
                  Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          AppointmentHoldersScreen(clientId: widget.clientId),
                    ),
                  );
                if (value == 'revoke') _revokeLink();
              },
              itemBuilder: (_) => const [
                PopupMenuItem(
                  value: 'holders',
                  child: Text('Appointment holders'),
                ),
                PopupMenuItem(
                  value: 'revoke',
                  child: Text('Revoke customer link'),
                ),
                PopupMenuItem(
                  value: 'recompute',
                  child: Text(
                    'Recalculate from bookings',
                    style: TextStyle(fontSize: 13.5, color: Sc.ink),
                  ),
                ),
              ],
            ),
        ],
      ),
      body: _body(profile),
    );
  }

  Widget _body(ClientProfileDetail? profile) {
    if (_loading)
      return const Center(child: CircularProgressIndicator(color: Sc.teal));

    if (profile == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(30),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.person_off_outlined,
                size: 32,
                color: Sc.slateFaint,
              ),
              const SizedBox(height: 14),
              Text(
                _error?.message ?? 'That profile could not be loaded',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 13.5,
                  color: Sc.slate,
                  height: 1.5,
                ),
              ),
              const SizedBox(height: 14),
              TextButton(onPressed: _load, child: const Text('TRY AGAIN')),
            ],
          ),
        ),
      );
    }

    return RefreshIndicator(
      color: Sc.teal,
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(22, 4, 22, 40),
        children: [
          if (profile.tags.isNotEmpty)
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final tag in profile.tags) ClientTagChip(tag: tag),
              ],
            ),
          if (profile.phone != null) ...[
            const SizedBox(height: 14),
            Row(
              children: [
                const Icon(
                  Icons.phone_outlined,
                  size: 15,
                  color: Sc.slateLight,
                ),
                const SizedBox(width: 8),
                Text(
                  profile.phone!,
                  style: const TextStyle(fontSize: 14, color: Sc.inkMuted),
                ),
              ],
            ),
          ],
          const SizedBox(height: 20),
          _counters(profile),
          const SizedBox(height: 22),
          _rhythm(profile),
          const SizedBox(height: 24),
          _notesCard(),
          const SizedBox(height: 26),
          const Text(
            'Visits',
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w700,
              color: Sc.ink,
            ),
          ),
          const SizedBox(height: 10),
          if (profile.history.isEmpty)
            const Text(
              'No bookings yet.',
              style: TextStyle(fontSize: 13, color: Sc.slate),
            )
          else
            for (final visit in profile.history) _visitRow(visit),
        ],
      ),
    );
  }

  Widget _counters(ClientProfileDetail profile) {
    return Wrap(
      spacing: 28,
      runSpacing: 18,
      children: [
        _stat('${profile.totalVisits}', 'visits'),
        _stat(money(profile.lifetimeSpendMinor), 'spent'),
        // No-shows and cancellations are shown together and only when they have
        // happened. A permanent "0 no-shows" invites the owner to read the
        // profile as a rap sheet.
        if (profile.noShows + profile.cancellations > 0)
          _stat('${profile.noShows + profile.cancellations}', 'missed'),
      ],
    );
  }

  Widget _stat(String value, String label) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          value,
          style: const TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.w700,
            color: Sc.ink,
            letterSpacing: -0.3,
          ),
        ),
        const SizedBox(height: 2),
        Text(label, style: const TextStyle(fontSize: 12, color: Sc.slate)),
      ],
    );
  }

  /// When they usually come back, and when they are next expected.
  ///
  /// This is the whole basis of the retention engine Phase 2 builds, so showing
  /// it now is not decoration: it is the owner's chance to tell us the rhythm is
  /// wrong before anything starts messaging people on the strength of it.
  Widget _rhythm(ClientProfileDetail profile) {
    final gap = profile.averageGapDays;
    final next = profile.nextExpectedVisitAt;

    if (gap == null && next == null && profile.lastVisitAt == null) {
      return const SizedBox.shrink();
    }

    return Container(
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: Sc.divider),
          bottom: BorderSide(color: Sc.divider),
        ),
      ),
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _rhythmLine('Last visit', agoLabel(profile.lastVisitAt)),
          if (gap != null)
            _rhythmLine('Usually returns', 'every ${gap.round()} days'),
          if (next != null)
            _rhythmLine('Next expected', relativeDay(next).toLowerCase()),
        ],
      ),
    );
  }

  Widget _rhythmLine(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Wrap(
        spacing: 12,
        runSpacing: 4,
        children: [
          Text(label, style: const TextStyle(fontSize: 13, color: Sc.slate)),
          Text(
            value,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: Sc.inkMuted,
            ),
          ),
        ],
      ),
    );
  }

  /// The only field on this screen a person fills in.
  Widget _notesCard() {
    final dirty = _notes.text != _savedNotes;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                'Notes',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: Sc.ink,
                ),
              ),
            ),
            if (dirty)
              TextButton(
                onPressed: _savingNotes ? null : _saveNotes,
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  minimumSize: const Size(48, 48),
                ),
                child: Text(
                  _savingNotes ? 'SAVING' : 'SAVE',
                  style: const TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.7,
                    color: Sc.teal,
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Container(
          decoration: BoxDecoration(
            color: Sc.tealSurface,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: Sc.divider),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 4),
          child: TextField(
            controller: _notes,
            maxLines: null,
            minLines: 3,
            enabled: !_savingNotes,
            onChanged: (_) => setState(() {}),
            style: const TextStyle(fontSize: 14, color: Sc.ink, height: 1.5),
            decoration: const InputDecoration(
              border: InputBorder.none,
              hintText: 'Allergic to the peel. Prefers the 6pm slot.',
              hintStyle: TextStyle(
                fontSize: 14,
                color: Sc.slateFaint,
                height: 1.5,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _visitRow(VisitRow visit) {
    final faded = visit.status == 'cancelled' || visit.status == 'no_show';
    final label = switch (visit.status) {
      'no_show' => 'No-show',
      'cancelled' => 'Cancelled',
      'completed' => null,
      _ => 'Upcoming',
    };

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 9),
      child: Opacity(
        opacity: faded ? 0.55 : 1,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    visit.serviceName,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: Sc.ink,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${dayLabel(visit.startsAt)} · ${hhmm(visit.startsAt)} · ${visit.staffName}',
                    style: const TextStyle(fontSize: 12.5, color: Sc.slate),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  money(visit.priceMinor),
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Sc.inkMuted,
                  ),
                ),
                if (label != null) ...[
                  const SizedBox(height: 3),
                  Text(
                    label.toUpperCase(),
                    style: TextStyle(
                      fontSize: 9.5,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.4,
                      color: visit.status == 'no_show'
                          ? Sc.danger
                          : Sc.slateLight,
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _saveNotes() async {
    setState(() => _savingNotes = true);
    final text = _notes.text;

    try {
      await _api.saveNotes(_businessId, widget.clientId, text);
      if (!mounted) return;
      setState(() {
        _savedNotes = text;
        _savingNotes = false;
      });
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() => _savingNotes = false);
      // The text stays in the box on failure. Clearing it would lose something
      // the owner typed because the wifi dropped.
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          backgroundColor: Sc.dangerTitle,
          content: Text('Notes not saved — ${err.message.toLowerCase()}'),
        ),
      );
    }
  }

  Future<void> _recompute() async {
    try {
      await _api.recomputeProfile(_businessId, widget.clientId);
    } on ApiException {
      // Rebuilding is derived work and safe to run twice, so a failure here
      // needs no special handling — the reload below shows whatever is true now.
    }
    await _load();
  }
}
