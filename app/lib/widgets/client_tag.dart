import 'package:flutter/material.dart';

import '../theme.dart';

/// The four auto-tags, in the colours they earn.
///
/// Nothing here is typed by anyone: the tags are computed from the visit history
/// on every read, which is why a stale VIP cannot exist. The colours say what
/// each one means before the word is read — teal is good, yellow wants
/// attention, red has already gone.
({Color fill, Color text, String label}) tagStyle(String tag) => switch (tag) {
      'new' => (fill: Sc.tealSoft, text: Sc.teal900, label: 'New'),
      'vip' => (fill: Color(0xFFFFF3D4), text: Sc.warnTitle, label: 'VIP'),
      'at_risk' => (fill: Sc.warnBg, text: Sc.warnBody, label: 'At risk'),
      'lapsed' => (fill: Sc.dangerBg, text: Sc.dangerTitle, label: 'Lapsed'),
      _ => (fill: Sc.chipFill, text: Sc.inkMuted, label: tag),
    };

class ClientTagChip extends StatelessWidget {
  const ClientTagChip({super.key, required this.tag, this.dense = false});

  final String tag;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final style = tagStyle(tag);

    return Container(
      decoration: BoxDecoration(
        color: style.fill,
        borderRadius: BorderRadius.circular(7),
      ),
      padding: EdgeInsets.symmetric(horizontal: dense ? 7 : 9, vertical: dense ? 2.5 : 4),
      child: Text(
        style.label.toUpperCase(),
        style: TextStyle(
          fontSize: dense ? 9.5 : 10.5,
          fontWeight: FontWeight.w600,
          letterSpacing: 0.4,
          color: style.text,
        ),
      ),
    );
  }
}
