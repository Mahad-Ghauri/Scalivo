import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/growth_models.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:scalivo_owner/import/client_csv.dart';
import 'package:scalivo_owner/screens/analytics_screen.dart';
import 'package:scalivo_owner/screens/campaign_screen.dart';
import 'package:scalivo_owner/screens/client_import_screen.dart';
import 'package:scalivo_owner/screens/grow_screen.dart';
import 'package:scalivo_owner/screens/poster_screen.dart';
import 'package:scalivo_owner/screens/reviews_screen.dart';
import 'package:scalivo_owner/state/auth_controller.dart';
import 'package:scalivo_owner/theme.dart';
import 'package:scalivo_owner/widgets/sc_button.dart';

Map<String, dynamic> outcome() => {
  'sends': 2,
  'delivered': 1,
  'undelivered': 1,
  'queued': 0,
  'skipped': 0,
  'replied': 0,
  'rebooked': 0,
  'optedOut': 0,
};
Map<String, dynamic> report({int revenue = 150000}) => {
  'revenueMinor': revenue,
  'series': [
    {'period': '2026-10-09', 'revenueMinor': revenue, 'completed': 1},
  ],
  'volume': {
    'total': 3,
    'completed': 1,
    'noShow': 1,
    'cancelled': 1,
    'upcoming': 0,
  },
  'noShowRate': 0.5,
  'topServices': [],
  'topClients': [],
  'forecast': {'revenueMinor': 0, 'bookings': 0},
};
Map<String, dynamic> review(int i) => {
  'id': 'review-$i',
  'authorName': 'Customer $i',
  'rating': 2,
  'comment': 'Needs follow up',
  'serviceName': 'Haircut',
  'published': false,
  'flagged': true,
  'createdAt': '2026-10-09T10:00:00Z',
};
Map<String, dynamic> preview() => {
  'matched': 4,
  'reachable': 2,
  'coldContacts': 1,
  'remainingToday': {'total': 60, 'cold': 15},
  'suggested': 'Come back for your next appointment.',
  'excluded': {'optedOut': 1, 'recentlyMessaged': 1, 'noAddress': 0},
};
Map<String, dynamic> importResult(bool dryRun) => {
  'dryRun': dryRun,
  'counts': {
    'created': 1,
    'linked': 0,
    'updated': 0,
    'duplicate': 0,
    'invalid': 0,
  },
  'rows': [
    {'row': 0, 'outcome': 'created', 'phone': '923001234567'},
  ],
};

class CsvPicker extends FileSelectorPlatform {
  XFile? selected;
  @override
  Future<XFile?> openFile({
    List<XTypeGroup>? acceptedTypeGroups,
    String? initialDirectory,
    String? confirmButtonText,
  }) async => selected;
}

