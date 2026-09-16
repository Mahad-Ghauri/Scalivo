import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'models.dart';

enum ApiErrorKind { network, unauthorized, validation, conflict, server }

/// Every failure the login and register screens are designed to show.
///
/// [fieldErrors] is what turns a 400 into a red underline on the offending
/// input rather than one generic banner — the backend keys its validation
/// errors by field name for exactly this.
class ApiException implements Exception {
  const ApiException(this.kind, this.message, {this.fieldErrors = const {}});

  final ApiErrorKind kind;
  final String message;
  final Map<String, String> fieldErrors;

  @override
  String toString() => message;
}

/// Where the backend lives.
///
/// An Android emulator cannot see the host's `localhost` — 10.0.2.2 is the
/// host loopback from inside it. The default below is therefore emulator-only:
/// on a physical phone 10.0.2.2 is a dead address and every call fails as a
/// network error.
///
/// For a physical Android device, tunnel over the USB cable and use localhost:
///   adb reverse tcp:3000 tcp:3000
///   flutter run --dart-define=SCALIVO_API=http://localhost:3000
/// The reverse is lost on unplug or reboot — re-run it.
///
/// Or, on the same wifi, point at the host's LAN IP instead:
///   flutter run --dart-define=SCALIVO_API=http://192.168.1.20:3000
const _configuredBaseUrl = String.fromEnvironment('SCALIVO_API');

String defaultBaseUrl() {
  if (_configuredBaseUrl.isNotEmpty) return _configuredBaseUrl;
  return Platform.isAndroid ? 'http://10.0.2.2:3000' : 'http://localhost:3000';
}

class ApiClient {
  ApiClient({String? baseUrl, http.Client? client})
      : baseUrl = baseUrl ?? defaultBaseUrl(),
        _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  /// Set by AuthController on login and on restore; cleared on logout.
  String? token;

  static const _timeout = Duration(seconds: 15);

  Future<AuthResult> login(String email, String password) async {
    final json = await _send('POST', '/auth/login', body: {
      'email': email,
      'password': password,
    });
    return AuthResult.fromJson(json);
  }

  Future<AuthResult> register({
    required String businessName,
    required String category,
    required String city,
    required String ownerName,
    required String email,
    required String password,
  }) async {
    final json = await _send('POST', '/auth/register', body: {
      'businessName': businessName,
      'category': category,
      'city': city,
      'ownerName': ownerName,
      'email': email,
      'password': password,
    });
    return AuthResult.fromJson(json);
  }

  Future<Me> me() async => Me.fromJson(await _send('GET', '/auth/me'));

  Future<void> registerDevice(String fcmToken) =>
      _send('POST', '/auth/device', body: {'fcmToken': fcmToken});

  Future<LinkResult> linkWhatsApp(String businessId) async =>
      LinkResult.fromJson(await _send('POST', '/businesses/$businessId/whatsapp/link'));

  Future<BusinessSummary> whatsappState(String businessId, BusinessSummary current) async {
    final json = await _send('GET', '/businesses/$businessId/whatsapp');
    return BusinessSummary(
      id: current.id,
      name: current.name,
      category: current.category,
      whatsappStatus: json['status'] as String?,
      whatsappIntent: json['intent'] as String?,
    );
  }

  // ── The diary ────────────────────────────────────────────────────────────

  /// A day is `from == to`. The backend groups by BUSINESS-local date, which is
  /// why the range is sent as plain 'YYYY-MM-DD' rather than as instants.
  Future<CalendarView> calendar(
    String businessId, {
    required String from,
    required String to,
    String? staffId,
    bool includeCancelled = false,
  }) async {
    final query = {
      'from': from,
      'to': to,
      'staffId': ?staffId,
      if (includeCancelled) 'includeCancelled': 'true',
    };
    return CalendarView.fromJson(
      await _send('GET', '/businesses/$businessId/calendar', query: query),
    );
  }

  Future<void> walkIn(
    String businessId, {
    required String serviceId,
    required String staffId,
    required DateTime startsAt,
    String? name,
    String? phone,
    String? clientId,
  }) =>
      _send('POST', '/businesses/$businessId/walk-ins', body: {
        'serviceId': serviceId,
        'staffId': staffId,
        'startsAt': startsAt.toUtc().toIso8601String(),
        if (name != null && name.isNotEmpty) 'name': name,
        if (phone != null && phone.isNotEmpty) 'phone': phone,
        'clientId': ?clientId,
      });

  Future<RescheduleOutcome> reschedule(
    String businessId,
    String bookingId, {
    required DateTime startsAt,
    String? staffId,
    bool override = false,
  }) async =>
      RescheduleOutcome.fromJson(
        await _send('POST', '/businesses/$businessId/bookings/$bookingId/reschedule', body: {
          'startsAt': startsAt.toUtc().toIso8601String(),
          'staffId': ?staffId,
          'override': override,
        }),
      );

  /// `outcome` is 'completed' or 'no_show'. Cancelling has its own route
  /// because it is the only one that frees the slot.
  Future<void> setOutcome(String businessId, String bookingId, String outcome) =>
      _send('POST', '/businesses/$businessId/bookings/$bookingId/outcome',
          body: {'outcome': outcome});

