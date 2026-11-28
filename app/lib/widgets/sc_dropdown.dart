import 'package:flutter/material.dart';

import '../theme.dart';

/// A dropdown wearing the same underline as [ScField], so a row holding one of
/// each reads as one row rather than two controls. Given an [icon], it wears
/// [ScField]'s boxed style instead.
class ScDropdown<T> extends StatelessWidget {
  const ScDropdown({
    super.key,
    required this.label,
    this.icon,
    required this.value,
    required this.items,
    required this.itemLabel,
    required this.onChanged,
    this.errorText,
    this.enabled = true,
  });

  final String label;
  final IconData? icon;
  final T? value;
  final List<T> items;
  final String Function(T) itemLabel;
  final ValueChanged<T?>? onChanged;
  final String? errorText;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final hasError = errorText != null;
    final boxed = icon != null;

    InputBorder edge(BorderSide side) => boxed
        ? OutlineInputBorder(borderRadius: BorderRadius.circular(Sc.boxRadius), borderSide: side)
        : UnderlineInputBorder(borderSide: side);

    final border = edge(hasError
        ? const BorderSide(color: Sc.danger, width: 2)
        : boxed
            ? const BorderSide(color: Sc.fieldBorder, width: 1.2)
            : const BorderSide(color: Sc.hairline, width: 1.5));

    return Opacity(
      opacity: enabled ? 1.0 : 0.45,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (!boxed) ...[
            Text(
              label,
              style: const TextStyle(
                fontSize: 12.5,
                color: Sc.slate,
                height: 1.2,
              ),
            ),
            const SizedBox(height: 2),
          ],
          Semantics(
            label: label,
            child: DropdownButtonFormField<T>(
              initialValue: value,
              isExpanded: true,
              itemHeight: null,
              onChanged: enabled ? onChanged : null,
              icon: const Icon(
                Icons.keyboard_arrow_down_rounded,
                size: 20,
                color: Sc.slateLight,
              ),
              style: const TextStyle(
                fontSize: 15.5,
                fontWeight: FontWeight.w500,
                color: Sc.ink,
                fontFamily: 'Poppins',
              ),
              dropdownColor: Colors.white,
              decoration: InputDecoration(
                isDense: true,
                contentPadding: boxed
                    ? const EdgeInsets.symmetric(vertical: 18, horizontal: 14)
                    : const EdgeInsets.only(top: 14, bottom: 14),
                filled: boxed,
                fillColor: Colors.white,
                // Keeps a hovered box white in the browser build; phones never hover.
                hoverColor: Colors.white,
                prefixIcon: boxed
                    ? Padding(
                        padding: const EdgeInsets.only(left: 14, right: 10),
                        child: Icon(icon, size: 22, color: Sc.teal),
                      )
                    : null,
                prefixIconConstraints: const BoxConstraints(minWidth: 44, minHeight: 48),
                enabledBorder: border,
                disabledBorder: border,
                focusedBorder: edge(hasError
                    ? const BorderSide(color: Sc.danger, width: 2)
                    : BorderSide(color: Sc.teal, width: boxed ? 1.6 : 2)),
              ),
              items: [
                for (final item in items)
                  DropdownMenuItem<T>(
                    value: item,
                    child: Text(
                      itemLabel(item),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
            ),
          ),
          if (hasError)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                errorText!,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: Sc.dangerText,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
