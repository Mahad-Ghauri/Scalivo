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
/// host loopback from inside it. Override for a real device on the same wifi:
/// `flutter run --dart-define=SCALIVO_API=http://192.168.1.20:3000`
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

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final request = http.Request(method, Uri.parse('$baseUrl$path'))
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
