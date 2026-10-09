import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/growth_models.dart';
import '../api/models.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/owner_report_widgets.dart';
import '../widgets/sc_button.dart';

class CampaignScreen extends StatefulWidget {
  const CampaignScreen({super.key, this.audience = CampaignAudience.lapsed});
  final CampaignAudience audience;
  @override
  State<CampaignScreen> createState() => _CampaignScreenState();
}

class _CampaignScreenState extends State<CampaignScreen> {
  final _message = TextEditingController();
  late CampaignAudience _audience;
  AudiencePreview? _preview;
  ApiException? _error;
  bool _loading = true, _sending = false, _confirming = false;
  int _version = 0;

  @override
  void initState() {
    super.initState();
    _audience = widget.audience;
    _load();
  }

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (_sending) return;
    final version = ++_version;
    setState(() {
      _loading = true;
      _error = null;
      _preview = null;
    });
    final auth = context.read<AuthController>();
    try {
      final preview = await auth.api.campaignAudience(
        auth.business!.id,
        _audience,
      );
      if (!mounted || version != _version) return;
      setState(() {
        _preview = preview;
        _loading = false;
        if (_message.text.isEmpty) _message.text = preview.suggested;
      });
    } on ApiException catch (err) {
      if (!mounted || version != _version) return;
      setState(() {
        _error = err;
        _loading = false;
      });
    }
  }

  Future<void> _send() async {
    final preview = _preview;
    if (_sending ||
        _loading ||
        preview == null ||
        preview.reachable == 0 ||
        context.read<AuthController>().health != SessionHealth.live) {
      return;
    }
    final message = _message.text.trim();
    if (message.length < 10 || message.length > 600) {
      setState(
        () => _error = const ApiException(
          ApiErrorKind.validation,
          'Use a message of 10–600 characters',
        ),
      );
      return;
    }
    setState(() {
      _sending = true;
      _confirming = true;
    });
    final confirmed = await confirmOwnerAction(
      context,
      'Send this campaign?',
      'This message targets up to ${preview.reachable} eligible customers. Opt-outs and recent messages are excluded. Messages are throttled; delivery is tracked separately.',
      label: 'Send campaign',
    );
    if (!mounted) return;
    setState(() => _confirming = false);
    if (!confirmed) {
      setState(() => _sending = false);
      return;
    }
    final auth = context.read<AuthController>();
    try {
      await auth.api.createCampaign(auth.business!.id, _audience, message);
      if (!mounted) return;
      Navigator.pop(context, true);
    } on ApiException catch (err) {
      if (!mounted) return;
      // A timed-out POST may have succeeded. Return to the measured campaign list
      // instead of inviting a retry that might send a second campaign.
      if (err.kind == ApiErrorKind.network || err.kind == ApiErrorKind.server) {
        final messenger = ScaffoldMessenger.of(context);
        Navigator.pop(context, true);
        messenger.showSnackBar(
          const SnackBar(
            content: Text(
              'Couldn’t verify the send. Check recent campaigns before trying again.',
            ),
          ),
        );
        return;
      }
      setState(() {
        _error = err;
        _sending = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final preview = _preview;
    final health = context.watch<AuthController>().health;
    return OwnerReportPage(
      title: 'New campaign',
      loading: _loading,
      error: _error,
      onRefresh: _load,
      children: [
        const Text(
          'Choose who to reach',
          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          children: [
            for (final audience in CampaignAudience.values)
              ChoiceChip(
                label: Text(
                  audience == CampaignAudience.atRisk ? 'At risk' : 'Lapsed',
                ),
                selected: _audience == audience,
                onSelected: _sending
                    ? null
                    : (_) {
                        if (_audience != audience) {
                          _audience = audience;
                          _load();
                        }
                      },
              ),
          ],
        ),
        const SizedBox(height: 20),
        if (preview != null)
          ReportSection(
            title: 'Audience preview',
            children: [
              ReportMetric(
                label: 'Matching customers',
                value: '${preview.matched}',
              ),
              ReportMetric(
                label: 'Eligible to receive',
                value: '${preview.reachable}',
              ),
              ReportMetric(
                label: 'Opted out',
                value: '${preview.excluded['optedOut']}',
              ),
              ReportMetric(
                label: 'Recently messaged',
                value: '${preview.excluded['recentlyMessaged']}',
              ),
              ReportMetric(
                label: 'No WhatsApp address',
                value: '${preview.excluded['noAddress']}',
              ),
              ReportMetric(
                label: 'First contact with this number',
                value: '${preview.coldContacts}',
              ),
              ReportMetric(
                label: 'Today’s remaining allowance',
                value: '${preview.remainingToday}',
              ),
              const Text(
                'Eligibility is checked again before sending. Daily limits may spread delivery across multiple days.',
                style: TextStyle(color: Sc.slate),
              ),
            ],
          ),
        TextField(
          controller: _message,
          enabled: !_sending,
          maxLength: 600,
          minLines: 4,
          maxLines: 8,
          decoration: const InputDecoration(
            labelText: 'Your message',
            helperText:
                '10–600 characters. Customers can reply STOP to opt out.',
          ),
          onChanged: (_) => setState(() {}),
        ),
        const SizedBox(height: 24),
        if (health != SessionHealth.live)
          const Padding(
            padding: EdgeInsets.only(bottom: 16),
            child: Text(
              'Reconnect WhatsApp before sending a campaign.',
              style: TextStyle(color: Sc.dangerText),
            ),
          ),
        if (preview?.reachable == 0)
          const Padding(
            padding: EdgeInsets.only(bottom: 16),
            child: Text(
              'Nobody in this group can be messaged right now. Try another group or check back later.',
            ),
          ),
        ScButton(
          label: 'Review & send',
          loading: _sending && !_confirming,
          loadingLabel: 'Sending',
          onPressed:
              _sending ||
                  _loading ||
                  preview == null ||
                  preview.reachable == 0 ||
                  health != SessionHealth.live ||
                  _message.text.trim().length < 10
              ? null
              : _send,
        ),
      ],
    );
  }
}
