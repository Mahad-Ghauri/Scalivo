/// Wire models. Small on purpose — the app only needs what the four Phase 1.1
/// screens render, and every field here is one the backend actually sends.
library;

import '../format.dart';

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
    this.timezone = 'Asia/Karachi',
  });

  final String id;
  final String name;
  final String category;
  final String timezone;
  final String? whatsappStatus;
  final String? whatsappIntent;

  factory BusinessSummary.fromJson(Map<String, dynamic> json) {
    final wa = json['whatsapp'] as Map<String, dynamic>? ?? const {};
    return BusinessSummary(
      id: json['id'] as String,
      name: json['name'] as String? ?? 'Your business',
      category: json['category'] as String? ?? '',
      timezone: json['timezone'] as String? ?? 'Asia/Karachi',
      whatsappStatus: wa['status'] as String?,
      whatsappIntent: wa['intent'] as String?,
    );
  }

  SessionHealth get health => sessionHealthOf(whatsappStatus, whatsappIntent);
}

class Me {
  const Me({
    required this.name,
    required this.email,
    required this.businesses,
    this.role = 'owner',
  });

  final String? name;
  final String email;
  final String role;
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
      role: user['role'] as String? ?? 'owner',
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

// ---------------------------------------------------------------------------
// The calendar, the CRM and settings — Phase 1.6 to 1.8, at the UI layer.
//
// Instants are displayed in the business zone, independently of the device.
// ---------------------------------------------------------------------------

DateTime _utc(Object? value, String timezone) =>
    businessTime(DateTime.parse(value! as String), timezone: timezone);
DateTime? _utcOrNull(Object? value, String timezone) =>
    value == null ? null : _utc(value, timezone);

/// A booking as the calendar draws it: names resolved, no id lookups needed.
class CalendarEntry {
  const CalendarEntry({
    required this.id,
    required this.staffId,
    required this.staffName,
    required this.clientId,
    required this.clientName,
    required this.clientPhone,
    required this.serviceId,
    required this.serviceName,
    required this.startsAt,
    required this.endsAt,
    required this.durationMinutes,
    required this.status,
    required this.priceMinor,
    required this.source,
    this.revision = 0,
    this.reminderState,
  });

  final String id;
  final String staffId;
  final String staffName;
  final String clientId;

  /// Null for a walk-in nobody named. Render "Walk-in", never a blank row.
  final String? clientName;
  final String? clientPhone;
  final String serviceId;
  final String serviceName;
  final DateTime startsAt;

  /// The SERVICE end, not the buffered end — the grid holds the turnaround, but
  /// drawing it would tell the owner the chair is busy while it is being tidied.
  final DateTime endsAt;
  final int durationMinutes;
  final String status;
  final int priceMinor;
  final String source;
  final int revision;

  /// The customer's side of the reminders: 'confirmed' (replied 1),
  /// 'awaiting' (reminded, silent) or 'undelivered'. Null before any reminder.
  final String? reminderState;

  bool get isTerminal =>
      status == 'completed' || status == 'no_show' || status == 'cancelled';

  bool canCompleteAt(DateTime now) =>
      status == 'confirmed' && !endsAt.isAfter(now);
  bool canNoShowAt(DateTime now) =>
      status == 'confirmed' &&
      !startsAt.add(const Duration(minutes: 10)).isAfter(now);
  bool canMarkOutcomeAt(DateTime now) => canCompleteAt(now) || canNoShowAt(now);

