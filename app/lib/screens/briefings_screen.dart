import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/briefing_models.dart';
import '../api/growth_models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../state/calendar_controller.dart';
import '../theme.dart';
import '../widgets/owner_report_widgets.dart';
import '../widgets/sc_button.dart';
import 'analytics_screen.dart';
import 'campaign_screen.dart';
import 'tabs/calendar_tab.dart';

/// Dashboard suggestions open existing screens; they never execute a send.
Widget? briefingActionScreen(BriefingAction action) {
  try {
    final uri = Uri.tryParse(action.href);
    if (uri == null || uri.hasScheme || uri.hasAuthority || uri.hasFragment) {
      return null;
    }
    final query = uri.queryParameters;
    if (uri.path == '/analytics' && query.isEmpty) {
      return const AnalyticsScreen();
    }
    if (uri.path == '/grow/broadcast' &&
        query.length == 1 &&
        uri.queryParametersAll['audience']?.length == 1) {
      return switch (query['audience']) {
        'lapsed' => const CampaignScreen(),
        'at_risk' => const CampaignScreen(audience: CampaignAudience.atRisk),
        _ => null,
      };
    }
    if (uri.path == '/appointments' && query.isEmpty) {
      return const _BriefingCalendarScreen();
    }
    if (uri.path != '/calendar' ||
        query.keys.any((key) => !['date', 'view'].contains(key)) ||
        uri.queryParametersAll.values.any((values) => values.length != 1) ||
        (query['view'] != null && query['view'] != 'day')) {
      return null;
    }
    final date = query['date'];
    if (date == null) return const _BriefingCalendarScreen();
    if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(date)) return null;
    final parsed = DateTime.tryParse(date);
    if (parsed == null || isoDate(parsed) != date) return null;
    return _BriefingCalendarScreen(date: parsed);
  } on FormatException {
    return null;
  }
}

class BriefingsScreen extends StatefulWidget {
  const BriefingsScreen({super.key});
  @override
  State<BriefingsScreen> createState() => _BriefingsScreenState();
}

