import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/growth_models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/owner_report_widgets.dart';
import '../widgets/sc_button.dart';
import 'client_profile_screen.dart';

class ReviewsScreen extends StatefulWidget {
  const ReviewsScreen({super.key});
  @override
  State<ReviewsScreen> createState() => _ReviewsScreenState();
}

class _ReviewsScreenState extends State<ReviewsScreen> {
  ReviewSummary? _summary;
  ReviewPage? _page;
  ApiException? _error;
  bool _loading = true;
  int _skip = 0, _version = 0;
  String _filter = 'all';

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
      _page = null;
    });
    final auth = context.read<AuthController>();
    try {
      final results = await Future.wait<Object>([
        auth.api.reviewSummary(auth.business!.id),
        auth.api.reviews(auth.business!.id, filter: _filter, skip: _skip),
      ]);
      if (!mounted || version != _version) return;
      setState(() {
        _summary = results[0] as ReviewSummary;
        _page = results[1] as ReviewPage;
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
    final summary = _summary;
    final page = _page;
    final timezone = context.read<AuthController>().business!.timezone;
    return OwnerReportPage(
      title: 'Reviews',
      loading: _loading,
      error: _error,
      onRefresh: _load,
      children: [
        if (summary != null)
          ReportSection(
            title: 'Across all ratings',
            children: [
              ReportMetric(
                label: 'Average rating',
                value: summary.averageRating == null
                    ? 'No ratings yet'
                    : '${summary.averageRating!.toStringAsFixed(1)} / 5',
              ),
              ReportMetric(
                label: 'Private alerts',
                value: '${summary.flagged}',
              ),
              ReportMetric(
                label: 'Review requests answered',
                value: summary.requested == 0
                    ? 'No requests yet'
                    : '${summary.answered} of ${summary.requested} · ${(summary.captureRate * 100).round()}%',
              ),
            ],
          ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final filter in [
              ('all', 'All'),
              ('published', 'Published'),
              ('flagged', 'Needs attention'),
            ])
              ChoiceChip(
                label: Text(filter.$2),
                selected: _filter == filter.$1,
                onSelected: (_) {
                  if (_filter != filter.$1) {
                    _filter = filter.$1;
                    _skip = 0;
                    _load();
                  }
                },
              ),
          ],
        ),
        const SizedBox(height: 20),
        if (page != null) ...[
          if (page.reviews.isEmpty)
            Text(
              _filter == 'flagged' ? 'No reviews need attention.' : 'No reviews here yet. Completed appointments can generate a rating request.',
            ),
          for (final review in page.reviews)
            Padding(
              padding: const EdgeInsets.only(bottom: 24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ReportMetric(
                    label: review.authorName,
                    value: '${review.rating} / 5',
                  ),
                  Text(
                    '${review.serviceName ?? 'Appointment'} · ${dayLabel(businessTime(review.createdAt, timezone: timezone))}',
                    style: const TextStyle(color: Sc.slate),
                  ),
                  if (review.comment.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 10),
                      child: Text(review.comment),
                    ),
                  Text(
                    review.flagged
                        ? 'Private · follow up with this customer'
                        : review.published
                        ? 'Published on your profile'
                        : 'Private rating',
                    style: TextStyle(
                      color: review.flagged ? Sc.dangerText : Sc.slate,
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (review.flagged && review.clientId != null)
                    TextButton(
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => ClientProfileScreen(
                            clientId: review.clientId!,
                            fallbackName: review.authorName,
                          ),
                        ),
                      ),
                      child: const Text('View customer'),
                    ),
                  const Divider(),
                ],
              ),
            ),
          if (_skip > 0)
            ScButton(
              label: 'Previous reviews',
              onPressed: _loading
                  ? null
                  : () {
                      _skip -= 20;
                      _load();
                    },
            ),
          const SizedBox(height: 10),
          if (_skip + page.reviews.length < page.total && _skip < 10000)
            ScButton(
              label: 'Next reviews',
              onPressed: _loading
                  ? null
                  : () {
                      _skip += 20;
                      _load();
                    },
            ),
          if (page.total > 0)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                'Showing ${_skip + (page.reviews.isEmpty ? 0 : 1)}–${_skip + page.reviews.length} of ${page.total}',
                style: const TextStyle(color: Sc.slate),
              ),
            ),
        ],
      ],
    );
  }
}
