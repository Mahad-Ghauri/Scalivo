import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/growth_models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/owner_report_widgets.dart';

class AnalyticsScreen extends StatefulWidget {
  const AnalyticsScreen({super.key});
  @override
  State<AnalyticsScreen> createState() => _AnalyticsScreenState();
}

class _AnalyticsScreenState extends State<AnalyticsScreen> {
  AnalyticsReport? _report;
  ApiException? _error;
  bool _loading = true;
  int _days = 30, _version = 0;

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
      _report = null;
    });
    final auth = context.read<AuthController>();
    final today = startOfToday(timezone: auth.business!.timezone);
    // Calendar arithmetic rather than 24-hour subtraction across DST changes.
    final from = DateTime(today.year, today.month, today.day - _days + 1);
    try {
      final report = await auth.api.analytics(
        auth.business!.id,
        from,
        today,
        granularity: _days > 30
            ? 'month'
            : _days > 7
            ? 'week'
            : 'day',
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

  @override
  Widget build(BuildContext context) {
    final report = _report;
    final highestRevenue =
        report?.series.fold<int>(
          0,
          (highest, point) => math.max(highest, point.revenueMinor),
        ) ??
        0;
    return OwnerReportPage(
      title: 'Analytics',
      loading: _loading,
      error: _error,
      onRefresh: _load,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final period in [
              (1, 'Today'),
              (7, '7 days'),
              (30, '30 days'),
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
        const SizedBox(height: 24),
        if (report != null) ...[
          ReportSection(
            title: 'Revenue earned',
            children: [
              Text(
                money(report.revenueMinor),
                style: const TextStyle(
                  fontSize: 30,
                  fontWeight: FontWeight.w600,
                  color: Sc.ink,
                ),
              ),
              const Text(
                'Completed appointments only. Cancelled and missed visits earn no revenue.',
                style: TextStyle(color: Sc.slate),
              ),
              if (report.volume['total'] == 0)
                const Padding(
                  padding: EdgeInsets.only(top: 12),
                  child: Text(
                    'No appointments in this period. Your numbers will appear as bookings come in.',
                  ),
                ),
            ],
          ),
          ReportSection(
            title: 'Appointments',
            children: [
              for (final metric in [
                ('total', 'Total'),
                ('completed', 'Completed'),
                ('noShow', 'No-show'),
                ('cancelled', 'Cancelled'),
                ('upcoming', 'Upcoming / pending'),
              ])
                ReportMetric(
                  label: metric.$2,
                  value: '${report.volume[metric.$1]}',
                ),
              ReportMetric(
                label: 'No-show rate',
                value: report.noShowRate == null
                    ? 'Not enough data'
                    : '${(report.noShowRate! * 100).toStringAsFixed(1)}%',
              ),
            ],
          ),
          ReportSection(
            title: 'Revenue over time',
            children: [
              for (final point in report.series)
                _revenueBar(point, highestRevenue),
            ],
          ),
          ReportSection(
            title: 'Already booked ahead',
            children: [
              ReportMetric(
                label:
                    '${report.forecastBookings} future confirmed appointments',
                value: money(report.forecastMinor),
              ),
              const Text(
                'Across all future dates, separate from this report period. This is booked revenue, not money earned.',
                style: TextStyle(color: Sc.slate),
              ),
            ],
          ),
          ReportSection(
            title: 'Top services in this period',
            children: [
              if (report.topServices.isEmpty)
                const Text('No completed services yet.'),
              for (final item in report.topServices)
                ReportMetric(
                  label: '${item.name} · ${item.visits} visits',
                  value: money(item.amountMinor),
                ),
            ],
          ),
          ReportSection(
            title: 'Top clients · lifetime',
            children: [
              if (report.topClients.isEmpty)
                const Text('No client spending yet.'),
              for (final item in report.topClients)
                ReportMetric(
                  label: '${item.name} · ${item.visits} visits',
                  value: money(item.amountMinor),
                ),
            ],
          ),
        ],
      ],
    );
  }

  Widget _revenueBar(RevenuePoint point, int highest) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        children: [
          ReportMetric(label: point.period, value: money(point.revenueMinor)),
          Semantics(
            label:
                '${point.period}: ${money(point.revenueMinor)}, ${point.completed} completed appointments',
            child: ExcludeSemantics(
              child: LinearProgressIndicator(
                value: highest == 0 ? 0 : point.revenueMinor / highest,
                minHeight: 6,
                color: Sc.teal,
                backgroundColor: Sc.chipFill,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