class _BriefingsScreenState extends State<BriefingsScreen> {
  BriefingFeed? _feed;
  ApiException? _error;
  bool _loading = true, _saving = false;
  String? _reading;
  int _version = 0;
  bool get _busy => _loading || _saving || _reading != null;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_saving || _reading != null) return;
    final version = ++_version;
    setState(() {
      _loading = true;
      _error = null;
    });
    final auth = context.read<AuthController>();
    try {
      final feed = await auth.api.briefings(auth.business!.id);
      if (!mounted || version != _version) return;
      setState(() {
        _feed = feed;
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

  Future<void> _save({bool? enabled, int? hour}) async {
    if (_busy) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final auth = context.read<AuthController>();
    try {
      await auth.api.updateAgentSettings(
        auth.business!.id,
        enabled: enabled,
        hour: hour,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Briefing settings updated')),
      );
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err;
        _saving = false;
      });
      return;
    }
    if (!mounted) return;
    setState(() => _saving = false);
    await _load();
  }

  Future<void> _markRead(Briefing briefing) async {
    if (_busy || briefing.readAt != null) return;
    setState(() {
      _reading = briefing.id;
      _error = null;
    });
    final auth = context.read<AuthController>();
    try {
      await auth.api.markBriefingRead(auth.business!.id, briefing.id);
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err;
        _reading = null;
      });
      return;
    }
    if (!mounted) return;
    setState(() => _reading = null);
    await _load();
  }

  Future<void> _open(Briefing briefing, Widget screen) async {
    if (_busy) return;
    await _markRead(briefing);
    if (!mounted) return;
    // A failed read receipt does not prevent the owner seeing their diary.
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => screen));
  }

  @override
  Widget build(BuildContext context) {
    final feed = _feed;
    final timezone = context.read<AuthController>().business!.timezone;
    final disabled = _busy || _error != null;
    return OwnerReportPage(
      title: 'Briefings',
      loading: _loading,
      error: _error,
      onRefresh: _load,
      children: [
        if (feed != null) ...[
          ReportSection(
            title: 'Summaries on your phone',
            children: [
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('Daily summaries and alerts'),
                subtitle: const Text(
                  'Daily briefing, Monday summary and threshold alerts. Turning this off keeps your existing history.',
                ),
                value: feed.settings.enabled,
                onChanged: disabled
                    ? null
                    : (enabled) => _save(enabled: enabled),
              ),
              DropdownButtonFormField<int>(
                key: ValueKey('${feed.settings.hour}:$_saving'),
                initialValue: feed.settings.hour,
                decoration: const InputDecoration(
                  labelText: 'Morning briefing time',
                ),
                items: [
                  for (var hour = 5; hour <= 11; hour++)
                    DropdownMenuItem(value: hour, child: Text('$hour:00 AM')),
                ],
                onChanged: disabled || !feed.settings.enabled
                    ? null
                    : (hour) {
                        if (hour != null && hour != feed.settings.hour) {
                          _save(hour: hour);
                        }
                      },
              ),
              const SizedBox(height: 12),
              Text(
                'Times follow your business timezone: $timezone. Allow app notifications to receive briefings on this device.',
                style: const TextStyle(color: Sc.slate),
              ),
              if (_saving)
                const Padding(
                  padding: EdgeInsets.all(12),
                  child: Center(
                    child: CircularProgressIndicator(color: Sc.teal),
                  ),
                ),
            ],
          ),
          ReportSection(
            title: 'Latest briefings',
            children: [
              Text(
                '${feed.unread} unread across your history',
                style: const TextStyle(color: Sc.slate),
              ),
              if (feed.briefings.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: Text(
                    feed.settings.enabled
                        ? 'No briefings yet. The next eligible briefing arrives at ${feed.settings.hour}:00 AM in your business timezone.'
                        : 'Briefings are paused. Enable them to receive future summaries and alerts.',
                  ),
                ),
              for (final briefing in feed.briefings)
                Padding(
                  padding: const EdgeInsets.only(top: 24),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Wrap(
                        spacing: 12,
                        runSpacing: 8,
                        children: [
                          Text(
                            switch (briefing.kind) {
                              'daily' => 'Daily summary',
                              'weekly' => 'Weekly summary',
                              _ => 'Needs attention',
                            },
                            style: const TextStyle(
                              fontWeight: FontWeight.w600,
                              color: Sc.slate,
                            ),
                          ),
                          if (briefing.readAt == null)
                            const Text(
                              'Unread',
                              style: TextStyle(
                                color: Sc.teal,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                        ],
                      ),
                      Text(
                        '${dayLabel(businessTime(briefing.scheduledFor, timezone: timezone))} · ${hhmm(businessTime(briefing.scheduledFor, timezone: timezone))}',
                        style: const TextStyle(color: Sc.slate),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        briefing.headline,
                        style: const TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(briefing.body),
                      const SizedBox(height: 12),
                      Text(
                        briefing.phrasedBy == 'template'
                            ? 'Written from your numbers'
                            : 'Written by Scalivo',
                        style: const TextStyle(color: Sc.slate),
                      ),
                      for (final action in briefing.actions)
                        if (briefingActionScreen(action)
                            case final Widget screen)
                          TextButton(
                            onPressed: disabled
                                ? null
                                : () => _open(briefing, screen),
                            child: Text(action.label),
                          ),
                      if (briefing.readAt == null)
                        ScButton(
                          label: 'Mark as read',
                          loading: _reading == briefing.id,
                          loadingLabel: 'Saving',
                          onPressed: disabled
                              ? null
                              : () => _markRead(briefing),
                        ),
                      const SizedBox(height: 16),
                      const Divider(),
                    ],
                  ),
                ),
              if (feed.briefings.length == 20)
                const Text(
                  'Showing the latest 20 briefings.',
                  style: TextStyle(color: Sc.slate),
                ),
            ],
          ),
        ],
      ],
    );
  }
}

class _BriefingCalendarScreen extends StatelessWidget {
  const _BriefingCalendarScreen({this.date});
  final DateTime? date;
  @override
  Widget build(BuildContext context) {
    final auth = context.read<AuthController>();
    return ChangeNotifierProvider(
      create: (_) {
        final controller = CalendarController(
          api: auth.api,
          businessId: auth.business!.id,
        );
        if (date != null) controller.selectedDay = date!;
        return controller;
      },
      child: Scaffold(
        backgroundColor: Sc.paper,
        appBar: AppBar(
          title: const Text('Calendar'),
          backgroundColor: Sc.paper,
          surfaceTintColor: Sc.paper,
        ),
        body: const Padding(padding: EdgeInsets.all(22), child: CalendarTab()),
      ),
    );
  }
}
