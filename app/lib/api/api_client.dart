import 'dart:async';
import 'dart:convert';

// foundation rather than dart:io: `Platform` does not exist on the web, and
// importing dart:io at all makes the whole app refuse to compile for a browser.
// `defaultTargetPlatform` answers the same question everywhere.
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'models.dart';
import '../format.dart';

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
///
/// In a browser it is plain localhost — there is no emulator in the way — but
/// the backend has to send CORS headers back, which it does in development only.
const _configuredBaseUrl = String.fromEnvironment('SCALIVO_API');

String defaultBaseUrl() {
  if (_configuredBaseUrl.isNotEmpty) return _configuredBaseUrl;
  // kIsWeb first: defaultTargetPlatform reports android for Chrome ON Android,
  // and 10.0.2.2 from a browser is simply an address that does not answer.
  if (kIsWeb) return 'http://localhost:3000';
  return defaultTargetPlatform == TargetPlatform.android
      ? 'http://10.0.2.2:3000'
      : 'http://localhost:3000';
}

class ApiClient {
  ApiClient({String? baseUrl, http.Client? client})
      : baseUrl = baseUrl ?? defaultBaseUrl(),
        _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  /// Set by AuthController on login and on restore; cleared on logout.
  String? token;
  String businessTimezone = 'Asia/Karachi';
  void Function()? onUnauthorized;

  static const _timeout = Duration(seconds: 15);

  String _businessInstant(DateTime value) {
    if (value.isUtc) return value.toIso8601String();
    final local = businessDate(value, timezone: businessTimezone);
    if (local.hour != value.hour || local.minute != value.minute || local.day != value.day) {
      throw const ApiException(ApiErrorKind.validation, 'That time does not exist in the business timezone. Pick another time.');
    }
    return local.toUtc().toIso8601String();
  }

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

  Future<void> unregisterDevice(String fcmToken) =>
      _send('DELETE', '/auth/device', body: {'fcmToken': fcmToken});

  Future<LinkResult> linkWhatsApp(String businessId) async =>
      LinkResult.fromJson(await _send('POST', '/businesses/$businessId/whatsapp/link',
          maxResponseBytes: 180000));

  /// Creates the messaging session this business does not have yet.
  ///
  /// Distinct from [linkWhatsApp], which resumes one that already exists and
  /// answers 409 when there is none. Provisioning allocates a real browser
  /// session on the gateway and registers our webhook, so it stays an explicit
  /// action rather than something a screen does on open.
  Future<LinkResult> provisionWhatsApp(String businessId) async =>
      LinkResult.fromJson(await _send('POST', '/businesses/$businessId/whatsapp/session',
          maxResponseBytes: 180000));

  /// Read the rotating code without restarting the session that offers it.
  Future<String?> whatsappQr(String businessId) async {
    if (!RegExp(r'^[a-fA-F0-9]{24}$').hasMatch(businessId)) {
      throw const ApiException(ApiErrorKind.validation, 'Invalid business');
    }
    final json = await _send(
      'GET',
      '/businesses/$businessId/whatsapp/qr',
      maxResponseBytes: 180000,
    );
    final qr = json['qrCode'];
    if (!json.containsKey('qrCode') ||
        (qr != null && (qr is! String || qr.length > 175000))) {
      throw const ApiException(ApiErrorKind.server, 'Something went wrong. Try again.');
    }
    return qr as String?;
  }

