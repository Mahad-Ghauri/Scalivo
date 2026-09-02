import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/sc_banner.dart';
import '../widgets/session_pill.dart';
import '../widgets/sheet_scaffold.dart';
import 'qr_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<AuthController>().refreshSession();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Coming back to the app is exactly when a stale banner is most misleading:
    // the session may have died while the phone was in a pocket.
    if (state == AppLifecycleState.resumed) {
      context.read<AuthController>().refreshSession();
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthController>();
    final business = auth.business;
    final health = auth.health;

    return SheetScaffold(
      heroHeight: 200,
      hero: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 4, 24, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          _greeting(),
                          style: const TextStyle(fontSize: 13, color: Sc.onTealMuted),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          business?.name ?? 'Your business',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 21,
                            fontWeight: FontWeight.w700,
                            color: Colors.white,
                            letterSpacing: -0.2,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  _avatar(context, auth),
                ],
              ),
              const SizedBox(height: 20),
              SessionPill(
                health: health,
                onTap: health == SessionHealth.live ? null : () => _openQr(context),
              ),
            ],
          ),
        ),
      ),
      sheetPadding: const EdgeInsets.fromLTRB(24, 34, 24, 0),
      sheet: _tab == 0 ? _today(context, auth) : _placeholder(_tab),
      floating: [
        if (_tab == 0)
          Positioned(
            right: 22,
            bottom: 96,
            child: FloatingActionButton(
              onPressed: () => _notYet(context, 'Walk-in bookings'),
              backgroundColor: Sc.teal,
              foregroundColor: Colors.white,
              elevation: 6,
              shape: const CircleBorder(),
              child: const Icon(Icons.add_rounded, size: 26),
            ),
          ),
        Positioned(left: 0, right: 0, bottom: 0, child: _nav()),
      ],
    );
  }

  Widget _today(BuildContext context, AuthController auth) {
    final down = auth.health == SessionHealth.down;

    return RefreshIndicator(
      color: Sc.teal,
      onRefresh: () => auth.refreshSession(),
      child: ListView(
        padding: const EdgeInsets.only(bottom: 100),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          if (down) ...[
            ScBanner(
              title: "Customers can't book right now",
              message: 'Your WhatsApp is unlinked. Reconnect it to start taking '
                  'bookings again.',
              action: Material(
                color: Sc.danger,
                borderRadius: BorderRadius.circular(10),
                child: InkWell(
                  onTap: () => _openQr(context),
                  borderRadius: BorderRadius.circular(10),
                  child: const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 18, vertical: 11),
                    child: Text(
                      'RECONNECT',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.85,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 20),
          ],
          if (auth.health == SessionHealth.notConnected) ...[
            ScBanner(
              title: 'Connect your WhatsApp',
              message: 'Link a number and customers can start booking by message.',
              tone: ScBannerTone.warning,
              action: Material(
                color: Sc.teal,
                borderRadius: BorderRadius.circular(10),
                child: InkWell(
                  onTap: () => _openQr(context),
                  borderRadius: BorderRadius.circular(10),
                  child: const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 18, vertical: 11),
                    child: Text(
                      'CONNECT',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.85,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 20),
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
                _todayLabel(),
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: Sc.slate,
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          const Text(
            'No bookings yet',
            style: TextStyle(fontSize: 13, color: Sc.slate),
          ),
          const SizedBox(height: 56),
          const _EmptyToday(),
        ],
      ),
    );
  }

  Widget _placeholder(int tab) {
    final (title, line) = switch (tab) {
      1 => ('Calendar', 'Your day, week and per-staff schedule will live here.'),
      2 => ('Clients', 'Profiles build themselves from bookings — no typing.'),
      _ => ('Settings', 'Services, staff, opening hours and your WhatsApp link.'),
    };

    return Padding(
      padding: const EdgeInsets.only(bottom: 78),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              title,
              style: const TextStyle(
                fontSize: 20,
                fontWeight: FontWeight.w600,
                color: Sc.ink,
              ),
            ),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32),
              child: Text(
                line,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13.5, color: Sc.slate, height: 1.5),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _avatar(BuildContext context, AuthController auth) {
    final initials = _initials(auth.me?.name ?? auth.business?.name ?? '?');

    return PopupMenuButton<String>(
      tooltip: 'Account',
      color: Colors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      onSelected: (value) {
        if (value == 'signout') auth.logout();
      },
      itemBuilder: (_) => [
        PopupMenuItem(
          enabled: false,
          child: Text(
            auth.me?.email ?? '',
            style: const TextStyle(fontSize: 12.5, color: Sc.slate),
          ),
        ),
        const PopupMenuItem(
          value: 'signout',
          child: Text(
            'Sign out',
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: Sc.ink),
          ),
        ),
      ],
      child: Container(
        width: 44,
        height: 44,
        decoration: const BoxDecoration(color: Sc.yellow, shape: BoxShape.circle),
        alignment: Alignment.center,
        child: Text(
          initials,
          style: const TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.w700,
            color: Sc.teal900,
          ),
        ),
      ),
    );
  }

  Widget _nav() {
    const items = [
      (Icons.format_list_bulleted_rounded, 'Today'),
      (Icons.calendar_today_rounded, 'Calendar'),
      (Icons.people_alt_outlined, 'Clients'),
      (Icons.tune_rounded, 'Settings'),
    ];

    return Container(
      height: 78,
      decoration: const BoxDecoration(
        color: Colors.white,
        border: Border(top: BorderSide(color: Sc.navBorder)),
      ),
      padding: const EdgeInsets.fromLTRB(8, 12, 8, 0),
      child: Row(
        children: [
          for (var i = 0; i < items.length; i++)
            Expanded(
              child: InkWell(
                onTap: () => setState(() => _tab = i),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      items[i].$1,
                      size: 22,
                      color: i == _tab ? Sc.teal900 : const Color(0xFFA3B1B0),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      items[i].$2,
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: i == _tab ? FontWeight.w600 : FontWeight.w500,
                        color: i == _tab ? Sc.teal900 : const Color(0xFFA3B1B0),
                      ),
                    ),
                    const SizedBox(height: 5),
                    if (i == _tab)
                      Container(
                        width: 18,
                        height: 2.5,
                        decoration: BoxDecoration(
                          color: Sc.yellow,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  void _openQr(BuildContext context) {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const QrScreen()));
  }

  void _notYet(BuildContext context, String what) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: Sc.teal900,
        content: Text('$what arrive with the calendar.'),
      ),
    );
  }

  String _greeting() {
    final hour = DateTime.now().hour;
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  String _todayLabel() {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    final now = DateTime.now();
    return '${days[now.weekday - 1]}, ${now.day} ${months[now.month - 1]}';
  }

  String _initials(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.characters.take(2).toString().toUpperCase();
    return (parts.first.characters.first + parts.last.characters.first).toUpperCase();
  }
}

/// What an owner sees before their first WhatsApp booking arrives — which, on
/// day one, is everyone. It explains where bookings come from rather than
/// showing an empty box.
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
