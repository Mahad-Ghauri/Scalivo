import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../format.dart';

/// The diary the owner is looking at.
///
/// One controller for the Today tab and the Calendar tab, because they are the
/// same question asked about different days and splitting them would mean a
/// walk-in created on one not appearing on the other.
///
/// **Every mutation reloads rather than patching the local list.** It would be
/// cheaper to flip a status in place after a successful "Complete" — and it
/// would be wrong the first time two people use the app at once, or the moment
/// a WhatsApp booking lands between the draw and the tap. The calendar is a view
/// of the server's state, and the server is the only thing that knows it.
class CalendarController extends ChangeNotifier {
  // Named `api` and `businessId` at the call site rather than taking
  // initializing formals: `this._api` would make the underscore part of the
  // parameter name, and a private name in a public constructor reads as a leak.
  // ignore_for_file: prefer_initializing_formals
  CalendarController({required ApiClient api, required String businessId})
      : _api = api,
        _businessId = businessId;

  final ApiClient _api;
  final String _businessId;

  DateTime selectedDay = startOfToday();

  /// Null means everyone. A real id narrows the day to one person's column.
  String? staffFilter;

  CalendarView? view;
  bool loading = false;
  ApiException? error;

  /// The catalogue, loaded once — the walk-in sheet needs both lists and they
  /// change about as often as the shop's signage.
  List<ServiceItem> services = const [];
  List<StaffSummary> staffList = const [];

  CalendarDay? get day => view?.dayFor(isoDate(selectedDay));

  List<CalendarEntry> get entries {
    final all = day?.entries ?? const <CalendarEntry>[];
    // Sorted here rather than trusted from the wire: the backend groups by day
    // but a screen that renders 4pm above 11am is unreadable regardless of why.
    final sorted = [...all]..sort((a, b) => a.startsAt.compareTo(b.startsAt));
    return sorted;
  }

  List<CalendarBlock> get blocks => day?.blocks ?? const [];

  /// What the owner is owed today: everything not yet completed, missed or
  /// called off. The number the Today header leads with.
  int get openCount => entries.where((e) => !e.isTerminal).length;

  Future<void> load({bool quiet = false}) async {
    if (!quiet) {
      loading = true;
      error = null;
      notifyListeners();
    }

    final date = isoDate(selectedDay);
    try {
      view = await _api.calendar(
        _businessId,
        from: date,
        to: date,
        staffId: staffFilter,
      );
      error = null;
    } on ApiException catch (err) {
      error = err;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  /// Fetched lazily and kept: the walk-in sheet is the only caller, and an owner
  /// who never adds a walk-in should never pay for these.
  ///
  /// [force] is what Settings calls after editing the catalogue. Without it a
  /// service added on one tab would be missing from the walk-in sheet on another
  /// until the app restarted — a cache that is right at first load and quietly
  /// wrong ever after is worse than no cache at all.
  Future<void> ensureCatalogue({bool force = false}) async {
    if (!force && services.isNotEmpty && staffList.isNotEmpty) return;
    try {
      final loaded = await Future.wait([
        _api.services(_businessId),
        _api.staff(_businessId),
      ]);
      services = loaded[0] as List<ServiceItem>;
      staffList = loaded[1] as List<StaffSummary>;
      notifyListeners();
    } on ApiException catch (err) {
      error = err;
      notifyListeners();
    }
  }

  Future<void> goTo(DateTime date) async {
    selectedDay = DateTime(date.year, date.month, date.day);
    await load();
  }

  Future<void> setStaffFilter(String? staffId) async {
    staffFilter = staffId;
    await load();
  }

  // ── Mutations ────────────────────────────────────────────────────────────
  //
  // Each returns null on success or the failure to show. They deliberately do
  // NOT throw: every one of these is a tap on a row in a list, and an exception
  // escaping into the widget tree there takes the whole screen down over one
  // appointment.

  Future<ApiException?> complete(CalendarEntry entry) =>
      _mutate(() => _api.setOutcome(_businessId, entry.id, 'completed'));

  Future<ApiException?> noShow(CalendarEntry entry) =>
      _mutate(() => _api.setOutcome(_businessId, entry.id, 'no_show'));

  Future<ApiException?> cancel(CalendarEntry entry) =>
      _mutate(() => _api.cancelBooking(_businessId, entry.id));

  /// Returns whether the customer was actually messaged, alongside any failure.
  ///
  /// The two are independent: the appointment moves even when the message does
  /// not go out, and an owner who is not told that will assume it was handled.
  Future<({ApiException? error, bool notified})> reschedule(
    CalendarEntry entry,
    DateTime startsAt, {
    String? staffId,
    bool override = false,
  }) async {
    try {
      final result = await _api.reschedule(
        _businessId,
        entry.id,
        startsAt: startsAt,
        staffId: staffId,
        override: override,
      );
      await load(quiet: true);
      return (error: null, notified: result.notified);
    } on ApiException catch (err) {
      return (error: err, notified: false);
    }
  }

  Future<ApiException?> walkIn({
    required String serviceId,
    required String staffId,
    required DateTime startsAt,
    String? name,
    String? phone,
    String? clientId,
  }) =>
      _mutate(() => _api.walkIn(
            _businessId,
            serviceId: serviceId,
            staffId: staffId,
            startsAt: startsAt,
            name: name,
            phone: phone,
            clientId: clientId,
          ));

  /// Declare time off-limits.
  ///
  /// Returns the count of appointments already inside the window alongside any
  /// failure, because those are two different facts and the second is not an
  /// error: the block succeeded, and the owner now has three people to move.
  /// Collapsing them into a boolean would lose the only thing they need to act on.
  Future<({ApiException? error, int affected})> blockTime({
    String? staffId,
    required DateTime startsAt,
    required DateTime endsAt,
    String? reason,
  }) async {
    try {
      final result = await _api.createBlock(
        _businessId,
        staffId: staffId,
        startsAt: startsAt,
        endsAt: endsAt,
        reason: reason,
      );
      await load(quiet: true);
      return (error: null, affected: result.affectedBookings);
    } on ApiException catch (err) {
      return (error: err, affected: 0);
    }
  }

  Future<ApiException?> removeBlock(CalendarBlock block) =>
      _mutate(() => _api.deleteBlock(_businessId, block.id));

  Future<ApiException?> _mutate(Future<void> Function() action) async {
    try {
      await action();
      await load(quiet: true);
      return null;
    } on ApiException catch (err) {
      // Reloaded even on failure: a 409 means the world moved, and leaving the
      // stale row on screen invites the owner to tap it again.
      await load(quiet: true);
      return err;
    }
  }
}
