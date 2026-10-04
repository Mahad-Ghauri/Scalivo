import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/models.dart';

const businessId = '65a000000000000000000010';

void main() {
  test('reads the current QR with the owner token and no session restart', () async {
    final client = ApiClient(
      baseUrl: 'https://api.example.test',
      client: MockClient((request) async {
        expect(request.method, 'GET');
        expect(request.url.path, '/businesses/$businessId/whatsapp/qr');
        expect(request.headers['Authorization'], 'Bearer owner-token');
        return http.Response(jsonEncode({'qrCode': 'current-code'}), 200);
      }),
    )..token = 'owner-token';

    expect(await client.whatsappQr(businessId), 'current-code');
  });

  test('null means the gateway currently offers no code', () async {
    final client = ApiClient(
      client: MockClient((_) async => http.Response('{"qrCode":null}', 200)),
    );
    expect(await client.whatsappQr(businessId), isNull);
  });

  test('rejects invalid business IDs before sending a request', () async {
    final client = ApiClient(
      client: MockClient((_) async {
        fail('Invalid input must never reach the transport');
      }),
    );
    for (final id in ['', '../other/whatsapp', '${businessId}0']) {
      await expectLater(client.whatsappQr(id), throwsA(isA<ApiException>()));
    }
  });

  test('rejects missing, incorrectly typed, and oversized QR values', () async {
    for (final body in [
      <String, Object?>{},
      {'qrCode': 42},
      {'qrCode': 'x' * 175001},
    ]) {
      final client = ApiClient(
        client: MockClient((_) async => http.Response(jsonEncode(body), 200)),
      );
      await expectLater(client.whatsappQr(businessId), throwsA(isA<ApiException>()));
    }
  });

  test('caps the response while reading its stream', () async {
    final client = ApiClient(
      client: MockClient.streaming((request, body) async {
        return http.StreamedResponse(Stream.value(List.filled(180001, 120)), 200);
      }),
    );
    await expectLater(
      client.whatsappQr(businessId),
      throwsA(isA<ApiException>().having((e) => e.kind, 'kind', ApiErrorKind.server)),
    );
  });

  test('times out a response body that never finishes and cancels its stream', () async {
    var cancelled = false;
    final body = StreamController<List<int>>(onCancel: () => cancelled = true);
    final client = ApiClient(
      client: MockClient.streaming((request, bytes) async {
        return http.StreamedResponse(body.stream, 200);
      }),
    );
    await expectLater(
      client.whatsappQr(businessId),
      throwsA(isA<ApiException>().having((e) => e.kind, 'kind', ApiErrorKind.network)),
    );
    expect(cancelled, isTrue);
    await body.close();
  });

  test('unauthorized and server errors do not expose server details', () async {
    for (final status in [401, 500]) {
      final client = ApiClient(
        client: MockClient((_) async {
          return http.Response('{"error":"private gateway details"}', status);
        }),
      );
      await expectLater(
        client.whatsappQr(businessId),
        throwsA(
          isA<ApiException>().having((e) => e.message, 'message', isNot(contains('private'))),
        ),
      );
    }
  });

  test('status polling rejects unknown statuses and malformed intents', () async {
    const current = BusinessSummary(
      id: businessId,
      name: 'Uxelerate',
      category: 'studio',
      whatsappStatus: 'qr_ready',
      whatsappIntent: 'linking',
    );
    for (final body in [
      {'status': 'unexpected', 'intent': 'live'},
      {'status': 'ready', 'intent': 1},
      <String, Object?>{},
    ]) {
      final client = ApiClient(
        client: MockClient((_) async => http.Response(jsonEncode(body), 200)),
      );
      await expectLater(client.whatsappState(businessId, current), throwsA(isA<ApiException>()));
    }
  });

  test('malformed error fields and messages remain controlled API failures', () async {
    for (final body in [
      '{"error":42}',
      '{"fields":[]}',
      '{"fields":"private detail"}',
      '[]',
      'null',
      '{broken',
    ]) {
      final client = ApiClient(client: MockClient((_) async => http.Response(body, 500)));
      await expectLater(client.whatsappQr(businessId), throwsA(isA<ApiException>()));
    }
  });

  test('accepts the exact QR limit and rejects one more character', () async {
    for (final size in [175000, 175001]) {
      final client = ApiClient(
        client: MockClient((_) async => http.Response(jsonEncode({'qrCode': 'x' * size}), 200)),
      );
      if (size == 175000) {
        expect((await client.whatsappQr(businessId))!.length, size);
      } else {
        await expectLater(client.whatsappQr(businessId), throwsA(isA<ApiException>()));
      }
    }
  });

  test('many individually small chunks cannot bypass the response cap', () async {
    var cancelled = false;
    final body = StreamController<List<int>>(onCancel: () => cancelled = true);
    final client = ApiClient(
      client: MockClient.streaming((_, _) async {
        return http.StreamedResponse(body.stream, 200);
      }),
    );
    final result = expectLater(client.whatsappQr(businessId), throwsA(isA<ApiException>()));
    for (var i = 0; i < 181; i++) {
      body.add(List.filled(1000, 120));
    }
    await result;
    expect(cancelled, isTrue);
    await body.close();
  });

  test('cancels a response that arrives after the header timeout', () async {
    var cancelled = false;
    final body = StreamController<List<int>>(onCancel: () => cancelled = true);
    final headers = Completer<http.StreamedResponse>();
    final client = ApiClient(client: MockClient.streaming((_, _) => headers.future));
    await expectLater(client.whatsappQr(businessId), throwsA(isA<ApiException>()));
    headers.complete(http.StreamedResponse(body.stream, 200));
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(cancelled, isTrue);
    await body.close();
  });
}
