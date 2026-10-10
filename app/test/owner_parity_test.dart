import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:scalivo_owner/api/owner_booking_models.dart';
import 'package:scalivo_owner/format.dart';
import 'package:scalivo_owner/screens/appointments_screen.dart';
import 'package:scalivo_owner/screens/booking_sheet.dart';
import 'package:scalivo_owner/screens/business_profile_screen.dart';
import 'package:scalivo_owner/screens/client_picker_screen.dart';
import 'package:scalivo_owner/screens/slot_picker_screen.dart';
import 'package:scalivo_owner/screens/tabs/calendar_tab.dart';
import 'package:scalivo_owner/screens/walk_in_sheet.dart';
import 'package:scalivo_owner/state/auth_controller.dart';
import 'package:scalivo_owner/state/calendar_controller.dart';
import 'package:scalivo_owner/theme.dart';

const ownerMe = Me(
  name: 'Owner',
  email: 'owner@example.test',
  businesses: [
    BusinessSummary(
      id: 'business',
      name: 'Salon',
      category: 'salon',
      whatsappStatus: 'created',
      whatsappIntent: 'stopped',
    ),
    BusinessSummary(
      id: 'second',
      name: 'Second salon',
      category: 'salon',
      timezone: 'Europe/London',
      whatsappStatus: 'created',
      whatsappIntent: 'stopped',
    ),
  ],
);
const person = StaffSummary(
  id: 'staff',
  name: 'Ayesha',
  serviceIds: ['service'],
);
CalendarEntry entry({String status = 'confirmed', bool future = false}) {
  final start = DateTime.now().toUtc().add(Duration(hours: future ? 24 : -1));
  return CalendarEntry(
    id: 'booking',
    staffId: 'staff',
    staffName: 'Ayesha',
    clientId: 'client',
    clientName: 'Sam',
    clientPhone: null,
    serviceId: 'service',
    serviceName: 'Haircut',
    startsAt: businessTime(start),
    endsAt: businessTime(start.add(const Duration(minutes: 30))),
    durationMinutes: 30,
    status: status,
    priceMinor: 150000,
    source: 'owner',
  );
}

Map<String, Object?> bookingRow(int index) => {
  'id': 'booking$index',
  'startsAt': '2026-10-10T09:00:00Z',
  'durationMinutes': 30,
  'status': 'confirmed',
  'priceMinor': 150000,
  'source': 'owner',
  'client': {'id': 'client', 'name': 'Customer $index', 'phone': null},
  'service': {'id': 'service', 'name': 'Haircut'},
  'staff': {'id': 'staff', 'name': 'Ayesha'},
};

