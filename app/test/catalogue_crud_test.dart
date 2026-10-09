import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:scalivo_owner/screens/services_screen.dart';
import 'package:scalivo_owner/screens/staff_screen.dart';
import 'package:scalivo_owner/state/auth_controller.dart';
import 'package:scalivo_owner/theme.dart';
import 'package:scalivo_owner/widgets/sc_button.dart';

void main() {
  late List<http.Request> writes;
  late Map<String, dynamic> service;
  late Map<String, dynamic> staff;
  late bool failDelete;
  late AuthController auth;

  setUp(() {
    writes = [];
    failDelete = false;
    service = {
      'id': 'service',
      'name': 'Facial',
      'durationMinutes': 30,
      'bufferMinutes': 0,
      'priceMinor': 150000,
      'active': true,
    };
    staff = {
      'id': 'staff',
      'name': 'Ayesha',
      'serviceIds': ['service'],
      'active': true,
      'workingHours': [
        {'dayOfWeek': 1, 'opensAt': '09:00', 'closesAt': '18:00', 'breaks': []},
      ],
    };
    final api = ApiClient(
      client: MockClient((request) async {
        final isService = request.url.path.contains('/services');
        final record = isService ? service : staff;
        if (request.method == 'GET') {
          expect(request.url.queryParameters['includeInactive'], 'true');
          return http.Response(
            jsonEncode({
              isService ? 'services' : 'staff': [record],
            }),
            200,
          );
        }
        writes.add(request);
        if (request.method == 'DELETE') {
          if (failDelete) {
            return http.Response(jsonEncode({'error': 'unavailable'}), 500);
          }
          record['active'] = false;
        } else {
          record.addAll(jsonDecode(request.body) as Map<String, dynamic>);
        }
        return http.Response(jsonEncode(record), 200);
      }),
    );
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

  tearDown(() => auth.dispose());

  Future<void> mount(WidgetTester tester, Widget screen) async {
    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: auth,
        child: MaterialApp(theme: buildScalivoTheme(), home: screen),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> menu(WidgetTester tester, String tooltip, String action) async {
    await tester.tap(find.byTooltip(tooltip));
    await tester.pumpAndSettle();
    await tester.tap(find.text(action));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'service create and edit use existing POST and PATCH with bounded inputs',
    (tester) async {
      await mount(tester, const ServicesScreen());
      await tester.tap(find.text('Add service'));
      await tester.pumpAndSettle();
      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'x' * 81);
      await tester.enterText(fields.at(1), '1441');
      await tester.enterText(fields.at(2), 'bad');
      await tester.enterText(fields.at(3), '-1');
      final add = find.widgetWithText(ScButton, 'Add service');
      await tester.ensureVisible(add);
      await tester.tap(add);
      await tester.pumpAndSettle();
      expect(writes, isEmpty);
      expect(find.text('Use a name of 1–80 characters'), findsOneWidget);
      expect(find.text('Use 1–1440 minutes'), findsOneWidget);
      expect(find.text('Use 0–1440 minutes'), findsOneWidget);
      expect(find.text('A price in rupees'), findsOneWidget);
      await tester.enterText(fields.at(0), 'Haircut');
      await tester.enterText(fields.at(1), '45');
      await tester.enterText(fields.at(2), '15');
      await tester.enterText(fields.at(3), '2000');
      await tester.ensureVisible(add);
      await tester.tap(add);
      await tester.pumpAndSettle();
      expect(writes.single.method, 'POST');
      expect(jsonDecode(writes.single.body)['priceMinor'], 200000);
      expect(find.text('Haircut'), findsOneWidget);
      await menu(tester, 'Service actions', 'Edit service');
      await tester.enterText(find.byType(TextField).first, 'Haircut deluxe');
      final save = find.widgetWithText(ScButton, 'Save');
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();
      expect(writes.last.method, 'PATCH');
      expect(writes.last.url.path, '/businesses/business/services/service');
      expect(find.text('Haircut deluxe'), findsOneWidget);
    },
  );

  testWidgets('service deletion is confirmed, cancellable and restorable', (
    tester,
  ) async {
    await mount(tester, const ServicesScreen());
    await menu(tester, 'Service actions', 'Delete service');
    await tester.tap(find.text('Keep service'));
    await tester.pumpAndSettle();
    expect(writes, isEmpty);
    await menu(tester, 'Service actions', 'Delete service');
    await tester.tap(find.widgetWithText(TextButton, 'Delete service'));
    await tester.pumpAndSettle();
    expect(writes.single.method, 'DELETE');
    expect(find.text('RETIRED'), findsOneWidget);
    await menu(tester, 'Service actions', 'Restore service');
    expect(writes.last.method, 'PATCH');
    expect(jsonDecode(writes.last.body), {'active': true});
    expect(find.text('RETIRED'), findsNothing);
  });

  testWidgets('failed deletion leaves the record available and allows retry', (
    tester,
  ) async {
    failDelete = true;
    await mount(tester, const ServicesScreen());
    await menu(tester, 'Service actions', 'Delete service');
    await tester.tap(find.widgetWithText(TextButton, 'Delete service'));
    await tester.pumpAndSettle();
    expect(service['active'], true);
    expect(find.text('RETIRED'), findsNothing);
    failDelete = false;
    await menu(tester, 'Service actions', 'Delete service');
    await tester.tap(find.widgetWithText(TextButton, 'Delete service'));
    await tester.pumpAndSettle();
    expect(service['active'], false);
  });

  testWidgets(
    'staff create, edit, delete and restore preserve hours and qualifications',
    (tester) async {
      await mount(tester, const StaffScreen());
      await tester.tap(find.text('Add staff'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Sana');
      await tester.tap(find.text('Facial'));
      await tester.tap(find.byType(Switch).first);
      await tester.pumpAndSettle();
      final add = find.widgetWithText(ScButton, 'Add');
      await tester.scrollUntilVisible(
        add,
        200,
        scrollable: find
            .descendant(
              of: find.byType(StaffEditScreen),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.ensureVisible(add);
      await tester.tap(add);
      await tester.pumpAndSettle();
      expect(writes.single.method, 'POST');
      expect(jsonDecode(writes.single.body)['serviceIds'], ['service']);
      final body = jsonDecode(writes.single.body) as Map<String, dynamic>;
      expect((body['workingHours'] as List<dynamic>).single['dayOfWeek'], 1);
      await menu(tester, 'Staff actions', 'Edit staff');
      await tester.enterText(find.byType(TextField), 'Sana Ali');
      final save = find.widgetWithText(ScButton, 'Save');
      await tester.scrollUntilVisible(
        save,
        200,
        scrollable: find
            .descendant(
              of: find.byType(StaffEditScreen),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.ensureVisible(save);
      await tester.tap(save);
      await tester.pumpAndSettle();
      expect(writes.last.method, 'PATCH');
      expect(find.text('Sana Ali'), findsOneWidget);
      await menu(tester, 'Staff actions', 'Delete staff');
      expect(writes.last.method, 'PATCH');
      await tester.tap(find.widgetWithText(TextButton, 'Delete staff'));
      await tester.pumpAndSettle();
      expect(writes.last.method, 'DELETE');
      await menu(tester, 'Staff actions', 'Restore staff');
      expect(jsonDecode(writes.last.body), {'active': true});
      expect(staff['workingHours'], isNotEmpty);
    },
  );

  testWidgets('staff cannot save closing hours before opening hours', (
    tester,
  ) async {
    staff['workingHours'] = [
      {'dayOfWeek': 1, 'opensAt': '18:00', 'closesAt': '09:00', 'breaks': []},
    ];
    await mount(
      tester,
      StaffEditScreen(
        api: auth.api,
        businessId: 'business',
        services: [ServiceItem.fromJson(service)],
        member: StaffMember.fromJson(staff),
      ),
    );
    final save = find.widgetWithText(ScButton, 'Save');
    await tester.scrollUntilVisible(
      save,
      200,
      scrollable: find
          .descendant(
            of: find.byType(StaffEditScreen),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(writes, isEmpty);
    await tester.scrollUntilVisible(
      find.text('Closing time must be after opening time'),
      -200,
      scrollable: find
          .descendant(
            of: find.byType(StaffEditScreen),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(
      find.text('Closing time must be after opening time'),
      findsOneWidget,
    );
  });

  testWidgets('staff creation is disabled when only retired services exist', (
    tester,
  ) async {
    service['active'] = false;
    await mount(tester, const StaffScreen());
    final add = tester.widget<FloatingActionButton>(
      find.byType(FloatingActionButton),
    );
    expect(add.onPressed, isNull);
    expect(writes, isEmpty);
  });
}
