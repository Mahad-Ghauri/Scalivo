import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../theme.dart';
import 'sc_banner.dart';
import 'sc_button.dart';

/// Common presentation for the owner's reports, using the app's existing tokens.
class OwnerReportPage extends StatelessWidget {
  const OwnerReportPage({
    super.key,
    required this.title,
    required this.loading,
    required this.onRefresh,
    required this.children,
    this.error,
  });
  final String title;
  final bool loading;
  final ApiException? error;
  final Future<void> Function() onRefresh;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Sc.paper,
    appBar: AppBar(
      title: Text(title),
      backgroundColor: Sc.paper,
      surfaceTintColor: Sc.paper,
    ),
    body: RefreshIndicator(
      color: Sc.teal,
      onRefresh: onRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(22, 12, 22, 40),
        children: [
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 20),
              child: ScBanner(
                title: error!.kind == ApiErrorKind.validation
                    ? 'Check these details'
                    : 'Couldn’t finish this request',
                message: error!.message,
                action: ScButton(
                  label: 'Try again',
                  onPressed: loading ? null : () => onRefresh(),
                ),
              ),
            ),
          if (loading)
            const Padding(
              padding: EdgeInsets.all(32),
              child: Center(child: CircularProgressIndicator(color: Sc.teal)),
            ),
          ...children,
        ],
      ),
    ),
  );
}

class ReportSection extends StatelessWidget {
  const ReportSection({super.key, required this.title, required this.children});
  final String title;
  final List<Widget> children;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 17,
            fontWeight: FontWeight.w600,
            color: Sc.ink,
          ),
        ),
        const SizedBox(height: 12),
        ...children,
      ],
    ),
  );
}

class ReportMetric extends StatelessWidget {
  const ReportMetric({super.key, required this.label, required this.value});
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Text(
            label,
            style: const TextStyle(color: Sc.slate, fontSize: 14),
          ),
        ),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            style: const TextStyle(
              color: Sc.ink,
              fontSize: 15,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}

Future<bool> confirmOwnerAction(
  BuildContext context,
  String title,
  String message, {
  String label = 'Confirm',
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Keep as is'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(label),
          ),
        ],
      ),
    ) ==
    true;
