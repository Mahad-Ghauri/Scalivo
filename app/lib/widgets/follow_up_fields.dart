import 'package:flutter/material.dart';

import '../theme.dart';

/// "Needs a follow-up · come back in N days · note" — the owner's choice,
/// shared by the walk-in sheet and the follow-up dialog so both validate the
/// same way. The parent owns the controllers.
class FollowUpFields extends StatelessWidget {
  const FollowUpFields({
    super.key,
    required this.enabled,
    required this.onToggle,
    required this.days,
    required this.note,
    this.busy = false,
    this.showToggle = true,
    this.label = 'Needs a follow-up',
    this.helper =
        'Once the visit is marked complete, the customer gets a WhatsApp '
        'message 3 days before with a time they can book in one reply.',
  });

  final String label;
  final String helper;

  final bool enabled;
  final ValueChanged<bool> onToggle;
  final TextEditingController days;
  final TextEditingController note;
  final bool busy;

  /// False inside the dialog, which is already the decision to add one.
  final bool showToggle;

  /// Days parsed from the field, or null when it isn't a whole 1–365.
  static int? parseDays(String raw) {
    final n = int.tryParse(raw.trim());
    return n != null && n >= 1 && n <= 365 ? n : null;
  }

  static String? cleanNote(String raw) {
    final t = raw.trim();
    return t.isEmpty ? null : (t.length > 200 ? t.substring(0, 200) : t);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (showToggle)
          Row(
            children: [
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(fontSize: 13.5, color: Sc.inkMuted),
                ),
              ),
              Switch(
                value: enabled,
                activeThumbColor: Colors.white,
                activeTrackColor: Sc.teal,
                onChanged: busy ? null : onToggle,
              ),
            ],
          ),
        if (enabled || !showToggle) ...[
          Row(
            children: [
              const Text(
                'Come back in',
                style: TextStyle(fontSize: 13.5, color: Sc.ink),
              ),
              const SizedBox(width: 10),
              SizedBox(
                width: 72,
                child: TextField(
                  key: const Key('followUpDays'),
                  controller: days,
                  enabled: !busy,
                  keyboardType: TextInputType.number,
                  textAlign: TextAlign.center,
                  decoration: const InputDecoration(isDense: true),
                ),
              ),
              const SizedBox(width: 10),
              const Text('days', style: TextStyle(fontSize: 13.5, color: Sc.ink)),
            ],
          ),
          const SizedBox(height: 10),
          TextField(
            key: const Key('followUpNote'),
            controller: note,
            enabled: !busy,
            maxLength: 200,
            decoration: const InputDecoration(
              isDense: true,
              hintText: 'Note for the customer, e.g. Session 2 of 6',
            ),
          ),
          Text(
            helper,
            style: const TextStyle(fontSize: 12, color: Sc.slate, height: 1.5),
          ),
        ],
      ],
    );
  }
}
