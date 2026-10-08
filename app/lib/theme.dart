import 'package:flutter/material.dart';

/// Shared Scalivo design tokens. Action and text colours meet normal-text contrast.
abstract final class Sc {
  // Teal — the brand ground. Flat: no stripes, no gradient.
  static const teal900 = Color(0xFF154D46); // scaffold + hero
  static const teal = Color(0xFF397F75); // primary action
  static const tealDisabled = Color(0xFF9CCDC6);
  static const tealSoft = Color(0xFFEAF4F2); // soft fill on white
  static const tealSurface = Color(0xFFF6FAF9);

  static const yellow = Color(0xFFF5B921); // logo, focused field, active tab

  // Text on white.
  static const ink = Color(0xFF12211F);
  static const inkMuted = Color(0xFF4B5B59);
  static const slate = Color(0xFF526563); // field labels
  static const slateLight = Color(0xFF627573);
  static const slateFaint = Color(0xFF627573);

  // Text on teal. Lifted along with the ground — the same muted tones that read
  // fine on #0D302E lose contrast against the lighter #154D46.
  static const onTealBright = Color(0xFFBFE7E1);
  static const onTealMuted = Color(0xFFA3C7C2);
  static const onTealFaint = Color(0xFF93BDB8);
  static const onTealDim = Color(0xFF7BA9A4);

  // Lines.
  static const hairline = Color(0xFFE3E9E8); // idle field underline
  static const divider = Color(0xFFF0F4F3); // list row separator
  static const navBorder = Color(0xFFEEF3F2);
  static const chipFill = Color(0xFFF2F5F5);

  // Danger — invalid input, and WhatsApp being down.
  static const danger = Color(0xFFD64545);
  static const dangerText = Color(0xFFC73B3B);
  static const dangerBg = Color(0xFFFDECEC);
  static const dangerTitle = Color(0xFF8F2020);
  static const dangerBody = Color(0xFFA05555);

  // Warning — the yellow banner.
  static const warnBg = Color(0xFFFFF7E3);
  static const warnTitle = Color(0xFF7A5A05);
  static const warnBody = Color(0xFF9A7C2C);
  static const warnIcon = Color(0xFFB98A0C);

  /// The white sheet's top corners. One value, used everywhere a sheet meets
  /// the teal above it — it is the most recognisable shape in the app.
  static const sheetRadius = Radius.circular(56);

  /// Buttons: 56 high, 14 radius, uppercase, wide tracking.
  static const buttonHeight = 56.0;
  static const buttonRadius = 14.0;
  static const buttonTracking = 1.2; // ~0.08em at 15px
}

ThemeData buildScalivoTheme() {
  final base = ThemeData(
    useMaterial3: true,
    fontFamily: 'Poppins',
    scaffoldBackgroundColor: Sc.teal900,
    colorScheme: ColorScheme.fromSeed(
      seedColor: Sc.teal,
      primary: Sc.teal,
      surface: Colors.white,
      brightness: Brightness.light,
    ),
  );

  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: Sc.ink, displayColor: Sc.ink),
    splashFactory: InkRipple.splashFactory,
  );
}
