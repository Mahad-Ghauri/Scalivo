import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets/sheet_scaffold.dart';

/// Shown while the stored token is checked against the server.
///
/// Purely visual — the decision about where to go next belongs to
/// AuthController, and this screen deliberately knows nothing about it.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key, this.error, this.onRetry, this.onSignOut});

  final String? error;
  final VoidCallback? onRetry;
  final VoidCallback? onSignOut;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Sc.teal900,
      body: SafeArea(
        child: Center(child: SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const LogoMark(size: 72),
            const SizedBox(height: 24),
            const Text('scalivo', style: TextStyle(fontSize: 38,
              fontWeight: FontWeight.w500, color: Colors.white, letterSpacing: -1.2)),
            const SizedBox(height: 9),
            const Text('Bookings that live in WhatsApp', textAlign: TextAlign.center,
              style: TextStyle(fontSize: 14, color: Sc.onTealBright)),
            const SizedBox(height: 40),
            if (error != null) ...[
              Text(error!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white)),
              const SizedBox(height: 16),
              TextButton(onPressed: onRetry,
                child: const Text('Try again', style: TextStyle(color: Colors.white))),
              TextButton(onPressed: onSignOut,
                child: const Text('Sign out', style: TextStyle(color: Colors.white))),
            ] else const SizedBox(width: 22, height: 22,
              child: CircularProgressIndicator(strokeWidth: 2.5,
                valueColor: AlwaysStoppedAnimation(Sc.yellow))),
            const SizedBox(height: 24),
            const Text('FOR BUSINESS OWNERS', textAlign: TextAlign.center,
              style: TextStyle(fontSize: 10, fontWeight: FontWeight.w500,
                letterSpacing: 1.8, color: Sc.onTealBright)),
          ]),
        )),
      ),
    );
  }
}
