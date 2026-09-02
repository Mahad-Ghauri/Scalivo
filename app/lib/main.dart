import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'push/push_service.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/qr_screen.dart';
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
  const ScalivoOwnerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => AuthController()..restore(),
      child: MaterialApp(
        title: 'Scalivo',
        debugShowCheckedModeBanner: false,
        navigatorKey: navigatorKey,
        theme: buildScalivoTheme(),
        home: const _Root(),
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
  const _Root();

  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  @override
  void initState() {
    super.initState();

    final push = PushService();
    push.ensureChannels();

    // A Session Health notification must open the QR screen directly. Landing
    // on Home and making a worried owner hunt for the fix wastes the minutes
    // the alert bought.
    push.onNotificationTap((route) {
      if (route != '/qr') return;
      navigatorKey.currentState?.push(
        MaterialPageRoute<void>(builder: (_) => const QrScreen()),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final status = context.select<AuthController, AuthStatus>((a) => a.status);

    return switch (status) {
      AuthStatus.unknown => const SplashScreen(),
      AuthStatus.signedOut => const LoginScreen(),
      AuthStatus.signedIn => const HomeScreen(),
    };
  }
}