class Fixture {
  final requests = <http.Request>[];
  bool failSlots = false, emptySlots = false;
  int total = 21;
  final profile = <String, Object?>{
    'name': 'Salon',
    'city': 'Karachi',
    'timezone': 'Asia/Karachi',
    'slotIncrementMinutes': 15,
    'published': false,
    'profile': {'tagline': 'Your local salon', 'about': ''},
  };
  late final ApiClient api = ApiClient(
    client: MockClient((request) async {
      requests.add(request);
      final path = request.url.path;
      Object data;
      if (path.endsWith('/availability')) {
        if (failSlots) return http.Response('private server detail', 500);
        data = {
          'slots': emptySlots
              ? []
              : [
                  {
                    'staffId': request.url.queryParameters['staffId'],
                    'startsAt':
                        '${request.url.queryParameters['date']}T09:00:00Z',
                    'durationMinutes': 30,
                  },
                ],
        };
      } else if (path.endsWith('/bookings')) {
        final skip = int.parse(request.url.queryParameters['skip']!);
        data = {
          'bookings': [
            for (var i = skip; i < total && i < skip + 20; i++) bookingRow(i),
          ],
          'total': total,
        };
      } else if (path.endsWith('/services')) {
        data = {
          'services': [
            {
              'id': 'service',
              'name': 'Haircut',
              'durationMinutes': 30,
              'priceMinor': 150000,
              'bufferMinutes': 0,
              'active': true,
            },
          ],
        };
      } else if (path.endsWith('/staff')) {
        data = {
          'staff': [
            {
              'id': 'staff',
              'name': 'Ayesha',
              'serviceIds': ['service'],
              'workingHours': [],
              'active': true,
            },
          ],
        };
      } else if (path.endsWith('/setup')) {
        data = {'bookable': true, 'published': false, 'steps': []};
      } else if (path.endsWith('/calendar')) {
        data = {'timezone': 'Asia/Karachi', 'staff': [], 'days': []};
      } else if (path.endsWith('/clients')) {
        data = {
          'clients': [
            {
              'clientId': 'client',
              'displayName': 'Sam',
              'phone': null,
              'tags': [],
              'totalVisits': 2,
              'lifetimeSpendMinor': 10000,
              'lastVisitAt': null,
            },
          ],
          'total': 1,
        };
      } else if (path == '/auth/me') {
        data = {
          'user': {
            'name': 'Owner',
            'email': 'owner@example.test',
            'role': 'owner',
          },
          'businesses': [
            {
              'id': 'business',
              'name': profile['name'],
              'category': 'salon',
              'timezone': profile['timezone'],
              'whatsapp': {'status': 'created', 'intent': 'stopped'},
            },
          ],
        };
      } else if (path.endsWith('/walk-ins') ||
          path.endsWith('/outcome') ||
          path.endsWith('/cancel')) {
        return http.Response('', 204);
      } else if (path.endsWith('/reschedule')) {
        data = {'notified': false};
      } else {
        if (request.method == 'PATCH') {
          final body = jsonDecode(request.body) as Map<String, dynamic>;
          if (body['slotIncrementMinutes'] == 5) {
            return http.Response(
              jsonEncode({
                'error': 'invalid settings',
                'fields': {
                  'slotIncrementMinutes':
                      'Upcoming bookings use the current grid',
                },
              }),
              409,
            );
          }
          profile.addAll(body);
        }
        data = profile;
      }
      return http.Response(jsonEncode(data), 200);
    }),
  )..token = 'fixture-token';
}

