import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../state/auth_controller.dart';
import '../state/calendar_controller.dart';
import '../state/clients_controller.dart';
import '../theme.dart';
import '../widgets/session_pill.dart';
import '../widgets/sheet_scaffold.dart';
import 'qr_screen.dart';
import 'tabs/calendar_tab.dart';
import 'tabs/clients_tab.dart';
import 'tabs/settings_tab.dart';
import 'tabs/today_tab.dart';
import 'walk_in_sheet.dart';

/// The four tabs, over one set of controllers.
///
/// Today and Calendar share a single CalendarController on purpose: they are the
/// same diary asked about different days, and two controllers would mean a
/// walk-in booked on one not appearing on the other until a refresh nobody
/// thinks to do.
///
/// The controllers live here rather than at the root of the app because they
/// need a businessId, and there isn't one until somebody has signed in. Creating
/// them above the auth gate would mean constructing them with a null tenant and
/// remembering to rebuild on login — which is the kind of thing that works until
/// the first time someone signs out and back in as somebody else.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthController>();
    final business = auth.business;

    // No business on the account is a real state — a half-finished registration
    // — and it must not crash the app on a null id.
    if (business == null) return const _NoBusiness();

    return MultiProvider(
      // Keyed by business id so signing in as another owner builds new
      // controllers rather than showing the previous tenant's diary.
      key: ValueKey(business.id),
      providers: [
        ChangeNotifierProvider(
          create: (_) => CalendarController(api: auth.api, businessId: business.id),
        ),
        ChangeNotifierProvider(
          create: (_) => ClientsController(api: auth.api, businessId: business.id),
        ),
      ],
      child: const _HomeShell(),
    );
  }
}

class _HomeShell extends StatefulWidget {
  const _HomeShell();

  @override
  State<_HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<_HomeShell> with WidgetsBindingObserver {
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
    // Coming back to the app is exactly when a stale screen is most misleading:
    // the session may have died while the phone was in a pocket, and bookings
    // may have arrived over WhatsApp while it was.
    if (state != AppLifecycleState.resumed) return;
    context.read<AuthController>().refreshSession();
    context.read<CalendarController>().load(quiet: true);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthController>();
    final business = auth.business;

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
                health: auth.health,
                onTap: auth.health == SessionHealth.live ? null : () => _openQr(context),
              ),
            ],
          ),
        ),
      ),
      sheetPadding: const EdgeInsets.fromLTRB(24, 34, 24, 0),
      // IndexedStack, not a switch: rebuilding the tab from scratch on every tap
      // would refetch the diary and lose the client search the owner just typed.
      sheet: IndexedStack(
        index: _tab,
        children: const [
          TodayTab(),
          CalendarTab(),
          ClientsTab(),
          SettingsTab(),
        ],
      ),
      floating: [
        // Only where a walk-in means something: the diary. On the clients and
        // settings tabs a floating "+" would be an invitation to type a customer
        // in by hand, which is the one thing this CRM does not want.
        if (_tab == 0 || _tab == 1)
          Positioned(
            right: 22,
            bottom: 96,
            child: FloatingActionButton(
              onPressed: () => _walkIn(context),
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

  Future<void> _walkIn(BuildContext context) async {
    final calendar = context.read<CalendarController>();
    final booked = await showWalkInSheet(context, controller: calendar);
    if (!booked || !context.mounted) return;

    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: Sc.teal900,
        content: Text('Booked. The slot is reserved.'),
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

  String _greeting() {
    final hour = DateTime.now().hour;
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  String _initials(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    if (parts.isEmpty) return '?';
    if (parts.length == 1) return parts.first.characters.take(2).toString().toUpperCase();
    return (parts.first.characters.first + parts.last.characters.first).toUpperCase();
  }
}

/// Signed in, but the account has no business on it.
///
/// Reachable if registration was interrupted between creating the user and
/// creating the business. Rare, and it must not be a white screen.
class _NoBusiness extends StatelessWidget {
  const _NoBusiness();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Sc.teal900,
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'No business on this account',
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                  color: Colors.white,
                ),
              ),
              const SizedBox(height: 10),
              const Text(
                'Sign up again, or sign in with the account you registered the '
                'business on.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13.5, color: Sc.onTealMuted, height: 1.5),
              ),
              const SizedBox(height: 22),
              TextButton(
                onPressed: () => context.read<AuthController>().logout(),
                child: const Text(
                  'SIGN OUT',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.8,
                    color: Sc.onTealBright,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
