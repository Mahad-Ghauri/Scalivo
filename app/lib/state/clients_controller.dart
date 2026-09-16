import 'dart:async';

import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/models.dart';

/// The customer list.
///
/// Search is debounced rather than fired per keystroke. The backend's search
/// runs a regex over the global Client collection before it can narrow to this
/// business — that is the tenancy-safe order, and it is not free — so typing
/// "Sana" should cost one query, not four.
class ClientsController extends ChangeNotifier {
  // ignore_for_file: prefer_initializing_formals
  ClientsController({required ApiClient api, required String businessId})
      : _api = api,
        _businessId = businessId;

  static const _debounce = Duration(milliseconds: 300);

  final ApiClient _api;
  final String _businessId;

  List<ClientRow> clients = const [];
  int total = 0;
  bool loading = false;
  ApiException? error;

  String query = '';
  String? tag;

  Timer? _pending;

  @override
  void dispose() {
    _pending?.cancel();
    super.dispose();
  }

  Future<void> load() async {
    loading = true;
    error = null;
    notifyListeners();

    try {
      final page = await _api.clients(_businessId, q: query, tag: tag);
      clients = page.clients;
      total = page.total;
    } on ApiException catch (err) {
      error = err;
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  void search(String value) {
    query = value.trim();
    _pending?.cancel();
    _pending = Timer(_debounce, load);
    // Notified immediately so the clear button appears as they type, even though
    // the results are still a third of a second away.
    notifyListeners();
  }

  Future<void> filterByTag(String? value) async {
    // Tapping the active tag clears it — the filter row has no separate "all"
    // chip for tags, because the tag itself is the toggle.
    tag = tag == value ? null : value;
    await load();
  }
}
