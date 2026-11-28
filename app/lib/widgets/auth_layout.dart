import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// The pieces the sign-in and sign-up screens share, so switching between them
/// reads as one screen changing its form rather than two different screens.

/// Rounder than the app's other sheets: these two screens are the welcome, and
/// the softer edge is part of the look.
const authSheetRadius = Radius.circular(28);

bool _keyboardUp(BuildContext context) => MediaQuery.viewInsetsOf(context).bottom > 0;
bool _largeText(BuildContext context) => MediaQuery.textScalerOf(context).scale(14) > 20;

/// Shrinks while the keyboard is up, so the fields are not pushed off screen.
double authHeroHeight(BuildContext context) =>
    (_keyboardUp(context) ? 104.0 : _largeText(context) ? 200.0 : 236.0) +
    MediaQuery.paddingOf(context).top;

/// Logo, then "A little order. / A better day." — the second line in mustard.
class AuthHero extends StatelessWidget {
  const AuthHero({super.key});

  @override
  Widget build(BuildContext context) {
    final keyboardUp = _keyboardUp(context);
    final largeText = _largeText(context);

    return SafeArea(
      bottom: false,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Row(children: [
              if (!keyboardUp) ...[const LogoMark(size: 36), const SizedBox(width: 12)],
              Expanded(child: Text('scalivo', style: TextStyle(fontSize: keyboardUp || largeText ? 18 : 24,
                fontWeight: FontWeight.w500, color: Colors.white, letterSpacing: -0.8))),
            ]),
            if (!keyboardUp && !largeText) ...[
              const SizedBox(height: 24),
              const Text.rich(
                TextSpan(children: [
                  TextSpan(text: 'A little order.\n'),
                  TextSpan(text: 'A better day.', style: TextStyle(color: Sc.yellow)),
                ]),
                style: TextStyle(fontSize: 34, fontWeight: FontWeight.w600, color: Colors.white,
                  height: 1.15, letterSpacing: -1),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

enum AuthTab { signIn, signUp }

/// The Sign in | Sign up switch at the top of the sheet.
///
/// Each tab is its own route: Sign up is pushed over Sign in, and tapping Sign
/// in pops back to it — so the system back button still does the obvious thing.
class AuthTabs extends StatelessWidget {
  const AuthTabs({super.key, required this.selected, required this.onSelect, this.enabled = true});

  final AuthTab selected;
  final ValueChanged<AuthTab> onSelect;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(color: const Color(0xFFE6E4DB), borderRadius: BorderRadius.circular(14)),
      child: Row(children: [
        _tab(AuthTab.signIn, 'Sign in'),
        _tab(AuthTab.signUp, 'Sign up'),
      ]),
    );
  }

  Widget _tab(AuthTab tab, String label) {
    final active = tab == selected;
    return Expanded(
      child: Semantics(
        button: true,
        selected: active,
        child: GestureDetector(
          onTap: active || !enabled ? null : () => onSelect(tab),
          behavior: HitTestBehavior.opaque,
          child: Container(
            constraints: const BoxConstraints(minHeight: 44),
            alignment: Alignment.center,
            decoration: active
                ? BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10))
                : null,
            child: Text(label, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w500,
              color: active ? Sc.teal900 : Sc.slate)),
          ),
        ),
      ),
    );
  }
}

/// A quick cross-fade between the two tabs. The hero is identical on both, so
/// only the form appears to change.
Route<void> authTabRoute(Widget screen) => PageRouteBuilder<void>(
      transitionDuration: const Duration(milliseconds: 220),
      reverseTransitionDuration: const Duration(milliseconds: 220),
      pageBuilder: (_, _, _) => screen,
      transitionsBuilder: (_, animation, _, child) => FadeTransition(opacity: animation, child: child),
    );
