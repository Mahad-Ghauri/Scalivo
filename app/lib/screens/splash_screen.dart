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
      body: Stack(
        children: [
          const Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                LogoMark(size: 104),
                SizedBox(height: 26),
                Text(
                  'Scalivo',
                  style: TextStyle(
                    fontSize: 38,
                    fontWeight: FontWeight.w700,
                    color: Colors.white,
                    letterSpacing: -0.7,
                  ),
                ),
                SizedBox(height: 9),
                Text(
                  'Bookings that live in WhatsApp',
                  style: TextStyle(fontSize: 14, color: Color(0xFFA9C7C3)),
                ),
              ],
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 56,
            child: Column(
              children: [
                if (error != null) ...[
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: Text(
                      error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.white),
                    ),
                  ),
                  TextButton(
                    onPressed: onRetry,
                    child: const Text(
                      'TRY AGAIN',
                      style: TextStyle(color: Colors.white),
                    ),
                  ),
                  TextButton(
                    onPressed: onSignOut,
                    child: const Text(
                      'SIGN OUT',
                      style: TextStyle(color: Colors.white),
                    ),
                  ),
                ] else
                  const SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.5,
                    valueColor: AlwaysStoppedAnimation(Sc.yellow),
                    backgroundColor: Color(0x38FFFFFF),
                  ),
                ),
                const SizedBox(height: 16),
                const Text(
                  'FOR BUSINESS OWNERS',
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w500,
                    letterSpacing: 1.8,
                    color: Sc.onTealDim,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

}