void main() {
  late Fixture f;
  late AuthController auth;
  setUp(() {
    f = Fixture();
    auth = AuthController(api: f.api)
      ..me = ownerMe
      ..status = AuthStatus.signedIn;
  });
  tearDown(() {
    auth.dispose();
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
    bool large = false,
  }) async {
    await tester.pumpWidget(
      ChangeNotifierProvider<AuthController>.value(
        value: auth,
        child: MaterialApp(
          theme: buildScalivoTheme(),
          builder: large
              ? (context, child) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: const TextScaler.linear(2)),
                  child: child!,
                )
              : null,
          home: screen,
        ),
      ),
    );
    await settle(tester);
  }

  Future<void> reveal(WidgetTester tester, Finder finder) async {
    await tester.scrollUntilVisible(
      finder,
      300,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.ensureVisible(finder);
    await settle(tester);
  }

  test('outcomes require confirmed status and the exact start boundary', () {
    final e = entry();
    expect(
      e.canMarkOutcomeAt(e.startsAt.subtract(const Duration(microseconds: 1))),
      false,
    );
    expect(e.canMarkOutcomeAt(e.startsAt), true);
    for (final status in appointmentStatuses.where((s) => s != 'confirmed')) {
      expect(entry(status: status).canMarkOutcomeAt(DateTime.now()), false);
    }
  });
  test(
    'controller refuses early outcome mutations without a network call',
    () async {
      final c = CalendarController(api: f.api, businessId: 'business');
      expect(await c.complete(entry(future: true)), isA<ApiException>());
      expect(await c.noShow(entry(status: 'pending')), isA<ApiException>());
      expect(f.requests, isEmpty);
      c.dispose();
    },
  );
  test(
    'appointments and availability use authenticated bounded queries',
    () async {
      final p = await f.api.appointments(
        'business',
        q: 'Sam',
        status: 'confirmed',
        skip: 20,
        from: '2026-10-01',
        to: '2026-10-31',
      );
      expect(p.bookings.length, 1);
      expect(p.bookings.first.startsAt.hour, 14);
      expect(f.requests.first.url.queryParameters['limit'], '20');
      expect(f.requests.first.headers['Authorization'], 'Bearer fixture-token');
      await f.api.availability(
        'business',
        serviceId: 'service',
        date: '2026-10-10',
        staffId: 'staff',
      );
      expect(f.requests.last.url.queryParameters['staffId'], 'staff');
      for (final request in [
        () => f.api.appointments('business', q: 'a' * 121),
        () => f.api.appointments('business', skip: -1),
        () => f.api.appointments('business', status: 'bad'),
        () => f.api.appointments('business', from: '2026-02-30'),
        () => f.api.appointments(
          'business',
          from: '2026-10-20',
          to: '2026-10-10',
        ),
        () => f.api.availability(
          'business',
          serviceId: 'service',
          date: '2026-02-30',
          staffId: 'staff',
        ),
      ]) {
        expect(request, throwsA(isA<ApiException>()));
      }
      expect(f.requests.length, 2);
    },
  );
  test(
    'malformed or oversized appointment data becomes a generic API failure',
    () async {
      final badApi = ApiClient(
        client: MockClient(
          (_) async => http.Response(
            jsonEncode({
              'total': 21,
              'bookings': [for (var i = 0; i < 21; i++) bookingRow(i)],
            }),
            200,
          ),
        ),
      );
      await expectLater(
        badApi.appointments('business'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.kind,
            'kind',
            ApiErrorKind.server,
          ),
        ),
      );
    },
  );
  test(
    'business switching uses only authorized membership and updates timezone',
    () {
      auth.selectBusiness('foreign');
      expect(auth.business!.id, 'business');
      auth.selectBusiness('second');
      expect(auth.business!.id, 'second');
      expect(f.api.businessTimezone, 'Europe/London');
      auth.selectBusiness('business');
      expect(f.api.businessTimezone, 'Asia/Karachi');
      auth.status = AuthStatus.signedOut;
      auth.selectBusiness('second');
      expect(auth.business!.id, 'business');
    },
  );
  test(
    'profile writes validate images and colour before network and preserve other settings',
    () async {
      for (final profile in [
        {'logoUrl': 'http://example.test/image'},
        {'coverUrl': 'https://user:secret@example.test/image'},
        {'themeColor': 'red'},
        {'unknown': ''},
      ]) {
        expect(
          () => f.api.saveBusinessProfile(
            'business',
            name: 'Salon',
            city: 'Karachi',
            timezone: 'Asia/Karachi',
            slotIncrementMinutes: 15,
            profile: profile,
          ),
          throwsA(isA<ApiException>()),
        );
      }
      expect(f.requests, isEmpty);
      await f.api.saveBusinessProfile(
        'business',
        name: 'New salon',
        city: 'Karachi',
        timezone: 'Asia/Karachi',
        slotIncrementMinutes: 15,
        profile: {'tagline': 'Hello'},
      );
      final body = jsonDecode(f.requests.single.body) as Map<String, dynamic>;
      expect(body.containsKey('reminders'), false);
      expect(body.containsKey('published'), false);
    },
  );
  for (final state in [
    (true, 'confirmed'),
    (false, 'pending'),
    (false, 'completed'),
  ]) {
    testWidgets(
      'booking actions hide ineligible outcomes ${state.$1} ${state.$2}',
      (tester) async {
        final controller = CalendarController(
          api: f.api,
          businessId: 'business',
        );
        await mount(
          tester,
          Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => showBookingSheet(
                  context,
                  controller: controller,
                  entry: entry(future: state.$1, status: state.$2),
                ),
                child: const Text('Open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await settle(tester);
        expect(find.text('Completed'), findsNothing);
        expect(find.text('No-show'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        controller.dispose();
      },
    );
  }
  testWidgets(
    'eligible booking shows both outcomes and requires confirmation',
    (tester) async {
      final controller = CalendarController(api: f.api, businessId: 'business');
      await mount(
        tester,
        Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showBookingSheet(
                context,
                controller: controller,
                entry: entry(),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await settle(tester);
      expect(find.text('Completed'), findsOneWidget);
      expect(find.text('No-show'), findsOneWidget);
      await tester.tap(find.text('Completed'));
      await settle(tester);
      expect(find.text('Mark this visit complete?'), findsOneWidget);
      expect(f.requests, isEmpty);
      await tester.pumpWidget(const SizedBox());
      controller.dispose();
    },
  );
  testWidgets(
    'slot picker displays business-local times and only eligible staff',
    (tester) async {
      await mount(
        tester,
        SlotPickerScreen(
          serviceId: 'service',
          staff: const [
            person,
            StaffSummary(
              id: 'other',
              name: 'Other',
              serviceIds: ['other-service'],
            ),
          ],
          date: DateTime(2026, 10, 10),
        ),
      );
      expect(find.text('2:00 PM'), findsOneWidget);
      expect(f.requests.single.url.queryParameters['staffId'], 'staff');
      expect(find.text('Other'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'unavailable and failed slot requests explain recovery without arbitrary times',
    (tester) async {
      f.failSlots = true;
      await mount(
        tester,
        SlotPickerScreen(
          serviceId: 'service',
          staff: const [person],
          date: DateTime(2026, 10, 10),
        ),
      );
      expect(find.text('private server detail'), findsNothing);
      expect(find.text('Try again'), findsOneWidget);
      f.failSlots = false;
      f.emptySlots = true;
      await tester.tap(find.text('Try again'));
      await settle(tester);
      expect(find.textContaining('No available times'), findsOneWidget);
      expect(find.byType(ListTile), findsNothing);
    },
  );
  testWidgets(
    'appointment pagination keeps one page and search resets offset',
    (tester) async {
      await mount(tester, const AppointmentsScreen());
      await reveal(tester, find.text('Next'));
      await tester.tap(find.text('Next'));
      await settle(tester);
      expect(
        f.requests
            .where((r) => r.url.path.endsWith('/bookings'))
            .last
            .url
            .queryParameters['skip'],
        '20',
      );
      expect(find.textContaining('Customer 20'), findsOneWidget);
      expect(find.textContaining('Customer 0 ·'), findsNothing);
      await tester.scrollUntilVisible(
        find.byType(TextField),
        -400,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.enterText(find.byType(TextField), 'Sam');
      await tester.testTextInput.receiveAction(TextInputAction.search);
      await settle(tester);
      final request = f.requests
          .where((r) => r.url.path.endsWith('/bookings'))
          .last;
      expect(request.url.queryParameters['skip'], '0');
      expect(request.url.queryParameters['q'], 'Sam');
    },
  );
  testWidgets(
    'client selection uses the existing tenant-scoped customer search',
    (tester) async {
      await mount(tester, const ClientPickerScreen());
      expect(find.text('Sam'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Sam');
      await tester.pump(const Duration(milliseconds: 350));
      await settle(tester);
      expect(f.requests.last.url.queryParameters['q'], 'Sam');
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'profile save updates owner identity and reports regridding conflict',
    (tester) async {
      await mount(tester, const BusinessProfileScreen());
      await tester.enterText(find.byType(TextField).first, 'New salon');
      await reveal(tester, find.text('Save details'));
      await tester.tap(find.text('Save details'));
      await settle(tester);
      expect(auth.business!.name, 'New salon');
      expect(find.text('Business details saved'), findsOneWidget);
      final dropdown = find.byType(DropdownButtonFormField<int>);
      await tester.ensureVisible(dropdown);
      await tester.tap(dropdown);
      await settle(tester);
      await tester.tap(find.text('5').last);
      await settle(tester);
      await tester.tap(find.text('Save details'));
      await settle(tester);
      expect(
        find.text('Upcoming bookings use the current grid'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'calendar toggle includes cancellations and week agenda requests seven dates',
    (tester) async {
      final c = CalendarController(api: f.api, businessId: 'business');
      await mount(
        tester,
        ChangeNotifierProvider<CalendarController>.value(
          value: c,
          child: const Scaffold(body: CalendarTab()),
        ),
      );
      await tester.tap(find.text('Show cancelled'));
      await settle(tester);
      expect(
        f.requests
            .where((r) => r.url.path.endsWith('/calendar'))
            .last
            .url
            .queryParameters['includeCancelled'],
        'true',
      );
      await tester.tap(find.text('Week agenda'));
      await settle(tester);
      final request = f.requests
          .where((r) => r.url.path.endsWith('/calendar'))
          .last;
      expect(
        DateTime.parse(request.url.queryParameters['to']!)
            .difference(DateTime.parse(request.url.queryParameters['from']!))
            .inDays,
        6,
      );
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );
  testWidgets(
    'walk-in requires an available time and exposes existing customer selection',
    (tester) async {
      final c = CalendarController(api: f.api, businessId: 'business');
      await mount(
        tester,
        Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showWalkInSheet(context, controller: c),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await settle(tester);
      expect(find.text('Choose existing customer'), findsOneWidget);
      await reveal(tester, find.text('Book it'));
      await tester.tap(find.text('Book it'));
      await settle(tester);
      expect(find.textContaining('Choose an available time'), findsWidgets);
      expect(f.requests.any((r) => r.url.path.endsWith('/walk-ins')), false);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );

  testWidgets(
    'existing customer booking submits only the returned slot and customer id',
    (tester) async {
      final c = CalendarController(api: f.api, businessId: 'business');
      await mount(
        tester,
        Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showWalkInSheet(context, controller: c),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await settle(tester);
      await reveal(tester, find.text('Choose existing customer'));
      await tester.tap(find.text('Choose existing customer'));
      await settle(tester);
      await tester.tap(find.text('Sam'));
      await settle(tester);
      await reveal(tester, find.text('Choose an available time'));
      await tester.tap(find.text('Choose an available time'));
      await settle(tester);
      await tester.tap(find.text('2:00 PM'));
      await settle(tester);
      await reveal(tester, find.text('Book it'));
      await tester.tap(find.text('Book it'));
      await settle(tester);
      final body =
          jsonDecode(
                f.requests
                    .firstWhere((r) => r.url.path.endsWith('/walk-ins'))
                    .body,
              )
              as Map<String, dynamic>;
      expect(body['clientId'], 'client');
      expect(body['staffId'], 'staff');
      expect(body['startsAt'], endsWith('T09:00:00.000Z'));
      expect(body.containsKey('name'), false);
      expect(body.containsKey('phone'), false);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );
  testWidgets(
    'rescheduling can change staff and uses a server-returned instant',
    (tester) async {
      final c = CalendarController(api: f.api, businessId: 'business');
      c.services = [
        ServiceItem.fromJson({
          'id': 'service',
          'name': 'Haircut',
          'durationMinutes': 30,
          'priceMinor': 150000,
        }),
      ];
      c.staffList = const [
        person,
        StaffSummary(id: 'second-staff', name: 'Sara', serviceIds: ['service']),
      ];
      c.setup = const SetupChecklist(bookable: true, steps: []);
      await mount(
        tester,
        Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showBookingSheet(
                context,
                controller: c,
                entry: entry(future: true),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open'));
      await settle(tester);
      await tester.tap(find.text('Reschedule'));
      await settle(tester);
      await tester.tap(find.byType(DropdownButtonFormField<String>));
      await settle(tester);
      await tester.tap(find.text('Sara').last);
      await settle(tester);
      await tester.tap(find.text('2:00 PM'));
      await settle(tester);
      final body =
          jsonDecode(
                f.requests
                    .firstWhere((r) => r.url.path.endsWith('/reschedule'))
                    .body,
              )
              as Map<String, dynamic>;
      expect(body['staffId'], 'second-staff');
      expect(body['startsAt'], endsWith('T09:00:00.000Z'));
      expect(find.textContaining('could not message'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );
  testWidgets(
    'hiding a published profile requires confirmation and keeps unsaved edits',
    (tester) async {
      f.profile['published'] = true;
      await mount(tester, const BusinessProfileScreen());
      await tester.enterText(find.byType(TextField).first, 'Unsaved name');
      await tester.tap(find.text('Hide listing'));
      await settle(tester);
      expect(find.text('Hide your listing?'), findsOneWidget);
      expect(f.requests.any((r) => r.method == 'PATCH'), false);
      await tester.tap(find.text('Hide listing').last);
      await settle(tester);
      expect(f.profile['published'], false);
      expect(find.text('Unsaved name'), findsOneWidget);
      expect(
        jsonDecode(f.requests.firstWhere((r) => r.method == 'PATCH').body),
        {'published': false},
      );
    },
  );
  testWidgets('profile and slots remain usable at double text scale', (
    tester,
  ) async {
    await mount(tester, const BusinessProfileScreen(), large: true);
    await reveal(tester, find.text('Save details'));
    expect(tester.takeException(), isNull);
    await mount(
      tester,
      SlotPickerScreen(
        serviceId: 'service',
        staff: const [person],
        date: DateTime(2026, 10, 10),
      ),
      large: true,
    );
    await reveal(tester, find.text('2:00 PM'));
    expect(tester.takeException(), isNull);
  });
}
