import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../firebase_options.dart';

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

  /// The agent's daily and weekly summaries, and its alerts (SPEC §11).
  ///
  /// A third channel for the same reason there is a second one: a summary arrives
  /// every single morning, which makes it the most likely thing an owner ever
  /// wants to silence. Sharing a channel with bookings would take their booking
  /// pings with it; sharing one with the alarm would be unforgivable.
  static const briefings = 'scalivo.briefings';
  static const briefingsName = 'Daily summary';
}

/// Data-payload key the backend sets so the app knows where to send someone.
///
/// A Session Health push must open the QR screen directly. Landing on Home and
/// making a worried owner hunt for the fix wastes the minutes the alert bought.
const kPushRoute = 'route';

/// Called for messages that arrive while the app is terminated or backgrounded.
///
/// Must be a top-level function: Android spawns a SEPARATE Dart isolate for it,
/// which shares no state with the running app. That is also why it re-runs
/// `Firebase.initializeApp` — the isolate has none of the app's setup.
///
/// Deliberately does almost nothing. The system tray notification is drawn by
/// FCM itself from the `notification` block; work done here is invisible to the
/// owner and runs under a short execution budget.
@pragma('vm:entry-point')
Future<void> _onBackgroundMessage(RemoteMessage message) async {
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
}

/// Firebase Cloud Messaging.
///
/// Everything FCM-specific lives behind this class, so the rest of the app deals
/// in "a token" and "a route was tapped" and never imports firebase_messaging.
class PushService {
  static final _local = FlutterLocalNotificationsPlugin();
  static Future<void>? _initialising;
  static const _timeout = Duration(seconds: 10);

  /// Held statically so a tap on a FOREGROUND notification routes the same way
  /// as a tap on a system one. Those take different paths — FCM delivers the
  /// background tap, flutter_local_notifications delivers this one — and an
  /// alarm that opens the QR screen only when the app was closed is a trap.
  static void Function(String route)? _tapHandler;
  void Function(String route)? _handler;
  StreamSubscription<RemoteMessage>? _opened, _foreground;
  bool _disposed = false;

  void dispose() {
    _disposed = true;
    if (identical(_tapHandler, _handler)) _tapHandler = null;
    unawaited(_opened?.cancel());
    unawaited(_foreground?.cancel());
  }

  /// Idempotent: [ensureChannels] and [token] are both called on paths that can
  /// run more than once (app start, every login, token rotation).
  Future<void> _init() => _initialising ??= _initialise();

  Future<void> _initialise() async {
    try {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
      FirebaseMessaging.onBackgroundMessage(_onBackgroundMessage);
    } catch (_) {
      _initialising = null;
      rethrow;
    }
  }

  Future<StreamSubscription<String>?> watchToken(
    void Function(String) handler,
  ) async {
    try {
      await _init().timeout(_timeout);
      return FirebaseMessaging.instance.onTokenRefresh.listen(handler);
    } catch (_) {
      return null;
    }
  }

  /// Stop this device receiving notifications for the signed-out account.
  Future<void> deleteToken() async {
    try {
      await _init().timeout(_timeout);
      await FirebaseMessaging.instance.deleteToken().timeout(_timeout);
    } catch (_) {
      debugPrint('[push] could not revoke device token');
    }
  }

  /// The FCM registration token for this device, or null if push is unavailable.
  ///
  /// Null is a normal outcome, not a failure: the owner may have denied the
  /// permission, or the device may have no Play Services. The caller registers
  /// what it gets and the backend simply has one fewer device to reach.
  Future<String?> token() async {
    try {
      await _init().timeout(_timeout);

      // Android 13+ and iOS both require an explicit grant. Asking here — on
      // login, once the owner has committed to the app — beats asking on first
      // launch, when a stranger's permission dialog is easy to dismiss.
      final settings = await FirebaseMessaging.instance.requestPermission();
      if (settings.authorizationStatus == AuthorizationStatus.denied) {
        debugPrint('[push] notifications denied — the owner will not get outage alerts');
        return null;
      }

      return await FirebaseMessaging.instance.getToken().timeout(_timeout);
    } catch (err) {
      // Never let push break login. An owner who cannot sign in because
      // notifications failed is a far worse outcome than a missed alert.
      debugPrint('[push] could not get a token');
      return null;
    }
  }

