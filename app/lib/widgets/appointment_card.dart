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
    final time = hhmm(entry.startsAt).split(' ');
    final faded = entry.status == 'cancelled' || entry.status == 'no_show';

    return Material(
      color: Sc.paper,
      child: InkWell(
        onTap: onTap,
        child: Container(
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: Sc.divider)),
          ),
          padding: const EdgeInsets.symmetric(vertical: 18),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final largeText = MediaQuery.textScalerOf(context).scale(14) > 20;
              final compact = constraints.maxWidth < 340 || largeText;
              final details = Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    entry.clientName ?? 'Walk-in',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                      color: faded ? Sc.slate : Sc.ink,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${entry.serviceName} · ${entry.staffName}',
                    style: const TextStyle(
                      fontSize: 12.5,
                      color: Sc.slate,
                      height: 1.5,
                    ),
                  ),
                  if (compact) ...[const SizedBox(height: 8), _status(tone)],
                  if (entry.source == 'whatsapp') ...[
                    const SizedBox(height: 5),
                    const Text(
                      'via WhatsApp',
                      style: TextStyle(fontSize: 11, color: Sc.slate),
                    ),
                  ],
                ],
              );
              if (largeText) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${hhmm(entry.startsAt)} · ${duration(entry.durationMinutes)}',
                      style: const TextStyle(
                        fontSize: 20,
                        fontFeatures: [FontFeature.tabularFigures()],
                        fontWeight: FontWeight.w500,
                        color: Sc.ink,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(width: 2, height: 46, color: tone.accent),
                        const SizedBox(width: 14),
                        Expanded(child: details),
                      ],
                    ),
                  ],
                );
              }
              return Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: compact ? 76 : 86,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          time.first,
                          style: const TextStyle(
                            fontSize: 23,
                            fontFeatures: [FontFeature.tabularFigures()],
                            fontWeight: FontWeight.w500,
                            letterSpacing: -0.8,
                            color: Sc.ink,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '${time.skip(1).join(' ')} · ${duration(entry.durationMinutes)}'.trim(),
                          style: const TextStyle(
                            fontSize: 11.5,
                            color: Sc.slate,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Container(width: 2, height: 46, color: tone.accent),
                  const SizedBox(width: 14),
                  Expanded(child: details),
                  if (!compact) ...[const SizedBox(width: 12), _status(tone)],
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _status(_Tone tone) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        money(entry.priceMinor),
        style: const TextStyle(
          fontSize: 12.5,
          fontWeight: FontWeight.w500,
          color: Sc.inkMuted,
        ),
      ),
      if (tone.label != null)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            tone.label!,
            style: const TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.3,
              color: Sc.slate,
            ),
          ),
        ),
    ],
  );

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
  const BlockCard({
    super.key,
    required this.block,
    this.staffName,
    this.onRemove,
  });

  final CalendarBlock block;
  final String? staffName;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: Sc.chipFill,
        borderRadius: BorderRadius.circular(4),
      ),
      padding: EdgeInsets.fromLTRB(16, 12, onRemove == null ? 16 : 6, 12),
      child: Row(
        children: [
          const Icon(Icons.block_rounded, size: 15, color: Sc.slate),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  block.reason?.isNotEmpty == true ? block.reason! : 'Blocked',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    color: Sc.inkMuted,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '${hhmm(block.startsAt)} – ${hhmm(block.endsAt)}'
                  '${staffName == null ? '' : ' · $staffName'}',
                  style: const TextStyle(fontSize: 11.5, color: Sc.slate),
                ),
              ],
            ),
          ),
          if (onRemove != null)
            IconButton(
              tooltip: 'Unblock',
              onPressed: onRemove,
              icon: const Icon(
                Icons.close_rounded,
                size: 16,
                color: Sc.slateLight,
              ),
            ),
        ],
      ),
    );
  }
}