  Future<void> cancelBooking(String businessId, String bookingId) =>
      _send('POST', '/businesses/$businessId/bookings/$bookingId/cancel');

  // ── Catalogue ────────────────────────────────────────────────────────────

  Future<List<ServiceItem>> services(String businessId) async {
    final json = await _send('GET', '/businesses/$businessId/services');
    return (json['services'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(ServiceItem.fromJson)
        .toList(growable: false);
  }

  Future<List<StaffSummary>> staff(String businessId) async {
    final json = await _send('GET', '/businesses/$businessId/staff');
    return (json['staff'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(StaffSummary.fromJson)
        .toList(growable: false);
  }

  // ── The CRM ──────────────────────────────────────────────────────────────

  Future<({List<ClientRow> clients, int total})> clients(
    String businessId, {
    String? q,
    String? tag,
    int skip = 0,
    int limit = 50,
  }) async {
    final json = await _send('GET', '/businesses/$businessId/clients', query: {
      if (q != null && q.isNotEmpty) 'q': q,
      'tag': ?tag,
      'skip': '$skip',
      'limit': '$limit',
    });

    return (
      clients: (json['clients'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(ClientRow.fromJson)
          .toList(growable: false),
      total: json['total'] as int? ?? 0,
    );
  }

  Future<ClientProfileDetail> clientProfile(String businessId, String clientId) async =>
      ClientProfileDetail.fromJson(
        await _send('GET', '/businesses/$businessId/clients/$clientId'),
      );

  Future<void> saveNotes(String businessId, String clientId, String notes) =>
      _send('PUT', '/businesses/$businessId/clients/$clientId/notes', body: {'notes': notes});

  /// Rebuild the counters from the bookings.
  ///
  /// The profile is a cache, and this is its repair. Exposed in the app rather
  /// than kept as an admin curiosity because the owner is the only person who
  /// will ever notice a number looking wrong.
  Future<void> recomputeProfile(String businessId, String clientId) =>
      _send('POST', '/businesses/$businessId/clients/$clientId/recompute');

  // ── Settings ─────────────────────────────────────────────────────────────

  Future<BusinessSettings> settings(String businessId) async =>
      BusinessSettings.fromJson(await _send('GET', '/businesses/$businessId'));

  /// Only the keys passed are sent. The backend flattens `reminders` to dotted
  /// paths, so sending the toggle alone does not wipe the lead times.
  Future<BusinessSettings> updateSettings(
    String businessId, {
    bool? remindersEnabled,
    List<int>? reminderLeadMinutes,
    int? minNoticeMinutes,
    int? bookingHorizonDays,
  }) async {
    final reminders = <String, dynamic>{
      'enabled': ?remindersEnabled,
      'leadMinutes': ?reminderLeadMinutes,
    };

    return BusinessSettings.fromJson(
      await _send('PATCH', '/businesses/$businessId', body: {
        'minNoticeMinutes': ?minNoticeMinutes,
        'bookingHorizonDays': ?bookingHorizonDays,
        if (reminders.isNotEmpty) 'reminders': reminders,
      }),
    );
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
  }) async {
    // Built through Uri rather than string concatenation: a customer search for
    // "R&B" or a name with a space would otherwise truncate the query silently.
    final uri = Uri.parse('$baseUrl$path').replace(
      queryParameters: (query == null || query.isEmpty) ? null : query,
    );

    final request = http.Request(method, uri)
      ..headers['Accept'] = 'application/json';

    if (token != null) request.headers['Authorization'] = 'Bearer $token';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }

    http.Response response;
    try {
      response = await http.Response.fromStream(await _client.send(request).timeout(_timeout));
    } on Object {
      // Any transport failure reads the same to an owner standing in a salon
      // with bad wifi, and the design has one banner for it.
      throw const ApiException(ApiErrorKind.network, 'No internet connection');
    }

    if (response.statusCode == 204 || response.body.isEmpty) {
      if (response.statusCode >= 400) throw _errorFor(response.statusCode, const {});
      return const {};
    }

    Map<String, dynamic> json;
    try {
      json = jsonDecode(response.body) as Map<String, dynamic>;
    } on Object {
      throw const ApiException(ApiErrorKind.server, 'Something went wrong. Try again.');
    }

    if (response.statusCode >= 400) {
      final fields = (json['fields'] as Map<String, dynamic>? ?? const {})
          .map((k, v) => MapEntry(k, v.toString()));
      throw _errorFor(response.statusCode, fields, json['error'] as String?);
    }

    return json;
  }

  ApiException _errorFor(int status, Map<String, String> fields, [String? serverMessage]) {
    return switch (status) {
      401 => const ApiException(ApiErrorKind.unauthorized, 'Wrong email or password'),
      // The server's message is safe to show here: 400 and 409 are both
      // validation outcomes phrased for a person, not internal detail.
      400 => ApiException(
          ApiErrorKind.validation,
          serverMessage ?? 'Check the highlighted fields',
          fieldErrors: fields,
        ),
      409 => ApiException(
          ApiErrorKind.conflict,
          serverMessage ?? 'That is already taken',
          fieldErrors: fields,
        ),
      _ => const ApiException(ApiErrorKind.server, 'Something went wrong. Try again.'),
    };
  }
}
