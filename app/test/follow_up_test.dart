import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:scalivo_owner/push/push_service.dart';
import 'package:scalivo_owner/screens/follow_ups_screen.dart';
import 'package:scalivo_owner/state/auth_controller.dart';
import 'package:scalivo_owner/theme.dart';
import 'package:scalivo_owner/widgets/follow_up_fields.dart';

Map<String, dynamic> entryJson({Object? followUp, Object? reminderState}) => {
  'id': 'b1',
  'staffId': 's1',
  'staffName': 'Ayesha',
  'clientId': 'c1',
  'clientName': 'Sana',
  'serviceId': 'laser',
  'serviceName': 'Laser',
  'startsAt': '2030-03-01T06:00:00.000Z',
  'endsAt': '2030-03-01T06:30:00.000Z',
  'durationMinutes': 30,
  'status': 'completed',
  'priceMinor': 500000,
  'source': 'whatsapp',
  'reminderState': ?reminderState,
  'followUp': ?followUp,
};

void main() {
  group('models', () {
    test('a calendar entry carries its follow-up and reminder badge', () {
      final entry = CalendarEntry.fromJson(
        entryJson(
          reminderState: 'confirmed',
          followUp: {
            'status': 'scheduled',
            'dueAt': '2030-03-22T06:00:00.000Z',
            'serviceId': 'laser',
            'staffId': 's1',
            'note': 'Session 2 of 6',
          },
        ),
      );
      expect(entry.reminderState, 'confirmed');
      expect(entry.followUp!.status, 'scheduled');
      expect(entry.followUp!.editable, isTrue);
      expect(entry.followUp!.note, 'Session 2 of 6');
      // Business-local (Asia/Karachi, UTC+5).
      expect(entry.followUp!.dueAt.hour, 11);
    });

    test('unknown badge values are dropped and an offered follow-up is read-only', () {
      final entry = CalendarEntry.fromJson(
        entryJson(
          reminderState: 'something-new',
          followUp: {
            'status': 'offered',
            'dueAt': '2030-03-22T06:00:00.000Z',
            'serviceId': 'laser',
          },
        ),
      );
      expect(entry.reminderState, isNull);
      expect(entry.followUp!.editable, isFalse);
      expect(CalendarEntry.fromJson(entryJson()).followUp, isNull);
    });

    test('a malformed follow-up status is refused, not drawn', () {
      expect(
        () => FollowUpInfo.fromJson({
          'status': 'hacked',
          'dueAt': '2030-03-22T06:00:00.000Z',
          'serviceId': 'x',
        }, 'Asia/Karachi'),
        throwsFormatException,
      );
    });

    test('days are bounded and notes trimmed', () {
      expect(FollowUpFields.parseDays('21'), 21);
      expect(FollowUpFields.parseDays(' 365 '), 365);
      for (final bad in ['0', '366', '-3', '2.5', 'abc', '']) {
        expect(FollowUpFields.parseDays(bad), isNull, reason: bad);
      }
      expect(FollowUpFields.cleanNote('   '), isNull);
      expect(FollowUpFields.cleanNote(' hi '), 'hi');
      expect(FollowUpFields.cleanNote('x' * 250)!.length, 200);
    });
  });

  test('the follow-up push opens the app', () {
    expect(PushService.notificationRoute({'route': '/follow-ups'}), '/follow-ups');
    expect(PushService.notificationRoute({'route': '/appointments'}), '/appointments');
  });

  group('api', () {
    late List<http.Request> requests;
    late ApiClient api;

    setUp(() {
      requests = [];
      api = ApiClient(
        client: MockClient((request) async {
          requests.add(request);
          if (request.method == 'DELETE') return http.Response('', 204);
          if (request.method == 'PATCH') {
            return http.Response(jsonEncode({'id': 'laser', 'name': 'Laser'}), 200);
          }
          if (request.method == 'PUT') {
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            return http.Response(
              jsonEncode({
                'followUp': {
                  'status': 'scheduled',
                  'dueAt': '2030-03-22T06:00:00.000Z',
                  'serviceId': 'laser',
                  'staffId': 's1',
                  'note': body['note'],
                },
              }),
              200,
            );
          }
          return http.Response(
            jsonEncode({
              'followUps': [
                {
                  'bookingId': 'b1',
                  'status': 'lapsed',
                  'dueAt': '2030-03-22T06:00:00.000Z',
                  'visitAt': '2030-03-01T06:00:00.000Z',
                  'serviceName': 'Laser',
                  'staffName': 'Ayesha',
                  'clientName': 'Sana',
                  'clientPhone': '923001234567',
                  'lapsedReason': 'no_reply',
                  'note': null,
                },
              ],
            }),
            200,
          );
        }),
      );
    });

    test('set, clear and list use the follow-up routes', () async {
      final saved = await api.setFollowUp('biz', 'b1', afterDays: 21, note: 'Session 2');
      expect(saved.note, 'Session 2');
      expect(requests.last.method, 'PUT');
      expect(requests.last.url.path, endsWith('/businesses/biz/bookings/b1/follow-up'));
      expect(jsonDecode(requests.last.body), {'afterDays': 21, 'note': 'Session 2'});

      await api.clearFollowUp('biz', 'b1');
      expect(requests.last.method, 'DELETE');

      final list = await api.followUps('biz', status: 'lapsed');
      expect(requests.last.url.queryParameters['status'], 'lapsed');
      expect(list.single.lapsedReason, 'no_reply');
      expect(list.single.clientPhone, '923001234567');
    });

    testWidgets('the screen lists people to call with why', (tester) async {
      final auth = AuthController(api: api)
        ..status = AuthStatus.signedIn
        ..me = const Me(
          name: 'Owner',
          email: 'owner@example.test',
          businesses: [
            BusinessSummary(
              id: 'biz',
              name: 'Clinic',
              category: 'clinic',
              whatsappStatus: 'ready',
              whatsappIntent: 'live',
            ),
          ],
        );
      addTearDown(auth.dispose);
      await tester.pumpWidget(
        ChangeNotifierProvider.value(
          value: auth,
          child: MaterialApp(
            theme: buildScalivoTheme(),
            home: const FollowUpsScreen(initialFilter: 'lapsed'),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(requests.single.url.queryParameters['status'], 'lapsed');
      expect(find.text('Sana'), findsOneWidget);
      expect(find.text('NEEDS A CALL'), findsOneWidget);
      expect(find.text('No reply to 2 messages'), findsOneWidget);

      final opened = <Uri>[];
      launcher = (uri) async {
        opened.add(uri);
        return true;
      };
      addTearDown(() => launcher = (_) async => false);
      await tester.tap(find.byKey(const Key('call-b1')));
      await tester.tap(find.byKey(const Key('whatsapp-b1')));
      expect(opened.map((u) => '$u'), ['tel:+923001234567', 'https://wa.me/923001234567']);

      // A device that can't dial still gets the number.
      launcher = (_) async => false;
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (
        call,
      ) async {
        if (call.method == 'Clipboard.setData') {
          copied = (call.arguments as Map)['text'] as String?;
        }
        return null;
      });
      await tester.tap(find.byKey(const Key('call-b1')));
      await tester.pumpAndSettle();
      expect(copied, '923001234567');
      expect(find.textContaining('923001234567 copied'), findsOneWidget);
    });

    test('a service saves, and can clear, its follow-up default', () async {
      await api.saveService(
        'biz',
        serviceId: 'laser',
        name: 'Laser',
        durationMinutes: 30,
        bufferMinutes: 0,
        priceMinor: 1,
        followUpDays: 21,
        followUpNote: 'Next session',
        setFollowUp: true,
      );
      var body = jsonDecode(requests.last.body) as Map<String, dynamic>;
      expect(body['followUpDays'], 21);
      expect(body['followUpNote'], 'Next session');

      await api.saveService(
        'biz',
        serviceId: 'laser',
        name: 'Laser',
        durationMinutes: 30,
        bufferMinutes: 0,
        priceMinor: 1,
        setFollowUp: true,
      );
      body = jsonDecode(requests.last.body) as Map<String, dynamic>;
      expect(body.containsKey('followUpDays'), isTrue);
      expect(body['followUpDays'], isNull);

      // Callers that don't show the field leave it alone.
      await api.saveService(
        'biz',
        serviceId: 'laser',
        name: 'Laser',
        durationMinutes: 30,
        bufferMinutes: 0,
        priceMinor: 1,
      );
      body = jsonDecode(requests.last.body) as Map<String, dynamic>;
      expect(body.containsKey('followUpDays'), isFalse);
    });
  });
}
