import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/briefing_models.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:scalivo_owner/main.dart';
import 'package:scalivo_owner/push/push_service.dart';
import 'package:scalivo_owner/screens/analytics_screen.dart';
import 'package:scalivo_owner/screens/briefings_screen.dart';
import 'package:scalivo_owner/screens/campaign_screen.dart';
import 'package:scalivo_owner/state/auth_controller.dart';
import 'package:scalivo_owner/theme.dart';

const briefingId = '65a000000000000000000001';
Map<String, dynamic> briefing({bool read = false}) => {
  'id': briefingId,
  'kind': 'daily',
  'headline': 'Your morning summary',
  'body': 'One appointment today, worth Rs 1,500.',
  'scheduledFor': '2026-10-10T02:00:00Z',
  'phrasedBy': 'template',
  'readAt': read ? '2026-10-10T03:00:00Z' : null,
  'actions': <Map<String, dynamic>>[],
};
Map<String, dynamic> feed({
  bool read = false,
  bool enabled = true,
  int hour = 7,
}) => {
  'settings': {'enabled': enabled, 'hour': hour, 'whatsappTo': null},
  'briefings': [briefing(read: read)],
  'unread': read ? 0 : 1,
};
const fixtureMe = Me(
  name: 'Test Owner',
  email: 'owner@example.test',
  businesses: [
    BusinessSummary(
      id: 'business',
      name: 'Test Business',
      category: 'salon',
      whatsappStatus: 'created',
      whatsappIntent: 'stopped',
    ),
  ],
);

class BriefingApi extends ApiClient {
  bool read = false, enabled = true, fail = false, empty = false;
  int hour = 7, reads = 0, loads = 0;
  Completer<void>? receipt;
  final settingsWrites = <Map<String, Object>>[];
  @override
  Future<BriefingFeed> briefings(String businessId) async {
    loads++;
    if (fail) {
      throw const ApiException(ApiErrorKind.network, 'No internet connection');
    }
    final json = feed(read: read, enabled: enabled, hour: hour);
    if (empty) json['briefings'] = [];
    return BriefingFeed.fromJson(json);
  }

  @override
  Future<void> markBriefingRead(String businessId, String id) async {
    reads++;
    if (receipt != null) await receipt!.future;
    if (fail) {
      throw const ApiException(ApiErrorKind.network, 'No internet connection');
    }
    read = true;
  }

  @override
  Future<AgentSettings> updateAgentSettings(
    String businessId, {
    bool? enabled,
    int? hour,
  }) async {
    settingsWrites.add({'enabled': ?enabled, 'hour': ?hour});
    if (fail) {
      throw const ApiException(ApiErrorKind.network, 'No internet connection');
    }
    if (enabled != null) this.enabled = enabled;
    if (hour != null) this.hour = hour;
    return AgentSettings.fromJson({'enabled': this.enabled, 'hour': this.hour});
  }

  @override
  Future<CalendarView> calendar(
    String businessId, {
    required String from,
    required String to,
    String? staffId,
    bool includeCancelled = false,
  }) async => CalendarView(
    timezone: 'Asia/Karachi',
    staff: const [],
    days: [CalendarDay(date: from, entries: const [], blocks: const [])],
  );
  @override
  Future<List<ServiceItem>> services(String businessId) async => [];
  @override
  Future<List<StaffSummary>> staff(String businessId) async => [];
  @override
  Future<SetupChecklist> setupChecklist(String businessId) async =>
      throw const ApiException(ApiErrorKind.network, 'Unavailable');
}

class FakeAuth extends AuthController {
  FakeAuth(ApiClient api) : super(api: api);
  bool closed = false;
  @override
  void dispose() {
    if (closed) return;
    closed = true;
    super.dispose();
  }

  @override
  Future<void> restore() async {}
  @override
  Future<void> refreshSession() async {}
  void signIn() {
    me = fixtureMe;
    status = AuthStatus.signedIn;
    notifyListeners();
  }

  void signOut() {
    me = null;
    status = AuthStatus.signedOut;
    notifyListeners();
  }
}

class FakePush extends PushService {
  void Function(String)? tap;
  bool disposed = false;
  @override
  Future<void> ensureChannels() async {}
  @override
  void onNotificationTap(void Function(String) handler) {
    tap = handler;
  }

  @override
  void dispose() {
    disposed = true;
    tap = null;
  }
}

