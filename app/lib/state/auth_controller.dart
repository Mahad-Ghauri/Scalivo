import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../push/push_service.dart';

enum AuthStatus { unknown, signedIn, signedOut }

/// Session state for the whole app: who is signed in, and what their WhatsApp
/// is doing.
///
/// Both live here rather than in two controllers because the banner is on every
/// screen — splitting them would mean every screen listening to two things and
/// getting the combination wrong somewhere.
class AuthController extends ChangeNotifier {
  AuthController({ApiClient? api, PushService? push, FlutterSecureStorage? storage})
      : _api = api ?? ApiClient(),
        _push = push ?? PushService(),
        _storage = storage ?? const FlutterSecureStorage();

  static const _tokenKey = 'scalivo.jwt';

  final ApiClient _api;
  final PushService _push;
  final FlutterSecureStorage _storage;

  AuthStatus status = AuthStatus.unknown;
  Me? me;
  bool busy = false;
  ApiException? error;

  ApiClient get api => _api;
  BusinessSummary? get business => me?.business;
  SessionHealth get health => business?.health ?? SessionHealth.notConnected;

  /// Called once from the splash screen.
  ///
  /// A stored token is not proof of a live session — it can be expired or
  /// signed with a rotated secret — so this always confirms with the server
  /// before letting anyone past. A 401 here is normal, not an error to show.
  Future<void> restore() async {
    final stored = await _storage.read(key: _tokenKey);
    if (stored == null) {
      _setSignedOut();
      return;
    }

    _api.token = stored;
    try {
      me = await _api.me();
      status = AuthStatus.signedIn;
      notifyListeners();
      await _registerDevice();
    } on ApiException catch (err) {
      // Only an outright rejection signs them out. A flaky connection must not
      // dump an owner back to the login screen every time the wifi drops.
      if (err.kind == ApiErrorKind.unauthorized) {
        await _clearToken();
        _setSignedOut();
      } else {
        status = AuthStatus.signedIn;
        error = err;
        notifyListeners();
      }
    }
  }

  Future<bool> login(String email, String password, {bool remember = true}) =>
      _authenticate(() => _api.login(email.trim(), password), persist: remember);

  Future<bool> register({
    required String businessName,
    required String category,
    required String city,
    required String ownerName,
    required String email,
    required String password,
  }) =>
      _authenticate(
        () => _api.register(
          businessName: businessName.trim(),
          category: category,
          city: city.trim(),
          ownerName: ownerName.trim(),
          email: email.trim(),
          password: password,
        ),
      );

  Future<void> logout() async {
    await _clearToken();
    me = null;
    _setSignedOut();
  }

  /// Re-reads the session status behind the banner. Cheap, and safe to call on
  /// resume or after a link attempt.
  Future<void> refreshSession() async {
    final current = business;
    if (current == null) return;

    try {
      final updated = await _api.whatsappState(current.id, current);
      me = Me(
        name: me?.name,
        email: me?.email ?? '',
        businesses: [updated, ...?me?.businesses.skip(1)],
      );
      notifyListeners();
    } on ApiException {
      // A failed poll is not news. The banner keeps showing the last known
      // state rather than flickering to "unknown" on one dropped request.
    }
  }

  void clearError() {
    if (error == null) return;
    error = null;
    notifyListeners();
  }

  /// [persist] is what "Remember me" actually controls. Unchecked, the token
  /// lives in memory for this launch only and never reaches the keystore — so
  /// the checkbox means something on a phone the owner shares with staff.
  Future<bool> _authenticate(Future<AuthResult> Function() call, {bool persist = true}) async {
    busy = true;
    error = null;
    notifyListeners();

    try {
      final result = await call();
      if (persist) {
        await _storage.write(key: _tokenKey, value: result.token);
      }
      _api.token = result.token;
      me = await _api.me();
      status = AuthStatus.signedIn;
      busy = false;
      notifyListeners();
      await _registerDevice();
      return true;
    } on ApiException catch (err) {
      error = err;
      busy = false;
      notifyListeners();
      return false;
    }
  }

  /// Best effort, always. Push is how the owner learns WhatsApp died, but
  /// failing to register a token must never block someone from signing in.
  Future<void> _registerDevice() async {
    final token = await _push.token();
    if (token == null) return;
    try {
      await _api.registerDevice(token);
    } on ApiException {
      // Retried on the next sign-in.
    }
  }

  Future<void> _clearToken() async {
    await _storage.delete(key: _tokenKey);
    _api.token = null;
  }

  void _setSignedOut() {
    status = AuthStatus.signedOut;
    busy = false;
    notifyListeners();
  }
}
