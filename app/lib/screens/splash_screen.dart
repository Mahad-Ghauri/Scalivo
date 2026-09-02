import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets/sheet_scaffold.dart';

/// Shown while the stored token is checked against the server.
///
/// Purely visual — the decision about where to go next belongs to
/// AuthController, and this screen deliberately knows nothing about it.
class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

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
          const Positioned(
            left: 0,
            right: 0,
            bottom: 56,
            child: Column(
              children: [
                SizedBox(
                  width: 22,
                  height: 22,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.5,
                    valueColor: AlwaysStoppedAnimation(Sc.yellow),
                    backgroundColor: Color(0x38FFFFFF),
                  ),
                ),
                SizedBox(height: 16),
                Text(
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

