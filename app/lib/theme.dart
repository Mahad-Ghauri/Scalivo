import 'package:flutter/material.dart';

/// Shared Scalivo design tokens. Action and text colours meet normal-text contrast.
abstract final class Sc {
  static const paper = Color(0xFFF8F7EF);

  // Forest ink on warm paper; mustard marks attention.
  static const teal900 = Color(0xFF153D35); // scaffold + hero
  static const teal = Color(0xFF28695C); // primary action
  static const tealDisabled = Color(0xFF9CCDC6);
  static const tealSoft = Color(0xFFEAF4F2); // soft fill on white
  static const tealSurface = Color(0xFFF6FAF9);

  static const yellow = Color(0xFFE7B74D); // logo, focused field, active tab

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
  static const hairline = Color(0xFFDADDD2); // idle field underline
  static const divider = Color(0xFFE3E4DA); // list row separator
  static const navBorder = Color(0xFFDADDD2);
  static const chipFill = Color(0xFFEEEFE6);

  // Danger — invalid input, and WhatsApp being down.
  static const danger = Color(0xFFD64545);
  static const dangerText = Color(0xFFC73B3B);
  static const dangerBg = Color(0xFFFDECEC);
  static const dangerTitle = Color(0xFF8F2020);
  static const dangerBody = Color(0xFFA05555);

  // Warning — the yellow banner.
  static const warnBg = Color(0xFFFFF7E3);
  static const warnTitle = Color(0xFF7A5A05);
  static const warnBody = Color(0xFF7B6424);
  static const warnIcon = Color(0xFFB98A0C);

  /// A restrained paper edge shared by full screens and action sheets.
  static const sheetRadius = Radius.circular(16);

  /// Buttons grow with their labels; 56 is their minimum height.
  static const buttonHeight = 56.0;
  static const buttonRadius = 8.0;
  static const buttonTracking = 0.2; // Calm tracking for sentence-case actions
}

ThemeData buildScalivoTheme() {
  final base = ThemeData(
    useMaterial3: true,
    fontFamily: 'Poppins',
    scaffoldBackgroundColor: Sc.teal900,
    colorScheme: ColorScheme.fromSeed(
      seedColor: Sc.teal,
      primary: Sc.teal,
      surface: Sc.paper,
      brightness: Brightness.light,
    ),
  );

  return base.copyWith(
    textTheme: base.textTheme.apply(bodyColor: Sc.ink, displayColor: Sc.ink),
    dividerColor: Sc.divider,
    visualDensity: VisualDensity.standard,
    splashFactory: InkRipple.splashFactory,
  );
}
