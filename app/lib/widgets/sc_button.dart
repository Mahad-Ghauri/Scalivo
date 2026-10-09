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
  });

  final String label;
  final String? loadingLabel;
  final VoidCallback? onPressed;
  final bool loading;
  final ScButtonTone tone;

  @override
  Widget build(BuildContext context) {
    final disabled = loading || onPressed == null;

    final fill = switch (tone) {
      ScButtonTone.primary => disabled ? Sc.tealDisabled : Sc.teal,
      ScButtonTone.danger => disabled ? Sc.dangerBody : Sc.dangerText,
    };

    final foreground = disabled && tone == ScButtonTone.primary ? Sc.teal900 : Colors.white;
    return Semantics(
      button: true,
      enabled: !disabled,
      liveRegion: loading,
      child: SizedBox(
        width: double.infinity,
        child: Material(
          color: fill,
          borderRadius: BorderRadius.circular(Sc.buttonRadius),
          child: InkWell(
            onTap: disabled ? null : onPressed,
            borderRadius: BorderRadius.circular(Sc.buttonRadius),
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
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          letterSpacing: Sc.buttonTracking,
                          color: foreground,
                        ),
                      ),
                    ),
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

enum ScButtonTone { primary, danger }
