import 'package:flutter/material.dart';

import '../theme.dart';

/// The one primary button: 56 high, 14 radius, uppercase, wide tracking.
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
      ScButtonTone.danger => disabled ? Sc.dangerBody : Sc.danger,
    };

    return SizedBox(
      height: Sc.buttonHeight,
      width: double.infinity,
      child: Material(
        color: fill,
        borderRadius: BorderRadius.circular(Sc.buttonRadius),
        child: InkWell(
          onTap: disabled ? null : onPressed,
          borderRadius: BorderRadius.circular(Sc.buttonRadius),
          child: Center(
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (loading) ...[
                  const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      valueColor: AlwaysStoppedAnimation(Colors.white),
                      backgroundColor: Color(0x73FFFFFF),
                    ),
                  ),
                  const SizedBox(width: 10),
                ],
                Text(
                  (loading ? loadingLabel ?? label : label).toUpperCase(),
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    letterSpacing: Sc.buttonTracking,
                    color: Colors.white,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

enum ScButtonTone { primary, danger }