  static String? notificationRoute(Map<String, dynamic> data) {
    final route = data[kPushRoute];
    final businessId = data['businessId'];
    if (route is! String || !['/qr', '/briefings'].contains(route)) return null;
    if (businessId == null) return route;
    if (businessId is! String || !RegExp(r'^[a-zA-Z0-9_-]{1,80}$').hasMatch(businessId)) return null;
    return Uri(path: route, queryParameters: {'businessId': businessId}).toString();
  }

  /// Called when a notification is tapped, and when one launched the app.
  void onNotificationTap(void Function(String route) handler) {
    _handler = handler;
    _tapHandler = handler;

    unawaited(() async {
      try {
        await _init().timeout(_timeout);
        if (_disposed) return;

        // A tap while the app was merely backgrounded.
        _opened = FirebaseMessaging.onMessageOpenedApp.listen((message) {
          final route = notificationRoute(message.data);
          if (route != null) handler(route);
        });

        // The app was TERMINATED and the notification started it. This arrives
        // once, is easy to forget, and is exactly the case a session-down alert
        // hits — the owner's phone was in their pocket.
        final initial = await FirebaseMessaging.instance.getInitialMessage().timeout(_timeout);
        if (_disposed) return;
        final route = initial == null ? null : notificationRoute(initial.data);
        if (route != null) handler(route);

        // Foregrounded messages draw no system notification on Android, so
        // there is nothing to tap unless we draw it ourselves.
        _foreground = FirebaseMessaging.onMessage.listen(_showForeground);
      } catch (err) {
        debugPrint('[push] could not attach notification handlers');
      }
    }());
  }

  /// Creates the three channels above. Android needs them to exist before the
  /// first notification arrives, or it silently uses a default channel — and a
  /// default channel is one the owner can mute along with everything else.
  Future<void> ensureChannels() async {
    try {
      await _init().timeout(_timeout);

      await _local.initialize(
        const InitializationSettings(
          android: AndroidInitializationSettings('@mipmap/ic_launcher'),
          iOS: DarwinInitializationSettings(),
        ),
        onDidReceiveNotificationResponse: (response) {
          final route = response.payload;
          if (route != null && route.isNotEmpty) _tapHandler?.call(route);
        },
      );

      final android = _local
          .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      if (android == null) return; // iOS has no channels

      await android.createNotificationChannel(
        const AndroidNotificationChannel(
          PushChannels.bookings,
          PushChannels.bookingsName,
          description: 'New bookings and customer messages.',
          importance: Importance.defaultImportance,
        ),
      );

      await android.createNotificationChannel(
        const AndroidNotificationChannel(
          PushChannels.sessionHealth,
          PushChannels.sessionHealthName,
          description: 'Alerts when your WhatsApp disconnects and customers cannot book.',
          importance: Importance.max,
          enableVibration: true,
        ),
      );

      await android.createNotificationChannel(
        const AndroidNotificationChannel(
          PushChannels.briefings,
          PushChannels.briefingsName,
          description: 'Your morning summary, the Monday look back, and things worth your attention.',
          // Default rather than low: it should appear in the tray and be worth
          // reading, but it must never make a sound at seven in the morning.
          importance: Importance.defaultImportance,
        ),
      );
    } catch (err) {
      debugPrint('[push] could not create channels');
    }
  }

  /// Draw a notification for a message that arrived while the app was open.
  Future<void> _showForeground(RemoteMessage message) async {
    final notification = message.notification;
    if (notification == null) return;

    // The backend sets this; falling back to bookings is the safe direction —
    // it under-escalates rather than crying wolf on the alarm channel.
    final channel = message.data['channel'] as String? ?? PushChannels.bookings;
    final isAlarm = channel == PushChannels.sessionHealth;

    // The name has to match the channel that was created under this id, or a
    // notification arriving before ensureChannels ran would register a channel
    // the owner sees under the wrong label in their system settings — and Android
    // never renames a channel once it exists.
    final name = switch (channel) {
      PushChannels.sessionHealth => PushChannels.sessionHealthName,
      PushChannels.briefings => PushChannels.briefingsName,
      _ => PushChannels.bookingsName,
    };

    await _local.show(
      notification.hashCode,
      notification.title,
      notification.body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          channel,
          name,
          importance: isAlarm ? Importance.max : Importance.defaultImportance,
          priority: isAlarm ? Priority.high : Priority.defaultPriority,
        ),
        iOS: const DarwinNotificationDetails(),
      ),
      payload: notificationRoute(message.data),
    );
  }
}
