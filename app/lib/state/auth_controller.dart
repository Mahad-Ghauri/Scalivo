import 'dart:async';

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
        _storage = storage ?? const FlutterSecureStorage() {
    _api.onUnauthorized = () => unawaited(_expireSession());
  }

  static const _tokenKey = 'scalivo.jwt';

  final ApiClient _api;
  final PushService _push;
  final FlutterSecureStorage _storage;

  int _sessionVersion = 0;
  String? _deviceToken;
  StreamSubscription<String>? _tokenChanges;

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
    final version = ++_sessionVersion;
    error = null;
    status = AuthStatus.unknown;
    notifyListeners();
    try {
      final stored = await _storage.read(key: _tokenKey);
      if (stored == null) {
        _setSignedOut();
        return;
      }

      _api.token = stored;
      final loaded = await _api.me();
      if (version != _sessionVersion) return;
      if (loaded.role == 'staff') {
        await _expireSession();
        return;
      }
      me = loaded;
      _api.businessTimezone = loaded.business?.timezone ?? 'Asia/Karachi';
      status = AuthStatus.signedIn;
      notifyListeners();
      await _registerDevice();
    } on ApiException catch (err) {
      if (version != _sessionVersion) return;
      // Only an outright rejection signs them out. A flaky connection must not
      // dump an owner back to the login screen every time the wifi drops.
      if (err.kind == ApiErrorKind.unauthorized) {
        await _clearToken();
        _setSignedOut();
      } else {
        status = AuthStatus.unknown;
        error = err;
        notifyListeners();
      }
    } catch (_) {
      if (version != _sessionVersion) return;
      status = AuthStatus.unknown;
      error = const ApiException(
        ApiErrorKind.server,
        'Could not restore your session. Try again.',
      );
      notifyListeners();
    }
  }

  Future<void> _expireSession() async {
    ++_sessionVersion;
    _api.token = null;
    me = null;
    _setSignedOut();
    try {
      await _storage.delete(key: _tokenKey);
    } catch (_) {
      // The in-memory session is already revoked.
    }
  }

  @override
  void dispose() {
    unawaited(_tokenChanges?.cancel());
    _api.onUnauthorized = null;
    ++_sessionVersion;
    super.dispose();
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
    ++_sessionVersion;
    await _tokenChanges?.cancel();
    _tokenChanges = null;
    final deviceToken = _deviceToken;
    if (deviceToken != null) {
      try {
        await _api.unregisterDevice(deviceToken);
      } on ApiException {
        // Revoking at Firebase below also prevents further delivery.
      }
    }
    _deviceToken = null;
    await _push.deleteToken();
    await _expireSession();
  }

  /// Re-reads the session status behind the banner. Cheap, and safe to call on
  /// resume or after a link attempt.
  Future<void> refreshSession() async {
    final version = _sessionVersion;
    final current = business;
    if (current == null) return;

    try {
      final updated = await _api.whatsappState(current.id, current);
      if (version != _sessionVersion) return;
      me = Me(
        role: me?.role ?? 'owner',
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
    final version = ++_sessionVersion;
    busy = true;
    error = null;
    notifyListeners();

    try {
      final result = await call();
      if (version != _sessionVersion) return false;
      if (result.role == 'staff') {
        throw const ApiException(
          ApiErrorKind.unauthorized,
          'This app is for business owners. Contact your owner for access.',
        );
      }
      if (persist) {
        await _storage.write(key: _tokenKey, value: result.token);
      }
      if (!persist) await _storage.delete(key: _tokenKey);
      if (version != _sessionVersion) return false;
      _api.token = result.token;
      final loaded = await _api.me();
      if (version != _sessionVersion) return false;
      me = loaded;
      _api.businessTimezone = loaded.business?.timezone ?? 'Asia/Karachi';
      status = AuthStatus.signedIn;
      busy = false;
      notifyListeners();
      await _registerDevice();
      return true;
    } on ApiException catch (err) {
      if (version != _sessionVersion) return false;
      error = err;
      busy = false;
      notifyListeners();
      return false;
    } catch (_) {
      if (version != _sessionVersion) return false;
      error = const ApiException(
        ApiErrorKind.server,
        'Could not save your session. Try again.',
      );
      busy = false;
      notifyListeners();
      return false;
    }
  }

  /// Best effort, always. Push is how the owner learns WhatsApp died, but
  /// failing to register a token must never block someone from signing in.
  Future<void> _registerDevice() async {
    final version = _sessionVersion;
    final token = await _push.token();
    if (version != _sessionVersion || token == null) return;
    await _saveDeviceToken(token);
    if (version != _sessionVersion) return;
    await _tokenChanges?.cancel();
    _tokenChanges = await _push.watchToken((token) {
      if (status == AuthStatus.signedIn) unawaited(_saveDeviceToken(token));
    });
  }

  Future<void> _saveDeviceToken(String token) async {
    final version = _sessionVersion;
    final previous = _deviceToken;
    try {
      if (previous != null && previous != token) {
        await _api.unregisterDevice(previous);
      }
      if (version != _sessionVersion) return;
      await _api.registerDevice(token);
      if (version == _sessionVersion) _deviceToken = token;
    } on ApiException {
      // Retried on sign-in or the next token rotation.
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
