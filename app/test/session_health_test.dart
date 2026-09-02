import 'package:flutter_test/flutter_test.dart';
import 'package:scalivo_owner/api/models.dart';

/// SPIKE FINDING #2, encoded as tests.
///
/// The measured event set for a phone-side unlink was `session.qr` followed 4ms
/// later by `session.status: qr_ready` — and `disconnected` never fired once
/// across the whole spike. So the banner cannot be driven by status alone; it
/// takes status *and* what we believed should be happening. These cases are the
/// ones that would silently break a monitor.
void main() {
  group('sessionHealthOf', () {
    test('ready while we expect it live is the healthy case', () {
      expect(sessionHealthOf('ready', 'live'), SessionHealth.live);
    });

    test('qr_ready while we expect it live is the alarm, not a fresh link', () {
      // This is the one that matters. An owner unlinked the device from their
      // phone; WhatsApp reports qr_ready and nothing else. If this returned
      // anything but `down`, the app would sit quiet through a dead session.
      expect(sessionHealthOf('qr_ready', 'live'), SessionHealth.down);
    });

    test('qr_ready while we are linking is ours, and not an alarm', () {
      expect(sessionHealthOf('qr_ready', 'linking'), SessionHealth.linking);
    });

    test('disconnected while live is also down — network drops still count', () {
      expect(sessionHealthOf('disconnected', 'live'), SessionHealth.down);
    });

    test('action_required and failed while live are both down', () {
      expect(sessionHealthOf('action_required', 'live'), SessionHealth.down);
      expect(sessionHealthOf('failed', 'live'), SessionHealth.down);
    });

    test('a stopped session is not an alarm', () {
      expect(sessionHealthOf('qr_ready', 'stopped'), SessionHealth.notConnected);
    });

    test('an unlinked business reads as not connected, never as healthy', () {
      expect(sessionHealthOf(null, null), SessionHealth.notConnected);
      expect(sessionHealthOf('ready', null), SessionHealth.notConnected);
    });
  });

  group('BusinessSummary', () {
    test('reads health from the nested whatsapp object', () {
      final business = BusinessSummary.fromJson(const {
        'id': 'b1',
        'name': 'Skinare Aesthetics',
        'category': 'salon',
        'whatsapp': {'status': 'qr_ready', 'intent': 'live'},
      });

      expect(business.name, 'Skinare Aesthetics');
      expect(business.health, SessionHealth.down);
    });

    test('survives a business with no session at all', () {
      final business = BusinessSummary.fromJson(const {'id': 'b1', 'name': 'New Salon'});
      expect(business.health, SessionHealth.notConnected);
    });
  });
}
