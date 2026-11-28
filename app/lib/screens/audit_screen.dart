import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';

import '../api/api_client.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/owner_report_widgets.dart';

/// The audit log: every booking, message, payment and change, who did it, and
/// a PDF of the same report to save or send.
class AuditScreen extends StatefulWidget {
  const AuditScreen({super.key});
  @override
  State<AuditScreen> createState() => _AuditScreenState();
}

class _AuditScreenState extends State<AuditScreen> {
  AuditReport? _report;
  ApiException? _error;
  bool _loading = true, _exporting = false;
  int _days = 30, _version = 0;
  String _category = '', _search = '';
  final _searchField = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _searchField.dispose();
    super.dispose();
  }

  (DateTime, DateTime) _range() {
    final auth = context.read<AuthController>();
    final today = startOfToday(timezone: auth.business!.timezone);
    return (DateTime(today.year, today.month, today.day - _days + 1), today);
  }

  Future<void> _load() async {
    final version = ++_version;
    setState(() {
      _loading = true;
      _error = null;
    });
    final auth = context.read<AuthController>();
    final (from, to) = _range();
    try {
      final report = await auth.api.auditReport(
        auth.business!.id,
        from,
        to,
        category: _category,
        search: _search,
      );
      if (!mounted || version != _version) return;
      setState(() {
        _report = report;
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

  Future<void> _downloadPdf(BuildContext origin) async {
    if (_exporting) return;
    setState(() => _exporting = true);
    final auth = context.read<AuthController>();
    final (from, to) = _range();
    try {
      final bytes = await auth.api.auditPdf(
        auth.business!.id,
        from,
        to,
        category: _category,
        search: _search,
      );
      final directory = await getTemporaryDirectory();
      final name = 'audit-report-${isoDate(from)}-to-${isoDate(to)}.pdf';
      final file = File('${directory.path}/$name');
      await file.writeAsBytes(bytes, flush: true);
      if (!mounted || !origin.mounted) return;
      final box = origin.findRenderObject() as RenderBox?;
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path, mimeType: 'application/pdf')],
          title: 'Audit report',
          sharePositionOrigin: box == null
              ? null
              : box.localToGlobal(Offset.zero) & box.size,
        ),
      );
    } on Object catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              err is ApiException
                  ? err.message
                  : 'Couldn’t save the PDF. Try again.',
            ),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  static const _toneColor = {
    'ok': Color(0xFF1F9D55),
    'warning': Color(0xFFB7791F),
    'problem': Color(0xFFC53030),
  };

  String _when(DateTime at) {
    final local = at.toLocal();
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    final hour = local.hour % 12 == 0 ? 12 : local.hour % 12;
    final minute = local.minute.toString().padLeft(2, '0');
    return '${local.day} ${months[local.month - 1]}, $hour:$minute ${local.hour < 12 ? 'AM' : 'PM'}';
  }

  @override
  Widget build(BuildContext context) {
    final report = _report;
    final labels = {for (final c in auditCategories) c.$1: c.$2};
    return OwnerReportPage(
      title: 'Audit log',
      loading: _loading && report == null,
      error: _error,
      onRefresh: _load,
      children: [
        Builder(
          builder: (origin) => FilledButton.icon(
            style: FilledButton.styleFrom(
              backgroundColor: Sc.teal,
              minimumSize: const Size.fromHeight(48),
            ),
            onPressed: _exporting ? null : () => _downloadPdf(origin),
            icon: _exporting
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.picture_as_pdf_outlined),
            label: Text(_exporting ? 'Preparing PDF…' : 'Download PDF'),
          ),
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final period in [
              (1, 'Today'),
              (7, '7 days'),
              (30, '30 days'),
              (90, '90 days'),
              (365, '12 months'),
            ])
              ChoiceChip(
                label: Text(period.$2),
                selected: _days == period.$1,
                onSelected: (_) {
                  if (_days != period.$1) {
                    _days = period.$1;
                    _load();
                  }
                },
              ),
          ],
        ),
        const SizedBox(height: 12),
        DropdownButtonFormField<String>(
          initialValue: _category,
          decoration: const InputDecoration(labelText: 'Type'),
          items: [
            for (final c in auditCategories)
              DropdownMenuItem(value: c.$1, child: Text(c.$2)),
          ],
          onChanged: (value) {
            _category = value ?? '';
            _load();
          },
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _searchField,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(
            labelText: 'Search customer, staff or service',
            prefixIcon: Icon(Icons.search),
          ),
          onSubmitted: (value) {
            _search = value;
            _load();
          },
        ),
        const SizedBox(height: 20),
        if (report != null) ...[
          ReportSection(
            title: 'Summary',
            children: [
              ReportMetric(
                label: 'Bookings',
                value: '${report.count('bookings')}',
              ),
              ReportMetric(
                label: 'From WhatsApp · website · you',
                value:
                    '${report.bySource('whatsapp')} · ${report.bySource('web')} · ${report.bySource('owner')}',
              ),
              ReportMetric(
                label: 'Completed',
                value: '${report.count('completed')}',
              ),
              ReportMetric(
                label: 'Cancelled',
                value: '${report.count('cancelled')}',
              ),
              ReportMetric(
                label: 'No-shows',
                value: '${report.count('noShows')}',
              ),
              ReportMetric(
                label: 'Revenue (completed)',
                value: money(report.count('revenueMinor')),
              ),
              ReportMetric(
                label: 'Messages sent',
                value: '${report.count('messagesSent')}',
              ),
              ReportMetric(
                label: 'Delivery rate',
                value: report.maybe('deliveryRate') == null
                    ? 'n/a'
                    : '${report.maybe('deliveryRate')}%',
              ),
              ReportMetric(
                label: 'Failed messages',
                value: '${report.count('messagesFailed')}',
              ),
              ReportMetric(
                label: 'WhatsApp disconnects',
                value: '${report.count('whatsappDisconnects')}',
              ),
              ReportMetric(
                label: 'Reviews · average',
                value:
                    '${report.count('reviews')} · ${report.maybe('averageRating') == null ? 'n/a' : '${report.maybe('averageRating')} / 5'}',
              ),
              ReportMetric(
                label: 'Staff actions',
                value: '${report.count('staffActions')}',
              ),
            ],
          ),
          ReportSection(
            title:
                '${report.events.length} entries${report.truncated ? ' (newest 5,000)' : ''}',
            children: [
              if (report.events.isEmpty)
                const Text('Nothing matches these filters.'),
              for (final e in report.events)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 6, right: 10),
                        child: CircleAvatar(
                          radius: 4,
                          backgroundColor: _toneColor[e.tone] ?? Sc.slate,
                        ),
                      ),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              e.title,
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                color: Sc.ink,
                              ),
                            ),
                            if (e.detail.isNotEmpty)
                              Text(
                                e.detail,
                                style: const TextStyle(
                                  color: Sc.slate,
                                  fontSize: 13,
                                ),
                              ),
                            const SizedBox(height: 2),
                            Text(
                              '${_when(e.at)} · ${labels[e.category] ?? e.category}${e.actor.isEmpty ? '' : ' · ${e.actor}'}',
                              style: const TextStyle(
                                color: Sc.slateLight,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ],
      ],
    );
  }
}