void main() {
  late ApiClient api;
  late AuthController auth;
  late List<http.Request> requests;
  late bool fail, nudgeEnabled;
  late FileSelectorPlatform originalPicker;
  late CsvPicker picker;

  setUp(() {
    requests = [];
    fail = false;
    nudgeEnabled = true;
    originalPicker = FileSelectorPlatform.instance;
    picker = CsvPicker();
    FileSelectorPlatform.instance = picker;
    api = ApiClient(
      client: MockClient((request) async {
        requests.add(request);
        if (fail) return http.Response('{"error":"internal secret"}', 500);
        final path = request.url.path;
        Object body;
        if (path.endsWith('/analytics')) {
          body = report();
        } else if (path.endsWith('/reviews/summary')) {
          body = {
            'requested': 21,
            'answered': 21,
            'flagged': 21,
            'captureRate': 1,
            'averageRating': 2,
          };
        } else if (path.endsWith('/reviews')) {
          body = {
            'reviews': request.url.queryParameters['skip'] == '20'
                ? [review(20)]
                : List.generate(20, review),
            'total': 21,
          };
        } else if (path.endsWith('/retention/audience')) {
          body = preview();
        } else if (path.endsWith('/retention/nudges')) {
          if (request.method == 'PATCH') {
            nudgeEnabled = jsonDecode(request.body)['nudges'] as bool;
            body = {'nudges': nudgeEnabled};
          } else {
            body = {'enabled': nudgeEnabled, 'days': 30, 'outcome': outcome()};
          }
        } else if (path.endsWith('/retention/campaigns')) {
          body = request.method == 'GET'
              ? {'campaigns': []}
              : {'campaignId': 'campaign', 'sent': 0};
        } else if (path.endsWith('/grow/boost')) {
          body = {'active': false, 'until': null};
        } else if (path.endsWith('/grow/funnel')) {
          body = {
            'totals': {'views': 10, 'starts': 3, 'bookings': 1},
            'whatsappBookings': 2,
          };
        } else if (path.endsWith('/invite')) {
          body = {'link': 'https://wa.me/923001234567?text=Book'};
        } else if (path.endsWith('/clients/import')) {
          body = importResult(request.url.queryParameters['dryRun'] == 'true');
        } else {
          body = {
            'name': 'Salon',
            'slug': 'salon',
            'published': true,
            'bookingUrl': 'https://example.test/salon',
          };
        }
        return http.Response(jsonEncode(body), 200);
      }),
    )..token = 'test-token';
    auth = AuthController(api: api)
      ..status = AuthStatus.signedIn
      ..me = const Me(
        name: 'Owner',
        email: 'owner@example.test',
        businesses: [
          BusinessSummary(
            id: 'business',
            name: 'Salon',
            category: 'salon',
            whatsappStatus: 'ready',
            whatsappIntent: 'live',
          ),
        ],
      );
  });
  tearDown(() {
    auth.dispose();
    FileSelectorPlatform.instance = originalPicker;
  });

  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 30));
    });
    await tester.pumpAndSettle();
  }

  Future<void> mount(
    WidgetTester tester,
    Widget screen, {
    bool largeText = false,
  }) async {
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: auth,
        child: MaterialApp(
          theme: buildScalivoTheme(),
          home: screen,
          builder: largeText
              ? (context, child) => MediaQuery(
                  data: MediaQuery.of(context)
                      .copyWith(textScaler: const TextScaler.linear(2)),
                  child: child!,
                )
              : null,
        ),
      ),
    );
    await settle(tester);
  }

  Future<void> reveal(WidgetTester tester, Finder finder) async {
    await tester.scrollUntilVisible(
      finder,
      250,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.ensureVisible(finder);
    await tester.pump();
    await tester.pumpAndSettle();
  }

  List<http.Request> writes() =>
      requests.where((r) => r.method != 'GET').toList();

  test(
    'API validates parameters before a request and preserves authentication',
    () async {
      await api.analytics(
        'business',
        DateTime(2026, 10, 1),
        DateTime(2026, 10, 9),
      );
      expect(requests.single.headers['Authorization'], 'Bearer test-token');
      expect(requests.single.url.queryParameters['from'], '2026-10-01');
      expect(
        () => api.reviews('business', skip: 10001),
        throwsA(isA<ApiException>()),
      );
      expect(
        () => api.createCampaign('business', CampaignAudience.lapsed, 'short'),
        throwsA(isA<ApiException>()),
      );
      expect(
        () => api.importClients('business', [], dryRun: true),
        throwsA(isA<ApiException>()),
      );
      expect(
        () => api.analytics('business', DateTime(2025), DateTime(2026, 10)),
        throwsA(isA<ApiException>()),
      );
      expect(requests, hasLength(1));
    },
  );

  test(
    'malformed and oversized responses become generic controlled failures',
    () async {
      api = ApiClient(
        client: MockClient(
          (_) async =>
              http.Response(jsonEncode({...report(), 'noShowRate': 3}), 200),
        ),
      );
      await expectLater(
        api.analytics('business', DateTime(2026), DateTime(2026)),
        throwsA(
          isA<ApiException>().having(
            (e) => e.kind,
            'kind',
            ApiErrorKind.server,
          ),
        ),
      );
      api = ApiClient(
        client: MockClient(
          (_) async => http.Response('x' * (1024 * 1024 + 1), 200),
        ),
      );
      await expectLater(
        api.reviewSummary('business'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'Something went wrong. Try again.',
          ),
        ),
      );
    },
  );

  test('CSV supports quoted commas, BOM and mapping without losing phone digits', () {
    final bytes = Uint8List.fromList(
      utf8.encode(
        '\uFEFFPhone,Name,spend\r\n923001234567,"Khan, Sana","Rs. 12,500"\r\n',
      ),
    );
    final table = parseClientCsv(bytes);
    final rows = mapClientCsv(table, {'phone': 0, 'name': 1, 'spend': 2});
    expect(rows.single, {
      'phone': '923001234567',
      'name': 'Khan, Sana',
      'spend': 'Rs. 12,500',
    });
    expect(
      () => mapClientCsv(table, {'phone': 0, 'name': 0}),
      throwsFormatException,
    );
    expect(
      () => parseClientCsv(Uint8List(maxClientCsvBytes + 1)),
      throwsFormatException,
    );
    expect(
      () => parseClientCsv(Uint8List.fromList(utf8.encode('phone,name\n123'))),
      throwsFormatException,
    );
    expect(
      () => parseClientCsv(
        Uint8List.fromList(utf8.encode('phone,name\n123,"unfinished')),
      ),
      throwsFormatException,
    );
    for (final delimiter in [';', '\t']) {
      final parsed = parseClientCsv(
        Uint8List.fromList(
          utf8.encode('phone${delimiter}name\n00123${delimiter}Sana'),
        ),
      );
      expect(parsed.last, ['00123', 'Sana']);
    }
  });

  testWidgets('campaign refuses sending while WhatsApp is disconnected', (
    tester,
  ) async {
    auth.me = const Me(
      name: 'Owner',
      email: 'owner@example.test',
      businesses: [
        BusinessSummary(
          id: 'business',
          name: 'Salon',
          category: 'salon',
          whatsappStatus: 'disconnected',
          whatsappIntent: 'live',
        ),
      ],
    );
    await mount(tester, const CampaignScreen());
    final send = find.widgetWithText(ScButton, 'Review & send');
    await reveal(tester, send);
    expect(tester.widget<ScButton>(send).onPressed, isNull);
    expect(
      find.text('Reconnect WhatsApp before sending a campaign.'),
      findsOneWidget,
    );
    expect(writes(), isEmpty);
  });

  testWidgets('cancelled CSV selection does not issue an import', (
    tester,
  ) async {
    await mount(tester, const ClientImportScreen());
    await tester.tap(find.text('Choose CSV file'));
    await settle(tester);
    expect(writes(), isEmpty);
    expect(find.text('Preview import'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('analytics handles server error, retry and period selection', (
    tester,
  ) async {
    fail = true;
    await mount(tester, const AnalyticsScreen());
    expect(find.text('internal secret'), findsNothing);
    fail = false;
    await tester.tap(find.text('Try again'));
    await settle(tester);
    expect(find.text('Rs 1,500'), findsWidgets);
    await tester.tap(find.text('7 days'));
    await settle(tester);
    expect(requests.last.url.queryParameters['granularity'], 'day');
    expect(tester.takeException(), isNull);
  });

  testWidgets('old analytics response cannot overwrite a newer period', (
    tester,
  ) async {
    final first = Completer<http.Response>();
    var calls = 0;
    final delayed = ApiClient(
      client: MockClient((_) async {
        calls++;
        return calls == 1
            ? first.future
            : http.Response(jsonEncode(report(revenue: 250000)), 200);
      }),
    );
    auth = AuthController(api: delayed)
      ..me = const Me(
        name: 'Owner',
        email: 'owner@example.test',
        businesses: [
          BusinessSummary(
            id: 'business',
            name: 'Salon',
            category: 'salon',
            whatsappStatus: 'ready',
            whatsappIntent: 'live',
          ),
        ],
      );
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: auth,
        child: MaterialApp(
          theme: buildScalivoTheme(),
          home: const AnalyticsScreen(),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.text('7 days'));
    await settle(tester);
    first.complete(http.Response(jsonEncode(report()), 200));
    await settle(tester);
    expect(find.text('Rs 2,500'), findsWidgets);
    expect(find.text('Rs 1,500'), findsNothing);
  });

  testWidgets('reviews paginate in bounded pages and show private flags', (
    tester,
  ) async {
    await mount(tester, const ReviewsScreen());
    expect(find.text('Private · follow up with this customer'), findsWidgets);
    final next = find.widgetWithText(ScButton, 'Next reviews');
    await reveal(tester, next);
    await tester.tap(next);
    await settle(tester);
    expect(requests.last.url.queryParameters['skip'], '20');
    expect(requests.last.url.queryParameters['limit'], '20');
    expect(find.text('Customer 20'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Needs attention'),
      -300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.tap(find.text('Needs attention'));
    await settle(tester);
    expect(requests.last.url.queryParameters['filter'], 'flagged');
    expect(requests.last.url.queryParameters['skip'], '0');
  });

  testWidgets('campaign requires confirmation and submits only once', (
    tester,
  ) async {
    await mount(tester, const CampaignScreen());
    final send = find.widgetWithText(ScButton, 'Review & send');
    await reveal(tester, send);
    await tester.tap(send);
    await settle(tester);
    expect(writes(), isEmpty);
    await tester.tap(find.text('Keep as is'));
    await settle(tester);
    expect(writes(), isEmpty);
    await tester.tap(send);
    await settle(tester);
    await tester.tap(find.text('Send campaign'));
    await settle(tester);
    expect(writes(), hasLength(1));
    expect(jsonDecode(writes().single.body)['audience'], 'lapsed');
  });

  testWidgets(
    'Grow pauses nudges only after confirmation and reports real delivery',
    (tester) async {
      await mount(tester, const GrowScreen());
      final toggle = find.widgetWithText(
        SwitchListTile,
        'Send rebooking nudges',
      );
      // Adaptive SwitchListTile remains the same public widget type.
      await reveal(tester, toggle);
      await tester.tap(toggle);
      await settle(tester);
      expect(writes(), isEmpty);
      await tester.tap(find.text('Confirm'));
      await settle(tester);
      expect(nudgeEnabled, false);
      expect(writes(), hasLength(1));
      expect(jsonDecode(writes().single.body), {'nudges': false});
    },
  );

  testWidgets('native CSV flow previews then confirms before importing', (
    tester,
  ) async {
    picker.selected = XFile.fromData(
      Uint8List.fromList(utf8.encode('phone,name\n923001234567,Sana')),
      name: 'clients.csv',
      path: 'clients.csv',
    );
    await mount(tester, const ClientImportScreen());
    await tester.tap(find.text('Choose CSV file'));
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 250));
    });
    await settle(tester);
    final previewButton = find.widgetWithText(ScButton, 'Preview import');
    await reveal(tester, previewButton);
    await tester.tap(previewButton);
    await settle(tester);
    expect(writes().single.url.queryParameters['dryRun'], 'true');
    final importButton = find.widgetWithText(ScButton, 'Import 1 customers');
    await reveal(tester, importButton);
    await tester.drag(find.byType(Scrollable).first, const Offset(0, -180));
    await tester.pumpAndSettle();
    await tester.tap(importButton);
    await settle(tester);
    expect(writes(), hasLength(1));
    await tester.tap(find.text('Import customers').last);
    await settle(tester);
    expect(writes(), hasLength(2));
    expect(writes().last.url.queryParameters['dryRun'], 'false');
    expect(find.text('Import complete'), findsOneWidget);
  });

  testWidgets(
    'poster stays usable with large text and contains a customer URL',
    (tester) async {
      await mount(
        tester,
        const PosterScreen(name: 'Salon', link: 'https://wa.me/923001234567'),
        largeText: true,
      );
      expect(find.byType(QrImageView), findsOneWidget);
      expect(
        tester.widget<PosterScreen>(find.byType(PosterScreen)).link,
        'https://wa.me/923001234567',
      );
      expect(tester.takeException(), isNull);
    },
  );
}
