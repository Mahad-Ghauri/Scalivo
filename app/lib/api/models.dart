/// Wire models. Small on purpose — the app only needs what the four Phase 1.1
/// screens render, and every field here is one the backend actually sends.
library;

class AuthResult {
  const AuthResult({required this.token, required this.role});

  final String token;
  final String role;

  factory AuthResult.fromJson(Map<String, dynamic> json) => AuthResult(
        token: json['token'] as String,
        role: json['role'] as String? ?? 'owner',
      );
}

class BusinessSummary {
  const BusinessSummary({
    required this.id,
    required this.name,
    required this.category,
    required this.whatsappStatus,
    required this.whatsappIntent,
  });

  final String id;
  final String name;
  final String category;
  final String? whatsappStatus;
  final String? whatsappIntent;

  factory BusinessSummary.fromJson(Map<String, dynamic> json) {
    final wa = json['whatsapp'] as Map<String, dynamic>? ?? const {};
    return BusinessSummary(
      id: json['id'] as String,
      name: json['name'] as String? ?? 'Your business',
      category: json['category'] as String? ?? '',
      whatsappStatus: wa['status'] as String?,
      whatsappIntent: wa['intent'] as String?,
    );
  }

  SessionHealth get health => sessionHealthOf(whatsappStatus, whatsappIntent);
}

class Me {
  const Me({required this.name, required this.email, required this.businesses});

  final String? name;
  final String email;
  final List<BusinessSummary> businesses;

  /// Phase 1 owners have exactly one business. Multi-business owners are a
  /// Phase 2 problem; until then, picking the first is honest rather than lossy.
  BusinessSummary? get business => businesses.isEmpty ? null : businesses.first;

  factory Me.fromJson(Map<String, dynamic> json) {
    final user = json['user'] as Map<String, dynamic>? ?? const {};
    final list = json['businesses'] as List<dynamic>? ?? const [];
    return Me(
      name: user['name'] as String?,
      email: user['email'] as String? ?? '',
      businesses: list
          .whereType<Map<String, dynamic>>()
          .map(BusinessSummary.fromJson)
          .toList(growable: false),
    );
  }
}

class LinkResult {
  const LinkResult({required this.status, required this.qrCode});

  final String status;

  /// A PNG data URL, or null. Null is not a failure: a session that was already
  /// linked recovers with no QR at all, which is the happy path.
  final String? qrCode;

  factory LinkResult.fromJson(Map<String, dynamic> json) => LinkResult(
        status: json['status'] as String? ?? 'created',
        qrCode: json['qrCode'] as String?,
      );
}

/// What the session banner shows.
enum SessionHealth {
  /// Linked and reporting ready.
  live,

  /// We expect it up and it isn't. Customers cannot book right now.
  down,

  /// We asked for a QR, so a qr_ready here is ours and not an alarm.
  linking,

  /// Never linked, or deliberately stopped. Not an alarm, but not working.
  notConnected,
}

/// The Dart twin of `isSessionAlarm` in the shared package.
///
/// SPIKE FINDING #2: a phone-side unlink never emits `disconnected` — it emits
/// `qr_ready`. So "down" cannot be read off the status alone; it only means
/// anything against what we believed *should* be happening. Status plus intent,
/// never status by itself.
SessionHealth sessionHealthOf(String? status, String? intent) {
  if (status == null || intent == null) return SessionHealth.notConnected;
  if (intent == 'linking') return SessionHealth.linking;
  if (intent == 'stopped') return SessionHealth.notConnected;

  // intent == 'live' from here: we believe this session should be up.
  return status == 'ready' ? SessionHealth.live : SessionHealth.down;
}
