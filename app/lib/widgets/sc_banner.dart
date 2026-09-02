import 'package:flutter/material.dart';

import '../theme.dart';

enum ScBannerTone { danger, warning }

/// Form-level and screen-level messages: wrong password, no internet, WhatsApp
/// is down.
///
/// Distinct from a field error, which sits under one input. This is for
/// anything that is about the whole screen.
class ScBanner extends StatelessWidget {
  const ScBanner({
    super.key,
    required this.title,
    this.message,
    this.tone = ScBannerTone.danger,
    this.action,
  });

  final String title;
  final String? message;
  final ScBannerTone tone;

  /// Rendered under the message. Used by the outage banner for RECONNECT.
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final danger = tone == ScBannerTone.danger;
    final background = danger ? Sc.dangerBg : Sc.warnBg;
    final rule = danger ? Sc.danger : Sc.yellow;
    final titleColor = danger ? Sc.dangerTitle : Sc.warnTitle;
    final bodyColor = danger ? Sc.dangerBody : Sc.warnBody;

    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: ColoredBox(
        color: background,
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SizedBox(width: 4, child: ColoredBox(color: rule)),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 13, 14, 13),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _badge(danger, rule),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              title,
                              style: TextStyle(
                                fontSize: 13.5,
                                fontWeight: FontWeight.w600,
                                color: titleColor,
                                height: 1.3,
                              ),
                            ),
                            if (message != null) ...[
                              const SizedBox(height: 3),
                              Text(
                                message!,
                                style: TextStyle(
                                  fontSize: 12.5,
                                  color: bodyColor,
                                  height: 1.45,
                                ),
                              ),
                            ],
                            if (action != null) ...[
                              const SizedBox(height: 10),
                              Align(alignment: Alignment.centerLeft, child: action!),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _badge(bool danger, Color color) {
    if (danger) {
      return Container(
        width: 19,
        height: 19,
        margin: const EdgeInsets.only(top: 1),
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        alignment: Alignment.center,
        child: const Text(
          '!',
          style: TextStyle(
            fontSize: 12.5,
            fontWeight: FontWeight.w700,
            color: Colors.white,
            height: 1.1,
          ),
        ),
      );
    }

    return const Padding(
      padding: EdgeInsets.only(top: 1),
      child: Icon(Icons.warning_amber_rounded, size: 19, color: Sc.warnIcon),
    );
  }
}