void main() {
  late BriefingApi api;
  late FakeAuth auth;
  setUp(() {
    api = BriefingApi();
    auth = FakeAuth(api)..signIn();
  });
  tearDown(() {
    auth.dispose();
  });
  Future<void> mount(WidgetTester tester, {bool large = false}) async {
    await tester.pumpWidget(
      ChangeNotifierProvider<AuthController>.value(
        value: auth,
        child: MaterialApp(
          theme: buildScalivoTheme(),
          home: const BriefingsScreen(),
          builder: large
              ? (context, child) => MediaQuery(
                  data: MediaQuery.of(context)
                      .copyWith(textScaler: const TextScaler.linear(2)),
                  child: child!,
                )
              : null,
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> reveal(WidgetTester tester, Finder finder) async {
    await tester.scrollUntilVisible(
      finder,
      250,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.ensureVisible(finder);
    await tester.pumpAndSettle();
  }

  test('API bounds input and requests the capped authenticated feed', () async {
    final requests = <http.Request>[];
    final client = ApiClient(
      client: MockClient((request) async {
        requests.add(request);
        return http.Response(
          jsonEncode(request.method == 'PATCH' ? feed()['settings'] : feed()),
          200,
        );
      }),
    )..token = 'test-token';
    await client.briefings('business');
    await client.updateAgentSettings('business', hour: 9);
    expect(requests.first.url.queryParameters, {'limit': '20'});
    expect(requests.first.headers['Authorization'], 'Bearer test-token');
    expect(jsonDecode(requests.last.body), {'hour': 9});
    expect(
      () => client.updateAgentSettings('business', hour: 12),
      throwsA(isA<ApiException>()),
    );
    expect(
      () => client.markBriefingRead('business', '../foreign'),
      throwsA(isA<ApiException>()),
    );
    expect(requests, hasLength(2));
  });

  test(
    'malformed briefing contracts fail as controlled generic errors',
    () async {
      for (final changed in [
        {
          ...feed(),
          'briefings': [
            {...briefing(), 'kind': 'execute'},
          ],
        },
        {
          ...feed(),
          'briefings': [
            {...briefing(), 'body': 'x' * 701},
          ],
        },
        {
          ...feed(),
          'settings': {'enabled': true, 'hour': 23},
        },
      ]) {
        final client = ApiClient(
          client: MockClient(
            (_) async => http.Response(jsonEncode(changed), 200),
          ),
        );
        await expectLater(
          client.briefings('business'),
          throwsA(
            isA<ApiException>().having(
              (e) => e.kind,
              'kind',
              ApiErrorKind.server,
            ),
          ),
        );
      }
    },
  );

  test('suggestions allow only existing app destinations and valid dates', () {
    Widget? destination(String href) => briefingActionScreen(
      BriefingAction.fromJson({'label': 'Open', 'href': href}),
    );
    expect(destination('/analytics'), isA<AnalyticsScreen>());
    expect(
      destination('/grow/broadcast?audience=at_risk'),
      isA<CampaignScreen>(),
    );
    expect(destination('/calendar?date=2026-10-10&view=day'), isNotNull);
    for (final href in [
      'https://example.test',
      '//example.test/analytics',
      '/services',
      '/agent/run',
      '/calendar?date=2026-02-30',
      '/calendar?view=week',
      '/grow/broadcast?audience=lapsed&audience=at_risk',
      '/analytics?token=secret',
    ]) {
      expect(destination(href), isNull, reason: href);
    }
  });

  testWidgets(
    'read state changes only after an explicit successful receipt and cannot duplicate',
    (tester) async {
      await mount(tester);
      expect(api.reads, 0);
      expect(find.text('Written from your numbers'), findsOneWidget);
      final button = find.text('Mark as read');
      await reveal(tester, button);
      api.receipt = Completer<void>();
      await tester.tap(button);
      await tester.tap(button);
      await tester.pump();
      expect(api.reads, 1);
      api.receipt!.complete();
      await tester.pumpAndSettle();
      expect(find.text('Mark as read'), findsNothing);
      expect(find.text('0 unread across your history'), findsOneWidget);
    },
  );

  testWidgets(
    'failed read receipt keeps the briefing unread and provides retry',
    (tester) async {
      await mount(tester);
      api.fail = true;
      final button = find.text('Mark as read');
      await reveal(tester, button);
      await tester.tap(button);
      await tester.pumpAndSettle();
      expect(api.read, false);
      expect(find.text('Unread'), findsOneWidget);
      api.fail = false;
      await reveal(tester, find.text('Try again'));
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('No internet connection'), findsNothing);
    },
  );

  testWidgets('settings save partial updates and use business-local hours', (
    tester,
  ) async {
    await mount(tester);
    await tester.tap(find.byType(DropdownButtonFormField<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('9:00 AM').last);
    await tester.pumpAndSettle();
    expect(api.settingsWrites.single, {'hour': 9});
    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();
    expect(api.settingsWrites.last, {'enabled': false});
    expect(find.textContaining('Asia/Karachi'), findsOneWidget);
  });

  testWidgets('failed time update restores the persisted selection', (
    tester,
  ) async {
    await mount(tester);
    api.fail = true;
    await tester.tap(find.byType(DropdownButtonFormField<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('9:00 AM').last);
    await tester.pumpAndSettle();
    expect(api.hour, 7);
    expect(find.text('7:00 AM'), findsOneWidget);
  });

  testWidgets('paused empty inbox and large text remain usable', (
    tester,
  ) async {
    api.empty = true;
    api.enabled = false;
    await mount(tester, large: true);
    await reveal(tester, find.textContaining('Briefings are paused.'));
    expect(find.textContaining('Briefings are paused.'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'cold-start notification waits for auth and opens the briefing inbox',
    (tester) async {
      auth.status = AuthStatus.unknown;
      auth.me = null;
      final push = FakePush();
      await tester.pumpWidget(ScalivoOwnerApp(auth: auth, push: push));
      await tester.pump();
      push.tap!('/briefings');
      await tester.pump();
      expect(find.byType(BriefingsScreen), findsNothing);
      auth.signIn();
      await tester.pumpAndSettle();
      expect(find.byType(BriefingsScreen), findsOneWidget);
      auth.signOut();
      await tester.pumpAndSettle();
      expect(find.byType(BriefingsScreen), findsNothing);
      await tester.pumpWidget(const SizedBox());
      expect(push.disposed, true);
    },
  );

  testWidgets(
    'signed-out and unknown notification routes cannot open protected screens',
    (tester) async {
      auth.signOut();
      final push = FakePush();
      await tester.pumpWidget(ScalivoOwnerApp(auth: auth, push: push));
      await tester.pumpAndSettle();
      push.tap!('/briefings');
      push.tap!('https://example.test');
      await tester.pumpAndSettle();
      expect(find.byType(BriefingsScreen), findsNothing);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
