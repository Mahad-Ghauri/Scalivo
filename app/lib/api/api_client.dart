import 'dart:async';
import 'dart:convert';

// foundation rather than dart:io: `Platform` does not exist on the web, and
// importing dart:io at all makes the whole app refuse to compile for a browser.
// `defaultTargetPlatform` answers the same question everywhere.
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'media_models.dart';
import 'models.dart';
import 'growth_models.dart';
export 'media_models.dart';
import 'briefing_models.dart';
import 'audit_models.dart';
export 'audit_models.dart';
import 'owner_booking_models.dart';
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
    if (local.hour != value.hour ||
        local.minute != value.minute ||
        local.day != value.day) {
      throw const ApiException(
        ApiErrorKind.validation,
        'That time does not exist in the business timezone. Pick another time.',
      );
    }
    return local.toUtc().toIso8601String();
  }

  Future<AuthResult> login(String email, String password) async {
    final json = await _send(
      'POST',
      '/auth/login',
      body: {'email': email, 'password': password},
    );
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
    final json = await _send(
      'POST',
      '/auth/register',
      body: {
        'businessName': businessName,
        'category': category,
        'city': city,
        'ownerName': ownerName,
        'email': email,
        'password': password,
      },
    );
    return AuthResult.fromJson(json);
  }

  Future<Me> me() async => Me.fromJson(await _send('GET', '/auth/me'));

  Future<void> registerDevice(String fcmToken) =>
      _send('POST', '/auth/device', body: {'fcmToken': fcmToken});

  Future<void> unregisterDevice(String fcmToken) =>
      _send('DELETE', '/auth/device', body: {'fcmToken': fcmToken});

  Future<LinkResult> linkWhatsApp(String businessId) async =>
      LinkResult.fromJson(
        await _send(
          'POST',
          '/businesses/$businessId/whatsapp/link',
          maxResponseBytes: 180000,
        ),
      );

  /// Creates the messaging session this business does not have yet.
  ///
  /// Distinct from [linkWhatsApp], which resumes one that already exists and
  /// answers 409 when there is none. Provisioning allocates a real browser
  /// session on the gateway and registers our webhook, so it stays an explicit
  /// action rather than something a screen does on open.
  Future<LinkResult> provisionWhatsApp(String businessId) async =>
      LinkResult.fromJson(
        await _send(
          'POST',
          '/businesses/$businessId/whatsapp/session',
          maxResponseBytes: 180000,
        ),
      );

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
      throw const ApiException(
        ApiErrorKind.server,
        'Something went wrong. Try again.',
      );
    }
    return qr as String?;
  }

  Future<BusinessSummary> whatsappState(
    String businessId,
    BusinessSummary current,
  ) async {
    final json = await _send(
      'GET',
      '/businesses/$businessId/whatsapp',
      maxResponseBytes: 4096,
    );
    const statuses = {
      null,
      'created',
      'initializing',
      'qr_ready',
      'authenticating',
      'ready',
      'disconnected',
      'action_required',
      'failed',
    };
    const intents = {null, 'linking', 'live', 'stopped'};
    if (!json.containsKey('status') ||
        !json.containsKey('intent') ||
        !statuses.contains(json['status']) ||
        !intents.contains(json['intent'])) {
      throw const ApiException(
        ApiErrorKind.server,
        'Something went wrong. Try again.',
      );
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

  /// Returns the response so a caller can attach a follow-up to the booking.
  Future<Map<String, dynamic>> walkIn(
    String businessId, {
    required String serviceId,
    required String staffId,
    required DateTime startsAt,
    String? name,
    String? phone,
    String? clientId,
    String? appointmentHolderId,
    List<Map<String, String>>? additionalServices,
    String? requestId,
  }) => _send(
    'POST',
    '/businesses/$businessId/walk-ins',
    body: {
      'serviceId': serviceId,
      'staffId': staffId,
      'startsAt': _businessInstant(startsAt),
      if (name != null && name.isNotEmpty) 'name': name,
      if (phone != null && phone.isNotEmpty) 'phone': phone,
      'clientId': ?clientId,
      'appointmentHolderId': ?appointmentHolderId,
      'additionalServices': ?additionalServices,
      'requestId': ?requestId,
    },
  );

  Future<RescheduleOutcome> reschedule(
    String businessId,
    String bookingId, {
    required DateTime startsAt,
    String? staffId,
    bool override = false,
  }) async => RescheduleOutcome.fromJson(
    await _send(
      'POST',
      '/businesses/$businessId/bookings/$bookingId/reschedule',
      body: {
        'startsAt': _businessInstant(startsAt),
        'staffId': ?staffId,
        'override': override,
      },
    ),
  );

  /// Attach or replace a visit's follow-up. Defaults on the server: the
  /// visit's service and professional.
  Future<FollowUpInfo> setFollowUp(
    String businessId,
    String bookingId, {
    required int afterDays,
    String? note,
  }) async {
    final json = await _send(
      'PUT',
      '/businesses/$businessId/bookings/$bookingId/follow-up',
      body: {'afterDays': afterDays, 'note': note},
    );
    return FollowUpInfo.fromJson(
      json['followUp'] as Map<String, dynamic>,
      businessTimezone,
    );
  }

  Future<void> clearFollowUp(String businessId, String bookingId) =>
      _send('DELETE', '/businesses/$businessId/bookings/$bookingId/follow-up');

  /// `status`: 'open' (default), 'lapsed' (needs a call) or 'all'.
  Future<List<FollowUpListItem>> followUps(
    String businessId, {
    String status = 'open',
  }) async {
    final json = await _send(
      'GET',
      '/businesses/$businessId/follow-ups',
      query: {'status': status},
    );
    return (json['followUps'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map((row) => FollowUpListItem.fromJson(row, businessTimezone))
        .toList(growable: false);
  }

  /// `outcome` is 'completed' or 'no_show'. Cancelling has its own route
  /// because it is the only one that frees the slot.
  Future<void> setOutcome(
    String businessId,
    String bookingId,
    String outcome, {
    String? earlyCompletionReason,
  }) => _send(
    'POST',
    '/businesses/$businessId/bookings/$bookingId/outcome',
    body: {'outcome': outcome, 'earlyCompletionReason': ?earlyCompletionReason},
  );

  Future<void> cancelBooking(String businessId, String bookingId) =>
      _send('POST', '/businesses/$businessId/bookings/$bookingId/cancel');

  Future<void> approveBooking(String businessId, String bookingId) =>
      _growth(businessId, 'POST', '/bookings/$bookingId/confirm', (_) {});

  Future<void> correctOutcome(
    String businessId,
    CalendarEntry entry,
    String outcome,
    String reason,
  ) => _growth(
    businessId,
    'POST',
    '/bookings/${entry.id}/correction',
    (_) {},
    body: {'outcome': outcome, 'reason': reason, 'revision': entry.revision},
  );

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
    final json = await _send(
      'GET',
      '/businesses/$businessId/services',
      query: {'includeInactive': 'true'},
    );
    return (json['services'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(ServiceItem.fromJson)
        .toList(growable: false);
  }

  Future<List<StaffMember>> allStaff(String businessId) async {
    final json = await _send(
      'GET',
      '/businesses/$businessId/staff',
      query: {'includeInactive': 'true'},
    );
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
    List<List<String>>? resourceRequirements,
    bool? requiresOwnerApproval,
    int? approvalWindowMinutes,
    int? followUpDays,
    String? followUpNote,

    /// True to send the follow-up default (including null, which clears it).
    /// False leaves it untouched, for callers that don't show the field.
    bool setFollowUp = false,
  }) async {
    final body = {
      'name': name,
      'durationMinutes': durationMinutes,
      'bufferMinutes': bufferMinutes,
      'priceMinor': priceMinor,
      if (resourceRequirements != null)
        'resourceRequirements': [
          for (final group in resourceRequirements) {'anyOfResourceIds': group},
        ],
      'requiresOwnerApproval': ?requiresOwnerApproval,
      'approvalWindowMinutes': ?approvalWindowMinutes,
      if (setFollowUp) ...{
        'followUpDays': followUpDays,
        'followUpNote': followUpNote,
      },
    };

    final json = serviceId == null
        ? await _send('POST', '/businesses/$businessId/services', body: body)
        : await _send(
            'PATCH',
            '/businesses/$businessId/services/$serviceId',
            body: body,
          );

    return ServiceItem.fromJson(json);
  }

  /// Retire, or bring back. There is no hard delete: bookings reference the id,
  /// and removing the row would blank out finished appointments.
  Future<void> setServiceActive(
    String businessId,
    String serviceId,
    bool active,
  ) => active
      ? _send(
          'PATCH',
          '/businesses/$businessId/services/$serviceId',
          body: {'active': true},
        )
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
        : await _send(
            'PATCH',
            '/businesses/$businessId/staff/$staffId',
            body: body,
          );

    return StaffMember.fromJson(json);
  }

  /// Deactivating does NOT cancel their upcoming bookings — those still exist
  /// and still hold their slots. The owner has to deal with them deliberately.
  Future<void> setStaffActive(String businessId, String staffId, bool active) =>
      active
      ? _send(
          'PATCH',
          '/businesses/$businessId/staff/$staffId',
          body: {'active': true},
        )
      : _send('DELETE', '/businesses/$businessId/staff/$staffId');

  // ── Blocked time ─────────────────────────────────────────────────────────
  Future<List<ResourceItem>> resources(String businessId) async {
    return _growth(
      businessId,
      'GET',
      '/resources',
      (json) => wireList(json['resources'], ResourceItem.fromJson, 200),
    );
  }

  Future<List<CalendarBlock>> resourceBlocks(String businessId) => _growth(
    businessId,
    'GET',
    '/resource-blocks',
    (json) => wireList(
      json['blocks'],
      (row) => CalendarBlock.fromJson(row, timezone: businessTimezone),
      100,
    ),
  );

  Future<void> saveResource(
    String businessId, {
    String? resourceId,
    required String name,
    required String kind,
    String? fixedRoomId,
    bool active = true,
    int quantity = 1,
  }) => _growth(
    businessId,
    resourceId == null ? 'POST' : 'PATCH',
    '/resources${resourceId == null ? '' : '/$resourceId'}',
    (_) {},
    body: {
      'name': name,
      'kind': kind,
      'fixedRoomId': fixedRoomId,
      'active': active,
      'quantity': quantity,
    },
  );

  Future<void> setResourceActive(
    String businessId,
    String resourceId,
    bool active,
  ) => _growth(
    businessId,
    'PATCH',
    '/resources/$resourceId',
    (_) {},
    body: {'active': active},
  );

  /// A null [staffId] closes the whole business — a holiday, not one person's
  /// afternoon.
  Future<BlockResult> createBlock(
    String businessId, {
    String? staffId,
    String? resourceId,
    required DateTime startsAt,
    required DateTime endsAt,
    String? reason,
  }) async => BlockResult.fromJson(
    await _send(
      'POST',
      '/businesses/$businessId/blocked-time',
      body: {
        'staffId': staffId,
        'resourceId': ?resourceId,
        'startsAt': _businessInstant(startsAt),
        'endsAt': _businessInstant(endsAt),
        if (reason != null && reason.isNotEmpty) 'reason': reason,
      },
    ),
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
    final json = await _send(
      'GET',
      '/businesses/$businessId/clients',
      query: {
        if (q != null && q.isNotEmpty) 'q': q,
        'tag': ?tag,
        'skip': '$skip',
        'limit': '$limit',
      },
    );

    return (
      clients: (json['clients'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map((row) => ClientRow.fromJson(row, timezone: businessTimezone))
          .toList(growable: false),
      total: json['total'] as int? ?? 0,
    );
  }

  Future<ClientProfileDetail> clientProfile(
    String businessId,
    String clientId,
  ) async => ClientProfileDetail.fromJson(
    await _send('GET', '/businesses/$businessId/clients/$clientId'),
    timezone: businessTimezone,
  );

  Future<void> saveNotes(String businessId, String clientId, String notes) =>
      _send(
        'PUT',
        '/businesses/$businessId/clients/$clientId/notes',
        body: {'notes': notes},
      );

  /// Rebuild the counters from the bookings.
  ///
  /// The profile is a cache, and this is its repair. Exposed in the app rather
  /// than kept as an admin curiosity because the owner is the only person who
  /// will ever notice a number looking wrong.
  Future<void> recomputeProfile(String businessId, String clientId) =>
      _send('POST', '/businesses/$businessId/clients/$clientId/recompute');

  Future<List<AppointmentHolderItem>> appointmentHolders(
    String businessId,
    String clientId,
  ) => _growth(
    businessId,
    'GET',
    '/clients/$clientId/holders',
    (json) => wireList(json['holders'], AppointmentHolderItem.fromJson, 20),
  );
  Future<void> saveAppointmentHolder(
    String businessId,
    String clientId,
    String name, {
    String? holderId,
    bool active = true,
  }) => _growth(
    businessId,
    holderId == null ? 'POST' : 'PATCH',
    '/clients/$clientId/holders${holderId == null ? '' : '/$holderId'}',
    (_) {},
    body: {'name': name, 'active': active},
  );
  Future<void> revokeCustomerLink(String businessId, String clientId) =>
      _growth(businessId, 'POST', '/clients/$clientId/revoke-link', (_) {});

  // ── Settings ─────────────────────────────────────────────────────────────

  Future<BusinessSettings> settings(String businessId) async =>
      BusinessSettings.fromJson(await _send('GET', '/businesses/$businessId'));

  /// What still stands between this business and a real booking. See
  /// [SetupChecklist] for why it is not optional decoration.
  Future<SetupChecklist> setupChecklist(String businessId) async =>
      SetupChecklist.fromJson(
        await _send('GET', '/businesses/$businessId/setup'),
      );

  /// Only the keys passed are sent. The backend flattens `reminders` to dotted
  /// paths, so sending the toggle alone does not wipe the lead times.
  Future<BusinessSettings> updateSettings(
    String businessId, {
    bool? remindersEnabled,
    List<int>? reminderLeadMinutes,
    bool? escalate,
    int? escalateMinutesBefore,
    int? minNoticeMinutes,
    int? bookingHorizonDays,
  }) async {
    final reminders = <String, dynamic>{
      'enabled': ?remindersEnabled,
      'leadMinutes': ?reminderLeadMinutes,
      'escalate': ?escalate,
      'escalateMinutesBefore': ?escalateMinutesBefore,
    };

    return BusinessSettings.fromJson(
      await _send(
        'PATCH',
        '/businesses/$businessId',
        body: {
          'minNoticeMinutes': ?minNoticeMinutes,
          'bookingHorizonDays': ?bookingHorizonDays,
          if (reminders.isNotEmpty) 'reminders': reminders,
        },
      ),
    );
  }

  // Owner growth tools reuse this client's authentication, timeout and error handling.
  Future<T> _growth<T>(
    String businessId,
    String method,
    String suffix,
    T Function(Map<String, dynamic>) parse, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
    List<int>? bytes,
    String? contentType,
    Duration? timeout,
  }) async {
    if (!RegExp(r'^[a-zA-Z0-9_-]{1,80}$').hasMatch(businessId)) {
      throw const ApiException(ApiErrorKind.validation, 'Invalid business');
    }
    try {
      return parse(
        await _send(
          method,
          '/businesses/$businessId$suffix',
          query: query,
          body: body,
          maxResponseBytes: 1024 * 1024,
          bytes: bytes,
          contentType: contentType,
          timeout: timeout,
        ),
      );
    } on FormatException {
      throw const ApiException(
        ApiErrorKind.server,
        'Something went wrong. Try again.',
      );
    } on TypeError {
      throw const ApiException(
        ApiErrorKind.server,
        'Something went wrong. Try again.',
      );
    }
  }

  Map<String, String> _reportRange(DateTime from, DateTime to) {
    final start = DateTime.utc(from.year, from.month, from.day);
    final end = DateTime.utc(to.year, to.month, to.day);
    final days = end.difference(start).inDays;
    if (days < 0 || days > 366) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Choose a range of up to one year',
      );
    }
    return {'from': isoDate(from), 'to': isoDate(to)};
  }

  Future<List<AvailableSlot>> availability(
    String businessId, {
    required String serviceId,
    required String date,
    required String staffId,
    String? bookingId,
    List<Map<String, String>> additionalServices = const [],
  }) {
    if (additionalServices.length > 4 ||
        additionalServices.any(
          (step) => ![step['serviceId'], step['staffId']].every(
            (id) => id != null && RegExp(r'^[a-fA-F0-9]{24}$').hasMatch(id),
          ),
        )) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Choose valid treatments and staff',
      );
    }
    if (![
          serviceId,
          staffId,
        ].every((id) => RegExp(r'^[a-zA-Z0-9_-]{1,80}$').hasMatch(id)) ||
        !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(date) ||
        DateTime.tryParse(date) == null ||
        isoDate(DateTime.parse(date)) != date) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Invalid availability request',
      );
    }
    return _growth(
      businessId,
      additionalServices.isEmpty ? 'GET' : 'POST',
      additionalServices.isEmpty ? '/availability' : '/sequences/availability',
      (json) {
        final slots = wireList(json['slots'], AvailableSlot.fromJson, 300);
        if (additionalServices.isNotEmpty &&
            slots.any(
              (slot) =>
                  slot.appointments.length != additionalServices.length + 1 ||
                  slot.appointments.first.serviceId != serviceId ||
                  slot.appointments.first.staffId != staffId ||
                  slot.appointments.first.startsAt != slot.startsAt,
            )) {
          throw const FormatException('Invalid consecutive visit');
        }
        if (slots.any(
          (slot) =>
              slot.staffId != staffId ||
              isoDate(
                    businessTime(slot.startsAt, timezone: businessTimezone),
                  ) !=
                  date,
        )) {
          throw const FormatException('Invalid availability response');
        }
        return slots;
      },
      query: additionalServices.isEmpty
          ? {
              'serviceId': serviceId,
              'date': date,
              'staffId': staffId,
              'bookingId': ?bookingId,
            }
          : null,
      body: additionalServices.isEmpty
          ? null
          : {
              'date': date,
              'steps': [
                {'serviceId': serviceId, 'staffId': staffId},
                ...additionalServices,
              ],
            },
    );
  }

  Future<AppointmentPage> appointments(
    String businessId, {
    String? q,
    String? status,
    String? staffId,
    String? serviceId,
    String? from,
    String? to,
    int skip = 0,
  }) {
    if (skip < 0 ||
        skip > 100000 ||
        (q?.length ?? 0) > 120 ||
        (status != null && !appointmentStatuses.contains(status)) ||
        [staffId, serviceId].whereType<String>().any(
          (id) => !RegExp(r'^[a-zA-Z0-9_-]{1,80}$').hasMatch(id),
        ) ||
        [from, to].whereType<String>().any(
          (date) =>
              !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(date) ||
              DateTime.tryParse(date) == null ||
              isoDate(DateTime.parse(date)) != date,
        ) ||
        (from != null && to != null && from.compareTo(to) > 0)) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Check appointment filters',
      );
    }
    return _growth(
      businessId,
      'GET',
      '/bookings',
      (json) => AppointmentPage.fromJson(json, businessTimezone),
      query: {
        'limit': '20',
        'skip': '$skip',
        'sort': 'desc',
        if (q != null && q.trim().isNotEmpty) 'q': q.trim(),
        'status': ?status,
        'staffId': ?staffId,
        'serviceId': ?serviceId,
        'from': ?from,
        'to': ?to,
      },
    );
  }

  /* ─────────────────────────── image uploads ─────────────────────────── */

  /// Uploads image [bytes] to [target]. The backend re-encodes, resizes and
  /// strips metadata; this only refuses what it would refuse anyway.
  Future<UploadedImage> uploadImage(
    String businessId,
    ImageTarget target,
    List<int> bytes, {
    required String contentType,
    String? caption,
    bool staffConsent = false,
  }) async {
    if (!acceptedImageTypes.contains(contentType)) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Choose a JPEG, PNG or WebP image.',
      );
    }
    if (bytes.isEmpty || bytes.length > maxImageBytes) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Images must be under 8 MB.',
      );
    }
    final trimmed = caption?.trim();
    if (target.uploadMethod == 'POST' &&
        (trimmed == null || trimmed.isEmpty || trimmed.length > 200)) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Describe the photo in 1–200 characters.',
      );
    }
    return _growth(
      businessId,
      target.uploadMethod,
      target.path,
      UploadedImage.fromJson,
      query: {
        if (target.uploadMethod == 'POST') 'alt': trimmed!,
        if (target.isStaff && staffConsent) 'consent': 'true',
      },
      bytes: bytes,
      contentType: contentType,
      timeout: const Duration(seconds: 120),
    );
  }

  /// Removes the image at [target] (or one portfolio photo).
  Future<void> deleteImage(String businessId, ImageTarget target) =>
      _growth(businessId, 'DELETE', target.path, (_) {});

  Future<void> captionGalleryPhoto(
    String businessId,
    String imageId,
    String caption,
  ) {
    final alt = caption.trim();
    if (alt.isEmpty || alt.length > 200) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Describe the photo in 1–200 characters.',
      );
    }
    return _growth(
      businessId,
      'PATCH',
      ImageTarget.galleryItem(imageId).path,
      (_) {},
      body: {'alt': alt},
    );
  }

  Future<void> reorderGallery(String businessId, List<String> imageIds) {
    if (imageIds.length > galleryMax) {
      throw const ApiException(ApiErrorKind.validation, 'Too many photos');
    }
    for (final id in imageIds) {
      ImageTarget.galleryItem(id); // validates the id shape
    }
    return _growth(
      businessId,
      'PUT',
      '/images/gallery/order',
      (_) {},
      body: {'imageIds': imageIds},
    );
  }

  Future<BusinessProfile> businessProfile(String businessId) =>
      _growth(businessId, 'GET', '', BusinessProfile.fromJson);

  Future<BusinessProfile> saveBusinessProfile(
    String businessId, {
    required String name,
    required String city,
    required String timezone,
    required int slotIncrementMinutes,
    required Map<String, String> profile,
  }) {
    const bounds = {
      'tagline': 120,
      'about': 2000,
      'neighbourhood': 80,
      'addressLine': 200,
      'logoUrl': 2000,
      'coverUrl': 2000,
      'themeColor': 7,
    };
    if (name.trim().isEmpty ||
        name.length > 120 ||
        city.trim().isEmpty ||
        city.length > 80 ||
        timezone.isEmpty ||
        timezone.length > 80 ||
        ![5, 10, 15, 30].contains(slotIncrementMinutes) ||
        profile.entries.any(
          (e) => !bounds.containsKey(e.key) || e.value.length > bounds[e.key]!,
        )) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Check business details',
      );
    }
    for (final key in ['logoUrl', 'coverUrl']) {
      final value = profile[key] ?? '';
      final uri = Uri.tryParse(value);
      if (value.isNotEmpty &&
          (uri == null ||
              uri.scheme != 'https' ||
              uri.host.isEmpty ||
              uri.userInfo.isNotEmpty)) {
        throw const ApiException(
          ApiErrorKind.validation,
          'Image links must use HTTPS',
        );
      }
    }
    final colour = profile['themeColor'] ?? '';
    if (colour.isNotEmpty && !RegExp(r'^#[a-fA-F0-9]{6}$').hasMatch(colour)) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Use a colour such as #1a2b3c',
      );
    }
    return _growth(
      businessId,
      'PATCH',
      '',
      BusinessProfile.fromJson,
      body: {
        'name': name.trim(),
        'city': city.trim(),
        'timezone': timezone,
        'slotIncrementMinutes': slotIncrementMinutes,
        'profile': profile,
      },
    );
  }

  Future<BusinessProfile> setPublished(String businessId, bool published) =>
      _growth(
        businessId,
        'PATCH',
        '',
        BusinessProfile.fromJson,
        body: {'published': published},
      );

  Future<BriefingFeed> briefings(String businessId) => _growth(
    businessId,
    'GET',
    '/agent/briefings',
    BriefingFeed.fromJson,
    query: {'limit': '20'},
  );

  Future<void> markBriefingRead(String businessId, String briefingId) {
    if (!RegExp(r'^[a-fA-F0-9]{24}$').hasMatch(briefingId)) {
      throw const ApiException(ApiErrorKind.validation, 'Invalid briefing');
    }
    return _growth(businessId, 'POST', '/agent/briefings/$briefingId/read', (
      json,
    ) {
      if (json['readAt'] != null) wireDate(json['readAt']);
    });
  }

  Future<AgentSettings> updateAgentSettings(
    String businessId, {
    bool? enabled,
    int? hour,
  }) {
    if ((enabled == null && hour == null) ||
        (hour != null && (hour < 5 || hour > 11))) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Choose a briefing time between 5 AM and 11 AM',
      );
    }
    return _growth(
      businessId,
      'PATCH',
      '/agent/settings',
      AgentSettings.fromJson,
      body: {'enabled': ?enabled, 'hour': ?hour},
    );
  }

  Future<AnalyticsReport> analytics(
    String businessId,
    DateTime from,
    DateTime to, {
    String granularity = 'day',
  }) {
    if (!['day', 'week', 'month'].contains(granularity)) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Invalid report period',
      );
    }
    return _growth(
      businessId,
      'GET',
      '/analytics',
      AnalyticsReport.fromJson,
      query: {..._reportRange(from, to), 'granularity': granularity},
    );
  }

  Map<String, String> _auditQuery(
    DateTime from,
    DateTime to,
    String category,
    String search,
  ) => {
    ..._reportRange(from, to),
    if (category.isNotEmpty) 'category': category,
    if (search.trim().isNotEmpty) 'search': search.trim(),
  };

  /// Everything that happened over a period, with a summary.
  Future<AuditReport> auditReport(
    String businessId,
    DateTime from,
    DateTime to, {
    String category = '',
    String search = '',
  }) async {
    if (!RegExp(r'^[a-fA-F0-9]{24}$').hasMatch(businessId)) {
      throw const ApiException(ApiErrorKind.validation, 'Invalid business');
    }
    return AuditReport.fromJson(
      await _send(
        'GET',
        '/businesses/$businessId/audit',
        query: _auditQuery(from, to, category, search),
        maxResponseBytes: 8 * 1024 * 1024,
        timeout: const Duration(seconds: 30),
      ),
    );
  }

  /// The same report as PDF bytes, built by the server.
  Future<List<int>> auditPdf(
    String businessId,
    DateTime from,
    DateTime to, {
    String category = '',
    String search = '',
  }) async {
    if (!RegExp(r'^[a-fA-F0-9]{24}$').hasMatch(businessId)) {
      throw const ApiException(ApiErrorKind.validation, 'Invalid business');
    }
    final uri = Uri.parse('$baseUrl/businesses/$businessId/audit/report.pdf')
        .replace(queryParameters: _auditQuery(from, to, category, search));
    http.Response response;
    try {
      response = await _client
          .get(
            uri,
            headers: {if (token != null) 'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 60));
    } on Object {
      throw const ApiException(ApiErrorKind.network, 'No internet connection');
    }
    if (response.statusCode == 401) onUnauthorized?.call();
    if (response.statusCode != 200) {
      throw const ApiException(
        ApiErrorKind.server,
        'Could not create the PDF. Try again.',
      );
    }
    return response.bodyBytes;
  }

  Future<ReviewSummary> reviewSummary(String businessId) =>
      _growth(businessId, 'GET', '/reviews/summary', ReviewSummary.fromJson);

  Future<ReviewPage> reviews(
    String businessId, {
    String filter = 'all',
    int skip = 0,
  }) {
    if (!['all', 'published', 'flagged'].contains(filter) ||
        skip < 0 ||
        skip > 10000) {
      throw const ApiException(ApiErrorKind.validation, 'Invalid review page');
    }
    return _growth(
      businessId,
      'GET',
      '/reviews',
      ReviewPage.fromJson,
      query: {'filter': filter, 'skip': '$skip', 'limit': '20'},
    );
  }

  Future<NudgeReport> nudges(String businessId) => _growth(
    businessId,
    'GET',
    '/retention/nudges',
    NudgeReport.fromJson,
    query: {'days': '30'},
  );

  Future<bool> setNudges(String businessId, bool enabled) => _growth(
    businessId,
    'PATCH',
    '/retention/nudges',
    (json) => wireBool(json['nudges']),
    body: {'nudges': enabled},
  );

  String _audience(CampaignAudience audience) =>
      audience == CampaignAudience.atRisk ? 'at_risk' : 'lapsed';

  Future<AudiencePreview> campaignAudience(
    String businessId,
    CampaignAudience audience,
  ) => _growth(
    businessId,
    'GET',
    '/retention/audience',
    AudiencePreview.fromJson,
    query: {'audience': _audience(audience)},
  );

  Future<List<CampaignSummary>> campaigns(String businessId) => _growth(
    businessId,
    'GET',
    '/retention/campaigns',
    (json) => wireList(json['campaigns'], CampaignSummary.fromJson, 20),
  );

  Future<void> createCampaign(
    String businessId,
    CampaignAudience audience,
    String message,
  ) {
    final text = message.trim();
    if (text.length < 10 || text.length > 600) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Use a message of 10–600 characters',
      );
    }
    return _growth(
      businessId,
      'POST',
      '/retention/campaigns',
      (_) {},
      body: {'audience': _audience(audience), 'message': text},
    );
  }

  Future<void> cancelCampaign(String businessId, String id) {
    if (!RegExp(r'^[a-zA-Z0-9_-]{1,80}$').hasMatch(id)) {
      throw const ApiException(ApiErrorKind.validation, 'Invalid campaign');
    }
    return _growth(
      businessId,
      'POST',
      '/retention/campaigns/$id/cancel',
      (_) {},
    );
  }

  Future<FunnelReport> funnel(String businessId, DateTime from, DateTime to) =>
      _growth(
        businessId,
        'GET',
        '/grow/funnel',
        FunnelReport.fromJson,
        query: _reportRange(from, to),
      );

  Future<BoostState> boost(String businessId) =>
      _growth(businessId, 'GET', '/grow/boost', BoostState.fromJson);

  Future<BoostState> setBoost(String businessId, bool enabled) => _growth(
    businessId,
    enabled ? 'POST' : 'DELETE',
    '/grow/boost',
    BoostState.fromJson,
  );

  Future<GrowthBusiness> growthBusiness(String businessId) =>
      _growth(businessId, 'GET', '', GrowthBusiness.fromJson);

  Future<String?> bookingInvite(String businessId) async {
    try {
      return await _growth(businessId, 'GET', '/invite', (json) {
        final link = wireText(json['link'], max: 1000);
        final uri = Uri.tryParse(link);
        if (uri == null ||
            uri.scheme != 'https' ||
            uri.host != 'wa.me' ||
            !RegExp(r'^/[0-9]{7,15}$').hasMatch(uri.path) ||
            uri.userInfo.isNotEmpty ||
            uri.hasPort) {
          throw const FormatException('Invalid booking link');
        }
        return link;
      });
    } on ApiException catch (err) {
      if (err.kind == ApiErrorKind.conflict) return null;
      rethrow;
    }
  }

  Future<ClientImportResult> importClients(
    String businessId,
    List<Map<String, String>> rows, {
    required bool dryRun,
  }) {
    const fields = {
      'phone',
      'name',
      'visits',
      'spend',
      'firstVisit',
      'lastVisit',
    };
    if (rows.isEmpty ||
        rows.length > 2000 ||
        rows.any(
          (row) =>
              !row.containsKey('phone') ||
              row.keys.any((key) => !fields.contains(key)) ||
              row.values.any((value) => value.length > 2000),
        ) ||
        utf8.encode(jsonEncode(rows)).length > 1024 * 1024) {
      throw const ApiException(
        ApiErrorKind.validation,
        'Choose a CSV with up to 2,000 customers and 1 MB of data',
      );
    }
    return _growth(
      businessId,
      'POST',
      '/clients/import',
      ClientImportResult.fromJson,
      query: {'dryRun': '$dryRun'},
      body: {'rows': rows},
    );
  }

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    Map<String, String>? query,
    int? maxResponseBytes,

    /// A raw body (an image upload) instead of JSON.
    List<int>? bytes,
    String? contentType,
    Duration? timeout,
  }) async {
    // Built through Uri rather than string concatenation: a customer search for
    // "R&B" or a name with a space would otherwise truncate the query silently.
    final uri = Uri.parse(
      '$baseUrl$path',
    ).replace(queryParameters: (query == null || query.isEmpty) ? null : query);

    final sentToken = token;

    final request = http.Request(method, uri)
      ..headers['Accept'] = 'application/json';

    if (token != null) request.headers['Authorization'] = 'Bearer $token';
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    } else if (bytes != null) {
      request.headers['Content-Type'] =
          contentType ?? 'application/octet-stream';
      request.bodyBytes = bytes;
    }

    http.Response response;
    StreamIterator<List<int>>? responseChunks;
    var timedOut = false;
    try {
      response =
          await (() async {
            final streamed = await _client.send(request);
            if (timedOut) {
              // Headers can arrive after timeout; release that late body too.
              await streamed.stream.listen(null).cancel();
              throw TimeoutException('Request timed out');
            }
            if (maxResponseBytes == null) {
              return http.Response.fromStream(streamed);
            }
            final chunks = StreamIterator(streamed.stream);
            responseChunks = chunks;
            final bytes = <int>[];
            while (await chunks.moveNext()) {
              final chunk = chunks.current;
              if (bytes.length + chunk.length > maxResponseBytes) {
                throw const ApiException(
                  ApiErrorKind.server,
                  'Something went wrong. Try again.',
                );
              }
              bytes.addAll(chunk);
            }
            return http.Response.bytes(
              bytes,
              streamed.statusCode,
              headers: streamed.headers,
            );
          })().timeout(
            timeout ?? _timeout,
            onTimeout: () {
              timedOut = true;
              throw TimeoutException('Request timed out');
            },
          );
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
      if (response.statusCode >= 400) {
        throw _errorFor(response.statusCode, const {});
      }
      return const {};
    }

    Map<String, dynamic> json;
    try {
      json = jsonDecode(response.body) as Map<String, dynamic>;
    } on Object {
      throw const ApiException(
        ApiErrorKind.server,
        'Something went wrong. Try again.',
      );
    }

    if (response.statusCode >= 400) {
      final rawFields = json['fields'];
      final serverMessage = json['error'];
      if ((rawFields != null && rawFields is! Map<String, dynamic>) ||
          (serverMessage != null && serverMessage is! String)) {
        throw const ApiException(
          ApiErrorKind.server,
          'Something went wrong. Try again.',
        );
      }
      final fields = (rawFields as Map<String, dynamic>? ?? const {}).map(
        (k, v) => MapEntry(k, v.toString()),
      );
      throw _errorFor(response.statusCode, fields, serverMessage as String?);
    }

    return json;
  }

  ApiException _errorFor(
    int status,
    Map<String, String> fields, [
    String? serverMessage,
  ]) {
    return switch (status) {
      401 => const ApiException(
        ApiErrorKind.unauthorized,
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
      // Image uploads: fixed, person-readable messages from the backend.
      413 || 415 => ApiException(
        ApiErrorKind.validation,
        serverMessage ?? 'That file cannot be uploaded',
      ),
      429 || 503 => ApiException(
        ApiErrorKind.server,
        serverMessage ?? 'Something went wrong. Try again.',
      ),
      _ => const ApiException(
        ApiErrorKind.server,
        'Something went wrong. Try again.',
      ),
    };
  }
}
