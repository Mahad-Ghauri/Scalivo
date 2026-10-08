import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:scalivo_owner/format.dart';
import 'package:scalivo_owner/push/push_service.dart';
import 'package:scalivo_owner/state/auth_controller.dart';
import 'package:scalivo_owner/state/calendar_controller.dart';
import 'package:scalivo_owner/state/clients_controller.dart';
import 'package:scalivo_owner/theme.dart';

class NoPush extends PushService {
  @override
  Future<String?> token() async => null;
  @override
  Future<void> deleteToken() async {}
}

class PendingApi extends ApiClient {
  final calendarRequests = <Completer<CalendarView>>[];
  final clientRequests = <Completer<({List<ClientRow> clients, int total})>>[];
  final offsets = <int>[];
  @override
  Future<CalendarView> calendar(
    String businessId, {
    required String from,
    required String to,
    String? staffId,
    bool includeCancelled = false,
  }) {
    final pending = Completer<CalendarView>();
    calendarRequests.add(pending);
    return pending.future;
  }

  @override
  Future<({List<ClientRow> clients, int total})> clients(
    String businessId, {
    String? q,
    String? tag,
    int skip = 0,
    int limit = 50,
  }) {
    offsets.add(skip);
    final pending = Completer<({List<ClientRow> clients, int total})>();
    clientRequests.add(pending);
    return pending.future;
  }
}

CalendarView view(String date) => CalendarView(
  timezone: 'Asia/Karachi',
  staff: const [],
  days: [CalendarDay(date: date, entries: const [], blocks: const [])],
);
ClientRow row(int id) =>
    ClientRow.fromJson({'id': '$id', 'clientId': '$id', 'tags': <String>[]});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  test(
    'newer calendar day wins even when the older request finishes last',
    () async {
      final api = PendingApi();
      final controller = CalendarController(api: api, businessId: 'business');
      final first = controller.goTo(DateTime(2026, 10, 9));
      final second = controller.goTo(DateTime(2026, 10, 10));
      api.calendarRequests[1].complete(view('2026-10-10'));
      await second;
      api.calendarRequests[0].complete(view('2026-10-09'));
      await first;
      expect(controller.view!.days.single.date, '2026-10-10');
      controller.dispose();
    },
  );

  test(
    'older client filter cannot replace newer results or error state',
    () async {
      final api = PendingApi();
      final controller = ClientsController(api: api, businessId: 'business');
      final first = controller.load();
      final second = controller.filterByTag('vip');
      api.clientRequests[1].complete((clients: [row(2)], total: 1));
      await second;
      api.clientRequests[0].completeError(
        const ApiException(ApiErrorKind.network, 'old failure'),
      );
      await first;
      expect(controller.clients.single.clientId, '2');
      expect(controller.error, isNull);
      controller.dispose();
    },
  );

  test('loads the next client page without losing the first page', () async {
    final api = PendingApi();
    final controller = ClientsController(api: api, businessId: 'business');
    final initial = controller.load();
    api.clientRequests[0].complete((
      clients: List.generate(50, row),
      total: 55,
    ));
    await initial;
    final next = controller.loadMore();
    api.clientRequests[1].complete((
      clients: List.generate(5, (i) => row(50 + i)),
      total: 55,
    ));
    await next;
    expect(api.offsets, [0, 50]);
    expect(controller.clients.length, 55);
    expect(controller.hasMore, isFalse);
    controller.dispose();
  });

  test('disposal ignores an outstanding calendar response', () async {
    final api = PendingApi();
    final controller = CalendarController(api: api, businessId: 'business');
    final request = controller.load();
    controller.dispose();
    api.calendarRequests.single.complete(view('2026-10-09'));
    await request;
    expect(controller.view, isNull);
  });

  test('offline restore stays on a recoverable bootstrap state', () async {
    FlutterSecureStorage.setMockInitialValues({'scalivo.jwt': 'stored-token'});
    final api = ApiClient(
      client: MockClient((_) async => throw http.ClientException('offline')),
    );
    final auth = AuthController(api: api, push: NoPush());
    await auth.restore();
    expect(auth.status, AuthStatus.unknown);
    expect(auth.error!.kind, ApiErrorKind.network);
    expect(auth.me, isNull);
    auth.dispose();
  });

  test(
    'a protected 401 clears both persistent and in-memory authentication',
    () async {
      FlutterSecureStorage.setMockInitialValues({
        'scalivo.jwt': 'expired-token',
      });
      final api = ApiClient(
        client: MockClient(
          (_) async => http.Response('{"error":"private details"}', 401),
        ),
      )..token = 'expired-token';
      final auth = AuthController(api: api, push: NoPush())
        ..status = AuthStatus.signedIn;
      await expectLater(api.me(), throwsA(isA<ApiException>()));
      await Future<void>.delayed(Duration.zero);
      expect(auth.status, AuthStatus.signedOut);
      expect(api.token, isNull);
      expect(
        await const FlutterSecureStorage().read(key: 'scalivo.jwt'),
        isNull,
      );
      auth.dispose();
    },
  );

  test('an old protected response cannot expire a newer token', () async {
    final pending = Completer<http.Response>();
    final api = ApiClient(client: MockClient((_) => pending.future))
      ..token = 'old';
    var expired = false;
    api.onUnauthorized = () => expired = true;
    final request = api.me();
    await Future<void>.delayed(Duration.zero);
    api.token = 'new';
    pending.complete(http.Response('{}', 401));
    await expectLater(request, throwsA(isA<ApiException>()));
    expect(expired, isFalse);
  });

  test(
    'business calendar reads and writes preserve the instant across zones',
    () async {
      final calendar = CalendarView.fromJson({
        'timezone': 'America/New_York',
        'staff': <Object>[],
        'days': [
          {
            'date': '2026-07-01',
            'entries': [
              {
                'id': 'booking',
                'staffId': 'staff',
                'clientId': 'client',
                'serviceId': 'service',
                'startsAt': '2026-07-01T13:00:00Z',
                'endsAt': '2026-07-01T13:30:00Z',
              },
            ],
          },
        ],
      });
      final startsAt = calendar.days.single.entries.single.startsAt;
      expect(hhmm(startsAt), '9:00 AM');
      expect(startsAt.toUtc(), DateTime.utc(2026, 7, 1, 13));
      final api = ApiClient(
        client: MockClient((request) async {
          expect(
            jsonDecode(request.body)['startsAt'],
            '2026-07-01T13:00:00.000Z',
          );
          return http.Response('{}', 201);
        }),
      )..businessTimezone = 'America/New_York';
      await api.walkIn(
        'business',
        serviceId: 'service',
        staffId: 'staff',
        startsAt: DateTime(2026, 7, 1, 9),
        name: 'Test',
      );
      expect(
        businessDate(
          DateTime(2026, 1, 1, 9),
          timezone: 'America/New_York',
        ).toUtc().hour,
        14,
      );
    },
  );

  test('primary actions and normal field text meet WCAG text contrast', () {
    double contrast(Color a, Color b) {
      final x = a.computeLuminance();
      final y = b.computeLuminance();
      return (x > y ? x + .05 : y + .05) / (x > y ? y + .05 : x + .05);
    }

    for (final color in [Sc.teal, Sc.slate, Sc.slateLight, Sc.slateFaint]) {
      expect(contrast(color, Colors.white), greaterThanOrEqualTo(4.5));
    }
  });
}
