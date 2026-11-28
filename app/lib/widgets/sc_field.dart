import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/// An underlined field with the label above it, per the design.
///
/// The underline carries the state — hairline idle, yellow focused, red in
/// error — which is why this is not a stock `InputDecoration` with a label
/// inside: the label must not move, because half these screens show a validation
/// message directly beneath the line.
///
/// Given an [icon], it becomes the boxed field of the sign-in and sign-up
/// screens instead: a white rounded box with the icon leading, and the label
/// kept for screen readers only — the hint and the icon say what goes there.
class ScField extends StatefulWidget {
  const ScField({
    super.key,
    required this.label,
    required this.controller,
    this.icon,
    this.hint,
    this.maxLength,
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
  final IconData? icon;
  final String? hint;
  final int? maxLength;
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
    final icon = widget.icon;
    final boxed = icon != null;

    final idle = hasError
        ? const BorderSide(color: Sc.danger, width: 2)
        : boxed
            ? const BorderSide(color: Sc.fieldBorder, width: 1.2)
            : const BorderSide(color: Sc.hairline, width: 1.5);

    final focused = hasError
        ? const BorderSide(color: Sc.danger, width: 2)
        : BorderSide(color: Sc.teal, width: boxed ? 1.6 : 2);

    InputBorder edge(BorderSide side) => boxed
        ? OutlineInputBorder(borderRadius: BorderRadius.circular(Sc.boxRadius), borderSide: side)
        : UnderlineInputBorder(borderSide: side);

    return Opacity(
      opacity: opacity,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (!boxed) ...[
            Text(
              widget.label,
              style: const TextStyle(
                fontSize: 12.5,
                color: Sc.slate,
                height: 1.2,
              ),
            ),
            const SizedBox(height: 2),
          ],
          Semantics(
            label: widget.label,
            child: TextField(
              inputFormatters: [if (widget.maxLength != null) LengthLimitingTextInputFormatter(widget.maxLength)],
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
                contentPadding: boxed
                    ? const EdgeInsets.symmetric(vertical: 18, horizontal: 16)
                    : const EdgeInsets.only(top: 14, bottom: 14),
                filled: boxed,
                fillColor: Colors.white,
                // Keeps a hovered box white in the browser build; phones never hover.
                hoverColor: Colors.white,
                prefixIcon: boxed
                    ? Padding(
                        padding: const EdgeInsets.only(left: 16, right: 12),
                        child: Icon(icon, size: 22, color: Sc.teal),
                      )
                    : null,
                prefixIconConstraints: const BoxConstraints(minWidth: 48, minHeight: 48),
                hintText: widget.hint,
                hintStyle: const TextStyle(
                  fontSize: 15.5,
                  fontWeight: FontWeight.w400,
                  color: Sc.slateFaint,
                ),
                enabledBorder: edge(idle),
                disabledBorder: edge(idle),
                focusedBorder: edge(focused),
                suffixIcon: widget.password ? _revealToggle() : null,
                suffixIconConstraints: const BoxConstraints(
                  minWidth: 48,
                  minHeight: 48,
                ),
              ),
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
    return SizedBox(width: 48, height: 48, child: IconButton(
      visualDensity: VisualDensity.standard,
      padding: const EdgeInsets.all(12),
      constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
      style: IconButton.styleFrom(minimumSize: const Size(48, 48)),
      tooltip: _obscured ? 'Show password' : 'Hide password',
      onPressed: widget.enabled
          ? () => setState(() => _obscured = !_obscured)
          : null,
      icon: Icon(
        _obscured ? Icons.visibility_outlined : Icons.visibility_off_outlined,
        color: widget.icon != null ? Sc.slateLight : Sc.teal,
        size: 22,
      ),
    ));
  }
}
