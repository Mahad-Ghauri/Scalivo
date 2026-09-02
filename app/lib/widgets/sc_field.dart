import 'package:flutter/material.dart';

import '../theme.dart';

/// An underlined field with the label above it, per the design.
///
/// The underline carries the state — hairline idle, yellow focused, red in
/// error — which is why this is not a stock `InputDecoration` with a label
/// inside: the label must not move, because half these screens show a validation
/// message directly beneath the line.
class ScField extends StatefulWidget {
  const ScField({
    super.key,
    required this.label,
    required this.controller,
    this.hint,
    this.helper,
    this.errorText,
    this.password = false,
    this.enabled = true,
    this.keyboardType,
    this.textInputAction,
    this.textCapitalization = TextCapitalization.none,
    this.onSubmitted,
  });

  final String label;
  final TextEditingController controller;
  final String? hint;
  final String? helper;
  final String? errorText;
  final bool password;
  final bool enabled;
  final TextInputType? keyboardType;
  final TextInputAction? textInputAction;
  final TextCapitalization textCapitalization;
  final ValueChanged<String>? onSubmitted;

  @override
  State<ScField> createState() => _ScFieldState();
}

class _ScFieldState extends State<ScField> {
  late bool _obscured = widget.password;

  @override
  Widget build(BuildContext context) {
    final hasError = widget.errorText != null;
    final opacity = widget.enabled ? 1.0 : 0.45;

    final idle = hasError
        ? const BorderSide(color: Sc.danger, width: 2)
        : const BorderSide(color: Sc.hairline, width: 1.5);

    final focused = hasError
        ? const BorderSide(color: Sc.danger, width: 2)
        : const BorderSide(color: Sc.yellow, width: 2);

    return Opacity(
      opacity: opacity,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            widget.label,
            style: const TextStyle(fontSize: 12.5, color: Sc.slate, height: 1.2),
          ),
          const SizedBox(height: 2),
          TextField(
            controller: widget.controller,
            enabled: widget.enabled,
            obscureText: _obscured,
            keyboardType: widget.keyboardType,
            textInputAction: widget.textInputAction,
            textCapitalization: widget.textCapitalization,
            onSubmitted: widget.onSubmitted,
            cursorColor: Sc.teal,
            style: const TextStyle(
              fontSize: 15.5,
              fontWeight: FontWeight.w600,
              color: Sc.ink,
            ),
            decoration: InputDecoration(
              isDense: true,
              contentPadding: const EdgeInsets.only(top: 8, bottom: 9),
              hintText: widget.hint,
              hintStyle: const TextStyle(
                fontSize: 15.5,
                fontWeight: FontWeight.w400,
                color: Sc.slateFaint,
              ),
              enabledBorder: UnderlineInputBorder(borderSide: idle),
              disabledBorder: UnderlineInputBorder(borderSide: idle),
              focusedBorder: UnderlineInputBorder(borderSide: focused),
              suffixIcon: widget.password ? _revealToggle() : null,
              suffixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
            ),
          ),
          if (hasError)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                widget.errorText!,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: Sc.dangerText,
                  height: 1.3,
                ),
              ),
            )
          else if (widget.helper != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                widget.helper!,
                style: const TextStyle(fontSize: 11.5, color: Sc.slateLight),
              ),
            ),
        ],
      ),
    );
  }

  Widget _revealToggle() {
    return GestureDetector(
      onTap: widget.enabled ? () => setState(() => _obscured = !_obscured) : null,
      behavior: HitTestBehavior.opaque,
      child: Padding(
        // Keeps the tap target at 44px without pushing the word off the line.
        padding: const EdgeInsets.fromLTRB(12, 12, 0, 12),
        child: Text(
          _obscured ? 'Show' : 'Hide',
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
            color: widget.enabled ? Sc.teal : Sc.slate,
          ),
        ),
      ),
    );
  }
}
