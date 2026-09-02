import 'package:flutter/material.dart';

import '../api/models.dart';
import '../theme.dart';

/// The session banner, in its compact form for the teal hero.
///
/// It occupies the same spot on every screen and only changes colour. An owner
/// learns where to look once; if the pill moved or disappeared when healthy,
/// they would have to re-find it at the exact moment they are worried.
class SessionPill extends StatelessWidget {
  const SessionPill({super.key, required this.health, this.detail, this.onTap});

  final SessionHealth health;

  /// The linked number when live, how long it has been down when not.
  final String? detail;

  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final (dot, text, fill, stroke, label) = switch (health) {
      SessionHealth.live => (
          Sc.teal,
          Sc.onTealBright,
          const Color(0x296FB3AA),
          const Color(0x526FB3AA),
          'WhatsApp connected',
        ),
      SessionHealth.down => (
          const Color(0xFFFF8080),
          const Color(0xFFFFC4C4),
          const Color(0x33D64545),
          const Color(0x7AD64545),
          'WhatsApp disconnected',
        ),
      SessionHealth.linking => (
          Sc.yellow,
          const Color(0xFFFFE1A0),
          const Color(0x29F5B921),
          const Color(0x52F5B921),
          'Waiting for scan',
        ),
      SessionHealth.notConnected => (
          Sc.onTealDim,
          Sc.onTealFaint,
          const Color(0x1FFFFFFF),
          const Color(0x33FFFFFF),
          'WhatsApp not connected',
        ),
    };

    return Align(
      alignment: Alignment.centerLeft,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(999),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(
              color: fill,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: stroke),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
                ),
                const SizedBox(width: 9),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: health == SessionHealth.down ? FontWeight.w600 : FontWeight.w500,
                    color: text,
                  ),
                ),
                if (detail != null) ...[
                  const SizedBox(width: 7),
                  Text('·', style: TextStyle(fontSize: 12.5, color: text.withValues(alpha: 0.6))),
                  const SizedBox(width: 7),
                  Text(
                    detail!,
                    style: TextStyle(fontSize: 12.5, color: text.withValues(alpha: 0.75)),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
