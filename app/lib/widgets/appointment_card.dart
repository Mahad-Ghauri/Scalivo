import 'package:flutter/material.dart';

import '../api/models.dart';
import '../format.dart';
import '../theme.dart';

/// One appointment, as the owner scans a day.
///
/// The information order is the order it is needed in: time first, because the
/// owner is looking for "what's next"; then who; then what and with whom. The
/// price is last and quiet — it matters at the till, not on the list.
///
/// A terminal appointment stays on the list rather than disappearing. A day with
/// its completed visits removed reads as a day where nothing happened, and the
/// owner loses the only record that the 11am actually turned up.
class AppointmentCard extends StatelessWidget {
  const AppointmentCard({super.key, required this.entry, this.onTap});

  final CalendarEntry entry;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final tone = _toneFor(entry.status);
    final faded = entry.status == 'cancelled' || entry.status == 'no_show';

    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: Sc.divider),
          ),
          padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
          child: Opacity(
            opacity: faded ? 0.55 : 1,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // A coloured spine rather than a badge: it reads down the list
                // at a glance without adding a word to every row.
                Container(
                  width: 3.5,
                  height: 42,
                  decoration: BoxDecoration(
                    color: tone.accent,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(width: 13),
                SizedBox(
                  width: 62,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        hhmm(entry.startsAt),
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          color: Sc.ink,
                          letterSpacing: -0.1,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        duration(entry.durationMinutes),
                        style: const TextStyle(fontSize: 11.5, color: Sc.slateLight),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              // A walk-in nobody named still has to read as a
                              // person, not as an empty row.
                              entry.clientName ?? 'Walk-in',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 14.5,
                                fontWeight: FontWeight.w600,
                                color: Sc.ink,
                              ),
                            ),
                          ),
                          if (entry.source == 'whatsapp')
                            const Padding(
                              padding: EdgeInsets.only(left: 6),
                              child: Icon(
                                Icons.chat_bubble,
                                size: 11,
                                color: Sc.slateFaint,
                              ),
                            ),
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        '${entry.serviceName} · ${entry.staffName}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12.5, color: Sc.slate),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    Text(
                      money(entry.priceMinor),
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: Sc.inkMuted,
                      ),
                    ),
                    if (tone.label != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        tone.label!,
                        style: TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0.3,
                          color: tone.accent,
                        ),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// Confirmed carries no label — it is the normal case, and labelling every
  /// row means the owner stops reading any of them.
  static _Tone _toneFor(String status) => switch (status) {
        'pending' => const _Tone(Sc.yellow, 'UNCONFIRMED'),
        'confirmed' => const _Tone(Sc.teal, null),
        'completed' => const _Tone(Sc.slateLight, 'DONE'),
        'no_show' => const _Tone(Sc.danger, 'NO-SHOW'),
        'cancelled' => const _Tone(Sc.slateFaint, 'CANCELLED'),
        _ => const _Tone(Sc.slateLight, null),
      };
}

class _Tone {
  const _Tone(this.accent, this.label);

  final Color accent;
  final String? label;
}

/// Time the owner declared off-limits, drawn inline with the appointments so a
/// blocked afternoon is visible in the same scan rather than on another screen.
class BlockCard extends StatelessWidget {
  const BlockCard({super.key, required this.block, this.staffName, this.onRemove});

  final CalendarBlock block;
  final String? staffName;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Sc.chipFill,
        borderRadius: BorderRadius.circular(16),
      ),
      padding: EdgeInsets.fromLTRB(16, 12, onRemove == null ? 16 : 6, 12),
      child: Row(
        children: [
          const Icon(Icons.block_rounded, size: 15, color: Sc.slate),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              block.reason?.isNotEmpty == true ? block.reason! : 'Blocked',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w500,
                color: Sc.inkMuted,
              ),
            ),
          ),
          Text(
            // A whole-business block has no staff name to show, and saying
            // "everyone" is clearer than leaving the row ambiguous.
            '${hhmm(block.startsAt)} – ${hhmm(block.endsAt)}'
            '${staffName == null ? '' : ' · $staffName'}',
            style: const TextStyle(fontSize: 11.5, color: Sc.slate),
          ),
          if (onRemove != null)
            IconButton(
              tooltip: 'Unblock',
              visualDensity: VisualDensity.compact,
              onPressed: onRemove,
              icon: const Icon(Icons.close_rounded, size: 16, color: Sc.slateLight),
            ),
        ],
      ),
    );
  }
}
