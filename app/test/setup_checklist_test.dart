import 'package:flutter_test/flutter_test.dart';
import 'package:scalivo_owner/api/models.dart';

/// The checklist is the only thing in the app that explains an empty diary.
///
/// Every gap it reports fails silently on the customer's side — an unbookable
/// business and a fully booked one both return an empty slot list — so the
/// cases worth pinning here are the ones where the card would quietly stop
/// saying anything, or start contradicting the banner beside it.
void main() {
  SetupChecklist parse(List<Map<String, dynamic>> steps, {bool bookable = false}) =>
      SetupChecklist.fromJson({'bookable': bookable, 'steps': steps});

  group('SetupChecklist.blocking', () {
    test('drops WhatsApp so the card cannot contradict the live banner', () {
      // The real shape for the seeded business: everything configured, only the
      // number unlinked. `auth.health` already says so on the banner and the
      // session pill, and it is live where this is a snapshot — two widgets
      // disagreeing about the session is worse than the gap this class fixes.
      final checklist = parse([
        {'id': 'services', 'done': true, 'detail': null},
        {'id': 'staff', 'done': true, 'detail': null},
        {'id': 'hours', 'done': true, 'detail': null},
        {'id': 'coverage', 'done': true, 'detail': null},
        {'id': 'whatsapp', 'done': false, 'detail': 'Connect a WhatsApp number'},
      ]);

      expect(checklist.bookable, isFalse);
      expect(checklist.blocking, isEmpty);
    });

    test('keeps completed steps out of the card', () {
      final checklist = parse([
        {'id': 'services', 'done': true, 'detail': null},
        {'id': 'staff', 'done': false, 'detail': 'Add at least one person'},
      ]);

      expect(checklist.blocking.map((s) => s.id), ['staff']);
    });

    test('carries the coverage detail through verbatim', () {
      // The one thing the app could not work out for itself: which services
      // nobody is assigned to. Measured live against the seeded business.
      final checklist = parse([
        {'id': 'coverage', 'done': false, 'detail': 'Nobody can perform: Coverage Probe'},
      ]);

      expect(checklist.blocking.single.detail, 'Nobody can perform: Coverage Probe');
    });

    test('a step id the app has never heard of still reaches the owner', () {
      // The backend owns this vocabulary and may add a step before the app is
      // rebuilt. An unknown id must be one more row to read, not a crash on the
      // screen whose whole job is explaining what is wrong.
      final checklist = parse([
        {'id': 'payments', 'done': false, 'detail': 'Connect a payout account'},
      ]);

      expect(checklist.blocking.single.id, 'payments');
    });

    test('a fully set-up business asks for nothing', () {
      final checklist = parse([
        {'id': 'services', 'done': true, 'detail': null},
        {'id': 'whatsapp', 'done': true, 'detail': null},
      ], bookable: true);

      expect(checklist.bookable, isTrue);
      expect(checklist.blocking, isEmpty);
    });
  });

  group('SetupChecklist.fromJson', () {
    test('a malformed payload reads as "not bookable", never as ready', () {
      // Defaulting `bookable` to true on a bad response would tell an owner
      // their broken setup is fine, which is the exact failure being fixed.
      final checklist = SetupChecklist.fromJson(const {});

      expect(checklist.bookable, isFalse);
      expect(checklist.steps, isEmpty);
      expect(checklist.blocking, isEmpty);
    });
  });
}
