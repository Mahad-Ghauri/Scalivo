import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../api/api_client.dart';
import '../api/growth_models.dart';
import '../api/models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/owner_report_widgets.dart';
import '../widgets/sc_button.dart';
import 'campaign_screen.dart';
import 'poster_screen.dart';

class GrowScreen extends StatefulWidget {
  const GrowScreen({super.key});
  @override
  State<GrowScreen> createState() => _GrowScreenState();
}

class _GrowScreenState extends State<GrowScreen> {
  GrowthBusiness? _business;
  BoostState? _boost;
  FunnelReport? _funnel;
  NudgeReport? _nudges;
  List<CampaignSummary> _campaigns = const [];
  String? _invite;
  ApiException? _error;
  bool _loading = true, _busy = false;
  int _version = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_busy) return;
    final version = ++_version;
    setState(() {
      _loading = true;
      _error = null;
    });
    final auth = context.read<AuthController>();
    final id = auth.business!.id;
    final today = startOfToday(timezone: auth.business!.timezone);
    final from = DateTime(today.year, today.month, today.day - 29);
    try {
      final results = await Future.wait<Object?>([
        auth.api.growthBusiness(id),
        auth.api.boost(id),
        auth.api.funnel(id, from, today),
        auth.api.nudges(id),
        auth.api.campaigns(id),
        auth.api.bookingInvite(id),
      ]);
      if (!mounted || version != _version) return;
      setState(() {
        _business = results[0] as GrowthBusiness;
        _boost = results[1] as BoostState;
        _funnel = results[2] as FunnelReport;
        _nudges = results[3] as NudgeReport;
        _campaigns = results[4] as List<CampaignSummary>;
        _invite = results[5] as String?;
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

  Future<void> _mutate(
    Future<void> Function() action,
    String title,
    String detail,
  ) async {
    if (_busy || _loading) return;
    setState(() => _busy = true);
    if (!await confirmOwnerAction(context, title, detail)) {
      if (mounted) setState(() => _busy = false);
      return;
    }
    if (!mounted) return;
    try {
      await action();
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Updated')));
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() => _error = err);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(err.message)));
    }
    if (!mounted) return;
    setState(() => _busy = false);
    await _load();
  }

  Future<void> _copy(String text) async {
    try {
      await Clipboard.setData(ClipboardData(text: text));
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text('Booking link copied')));
      }
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Couldn’t copy the link. Try again.')),
        );
      }
    }
  }

  Future<void> _share(BuildContext origin, String text) async {
    final box = origin.findRenderObject() as RenderBox?;
    try {
      await SharePlus.instance.share(
        ShareParams(
          text: text,
          sharePositionOrigin: box == null
              ? null
              : box.localToGlobal(Offset.zero) & box.size,
        ),
      );
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Couldn’t open sharing. You can copy the link instead.',
            ),
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthController>();
    final business = _business;
    final boost = _boost;
    final nudges = _nudges;
    final funnel = _funnel;
    final disabled = _busy || _loading || _error != null;
    return OwnerReportPage(
      title: 'Grow',
      loading: _loading,
      error: _error,
      onRefresh: _load,
      children: [
        if (business != null)
          ReportSection(
            title: 'Bring customers to your booking page',
            children: [
              if (_invite == null && business.bookingUrl == null)
                const Text(
                  'Connect WhatsApp or publish your business profile before sharing a booking link.',
                ),
              if (_invite != null)
                _shareRow('WhatsApp booking', _invite!, disabled),
              if (business.bookingUrl != null) ...[
                for (final channel in [
                  ('instagram', 'Instagram'),
                  ('facebook', 'Facebook'),
                  ('whatsapp', 'WhatsApp status'),
                  ('link', 'Anywhere else'),
                ])
                  _shareRow(
                    channel.$2,
                    Uri.parse(business.bookingUrl!)
                        .replace(queryParameters: {'ref': channel.$1})
                        .toString(),
                    disabled,
                  ),
              ],
              if (_invite != null || business.bookingUrl != null)
                ScButton(
                  label: 'Create QR poster',
                  onPressed: disabled
                      ? null
                      : () {
                          final link =
                              _invite ??
                              Uri.parse(business.bookingUrl!)
                                  .replace(queryParameters: {'ref': 'qr'})
                                  .toString();
                          Navigator.push(
                            context,
                            MaterialPageRoute<void>(
                              builder: (_) =>
                                  PosterScreen(name: business.name, link: link),
                            ),
                          );
                        },
                ),
            ],
          ),
        if (boost != null && business != null)
          ReportSection(
            title: 'Featured listing',
            children: [
              const Text(
                'A boost highlights your published listing for seven days. It does not guarantee bookings.',
                style: TextStyle(color: Sc.slate),
              ),
              if (boost.active && boost.until != null)
                Text(
                  'Active until ${dayLabel(businessTime(boost.until!, timezone: auth.business!.timezone))}',
                ),
              if (!business.published)
                const Text('Publish your business profile before boosting it.'),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('Boost listing'),
                value: boost.active,
                onChanged: disabled || !business.published
                    ? null
                    : (enabled) => _mutate(
                        () async {
                          await auth.api.setBoost(auth.business!.id, enabled);
                        },
                        enabled ? 'Boost your listing?' : 'Stop this boost?',
                        enabled
                            ? 'Your published listing will be highlighted for seven days.'
                            : 'Your listing will return to its normal placement.',
                      ),
              ),
            ],
          ),
        if (funnel != null)
          ReportSection(
            title: 'Discovery · last 30 days',
            children: [
              ReportMetric(
                label: 'Profile views',
                value: '${funnel.totals['views']}',
              ),
              ReportMetric(
                label: 'Booking forms started',
                value: '${funnel.totals['starts']}',
              ),
              ReportMetric(
                label: 'Web bookings',
                value: '${funnel.totals['bookings']}',
              ),
              ReportMetric(
                label: 'WhatsApp bookings',
                value: '${funnel.whatsappBookings}',
              ),
              const Text(
                'WhatsApp bookings are separate because they do not start with a profile view. Pull down to refresh.',
                style: TextStyle(color: Sc.slate),
              ),
            ],
          ),
        if (nudges != null)
          ReportSection(
            title: 'Automatic rebooking nudges',
            children: [
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('Send rebooking nudges'),
                subtitle: const Text(
                  'Eligible at-risk clients only. Opt-outs, quiet periods and daily limits apply.',
                ),
                value: nudges.enabled,
                onChanged: disabled
                    ? null
                    : (enabled) => _mutate(
                        () async {
                          await auth.api.setNudges(auth.business!.id, enabled);
                        },
                        enabled
                            ? 'Enable automatic nudges?'
                            : 'Pause automatic nudges?',
                        enabled
                            ? 'The system may send rebooking messages to eligible clients. Existing messaging limits remain in effect.'
                            : 'Future automatic nudges will pause. Transactional reminders will continue.',
                      ),
              ),
              const Text(
                'Measured outcomes · last 30 days',
                style: TextStyle(color: Sc.slate),
              ),
              ..._outcome(nudges.outcome),
            ],
          ),
        ReportSection(
          title: 'Campaigns',
          children: [
            ScButton(
              label: 'New campaign',
              onPressed: disabled || auth.health != SessionHealth.live
                  ? null
                  : () async {
                      final changed = await Navigator.push<bool>(
                        context,
                        MaterialPageRoute(
                          builder: (_) => const CampaignScreen(),
                        ),
                      );
                      if (mounted && changed == true) _load();
                    },
            ),
            if (auth.health != SessionHealth.live)
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: Text('Reconnect WhatsApp to send a new campaign.'),
              ),
            if (_campaigns.isEmpty && !_loading && _error == null)
              const Padding(
                padding: EdgeInsets.only(top: 12),
                child: Text(
                  'No campaigns yet. Preview an eligible audience before sending.',
                ),
              ),
            const SizedBox(height: 16),
            for (final campaign in _campaigns)
              ReportSection(
                title:
                    '${campaign.audience == 'lapsed' ? 'Lapsed' : 'At-risk'} clients · ${dayLabel(businessTime(campaign.createdAt, timezone: auth.business!.timezone))}',
                children: [
                  Text(campaign.message),
                  ReportMetric(
                    label: 'Campaign status',
                    value: campaign.status == 'sent'
                        ? 'All attempts finished'
                        : campaign.status == 'sending'
                        ? 'Sending gradually'
                        : 'Stopped',
                  ),
                  ReportMetric(
                    label: 'Targeted',
                    value: '${campaign.targeted}',
                  ),
                  ..._outcome(campaign.outcome),
                  if (campaign.status == 'sending')
                    ScButton(
                      label: 'Stop remaining sends',
                      tone: ScButtonTone.danger,
                      onPressed: disabled
                          ? null
                          : () => _mutate(
                              () => auth.api.cancelCampaign(
                                auth.business!.id,
                                campaign.id,
                              ),
                              'Stop this campaign?',
                              'Messages already sent cannot be recalled. Only remaining sends will stop.',
                            ),
                    ),
                ],
              ),
            if (_campaigns.length == 20)
              const Text(
                'Showing the latest 20 campaigns.',
                style: TextStyle(color: Sc.slate),
              ),
          ],
        ),
      ],
    );
  }

  Widget _shareRow(String label, String link, bool disabled) => Padding(
    padding: const EdgeInsets.only(bottom: 18),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
        SelectableText(link, style: const TextStyle(color: Sc.slate)),
        Wrap(
          spacing: 8,
          children: [
            TextButton.icon(
              onPressed: disabled ? null : () => _copy(link),
              icon: const Icon(Icons.copy_outlined),
              label: const Text('Copy link'),
            ),
            Builder(
              builder: (origin) => TextButton.icon(
                onPressed: disabled
                    ? null
                    : () =>
                          _share(origin, 'Book with ${_business!.name}: $link'),
                icon: const Icon(Icons.share_outlined),
                label: const Text('Share'),
              ),
            ),
          ],
        ),
      ],
    ),
  );
  List<Widget> _outcome(CampaignOutcome outcome) => [
    for (final item in [
      ('delivered', 'Delivered'),
      ('undelivered', 'Not confirmed delivered'),
      ('queued', 'Queued'),
      ('skipped', 'Skipped'),
      ('replied', 'Replied'),
      ('rebooked', 'Rebooked'),
      ('optedOut', 'Opted out'),
    ])
      ReportMetric(label: item.$2, value: '${outcome.counts[item.$1]}'),
  ];
}