  factory CalendarEntry.fromJson(
    Map<String, dynamic> json, {
    String timezone = 'Asia/Karachi',
  }) => CalendarEntry(
    id: json['id'] as String,
    revision: json['revision'] as int? ?? 0,
    staffId: json['staffId'] as String,
    staffName: json['staffName'] as String? ?? 'Staff',
    clientId: json['clientId'] as String,
    clientName: json['clientName'] as String?,
    clientPhone: json['clientPhone'] as String?,
    serviceId: json['serviceId'] as String,
    serviceName: json['serviceName'] as String? ?? 'Service',
    startsAt: _utc(json['startsAt'], timezone),
    endsAt: _utc(json['endsAt'], timezone),
    durationMinutes: json['durationMinutes'] as int? ?? 0,
    status: json['status'] as String? ?? 'pending',
    priceMinor: json['priceMinor'] as int? ?? 0,
    source: json['source'] as String? ?? 'whatsapp',
    reminderState: parseReminderState(json['reminderState']),
  );
}

/// Unknown values are dropped rather than shown: a newer backend must not
/// make an older app draw a badge it cannot explain.
String? parseReminderState(Object? raw) =>
    const ['confirmed', 'awaiting', 'undelivered'].contains(raw)
    ? raw as String
    : null;

/// Time the owner declared off-limits. A null staffId closes the business.
class CalendarBlock {
  const CalendarBlock({
    required this.id,
    required this.staffId,
    required this.startsAt,
    required this.endsAt,
    required this.reason,
    this.resourceId,
  });

  final String id;
  final String? staffId;
  final String? resourceId;
  final DateTime startsAt;
  final DateTime endsAt;
  final String? reason;

  factory CalendarBlock.fromJson(
    Map<String, dynamic> json, {
    String timezone = 'Asia/Karachi',
  }) => CalendarBlock(
    id: json['id'] as String,
    staffId: json['staffId'] as String?,
    resourceId: json['resourceId'] as String?,
    startsAt: _utc(json['startsAt'], timezone),
    endsAt: _utc(json['endsAt'], timezone),
    reason: json['reason'] as String?,
  );
}

class CalendarDay {
  const CalendarDay({
    required this.date,
    required this.entries,
    required this.blocks,
  });

  /// Business-local 'YYYY-MM-DD'. The grouping the backend already did, kept
  /// rather than re-derived: splitting on the phone's midnight would move the
  /// first hours of every Karachi day onto the previous page.
  final String date;
  final List<CalendarEntry> entries;
  final List<CalendarBlock> blocks;

