import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:scalivo_owner/screens/appointment_holders_screen.dart';
import 'package:scalivo_owner/screens/resources_screen.dart';
import 'package:scalivo_owner/screens/services_screen.dart';
import 'package:scalivo_owner/api/owner_booking_models.dart';
import 'package:scalivo_owner/state/auth_controller.dart';
import 'package:scalivo_owner/state/calendar_controller.dart';
import 'package:scalivo_owner/theme.dart';

void main() {
  late ApiClient api;
  late AuthController auth;
  late CalendarController calendar;
  late List<http.Request> requests;
  late List<Map<String, Object?>> resources;
  late List<Map<String, Object?>> holders;
  late List<List<String>> requirements;
  bool failResources = false;
  setUp(() {
    requests = [];
    resources = [
      {
        'id': 'room',
        'name': 'Treatment room',
        'kind': 'room',
        'active': true,
        'fixedRoomId': null,
      },
    ];
    holders = [
      {'id': 'child', 'name': 'Sam'},
    ];
    requirements = [];
    failResources = false;
    api = ApiClient(
      client: MockClient((request) async {
        requests.add(request);
        final path = request.url.path;
        if (path.endsWith('/resources')) {
          if (failResources) return http.Response('private detail', 500);
          if (request.method == 'POST') {
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            resources.add({'id': 'new', ...body});
            return http.Response('{}', 201);
          }
          return http.Response(jsonEncode({'resources': resources}), 200);
        }
        if (path.endsWith('/resource-blocks')) {
          return http.Response('{"blocks":[]}', 200);
        }
        if (path.endsWith('/holders')) {
          return http.Response(jsonEncode({'holders': holders}), 200);
        }
        if (path.endsWith('/services')) {
          return http.Response(
            jsonEncode({
              'services': [
                {
                  'id': 'service',
                  'name': 'QA Facial',
                  'durationMinutes': 30,
                  'bufferMinutes': 15,
                  'priceMinor': 150000,
                  'active': true,
                  'resourceRequirements': [
                    for (final group in requirements)
                      {'anyOfResourceIds': group},
                  ],
                },
              ],
            }),
            200,
          );
        }
        if (path.endsWith('/services/service') && request.method == 'PATCH') {
          return http.Response(
            jsonEncode({
              'id': 'service',
              ...jsonDecode(request.body) as Map<String, dynamic>,
            }),
            200,
          );
        }
        return http.Response('{}', 204);
      }),
    )..token = 'fixture-token';
    auth = AuthController(api: api)
      ..me = const Me(
        name: 'Owner',
        email: 'owner@example.test',
        businesses: [
          BusinessSummary(
            id: 'business',
            name: 'Salon',
            category: 'salon',
            whatsappStatus: 'ready',
            whatsappIntent: 'running',
          ),
        ],
      )
      ..status = AuthStatus.signedIn;
    calendar = CalendarController(api: api, businessId: 'business');
  });
  tearDown(() {
    calendar.dispose();
    auth.dispose();
  });
  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pumpAndSettle();
  }

  Future<void> mount(WidgetTester tester, Widget screen) async {
    await tester.pumpWidget(
      ChangeNotifierProvider<AuthController>.value(
        value: auth,
        child: MaterialApp(theme: buildScalivoTheme(), home: screen),
      ),
    );
    await settle(tester);
  }

  testWidgets(
    'service editor requires separate room and equipment groups and permits interchangeable rooms',
    (tester) async {
      tester.view.physicalSize = const Size(900, 2200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      resources.addAll([
        {'id': 'room2', 'name': 'Second room', 'kind': 'room', 'active': true},
        {
          'id': 'pen',
          'name': 'Hydrafacial pen',
          'kind': 'equipment',
          'active': true,
        },
      ]);
      await mount(tester, const ServicesScreen());
      await tester.tap(find.text('QA Facial'));
      await settle(tester);
      await tester.tap(find.text('Add resource requirement'));
      await settle(tester);
      await tester.tap(find.widgetWithText(CheckboxListTile, 'Treatment room'));
      await settle(tester);
      expect(
        tester
            .widget<CheckboxListTile>(
              find.widgetWithText(CheckboxListTile, 'Hydrafacial pen'),
            )
            .onChanged,
        isNull,
      );
      expect(
        tester
            .widget<CheckboxListTile>(
              find.widgetWithText(CheckboxListTile, 'Second room'),
            )
            .onChanged,
        isNotNull,
      );
      await tester.tap(find.widgetWithText(CheckboxListTile, 'Second room'));
      await settle(tester);
      await tester.tap(find.text('Add resource requirement'));
      await settle(tester);
      await tester.tap(
        find.widgetWithText(CheckboxListTile, 'Hydrafacial pen').last,
      );
      await settle(tester);
      expect(
        tester
            .widget<CheckboxListTile>(
              find.widgetWithText(CheckboxListTile, 'Treatment room').last,
            )
            .onChanged,
        isNull,
      );
      await tester.tap(find.text('Save'));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await settle(tester);
      final writes = requests
          .where((request) => request.method == 'PATCH')
          .toList();
      expect(writes, hasLength(1));
      expect(
        (jsonDecode(writes.single.body)
            as Map<String, dynamic>)['resourceRequirements'],
        [
          {
            'anyOfResourceIds': ['room', 'room2'],
          },
          {
            'anyOfResourceIds': ['pen'],
          },
        ],
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'legacy mixed requirement displays a warning, blocks saving, and lets the owner remove the incorrect alternative',
    (tester) async {
      tester.view.physicalSize = const Size(900, 2200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      resources.add({
        'id': 'pen',
        'name': 'Hydrafacial pen',
        'kind': 'equipment',
        'active': true,
      });
      requirements = [
        ['room', 'pen'],
      ];
      await mount(tester, const ServicesScreen());
      await tester.tap(find.text('QA Facial'));
      await settle(tester);
      expect(
        find.textContaining('This setup mixes resource types'),
        findsOneWidget,
      );
      await tester.tap(find.text('Save'));
      await settle(tester);
      expect(
        find.text(
          'Put rooms, beds, chairs and equipment in separate requirements before saving',
        ),
        findsOneWidget,
      );
      expect(requests.where((request) => request.method == 'PATCH'), isEmpty);
      await tester.tap(
        find.widgetWithText(CheckboxListTile, 'Hydrafacial pen'),
      );
      await settle(tester);
      expect(
        find.textContaining('This setup mixes resource types'),
        findsNothing,
      );
      expect(
        tester
            .widget<CheckboxListTile>(
              find.widgetWithText(CheckboxListTile, 'Hydrafacial pen'),
            )
            .onChanged,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'resource setup shows scoped data and recovers from a generic network error',
    (tester) async {
      failResources = true;
      await mount(tester, ResourcesScreen(controller: calendar));
      expect(find.textContaining('private detail'), findsNothing);
      expect(find.text('Try again'), findsOneWidget);
      failResources = false;
      await tester.tap(find.text('Try again'));
      await settle(tester);
      expect(find.text('Treatment room'), findsOneWidget);
      expect(
        requests.every(
          (request) =>
              request.headers['Authorization'] == 'Bearer fixture-token',
        ),
        true,
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'add resource opens its editor, rejects blank names, and saves one resource',
    (tester) async {
      await mount(tester, ResourcesScreen(controller: calendar));
      await tester.tap(find.text('Add resource'));
      await settle(tester);
      expect(find.text('New resource'), findsOneWidget);
      await tester.tap(find.text('Save resource'));
      await settle(tester);
      expect(find.text('Use a name of 1–80 characters'), findsOneWidget);
      expect(requests.where((request) => request.method == 'POST'), isEmpty);
      await tester.enterText(
        find.byType(TextField).first,
        'Second treatment room',
      );
      await tester.tap(find.text('Save resource'));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await settle(tester);
      final writes = requests
          .where((request) => request.method == 'POST')
          .toList();
      expect(writes, hasLength(1));
      expect(writes.single.url.path, '/businesses/business/resources');
      expect(jsonDecode(writes.single.body), {
        'name': 'Second treatment room',
        'kind': 'room',
        'fixedRoomId': null,
        'active': true,
        'quantity': 1,
      });
      expect(find.text('New resource'), findsNothing);
      expect(find.text('Second treatment room'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'quantity validates bounds and saves interchangeable equipment inventory',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await mount(tester, ResourcesScreen(controller: calendar));
      await tester.tap(find.text('Add resource'));
      await settle(tester);
      await tester.enterText(find.byType(TextField).first, 'Hydrafacial pens');
      await tester.tap(find.byType(DropdownButtonFormField<String>).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Equipment').last);
      await settle(tester);
      for (final invalid in ['0', '21', '1.5', '']) {
        await tester.enterText(find.byType(TextField).last, invalid);
        await tester.tap(find.text('Save resource'));
        await settle(tester);
        expect(
          find.text('Enter a whole quantity from 1 to 20'),
          findsOneWidget,
        );
        expect(requests.where((request) => request.method == 'POST'), isEmpty);
      }
      await tester.enterText(find.byType(TextField).last, '2');
      await tester.tap(find.text('Save resource'));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 30)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await settle(tester);
      final write = requests.singleWhere((request) => request.method == 'POST');
      expect(jsonDecode(write.body), containsPair('quantity', 2));
      expect(jsonDecode(write.body), containsPair('kind', 'equipment'));
      expect(find.text('Equipment · Quantity 2'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  for (final type in ['Bed', 'Chair']) {
    testWidgets(
      '$type inventory requires a room and saves quantity and parent together',
      (tester) async {
        tester.view.physicalSize = const Size(900, 1800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        await mount(tester, ResourcesScreen(controller: calendar));
        await tester.tap(find.text('Add resource'));
        await settle(tester);
        await tester.enterText(find.byType(TextField).first, '$type inventory');
        await tester.tap(find.byType(DropdownButtonFormField<String>).first);
        await tester.pumpAndSettle();
        await tester.tap(find.text(type).last);
        await settle(tester);
        await tester.enterText(find.byType(TextField).last, '2');
        await tester.tap(find.text('Save resource'));
        await settle(tester);
        expect(
          find.text('Choose the room containing these beds or chairs'),
          findsOneWidget,
        );
        expect(requests.where((request) => request.method == 'POST'), isEmpty);
        await tester.tap(find.byType(DropdownButtonFormField<String>).last);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Treatment room').last);
        await settle(tester);
        await tester.tap(find.text('Save resource'));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 30)),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        await settle(tester);
        final payload = jsonDecode(
          requests.singleWhere((request) => request.method == 'POST').body,
        );
        expect(payload, containsPair('fixedRoomId', 'room'));
        expect(payload, containsPair('quantity', 2));
        expect(payload, containsPair('kind', type.toLowerCase()));
        expect(tester.takeException(), isNull);
      },
    );
  }
  testWidgets(
    'service editor shows station capacity and keeps equipment in a separate requirement',
    (tester) async {
      tester.view.physicalSize = const Size(900, 2200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      resources.addAll([
        {
          'id': 'beds',
          'name': 'Facial beds',
          'kind': 'bed',
          'quantity': 2,
          'active': true,
          'fixedRoomId': 'room',
        },
        {
          'id': 'pens',
          'name': 'Facial pens',
          'kind': 'equipment',
          'quantity': 2,
          'active': true,
        },
      ]);
      await mount(tester, const ServicesScreen());
      await tester.tap(find.text('QA Facial'));
      await settle(tester);
      await tester.tap(find.text('Add resource requirement'));
      await settle(tester);
      await tester.tap(find.widgetWithText(CheckboxListTile, 'Facial beds'));
      await settle(tester);
      expect(find.text('Bed · Quantity 2'), findsOneWidget);
      expect(
        tester
            .widget<CheckboxListTile>(
              find.widgetWithText(CheckboxListTile, 'Facial pens'),
            )
            .onChanged,
        isNull,
      );
      await tester.tap(find.text('Add resource requirement'));
      await settle(tester);
      await tester.tap(
        find.widgetWithText(CheckboxListTile, 'Facial pens').last,
      );
      await settle(tester);
      await tester.tap(find.text('Save'));
      await settle(tester);
      final payload = jsonDecode(
        requests.singleWhere((request) => request.method == 'PATCH').body,
      );
      expect(
        payload,
        containsPair('resourceRequirements', [
          {
            'anyOfResourceIds': ['beds'],
          },
          {
            'anyOfResourceIds': ['pens'],
          },
        ]),
      );
      expect(tester.takeException(), isNull);
    },
  );

  for (final kind in ['bed', 'chair']) {
    testWidgets(
      'service editor rejects whole room plus $kind and saves after removing the room requirement',
      (tester) async {
        tester.view.physicalSize = const Size(900, 2600);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        resources.addAll([
          {
            'id': 'station',
            'name': 'Treatment station',
            'kind': kind,
            'quantity': 2,
            'active': true,
            'fixedRoomId': 'room',
          },
          {
            'id': 'pen',
            'name': 'Facial pens',
            'kind': 'equipment',
            'quantity': 2,
            'active': true,
          },
        ]);
        requirements = [
          ['room'],
          ['station'],
          ['pen'],
        ];
        await mount(tester, const ServicesScreen());
        await tester.tap(find.text('QA Facial'));
        await settle(tester);
        await tester.tap(find.text('Save'));
        await settle(tester);
        expect(
          find.text(
            'Choose either a whole room or a bed/chair. A bed/chair already includes its room.',
          ),
          findsOneWidget,
        );
        expect(requests.where((request) => request.method == 'PATCH'), isEmpty);
        await tester.tap(find.byTooltip('Remove requirement').first);
        await settle(tester);
        await tester.tap(find.text('Save'));
        await settle(tester);
        final saved = jsonDecode(
          requests.singleWhere((request) => request.method == 'PATCH').body,
        ) as Map<String, dynamic>;
        expect(saved['resourceRequirements'], [
          {
            'anyOfResourceIds': ['station'],
          },
          {
            'anyOfResourceIds': ['pen'],
          },
        ]);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'appointment recipient selection returns the family member without changing the contact',
    (tester) async {
      AppointmentHolderItem? chosen;
      await mount(
        tester,
        Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                chosen = await Navigator.push<AppointmentHolderItem>(
                  context,
                  MaterialPageRoute(
                    builder: (_) => const AppointmentHoldersScreen(
                      clientId: 'client',
                      select: true,
                    ),
                  ),
                );
              },
              child: const Text('Choose recipient'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Choose recipient'));
      await settle(tester);
      await tester.tap(find.text('Sam'));
      await tester.pumpAndSettle();
      expect(chosen?.id, 'child');
      expect(
        requests.single.url.path,
        '/businesses/business/clients/client/holders',
      );
      expect(requests.single.method, 'GET');
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'appointment holder edit validates blank names and closes without controller lifecycle errors',
    (tester) async {
      await mount(tester, const AppointmentHoldersScreen(clientId: 'client'));
      await tester.tap(find.text('Sam'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), '');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.text('Enter a name'), findsOneWidget);
      await tester.tap(find.text('Keep'));
      await tester.pumpAndSettle();
      expect(requests.every((request) => request.method == 'GET'), true);
      expect(tester.takeException(), isNull);
    },
  );
  test('consecutive offer parser caps appointments and rejects missing treatment details', () {
    final offer = AvailableSlot.fromJson({
      'staffId': 'staff',
      'startsAt': '2026-10-12T10:00:00Z',
      'appointments': [
        {
          'serviceId': 'facial',
          'staffId': 'staff',
          'startsAt': '2026-10-12T10:00:00Z',
          'durationMinutes': 30,
        },
        {
          'serviceId': 'massage',
          'staffId': 'other',
          'startsAt': '2026-10-12T10:45:00Z',
          'durationMinutes': 60,
        },
      ],
    });
    expect(offer.appointments.last.serviceId, 'massage');
    expect(
      offer.appointments.last.startsAt,
      DateTime.utc(2026, 10, 12, 10, 45),
    );
    expect(
      () => AvailableSlot.fromJson({
        'staffId': 'staff',
        'startsAt': '2026-10-12T10:00:00Z',
        'appointments': List.generate(6, (_) => {'serviceId': 'service'}),
      }),
      throwsFormatException,
    );
    expect(
      () => SequenceAppointment.fromJson({
        'serviceId': 'facial',
        'staffId': 'staff',
        'startsAt': '2026-10-12T10:00:00Z',
        'durationMinutes': 0,
      }),
      throwsFormatException,
    );
  });
  test('new booking mutations preserve recipient, sequence and audit reason without exposing credentials', () async {
    await api.walkIn(
      'business',
      serviceId: 'facial',
      staffId: 'first',
      startsAt: DateTime(2026, 10, 12, 15),
      clientId: 'contact',
      appointmentHolderId: 'child',
      additionalServices: [
        {'serviceId': 'massage', 'staffId': 'second'},
      ],
      requestId: 's' * 32,
    );
    final body = jsonDecode(requests.last.body) as Map<String, dynamic>;
    expect(body['clientId'], 'contact');
    expect(body['appointmentHolderId'], 'child');
    expect(body['additionalServices'], [
      {'serviceId': 'massage', 'staffId': 'second'},
    ]);
    expect(body.containsKey('token'), false);
    await api.setOutcome(
      'business',
      'booking',
      'completed',
      earlyCompletionReason: 'Treatment finished early',
    );
    expect(
      (jsonDecode(requests.last.body)
          as Map<String, dynamic>)['earlyCompletionReason'],
      'Treatment finished early',
    );
  });
}
