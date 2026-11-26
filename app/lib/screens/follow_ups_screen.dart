import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/owner_report_widgets.dart';

/// Follow-ups the owner set, and the ones that need a human.
///
/// "Needs a call" is the working view: the customer didn't reply to two
/// WhatsApp messages, opted out, or has no WhatsApp. It is where a lapsed
/// follow-up's push notification lands.
class FollowUpsScreen extends StatefulWidget {
  const FollowUpsScreen({super.key, this.initialFilter = 'open'});

  final String initialFilter;

  @override
  State<FollowUpsScreen> createState() => _FollowUpsScreenState();
}

class _FollowUpsScreenState extends State<FollowUpsScreen> {
  static const filters = {'open': 'Open', 'lapsed': 'Needs a call', 'all': 'All'};

  static const status = {
    'scheduled': ('Scheduled', Sc.teal),
    'offered': ('Messaged', Sc.slate),
    'nudged': ('Reminded once', Sc.slate),
    'booked': ('Booked ✅', Sc.teal),
    'declined': ('Not now', Sc.slateLight),
    'lapsed': ('Needs a call', Sc.dangerTitle),
    'cancelled': ('Removed', Sc.slateLight),
  };

  static const reasons = {
    'no_reply': 'No reply to 2 messages',
    'opted_out': 'Opted out of WhatsApp',
    'unreachable': 'No WhatsApp on file',
    'service_retired': 'Service no longer offered',
    'visit_not_marked_complete': 'Visit never marked complete',
  };

  late String _filter = filters.containsKey(widget.initialFilter)
      ? widget.initialFilter
      : 'open';
  List<FollowUpListItem> _items = const [];
  ApiException? _error;
  bool _loading = true;
  int _version = 0;

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
    final auth = context.read<AuthController>();
    try {
      final items = await auth.api.followUps(auth.business!.id, status: _filter);
      if (!mounted || version != _version) return;
      setState(() {
        _items = items;
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

  @override
  Widget build(BuildContext context) {
    return OwnerReportPage(
      title: 'Follow-ups',
      loading: _loading,
      error: _error,
      onRefresh: _load,
      children: [
        const Text(
          'Customers are messaged on WhatsApp 3 days before a follow-up is '
          "due, with a time they can book in one reply. The ones who don't "
          'answer land in Needs a call.',
          style: TextStyle(fontSize: 13, color: Sc.slate, height: 1.5),
        ),
        const SizedBox(height: 14),
        Wrap(
          spacing: 8,
          children: [
            for (final f in filters.entries)
              ChoiceChip(
                label: Text(f.value),
                selected: _filter == f.key,
                onSelected: _loading
                    ? null
                    : (_) {
                        setState(() => _filter = f.key);
                        _load();
                      },
              ),
          ],
        ),
        const SizedBox(height: 16),
        if (!_loading && _error == null && _items.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 32),
            child: Text(
              _filter == 'lapsed'
                  ? 'Nobody to call.'
                  : 'No follow-ups yet. Add one from any appointment.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Sc.slate),
            ),
          ),
        for (final item in _items) _row(item),
      ],
    );
  }

  /// Opens the dialler or WhatsApp. If the device can't (no SIM, tablet,
  /// emulator), the number is copied instead so the owner still has it.
  Future<void> _open(Uri uri, String phone) async {
    bool opened;
    try {
      opened = await launcher(uri);
    } catch (_) {
      opened = false;
    }
    if (opened || !mounted) return;
    await Clipboard.setData(ClipboardData(text: phone));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        content: Text("Couldn't open that here — $phone copied"),
      ),
    );
  }

  Widget _row(FollowUpListItem item) {
    final (label, color) = status[item.status] ?? (item.status, Sc.slate);
    final reason = item.lapsedReason == null
        ? null
        : reasons[item.lapsedReason] ?? item.lapsedReason;
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Sc.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  item.clientName ?? 'Customer',
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: Sc.ink,
                  ),
                ),
              ),
              Text(
                label.toUpperCase(),
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.3,
                  color: color,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '${item.serviceName}'
            '${item.staffName != null ? ' with ${item.staffName}' : ''}'
            ' · due ${relativeDay(item.dueAt)}',
            style: const TextStyle(fontSize: 13, color: Sc.inkMuted),
          ),
          if (item.note != null)
            Text(item.note!, style: const TextStyle(fontSize: 13, color: Sc.ink)),
          if (reason != null)
            Text(reason, style: const TextStyle(fontSize: 12.5, color: Sc.dangerText)),
          if (item.clientPhone != null && item.status != 'booked')
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Wrap(
                spacing: 8,
                children: [
                  OutlinedButton.icon(
                    key: Key('call-${item.bookingId}'),
                    onPressed: () => _open(phoneUri(item.clientPhone!), item.clientPhone!),
                    icon: const Icon(Icons.call_rounded, size: 16),
                    label: const Text('Call'),
                  ),
                  FilledButton.icon(
                    key: Key('whatsapp-${item.bookingId}'),
                    style: FilledButton.styleFrom(backgroundColor: Sc.teal),
                    onPressed: () => _open(whatsAppUri(item.clientPhone!), item.clientPhone!),
                    icon: const Icon(Icons.chat_rounded, size: 16),
                    label: const Text('WhatsApp'),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Digits only, international form: the backend stores E.164 without "+".
String _digits(String phone) => phone.replaceAll(RegExp(r'[^0-9]'), '');

Uri phoneUri(String phone) => Uri(scheme: 'tel', path: '+${_digits(phone)}');

Uri whatsAppUri(String phone) => Uri.https('wa.me', '/${_digits(phone)}');

/// Swappable so widget tests can see what would open without a platform.
Future<bool> Function(Uri) launcher =
    (uri) => launchUrl(uri, mode: LaunchMode.externalApplication);
