import 'package:flutter/material.dart';

import '../theme.dart';

/// Primary actions keep a generous minimum target and grow with text.
///
/// The loading state changes the label as well as the fill — "LOGGING IN" tells
/// an owner on a bad connection that something is happening, which a spinner
/// alone on a greyed button does not.
class ScButton extends StatelessWidget {
  const ScButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.loadingLabel,
    this.loading = false,
    this.tone = ScButtonTone.primary,
    this.arrow = false,
  });

  final String label;
  final String? loadingLabel;
  final VoidCallback? onPressed;
  final bool loading;
  final ScButtonTone tone;

  /// A mustard arrow after the label — "go", on the sign-in and sign-up screens.
  final bool arrow;

  @override
  Widget build(BuildContext context) {
    final disabled = loading || onPressed == null;

    final fill = switch (tone) {
      ScButtonTone.primary => disabled ? Sc.tealDisabled : Sc.teal,
      ScButtonTone.forest => disabled ? Sc.tealDisabled : Sc.teal900,
      ScButtonTone.danger => disabled ? Sc.dangerBody : Sc.dangerText,
    };
    final radius = tone == ScButtonTone.forest ? Sc.boxRadius : Sc.buttonRadius;

    final foreground = disabled && tone != ScButtonTone.danger ? Sc.teal900 : Colors.white;
    return Semantics(
      button: true,
      enabled: !disabled,
      liveRegion: loading,
      child: SizedBox(
        width: double.infinity,
        child: Material(
          color: fill,
          borderRadius: BorderRadius.circular(radius),
          child: InkWell(
            onTap: disabled ? null : onPressed,
            borderRadius: BorderRadius.circular(radius),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: Sc.buttonHeight),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: 15,
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    if (loading) ...[
                      SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(
                          strokeWidth: 2.5,
                          valueColor: AlwaysStoppedAnimation(foreground),
                        ),
                      ),
                      const SizedBox(width: 10),
                    ],
                    Flexible(
                      child: Text(
                        loading ? loadingLabel ?? label : label,
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: tone == ScButtonTone.forest ? 16 : 15,
                          fontWeight: FontWeight.w600,
                          letterSpacing: Sc.buttonTracking,
                          color: foreground,
                        ),
                      ),
                    ),
                    if (arrow && !loading) ...[
                      const SizedBox(width: 12),
                      Icon(Icons.arrow_forward_rounded, size: 22,
                        color: disabled ? foreground : Sc.yellow),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

enum ScButtonTone {
  primary,
  danger,

  /// Deep forest with rounder corners — the sign-in and sign-up screens.
  forest,
}
