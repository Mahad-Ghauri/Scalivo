import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'push/push_service.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/qr_screen.dart';
import 'screens/appointments_screen.dart';
import 'screens/briefings_screen.dart';
import 'screens/splash_screen.dart';
import 'state/auth_controller.dart';
import 'theme.dart';

/// Held at the top so a notification tap can navigate without a BuildContext —
/// the push arrives from outside the widget tree.
final navigatorKey = GlobalKey<NavigatorState>();

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  // The hero is dark on every screen, so the OS status bar icons must be light.
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
      statusBarBrightness: Brightness.dark,
    ),
  );

  runApp(const ScalivoOwnerApp());
}

class ScalivoOwnerApp extends StatelessWidget {
  const ScalivoOwnerApp({super.key, this.auth, this.push});
  final AuthController? auth;
  final PushService? push;

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => (auth ?? AuthController())..restore(),
      child: MaterialApp(
        title: 'Scalivo',
        debugShowCheckedModeBanner: false,
        navigatorKey: navigatorKey,
        theme: buildScalivoTheme(),
        home: _Root(push: push ?? PushService()),
      ),
    );
  }
}

/// Auth decides the screen, not imperative navigation.
///
/// A token expiring mid-session must land the owner on Login from wherever they
/// were, and a `pushReplacement` scattered across five screens is how that gets
/// missed on the sixth.
class _Root extends StatefulWidget {
  const _Root({required this.push});
  final PushService push;

  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  late final AuthController _auth;
  late final PushService _push;
  String? _pendingRoute;
  String? _lastBusinessId;
  @override
  void initState() {
    super.initState();

    _push = widget.push;
    _push.ensureChannels();

    // A Session Health notification must open the QR screen directly. Landing
    // on Home and making a worried owner hunt for the fix wastes the minutes
    // the alert bought.
    _auth = context.read<AuthController>();
    _lastBusinessId = _auth.business?.id;
    _auth.addListener(_authChanged);
    _push.onNotificationTap(_onNotificationTap);
  }

  void _onNotificationTap(String route) {
    if (!mounted || route.length > 200) return;
    final uri = Uri.tryParse(route);
    if (uri == null || uri.hasScheme || uri.hasAuthority || uri.hasFragment || !['/qr', '/briefings', '/appointments'].contains(uri.path)) return;
    try {
      if (uri.queryParametersAll.entries.any((e) => e.key != 'businessId' || e.value.length != 1 || !RegExp(r'^[a-zA-Z0-9_-]{1,80}$').hasMatch(e.value.single))) return;
    } on FormatException { return; }
    if (_auth.status == AuthStatus.signedOut) return;
    // A cold-start tap may arrive before stored-token validation completes.
    _pendingRoute = route;
    _openPendingRoute();
  }

  void _openPendingRoute() {
    if (_auth.status != AuthStatus.signedIn || _auth.business == null || _pendingRoute == null) return;
    final uri = Uri.parse(_pendingRoute!);
    _pendingRoute = null;
    final businessId = uri.queryParameters['businessId'];
    if (businessId != null) {
      if (_auth.me?.businesses.any((b) => b.id == businessId) != true) return;
      _auth.selectBusiness(businessId);
    }
    final route = uri.path;
    final targetBusinessId = _auth.business!.id;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _auth.status != AuthStatus.signedIn || _auth.business?.id != targetBusinessId) return;
      navigatorKey.currentState?.push(MaterialPageRoute<void>(
        builder: (_) => switch (route) {
          '/qr' => const QrScreen(),
          '/appointments' => const AppointmentsScreen(),
          _ => const BriefingsScreen(),
        },
      ));
    });
  }

  void _authChanged() {
    if (context.read<AuthController>().status == AuthStatus.signedOut) {
      _pendingRoute = null;
      navigatorKey.currentState?.popUntil((route) => route.isFirst);
    }
    if (_lastBusinessId != _auth.business?.id) {
      _lastBusinessId = _auth.business?.id;
      navigatorKey.currentState?.popUntil((route) => route.isFirst);
    }
    _openPendingRoute();
  }

  @override
  void dispose() {
    _auth.removeListener(_authChanged);
    _push.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final status = context.select<AuthController, AuthStatus>((a) => a.status);

    return switch (status) {
      AuthStatus.unknown => SplashScreen(
        error: context.watch<AuthController>().error?.message,
        onRetry: context.read<AuthController>().restore,
        onSignOut: context.read<AuthController>().logout,
      ),
      AuthStatus.signedOut => const LoginScreen(),
      AuthStatus.signedIn => const HomeScreen(),
    };
  }
}
