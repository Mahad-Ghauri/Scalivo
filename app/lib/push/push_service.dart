import 'package:flutter/foundation.dart';

/// Android notification channel ids.
///
/// **These must stay separate, and it is not cosmetic.** Android lets a person
/// mute a channel, not a notification. If bookings and outage alerts shared one
/// channel, an owner tired of a ping for every 11pm booking would mute the
/// channel — and with it the one alert that must always land: WhatsApp is down
/// and customers cannot book. Two channels means they can silence the noise and
/// physically cannot silence the alarm.
abstract final class PushChannels {
  /// Silent, dismissible. A new booking is information, not an emergency.
  static const bookings = 'scalivo.bookings';
  static const bookingsName = 'Bookings';

  /// High priority, sound, sticky. This is the one that matters.
  static const sessionHealth = 'scalivo.session_health';
  static const sessionHealthName = 'WhatsApp connection';
}

/// Data-payload key the backend sets so the app knows where to send someone.
///
/// A Session Health push must open the QR screen directly. Landing on Home and
/// making a worried owner hunt for the fix wastes the minutes the alert bought.
const kPushRoute = 'route';

/// Firebase Cloud Messaging, behind a seam.
///
/// Deliberately not wired yet: `firebase_messaging` cannot build without a real
/// `google-services.json` / `GoogleService-Info.plist`, so adding it before the
/// Firebase project exists would break `flutter run` for both of you today. The
/// contract above — two channels, and a route in the data payload — is settled,
/// and it is the part that is expensive to change later.
///
/// To finish it: create the Firebase project, drop the config files in, add
/// `firebase_core` + `firebase_messaging` to pubspec, and fill in the three
/// methods below. Nothing outside this file changes.
class PushService {
  /// The FCM registration token for this device, or null while push is unwired.
  Future<String?> token() async {
    if (kDebugMode) {
      debugPrint('[push] FCM not configured yet — no device token to register.');
    }
    return null;
  }

  /// Called when a notification is tapped. Wire this to the navigator so a
  /// [kPushRoute] of `/qr` opens the re-scan screen.
  void onNotificationTap(void Function(String route) handler) {}

  /// Creates the two channels above. Android needs them to exist before the
  /// first notification arrives, or it silently uses a default channel.
  Future<void> ensureChannels() async {}
}
