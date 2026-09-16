import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/models.dart';
import '../../format.dart';
import '../../state/auth_controller.dart';
import '../../state/calendar_controller.dart';
import '../../theme.dart';
import '../../widgets/sc_banner.dart';
import '../qr_screen.dart';
import 'calendar_tab.dart';

/// The screen an owner opens the app to see.
///
/// It answers one question — what is happening today — and it puts the WhatsApp
/// banner above the answer, because a day that looks empty because the session
/// is down reads exactly like a quiet day until someone says otherwise.
class TodayTab extends StatefulWidget {
  const TodayTab({super.key});

  @override
  State<TodayTab> createState() => _TodayTabState();
}

class _TodayTabState extends State<TodayTab> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final controller = context.read<CalendarController>();
      controller.ensureCatalogue();
      if (controller.view == null) controller.load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthController>();
    final calendar = context.watch<CalendarController>();

    // The Today tab is only ever today. If the owner wandered off in the
    // Calendar tab and came back, this pulls the shared controller home rather
    // than showing next Tuesday under a "Today" heading.
    final showingToday = isSameDay(calendar.selectedDay, startOfToday());

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (auth.health == SessionHealth.down) ...[
          ScBanner(
            title: "Customers can't book right now",
            message: 'Your WhatsApp is unlinked. Reconnect it to start taking '
                'bookings again.',
            action: _bannerAction('RECONNECT', Sc.danger),
          ),
          const SizedBox(height: 18),
        ],
        if (auth.health == SessionHealth.notConnected) ...[
          ScBanner(
            title: 'Connect your WhatsApp',
            message: 'Link a number and customers can start booking by message.',
            tone: ScBannerTone.warning,
            action: _bannerAction('CONNECT', Sc.teal),
          ),
          const SizedBox(height: 18),
        ],
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            const Expanded(
              child: Text(
                'Today',
                style: TextStyle(
                  fontSize: 23,
                  fontWeight: FontWeight.w700,
                  color: Sc.ink,
                  letterSpacing: -0.2,
                ),
              ),
            ),
            Text(
              dayLabel(DateTime.now()),
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w500,
                color: Sc.slate,
              ),
            ),
          ],
        ),
        const SizedBox(height: 5),
        Text(
          _summary(calendar, showingToday),
          style: const TextStyle(fontSize: 13, color: Sc.slate),
        ),
        const SizedBox(height: 18),
        Expanded(
          child: showingToday
              ? DayAgenda(controller: calendar, emptyState: const _EmptyToday())
              : _returnHome(calendar),
        ),
      ],
    );
  }

  String _summary(CalendarController calendar, bool showingToday) {
    if (!showingToday) return 'Showing another day';
    if (calendar.loading && calendar.view == null) return 'Loading…';

    final open = calendar.openCount;
    final total = calendar.entries.length;
    if (total == 0) return 'No bookings yet';
    if (open == 0) return 'All $total done';
    return '$open of $total still to come';
  }

  Widget _returnHome(CalendarController calendar) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            'The calendar is on another day.',
            style: TextStyle(fontSize: 13.5, color: Sc.slate),
          ),
          const SizedBox(height: 12),
          TextButton(
            onPressed: () => calendar.goTo(startOfToday()),
            child: const Text(
              'BACK TO TODAY',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                letterSpacing: 0.8,
                color: Sc.teal,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _bannerAction(String label, Color color) {
    return Material(
      color: color,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        onTap: () => Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => const QrScreen()),
        ),
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
          child: Text(
            label,
            style: const TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.85,
              color: Colors.white,
            ),
          ),
        ),
      ),
    );
  }
}

/// What an owner sees before their first booking arrives — which, on day one, is
/// everyone. It explains where bookings come from rather than showing an empty
/// box, because "nothing here" and "this does not work" look identical.
class _EmptyToday extends StatelessWidget {
  const _EmptyToday();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Container(
          width: 74,
          height: 74,
          decoration: const BoxDecoration(color: Sc.tealSoft, shape: BoxShape.circle),
          child: const Icon(Icons.chat_bubble_outline_rounded, size: 30, color: Sc.teal),
        ),
        const SizedBox(height: 18),
        const Text(
          'Nothing booked today',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: Sc.ink),
        ),
        const SizedBox(height: 7),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 26),
          child: Text(
            'When someone messages your WhatsApp number, their booking shows up '
            'here — and their profile builds itself.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 13.5, color: Sc.slate, height: 1.55),
          ),
        ),
      ],
    );
  }
}
