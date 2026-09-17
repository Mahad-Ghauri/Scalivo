import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/models.dart';
import '../../format.dart';
import '../../state/auth_controller.dart';
import '../../state/calendar_controller.dart';
import '../../theme.dart';
import '../../widgets/sc_banner.dart';
import '../qr_screen.dart';
import '../services_screen.dart';
import '../staff_screen.dart';
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
        // Under the WhatsApp banners rather than above them: a business with no
        // services and no session has two problems, and the session is the one
        // that makes every other screen lie.
        if (calendar.setup?.blocking.isNotEmpty ?? false) ...[
          _SetupCard(
            steps: calendar.setup!.blocking,
            onOpen: _openFix,
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

  /// Opens whichever screen fixes [stepId], then refetches.
  ///
  /// The refetch is the point. Every one of these steps is fixed on another
  /// screen, and a checklist that still demands a service the owner just added
  /// trains them to stop believing it.
  Future<void> _openFix(String stepId) async {
    // `hours` and `coverage` both land on Staff: hours are a property of a
    // person, and a service nobody can perform is fixed by assigning it to one.
    final screen = stepId == 'services' ? const ServicesScreen() : const StaffScreen();

    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));
    if (!mounted) return;
    await context.read<CalendarController>().ensureCatalogue(force: true);
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

/// The gaps that stop this business taking a booking, and the way to each one.
///
/// This is the only place in the app that says why an empty diary is empty.
/// Without it the owner sees a calendar with nothing in it, a WhatsApp number
/// that is connected, and no indication anywhere that the menu they are
/// offering customers dead-ends on "no times available" — because an
/// unbookable business and a fully booked one return the same empty list.
class _SetupCard extends StatelessWidget {
  const _SetupCard({required this.steps, required this.onOpen});

  final List<SetupStep> steps;
  final ValueChanged<String> onOpen;

  /// The step ids, in the order an owner has to do them: there is no point
  /// assigning a service to a person who does not exist yet.
  static const _order = ['services', 'staff', 'hours', 'coverage'];

  static const _labels = {
    'services': 'Add what you offer',
    'staff': 'Add who does the work',
    'hours': 'Set working hours',
    'coverage': 'Match services to people',
  };

  @override
  Widget build(BuildContext context) {
    // Sorted here rather than trusted from the wire. An unknown id sorts last
    // rather than throwing — see SetupStep on why the vocabulary is open.
    final sorted = [...steps]..sort(
        (a, b) => _rank(a.id).compareTo(_rank(b.id)),
      );

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Sc.divider),
      ),
      padding: const EdgeInsets.fromLTRB(15, 14, 15, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.flag_outlined, size: 18, color: Sc.warnIcon),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  sorted.length == 1
                      ? 'One thing left before you can take bookings'
                      : '${sorted.length} things left before you can take bookings',
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: Sc.ink,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Padding(
            padding: EdgeInsets.only(left: 27, right: 4),
            child: Text(
              // Said outright, because it is the whole reason this card exists
              // and the owner has no other way to discover it.
              'Until these are done, customers see your menu but never any '
              'available times.',
              style: TextStyle(fontSize: 12.5, color: Sc.slate, height: 1.45),
            ),
          ),
          const SizedBox(height: 6),
          for (final step in sorted) _row(step),
        ],
      ),
    );
  }

  static int _rank(String id) {
    final at = _order.indexOf(id);
    return at < 0 ? _order.length : at;
  }

  Widget _row(SetupStep step) {
    return InkWell(
      onTap: () => onOpen(step.id),
      borderRadius: BorderRadius.circular(9),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 9),
        child: Row(
          children: [
            const SizedBox(width: 27),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    // Falls back to the id so an unrecognised step is still a
                    // row the owner can tap, not a blank line.
                    _labels[step.id] ?? step.id,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: Sc.ink,
                    ),
                  ),
                  if (step.detail != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      // The server's own words. For `coverage` this names the
                      // exact services nobody can perform, which is the one
                      // piece of this the app could not work out for itself.
                      step.detail!,
                      style: const TextStyle(fontSize: 12.5, color: Sc.slate, height: 1.4),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: 8),
            const Icon(Icons.chevron_right_rounded, size: 20, color: Sc.slateLight),
          ],
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