  factory CalendarDay.fromJson(
    Map<String, dynamic> json, {
    String timezone = 'Asia/Karachi',
  }) => CalendarDay(
    date: json['date'] as String,
    entries: (json['entries'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map((row) => CalendarEntry.fromJson(row, timezone: timezone))
        .toList(growable: false),
    blocks: (json['blocks'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map((row) => CalendarBlock.fromJson(row, timezone: timezone))
        .toList(growable: false),
  );
}

class CalendarView {
  const CalendarView({
    required this.timezone,
    required this.staff,
    required this.days,
  });

  final String timezone;

  /// Everyone the range covers, so an empty column still renders as a column.
  final List<StaffSummary> staff;
  final List<CalendarDay> days;

  factory CalendarView.fromJson(Map<String, dynamic> json) => CalendarView(
    timezone: json['timezone'] as String? ?? 'Asia/Karachi',
    staff: (json['staff'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(StaffSummary.fromJson)
        .toList(growable: false),
    days: (json['days'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(
          (row) => CalendarDay.fromJson(
            row,
            timezone: json['timezone'] as String? ?? 'Asia/Karachi',
          ),
        )
        .toList(growable: false),
  );

  CalendarDay? dayFor(String date) {
    for (final day in days) {
      if (day.date == date) return day;
    }
    return null;
  }
}

class StaffSummary {
  const StaffSummary({
    required this.id,
    required this.name,
    this.serviceIds = const [],
  });

  final String id;
  final String name;
  final List<String> serviceIds;

  factory StaffSummary.fromJson(Map<String, dynamic> json) => StaffSummary(
    id: (json['id'] ?? json['_id']) as String,
    name: json['name'] as String? ?? 'Staff',
    serviceIds: (json['serviceIds'] as List<dynamic>? ?? const [])
        .cast<String>(),
  );
}

/// A service, whole.
///
/// Not a summary: `GET /services` returns the entire row, so carrying only four
/// of its fields would mean the catalogue screen refetching what it was already
/// given. StaffSummary below is genuinely partial, and named so.
class ServiceItem {
  const ServiceItem({
    required this.id,
    required this.name,
    required this.durationMinutes,
    required this.bufferMinutes,
    required this.priceMinor,
    required this.depositRequired,
    required this.depositAmountMinor,
    required this.displayOrder,
    required this.active,
    this.resourceRequirements = const [],
    this.requiresOwnerApproval = false,
    this.approvalWindowMinutes = 30,
  });

  final String id;
  final String name;
  final int durationMinutes;

  /// Turnaround. The grid claims it so nothing can be booked into it, but the
  /// appointment is drawn at its service length — see CalendarEntry.endsAt.
  final int bufferMinutes;
  final int priceMinor;
  final bool depositRequired;
  final int? depositAmountMinor;
  final int displayOrder;

  /// Retired services stay: bookings reference them, and a hard delete would
  /// turn finished appointments into blanks in a client's visit history.
  final bool active;
  final List<List<String>> resourceRequirements;
  final bool requiresOwnerApproval;
  final int approvalWindowMinutes;

  factory ServiceItem.fromJson(Map<String, dynamic> json) => ServiceItem(
    id: (json['id'] ?? json['_id']) as String,
    name: json['name'] as String? ?? 'Service',
    durationMinutes: json['durationMinutes'] as int? ?? 30,
    bufferMinutes: json['bufferMinutes'] as int? ?? 0,
    priceMinor: json['priceMinor'] as int? ?? 0,
    depositRequired: json['depositRequired'] as bool? ?? false,
    depositAmountMinor: json['depositAmountMinor'] as int?,
    displayOrder: json['displayOrder'] as int? ?? 0,
    active: json['active'] as bool? ?? true,
    resourceRequirements:
        (json['resourceRequirements'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(
              (group) =>
                  (group['anyOfResourceIds'] as List<dynamic>? ?? const [])
                      .whereType<String>()
                      .toList(growable: false),
            )
            .toList(growable: false),
    requiresOwnerApproval: json['requiresOwnerApproval'] as bool? ?? false,
    approvalWindowMinutes: json['approvalWindowMinutes'] as int? ?? 30,
  );
}

class ResourceItem {
  const ResourceItem({
    required this.id,
    required this.name,
    required this.kind,
    required this.active,
    this.fixedRoomId,
    this.quantity = 1,
  });
  final String id;
  final String name;
  final String kind;
  final bool active;
  final String? fixedRoomId;
  final int quantity;
  String get kindLabel => switch (kind) {
    'room' => 'Whole room',
    'bed' => 'Bed',
    'chair' => 'Chair',
    _ => 'Equipment',
  };
  factory ResourceItem.fromJson(Map<String, dynamic> json) => ResourceItem(
    id: (json['id'] ?? json['_id']) as String,
    name: json['name'] as String,
    kind: json['kind'] as String,
    active: json['active'] as bool? ?? true,
    fixedRoomId: json['fixedRoomId'] as String?,
    quantity: json['quantity'] as int? ?? 1,
  );
}

class AppointmentHolderItem {
  const AppointmentHolderItem({required this.id, required this.name});
  final String id;
  final String name;
  factory AppointmentHolderItem.fromJson(Map<String, dynamic> json) =>
      AppointmentHolderItem(
        id: json['id'] as String,
        name: json['name'] as String,
      );
}

/// One row of the customer list.
class ClientRow {
  const ClientRow({
    required this.clientId,
    required this.displayName,
    required this.phone,
    required this.tags,
    required this.totalVisits,
    required this.lifetimeSpendMinor,
    required this.lastVisitAt,
  });

  final String clientId;
  final String? displayName;
  final String? phone;
  final List<String> tags;
  final int totalVisits;
  final int lifetimeSpendMinor;
  final DateTime? lastVisitAt;

  factory ClientRow.fromJson(
    Map<String, dynamic> json, {
    String timezone = 'Asia/Karachi',
  }) => ClientRow(
    clientId: json['clientId'] as String,
    displayName: json['displayName'] as String?,
    phone: json['phone'] as String?,
    tags: (json['tags'] as List<dynamic>? ?? const []).cast<String>(),
    totalVisits: json['totalVisits'] as int? ?? 0,
    lifetimeSpendMinor: json['lifetimeSpendMinor'] as int? ?? 0,
    lastVisitAt: _utcOrNull(json['lastVisitAt'], timezone),
  );
}

/// One visit on a profile's history.
class VisitRow {
  const VisitRow({
    required this.id,
    required this.startsAt,
    required this.status,
    required this.priceMinor,
    required this.serviceName,
    required this.staffName,
    required this.source,
  });

  final String id;
  final DateTime startsAt;
  final String status;
  final int priceMinor;
  final String serviceName;
  final String staffName;
  final String source;

  factory VisitRow.fromJson(
    Map<String, dynamic> json, {
    String timezone = 'Asia/Karachi',
  }) => VisitRow(
    id: json['id'] as String,
    startsAt: _utc(json['startsAt'], timezone),
    status: json['status'] as String? ?? 'pending',
    priceMinor: json['priceMinor'] as int? ?? 0,
    serviceName: json['serviceName'] as String? ?? 'Service',
    staffName: json['staffName'] as String? ?? 'Staff',
    source: json['source'] as String? ?? 'whatsapp',
  );
}

class ClientProfileDetail {
  const ClientProfileDetail({
    required this.clientId,
    required this.displayName,
    required this.phone,
    required this.tags,
    required this.totalVisits,
    required this.noShows,
    required this.cancellations,
    required this.lifetimeSpendMinor,
    required this.averageGapDays,
    required this.lastVisitAt,
    required this.nextExpectedVisitAt,
    required this.notes,
    required this.marketingOptOut,
    required this.history,
  });

  final String clientId;
  final String? displayName;
  final String? phone;
  final List<String> tags;
  final int totalVisits;
  final int noShows;
  final int cancellations;
  final int lifetimeSpendMinor;
  final num? averageGapDays;
  final DateTime? lastVisitAt;
  final DateTime? nextExpectedVisitAt;
  final String notes;
  final bool marketingOptOut;
  final List<VisitRow> history;

  factory ClientProfileDetail.fromJson(
    Map<String, dynamic> json, {
    String timezone = 'Asia/Karachi',
  }) {
    final p = json['profile'] as Map<String, dynamic>? ?? const {};
    return ClientProfileDetail(
      clientId: p['clientId'] as String? ?? '',
      displayName: p['displayName'] as String?,
      phone: p['phone'] as String?,
      tags: (p['tags'] as List<dynamic>? ?? const []).cast<String>(),
      totalVisits: p['totalVisits'] as int? ?? 0,
      noShows: p['noShows'] as int? ?? 0,
      cancellations: p['cancellations'] as int? ?? 0,
      lifetimeSpendMinor: p['lifetimeSpendMinor'] as int? ?? 0,
      averageGapDays: p['averageGapDays'] as num?,
      lastVisitAt: _utcOrNull(p['lastVisitAt'], timezone),
      nextExpectedVisitAt: _utcOrNull(p['nextExpectedVisitAt'], timezone),
      notes: p['notes'] as String? ?? '',
      marketingOptOut: p['marketingOptOut'] as bool? ?? false,
      history: (json['history'] as List<dynamic>? ?? const [])
          .whereType<Map<String, dynamic>>()
          .map((row) => VisitRow.fromJson(row, timezone: timezone))
          .toList(growable: false),
    );
  }
}

/// The settings screen's slice of the business document.
class BusinessSettings {
  const BusinessSettings({
    required this.name,
    required this.city,
    required this.timezone,
    required this.minNoticeMinutes,
    required this.bookingHorizonDays,
    required this.remindersEnabled,
    required this.reminderLeadMinutes,
    this.escalate = true,
    this.escalateMinutesBefore = 180,
  });

  final String name;
  final String? city;
  final String timezone;
  final int minNoticeMinutes;
  final int bookingHorizonDays;
  final bool remindersEnabled;

  /// Longest first, the way the backend normalises them.
  final List<int> reminderLeadMinutes;

  /// Push the owner when a reminded customer stays silent, or isn't reached.
  final bool escalate;
  final int escalateMinutesBefore;

  factory BusinessSettings.fromJson(Map<String, dynamic> json) {
    final r = json['reminders'] as Map<String, dynamic>? ?? const {};
    return BusinessSettings(
      name: json['name'] as String? ?? '',
      city: json['city'] as String?,
      timezone: json['timezone'] as String? ?? 'Asia/Karachi',
      minNoticeMinutes: json['minNoticeMinutes'] as int? ?? 60,
      bookingHorizonDays: json['bookingHorizonDays'] as int? ?? 30,
      remindersEnabled: r['enabled'] as bool? ?? true,
      reminderLeadMinutes: (r['leadMinutes'] as List<dynamic>? ?? const [1440])
          .map((v) => v as int)
          .toList(),
      escalate: r['escalate'] as bool? ?? true,
      escalateMinutesBefore: r['escalateMinutesBefore'] as int? ?? 180,
    );
  }
}

/// What a reschedule or an outcome change came back as.
///
/// `notified` is carried separately from success on purpose: the appointment
/// moved either way, and an owner whose customer could not be messaged needs to
/// know to pick up the phone rather than assume it was handled.
class RescheduleOutcome {
  const RescheduleOutcome({required this.notified});

  final bool notified;

  factory RescheduleOutcome.fromJson(Map<String, dynamic> json) =>
      RescheduleOutcome(notified: json['notified'] as bool? ?? false);
}

// ---------------------------------------------------------------------------
// The catalogue an owner configures, and the time they declare off-limits.
// ---------------------------------------------------------------------------

/// One break inside a working day. Both ends are 'HH:MM' business-local.
class TimeBreak {
  const TimeBreak({required this.startsAt, required this.endsAt});

  final String startsAt;
  final String endsAt;

  factory TimeBreak.fromJson(Map<String, dynamic> json) => TimeBreak(
    startsAt: json['startsAt'] as String? ?? '13:00',
    endsAt: json['endsAt'] as String? ?? '14:00',
  );

  Map<String, dynamic> toJson() => {'startsAt': startsAt, 'endsAt': endsAt};
}

/// One day a staff member works.
///
/// A day that is simply absent from the list is a day off — there is no
/// `closed` flag, and inventing one in the app would mean sending the backend
/// something its schema does not have.
class WorkingDay {
  const WorkingDay({
    required this.dayOfWeek,
    required this.opensAt,
    required this.closesAt,
    required this.breaks,
  });

  /// 0 = Sunday, matching luxon's `weekday % 7` in the backend's availability.
  final int dayOfWeek;
  final String opensAt;
  final String closesAt;
  final List<TimeBreak> breaks;

  WorkingDay copyWith({
    String? opensAt,
    String? closesAt,
    List<TimeBreak>? breaks,
  }) => WorkingDay(
    dayOfWeek: dayOfWeek,
    opensAt: opensAt ?? this.opensAt,
    closesAt: closesAt ?? this.closesAt,
    breaks: breaks ?? this.breaks,
  );

  factory WorkingDay.fromJson(Map<String, dynamic> json) => WorkingDay(
    dayOfWeek: json['dayOfWeek'] as int? ?? 0,
    opensAt: json['opensAt'] as String? ?? '09:00',
    closesAt: json['closesAt'] as String? ?? '18:00',
    breaks: (json['breaks'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(TimeBreak.fromJson)
        .toList(),
  );

  Map<String, dynamic> toJson() => {
    'dayOfWeek': dayOfWeek,
    'opensAt': opensAt,
    'closesAt': closesAt,
    'breaks': [for (final b in breaks) b.toJson()],
  };
}

/// A staff member, whole — unlike [StaffSummary], which is the id-and-name pair
/// the calendar returns for its columns and genuinely has nothing else on it.
class StaffMember {
  const StaffMember({
    required this.id,
    required this.name,
    required this.serviceIds,
    required this.workingHours,
    required this.active,
  });

  final String id;
  final String name;

  /// What this person can perform. Empty means nothing can be booked with them,
  /// which is a real state and a common first-run mistake.
  final List<String> serviceIds;
  final List<WorkingDay> workingHours;
  final bool active;

  factory StaffMember.fromJson(Map<String, dynamic> json) => StaffMember(
    id: (json['id'] ?? json['_id']) as String,
    name: json['name'] as String? ?? 'Staff',
    serviceIds: (json['serviceIds'] as List<dynamic>? ?? const [])
        .cast<String>(),
    workingHours: (json['workingHours'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(WorkingDay.fromJson)
        .toList(),
    active: json['active'] as bool? ?? true,
  );
}

/// What came back from declaring time off-limits.
///
/// [affectedBookings] is not an error. The backend deliberately does NOT refuse
/// a block that covers existing appointments — a block only removes future
/// offers, it cannot double-book anything, and an owner blocking Friday for a
/// funeral has not thereby cancelled the three people already in the diary.
/// They are returned so the owner can move or cancel them deliberately.
class BlockResult {
  const BlockResult({required this.id, required this.affectedBookings});

  final String id;
  final int affectedBookings;

  factory BlockResult.fromJson(Map<String, dynamic> json) => BlockResult(
    id: (json['block'] as Map<String, dynamic>?)?['id'] as String? ?? '',
    affectedBookings:
        (json['affectedBookings'] as List<dynamic>? ?? const []).length,
  );
}

// ---------------------------------------------------------------------------
// Setup readiness.
// ---------------------------------------------------------------------------

/// One thing standing between this business and its first booking.
///
/// `id` is kept as a raw string rather than parsed into an enum. The backend
/// owns this vocabulary and may add a step before the app is rebuilt; an
/// unrecognised id should show up as one more row the owner can read, not throw
/// on a screen whose whole job is to explain what is wrong.
class SetupStep {
  const SetupStep({required this.id, required this.done, required this.detail});

  final String id;
  final bool done;

  /// What the owner has to do about it, or null when there is nothing to do.
  final String? detail;

  factory SetupStep.fromJson(Map<String, dynamic> json) => SetupStep(
    id: json['id'] as String? ?? '',
    done: json['done'] as bool? ?? false,
    detail: json['detail'] as String?,
  );
}

/// Why this business cannot take a booking yet.
///
/// Worth stating plainly, because it is the reason this exists at all: every
/// gap listed here fails SILENTLY. A service nobody is assigned to still
/// appears in the WhatsApp menu, still accepts a tap, and then dead-ends on "no
/// times available" — which is byte-for-byte what a fully booked day returns.
/// The server can tell those apart. Until this list was rendered anywhere, the
/// owner could not, and the app looked like it worked.
class SetupChecklist {
  const SetupChecklist({required this.bookable, required this.steps});

  /// True only when every step is done.
  final bool bookable;

  final List<SetupStep> steps;

  /// The unfinished steps worth putting in front of the owner.
  ///
  /// WhatsApp is deliberately dropped: the session pill and the Today banner
  /// already carry it, and they read `auth.health`, which is live where this is
  /// a snapshot taken at fetch time. Two widgets disagreeing about whether the
  /// number is connected is a worse bug than the one this class fixes.
  List<SetupStep> get blocking =>
      steps.where((s) => !s.done && s.id != 'whatsapp').toList(growable: false);

  factory SetupChecklist.fromJson(Map<String, dynamic> json) => SetupChecklist(
    bookable: json['bookable'] as bool? ?? false,
    steps: (json['steps'] as List<dynamic>? ?? const [])
        .whereType<Map<String, dynamic>>()
        .map(SetupStep.fromJson)
        .toList(growable: false),
  );
}
