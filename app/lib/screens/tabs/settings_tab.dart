import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/api_client.dart';
import '../../api/models.dart';
import '../../format.dart';
import '../../state/auth_controller.dart';
import '../../theme.dart';
import '../qr_screen.dart';

/// Settings, and specifically the reminder schedule.
///
/// Reminders are the one thing here an owner will want to change in their first
/// week, and until this screen existed the backend had the setting with nothing
/// able to set it. The lead times are offered as a short list of real choices
/// rather than a number field: "1 day before" is a decision an owner makes, and
/// "1437 minutes" is a number they would only ever type by accident.
class SettingsTab extends StatefulWidget {
  const SettingsTab({super.key});

  @override
  State<SettingsTab> createState() => _SettingsTabState();
}

class _SettingsTabState extends State<SettingsTab> {
  /// The leads worth offering. Anything else is reachable through the API, and
  /// nobody has asked for it.
  static const _choices = [15, 60, 120, 180, 1440, 2880];

  late final ApiClient _api = context.read<AuthController>().api;
  late final String _businessId = context.read<AuthController>().business!.id;

  BusinessSettings? _settings;
  ApiException? _error;
  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final settings = await _api.settings(_businessId);
      if (!mounted) return;
      setState(() {
        _settings = settings;
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
    final auth = context.watch<AuthController>();
    final settings = _settings;

    if (_loading) return const Center(child: CircularProgressIndicator(color: Sc.teal));

    if (settings == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, size: 32, color: Sc.slateFaint),
            const SizedBox(height: 14),
            Text(
              _error?.message ?? 'Settings could not be loaded',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 13.5, color: Sc.slate),
            ),
            const SizedBox(height: 14),
            TextButton(onPressed: _load, child: const Text('TRY AGAIN')),
          ],
        ),
      );
    }

    return RefreshIndicator(
      color: Sc.teal,
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 110),
        children: [
          const Text(
            'Settings',
            style: TextStyle(
              fontSize: 23,
              fontWeight: FontWeight.w700,
              color: Sc.ink,
              letterSpacing: -0.2,
            ),
          ),
          const SizedBox(height: 22),
          _whatsappCard(auth),
          const SizedBox(height: 24),
          _remindersCard(settings),
          const SizedBox(height: 24),
          _bookingWindowCard(settings),
          const SizedBox(height: 26),
          _about(settings),
        ],
      ),
    );
  }

  Widget _whatsappCard(AuthController auth) {
    final health = auth.health;
    final (label, detail, tone) = switch (health) {
      SessionHealth.live => ('Connected', 'Customers can book by message.', Sc.teal),
      SessionHealth.down => ('Disconnected', 'Nobody can book right now.', Sc.danger),
      SessionHealth.linking => ('Linking', 'Finish scanning the QR code.', Sc.warnIcon),
      SessionHealth.notConnected => ('Not connected', 'Link a number to start.', Sc.slate),
    };

    return _card(
      title: 'WhatsApp',
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const QrScreen()),
        ),
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: tone, shape: BoxShape.circle),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: const TextStyle(
                        fontSize: 14.5,
                        fontWeight: FontWeight.w600,
                        color: Sc.ink,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(detail, style: const TextStyle(fontSize: 12.5, color: Sc.slate)),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, size: 20, color: Sc.slateLight),
            ],
          ),
        ),
      ),
    );
  }

  Widget _remindersCard(BusinessSettings settings) {
    return _card(
      title: 'Reminders',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Remind customers before their appointment',
                  style: TextStyle(fontSize: 13.5, color: Sc.inkMuted, height: 1.4),
                ),
              ),
              const SizedBox(width: 10),
              Switch(
                value: settings.remindersEnabled,
                activeThumbColor: Colors.white,
                activeTrackColor: Sc.teal,
                onChanged: _saving ? null : (on) => _save(remindersEnabled: on),
              ),
            ],
          ),
          if (settings.remindersEnabled) ...[
            const SizedBox(height: 6),
            const Divider(height: 22, color: Sc.divider),
            const Text(
              'WHEN',
              style: TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.8,
                color: Sc.slateLight,
              ),
            ),
            const SizedBox(height: 10),
            for (final lead in _choices)
              _leadRow(lead, settings.reminderLeadMinutes.contains(lead), settings),
            const SizedBox(height: 10),
            const Text(
              // Worth saying plainly: the clamp is invisible otherwise, and an
              // owner who picked "2 hours before" for a 7am class would
              // reasonably expect a 5am message and be right to wonder.
              'A reminder that would land between 9pm and 8am is sent at 9pm the '
              'evening before instead — never later, so it always arrives before '
              'the appointment.',
              style: TextStyle(fontSize: 12, color: Sc.slate, height: 1.5),
            ),
          ],
        ],
      ),
    );
  }

  Widget _leadRow(int lead, bool active, BusinessSettings settings) {
    return InkWell(
      onTap: _saving ? null : () => _toggleLead(lead, settings),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Row(
          children: [
            Icon(
              active ? Icons.check_circle_rounded : Icons.circle_outlined,
              size: 19,
              color: active ? Sc.teal : Sc.slateFaint,
            ),
            const SizedBox(width: 11),
            Text(
              leadLabel(lead),
              style: TextStyle(
                fontSize: 14,
                fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                color: active ? Sc.ink : Sc.inkMuted,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _bookingWindowCard(BusinessSettings settings) {
    return _card(
      title: 'Booking window',
      child: Column(
        children: [
          _stepper(
            label: 'Shortest notice',
            value: '${settings.minNoticeMinutes} min',
            // Zero is a real choice — a walk-in-heavy business wants it — so the
            // floor is 0 rather than a token minimum.
            onLess: settings.minNoticeMinutes <= 0
                ? null
                : () => _save(minNoticeMinutes: _stepNotice(settings.minNoticeMinutes, -1)),
            onMore: settings.minNoticeMinutes >= 1440
                ? null
                : () => _save(minNoticeMinutes: _stepNotice(settings.minNoticeMinutes, 1)),
            hint: 'How soon before a slot a customer may still book it.',
          ),
          const Divider(height: 24, color: Sc.divider),
          _stepper(
            label: 'How far ahead',
            value: '${settings.bookingHorizonDays} days',
            onLess: settings.bookingHorizonDays <= 1
                ? null
                : () => _save(bookingHorizonDays: settings.bookingHorizonDays - 7 < 1
                    ? 1
                    : settings.bookingHorizonDays - 7),
            onMore: settings.bookingHorizonDays >= 365
                ? null
                : () => _save(bookingHorizonDays: settings.bookingHorizonDays + 7 > 365
                    ? 365
                    : settings.bookingHorizonDays + 7),
            hint: 'The furthest out anyone can book.',
          ),
        ],
      ),
    );
  }

  /// Steps through the values an owner would actually pick, not by a fixed
  /// amount: 0 → 15 → 30 → 60 → 120 → 240 → 1440.
  static int _stepNotice(int current, int direction) {
    const steps = [0, 15, 30, 60, 120, 240, 1440];
    final index = steps.indexWhere((s) => s >= current);
    final at = index < 0 ? steps.length - 1 : index;
    return steps[(at + direction).clamp(0, steps.length - 1)];
  }

  Widget _stepper({
    required String label,
    required String value,
    required String hint,
    required VoidCallback? onLess,
    required VoidCallback? onMore,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                label,
                style: const TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w500,
                  color: Sc.ink,
                ),
              ),
            ),
            _round(Icons.remove_rounded, onLess),
            SizedBox(
              width: 72,
              child: Text(
                value,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                  color: Sc.ink,
                ),
              ),
            ),
            _round(Icons.add_rounded, onMore),
          ],
        ),
        const SizedBox(height: 4),
        Text(hint, style: const TextStyle(fontSize: 12, color: Sc.slate, height: 1.4)),
      ],
    );
  }

  Widget _round(IconData icon, VoidCallback? onTap) {
    final enabled = onTap != null && !_saving;
    return Material(
      color: enabled ? Sc.tealSoft : Sc.chipFill,
      shape: const CircleBorder(),
      child: InkWell(
        onTap: enabled ? onTap : null,
        customBorder: const CircleBorder(),
        child: SizedBox(
          width: 32,
          height: 32,
          child: Icon(icon, size: 17, color: enabled ? Sc.teal900 : Sc.slateFaint),
        ),
      ),
    );
  }

  Widget _about(BusinessSettings settings) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          settings.name,
          style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: Sc.inkMuted),
        ),
        const SizedBox(height: 3),
        Text(
          '${settings.city ?? 'No city set'} · ${settings.timezone}',
          style: const TextStyle(fontSize: 12, color: Sc.slateLight),
        ),
      ],
    );
  }

  Widget _card({required String title, required Widget child}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, color: Sc.ink),
        ),
        const SizedBox(height: 10),
        Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(15),
            border: Border.all(color: Sc.divider),
          ),
          padding: const EdgeInsets.fromLTRB(15, 13, 15, 13),
          child: child,
        ),
      ],
    );
  }

  /// Removing the last lead time switches reminders off rather than leaving them
  /// "on" with nothing to send — which is the same state wearing a misleading
  /// label, and the owner would have no way to tell why nobody is being reminded.
  Future<void> _toggleLead(int lead, BusinessSettings settings) async {
    final next = [...settings.reminderLeadMinutes];
    next.contains(lead) ? next.remove(lead) : next.add(lead);

    if (next.isEmpty) {
      await _save(remindersEnabled: false, reminderLeadMinutes: const []);
      return;
    }
    await _save(reminderLeadMinutes: next);
  }

  Future<void> _save({
    bool? remindersEnabled,
    List<int>? reminderLeadMinutes,
    int? minNoticeMinutes,
    int? bookingHorizonDays,
  }) async {
    setState(() => _saving = true);

    try {
      final updated = await _api.updateSettings(
        _businessId,
        remindersEnabled: remindersEnabled,
        reminderLeadMinutes: reminderLeadMinutes,
        minNoticeMinutes: minNoticeMinutes,
        bookingHorizonDays: bookingHorizonDays,
      );
      if (!mounted) return;
      // Taken from the RESPONSE, not from what was sent: the backend sorts and
      // de-duplicates the lead times, and showing the request would leave the
      // screen disagreeing with the server about what was saved.
      setState(() {
        _settings = updated;
        _saving = false;
      });
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() => _saving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          backgroundColor: Sc.dangerTitle,
          content: Text(err.fieldErrors.values.firstOrNull ?? err.message),
        ),
      );
    }
  }
}