  Future<BusinessSummary> whatsappState(String businessId, BusinessSummary current) async {
    final json = await _send('GET', '/businesses/$businessId/whatsapp', maxResponseBytes: 4096);
    const statuses = {
      null, 'created', 'initializing', 'qr_ready', 'authenticating',
      'ready', 'disconnected', 'action_required', 'failed',
    };
    const intents = {null, 'linking', 'live', 'stopped'};
    if (!json.containsKey('status') || !json.containsKey('intent') ||
        !statuses.contains(json['status']) || !intents.contains(json['intent'])) {
      throw const ApiException(ApiErrorKind.server, 'Something went wrong. Try again.');
    }
    return BusinessSummary(
      id: current.id,
      name: current.name,
      category: current.category,
      timezone: current.timezone,
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
        'startsAt': _businessInstant(startsAt),
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
          'startsAt': _businessInstant(startsAt),
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

  /// The same endpoint, parsed whole, and with retired rows included.
  ///
  /// The settings screen is the one place that wants inactive rows: retiring is
  /// the only delete this system has, so un-retiring is the only undo, and a
  /// list that hides them offers no way back.
  Future<List<ServiceItem>> allServices(String businessId) async {
    final json = await _send('GET', '/businesses/$businessId/services',
        query: {'includeInactive': 'true'});
    return (json['services'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(ServiceItem.fromJson)
        .toList(growable: false);
  }

  Future<List<StaffMember>> allStaff(String businessId) async {
    final json =
        await _send('GET', '/businesses/$businessId/staff', query: {'includeInactive': 'true'});
    return (json['staff'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(StaffMember.fromJson)
        .toList(growable: false);
  }

  Future<ServiceItem> saveService(
    String businessId, {
    /// Null creates; an id edits. One method because the form is identical and
    /// two would drift on the next field either of them grows.
    String? serviceId,
    required String name,
    required int durationMinutes,
    required int bufferMinutes,
    required int priceMinor,
  }) async {
    final body = {
      'name': name,
      'durationMinutes': durationMinutes,
      'bufferMinutes': bufferMinutes,
      'priceMinor': priceMinor,
    };

    final json = serviceId == null
        ? await _send('POST', '/businesses/$businessId/services', body: body)
        : await _send('PATCH', '/businesses/$businessId/services/$serviceId', body: body);

    return ServiceItem.fromJson(json);
  }

  /// Retire, or bring back. There is no hard delete: bookings reference the id,
  /// and removing the row would blank out finished appointments.
  Future<void> setServiceActive(String businessId, String serviceId, bool active) => active
      ? _send('PATCH', '/businesses/$businessId/services/$serviceId', body: {'active': true})
      : _send('DELETE', '/businesses/$businessId/services/$serviceId');

  Future<StaffMember> saveStaff(
    String businessId, {
    String? staffId,
    required String name,
    required List<String> serviceIds,
    required List<WorkingDay> workingHours,
  }) async {
    final body = {
      'name': name,
      'serviceIds': serviceIds,
      'workingHours': [for (final day in workingHours) day.toJson()],
    };

    final json = staffId == null
        ? await _send('POST', '/businesses/$businessId/staff', body: body)
        : await _send('PATCH', '/businesses/$businessId/staff/$staffId', body: body);

    return StaffMember.fromJson(json);
  }

  /// Deactivating does NOT cancel their upcoming bookings — those still exist
  /// and still hold their slots. The owner has to deal with them deliberately.
  Future<void> setStaffActive(String businessId, String staffId, bool active) => active
      ? _send('PATCH', '/businesses/$businessId/staff/$staffId', body: {'active': true})
      : _send('DELETE', '/businesses/$businessId/staff/$staffId');

  // ── Blocked time ─────────────────────────────────────────────────────────

  /// A null [staffId] closes the whole business — a holiday, not one person's
  /// afternoon.
  Future<BlockResult> createBlock(
    String businessId, {
    String? staffId,
    required DateTime startsAt,
    required DateTime endsAt,
    String? reason,
  }) async =>
      BlockResult.fromJson(
        await _send('POST', '/businesses/$businessId/blocked-time', body: {
          'staffId': staffId,
          'startsAt': _businessInstant(startsAt),
          'endsAt': _businessInstant(endsAt),
          if (reason != null && reason.isNotEmpty) 'reason': reason,
        }),
      );

  Future<void> deleteBlock(String businessId, String blockId) =>
      _send('DELETE', '/businesses/$businessId/blocked-time/$blockId');

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
          .map((row) => ClientRow.fromJson(row, timezone: businessTimezone))
          .toList(growable: false),
      total: json['total'] as int? ?? 0,
    );
  }

  Future<ClientProfileDetail> clientProfile(String businessId, String clientId) async =>
      ClientProfileDetail.fromJson(
        await _send('GET', '/businesses/$businessId/clients/$clientId'),
    timezone: businessTimezone,
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

  /// What still stands between this business and a real booking. See
  /// [SetupChecklist] for why it is not optional decoration.
  Future<SetupChecklist> setupChecklist(String businessId) async =>
      SetupChecklist.fromJson(await _send('GET', '/businesses/$businessId/setup'));

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
    int? maxResponseBytes,
  }) async {
    // Built through Uri rather than string concatenation: a customer search for
    // "R&B" or a name with a space would otherwise truncate the query silently.
    final uri = Uri.parse('$baseUrl$path').replace(
      queryParameters: (query == null || query.isEmpty) ? null : query);

    final sentToken = token;

    final request = http.Request(method, uri)
      ..headers['Accept'] = 'application/json';

    if (token != null) request.headers['Authorization'] = 'Bearer $token';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }

    http.Response response;
    StreamIterator<List<int>>? responseChunks;
    var timedOut = false;
    try {
      response = await (() async {
        final streamed = await _client.send(request);
        if (timedOut) {
          // Headers can arrive after timeout; release that late body too.
          await streamed.stream.listen(null).cancel();
          throw TimeoutException('Request timed out');
        }
        if (maxResponseBytes == null) return http.Response.fromStream(streamed);
        final chunks = StreamIterator(streamed.stream);
        responseChunks = chunks;
        final bytes = <int>[];
        while (await chunks.moveNext()) {
          final chunk = chunks.current;
          if (bytes.length + chunk.length > maxResponseBytes) {
            throw const ApiException(ApiErrorKind.server, 'Something went wrong. Try again.');
          }
          bytes.addAll(chunk);
        }
        return http.Response.bytes(bytes, streamed.statusCode, headers: streamed.headers);
      })().timeout(_timeout, onTimeout: () {
        timedOut = true;
        throw TimeoutException('Request timed out');
      });
    } on ApiException {
      rethrow;
    } on Object {
      // Any transport failure reads the same to an owner standing in a salon
      // with bad wifi, and the design has one banner for it.
      throw const ApiException(ApiErrorKind.network, 'No internet connection');
    } finally {
      // A timed-out or oversized QR response must release its body stream.
      await responseChunks?.cancel();
    }

    if (response.statusCode == 401 &&
        (path == '/auth/login' || path == '/auth/register')) {
      throw const ApiException(
        ApiErrorKind.unauthorized,
        'Wrong email or password',
      );
    }
    if (response.statusCode == 401 &&
        sentToken != null &&
        sentToken == token &&
        path != '/auth/login' &&
        path != '/auth/register') {
      onUnauthorized?.call();
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
      final rawFields = json['fields'];
      final serverMessage = json['error'];
      if ((rawFields != null && rawFields is! Map<String, dynamic>) ||
          (serverMessage != null && serverMessage is! String)) {
        throw const ApiException(ApiErrorKind.server, 'Something went wrong. Try again.');
      }
      final fields = (rawFields as Map<String, dynamic>? ?? const {})
          .map((k, v) => MapEntry(k, v.toString()));
      throw _errorFor(response.statusCode, fields, serverMessage as String?);
    }

    return json;
  }

  ApiException _errorFor(int status, Map<String, String> fields, [String? serverMessage]) {
    return switch (status) {
      401 => const ApiException(ApiErrorKind.unauthorized,
        'Your session expired. Please sign in again.',
      ),
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
