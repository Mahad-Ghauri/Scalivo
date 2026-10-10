import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/models.dart';
import '../state/auth_controller.dart';
import '../state/calendar_controller.dart';
import '../state/clients_controller.dart';
import '../theme.dart';
import '../widgets/session_pill.dart';
import '../widgets/sc_button.dart';
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
      key: ValueKey('${business.id}:${business.timezone}'),
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

    final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
    final largeText = scale > 1.3;
    final bottom = MediaQuery.paddingOf(context).bottom;
    final navHeight = 76 + bottom;
    return SheetScaffold(
      heroHeight: 164 + MediaQuery.paddingOf(context).top,
      fitHero: largeText,
      bottomBar: largeText ? _nav() : null,
      overlap: 0,
      hero: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 16, 24, 0),
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
                        if (!largeText) ...[
                          const Text('SCALIVO / YOUR WORKING DAY',
                            style: TextStyle(fontSize: 10, letterSpacing: 1.0, color: Sc.onTealMuted)),
                          const SizedBox(height: 3),
                        ],
                        Text(
                          business?.name ?? 'Your business',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 21,
                            fontWeight: FontWeight.w500,
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
              const SizedBox(height: 10),
              SessionPill(
                health: auth.health,
                onTap: auth.health == SessionHealth.live ? null : () => _openQr(context),
              ),
            ],
          ),
        ),
      ),
      sheetPadding: EdgeInsets.fromLTRB(24, 26, 24, largeText ? 0 : navHeight),
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
        if (!largeText && (_tab == 0 || _tab == 1))
          Positioned(
            right: 22,
            bottom: navHeight + 14,
            child: FloatingActionButton.extended(
              onPressed: () => _walkIn(context),
              backgroundColor: Sc.teal,
              foregroundColor: Colors.white,
              elevation: 0,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
              icon: const Icon(Icons.add_rounded, size: 22),
              label: const Text('Walk-in', style: TextStyle(fontWeight: FontWeight.w600)),
            ),
          ),
        if (!largeText) Positioned(left: 0, right: 0, bottom: 0, child: _nav()),
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
        if (value.startsWith('business:')) auth.selectBusiness(value.substring(9));
      },
      itemBuilder: (_) => [
        PopupMenuItem(
          enabled: false,
          child: Text(
            auth.me?.email ?? '',
            style: const TextStyle(fontSize: 12.5, color: Sc.slate),
          ),
        ),
        if ((auth.me?.businesses.length ?? 0) > 1)
          for (final b in auth.me!.businesses) PopupMenuItem(value: 'business:${b.id}', child: Row(children: [
            Icon(b.id == auth.business?.id ? Icons.check : Icons.storefront_outlined, size: 18), const SizedBox(width: 10), Expanded(child: Text(b.name))])),
        const PopupMenuItem(
          value: 'signout',
          child: Text(
            'Sign out',
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: Sc.ink),
          ),
        ),
      ],
      child: Container(
        width: 48,
        height: 48,
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

    final largeText = MediaQuery.textScalerOf(context).scale(14) / 14 > 1.3;
    Widget destination(int index) => Expanded(
      child: Semantics(button: true, selected: index == _tab,
        child: InkWell(onTap: () => setState(() => _tab = index),
          child: ConstrainedBox(constraints: BoxConstraints(minHeight: largeText ? 48 : 60),
            child: largeText
              ? Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                  child: Row(children: [
                    Icon(items[index].$1, size: 20, color: index == _tab ? Sc.teal900 : Sc.slate),
                    const SizedBox(width: 8),
                    Expanded(child: Text(items[index].$2, maxLines: 1, softWrap: false,
                      style: TextStyle(fontSize: 11, fontWeight: index == _tab ? FontWeight.w600 : FontWeight.w400,
                        color: index == _tab ? Sc.teal900 : Sc.slate))),
                  ]))
              : Column(mainAxisSize: MainAxisSize.min, children: [
                  Icon(items[index].$1, size: 22, color: index == _tab ? Sc.teal900 : Sc.slate),
                  const SizedBox(height: 5),
                  Text(items[index].$2, textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 11, fontWeight: index == _tab ? FontWeight.w600 : FontWeight.w400,
                      color: index == _tab ? Sc.teal900 : Sc.slate)),
                  const SizedBox(height: 5),
                  Container(width: 20, height: 2, color: index == _tab ? Sc.yellow : Colors.transparent),
                ])),
        )),
    );
    return Material(color: Sc.paper, child: Container(
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: Sc.navBorder))),
      child: SafeArea(top: false, child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
        child: largeText ? Column(mainAxisSize: MainAxisSize.min, children: [
          if (_tab == 0 || _tab == 1) Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
            child: ScButton(label: 'Walk-in', onPressed: () => _walkIn(context))),
          Row(children: [destination(0), destination(1)]),
          Row(children: [destination(2), destination(3)]),
        ]) : Row(children: [for (var i = 0; i < items.length; i++) destination(i)]),
      )),
    ));
  }

  void _openQr(BuildContext context) {
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const QrScreen()));
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
