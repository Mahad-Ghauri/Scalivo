import '../format.dart';
import 'growth_models.dart';
import 'models.dart';

const appointmentStatuses = [
  'pending',
  'awaiting_approval',
  'awaiting_deposit',
  'confirmed',
  'completed',
  'no_show',
  'cancelled',
];

class AvailableSlot {
  AvailableSlot.fromJson(Map<String, dynamic> json)
    : staffId = wireText(json['staffId'], max: 80),
      startsAt = wireDate(json['startsAt']),
      appointments = json['appointments'] == null
          ? const []
          : wireList(json['appointments'], SequenceAppointment.fromJson, 5) {
    final minutes = wireCount(
      json['durationMinutes'] ??
          (appointments.isNotEmpty ? appointments.first.durationMinutes : null),
    );
    if (minutes < 1 || minutes > 1440) {
      throw const FormatException('Invalid slot duration');
    }
  }
  final String staffId;
  final DateTime startsAt;
  final List<SequenceAppointment> appointments;
}

class SequenceAppointment {
  SequenceAppointment.fromJson(Map<String, dynamic> json)
    : serviceId = wireText(json['serviceId'], max: 80),
      staffId = wireText(json['staffId'], max: 80),
      startsAt = wireDate(json['startsAt']),
      durationMinutes = wireCount(json['durationMinutes']) {
    if (durationMinutes < 1 || durationMinutes > 1440)
      throw const FormatException('Invalid treatment duration');
  }
  final String serviceId;
  final String staffId;
  final DateTime startsAt;
  final int durationMinutes;
}

class AppointmentPage {
  AppointmentPage.fromJson(Map<String, dynamic> json, String timezone)
    : total = wireCount(json['total']),
      bookings = wireList(json['bookings'], (row) {
        final client = row['client'] == null ? null : wireMap(row['client']);
        final service = row['service'] == null ? null : wireMap(row['service']);
        final staff = row['staff'] == null ? null : wireMap(row['staff']);
        final status = wireText(row['status'], max: 30);
        final duration = wireCount(row['durationMinutes']);
        if (!appointmentStatuses.contains(status) ||
            duration < 1 ||
            duration > 1440) {
          throw const FormatException('Invalid appointment');
        }
        final start = businessTime(
          wireDate(row['startsAt']),
          timezone: timezone,
        );
        return CalendarEntry(
          revision: row['revision'] == null ? 0 : wireCount(row['revision']),
          id: wireText(row['id'], max: 80),
          staffId: staff == null ? '' : wireText(staff['id'], max: 80),
          staffName: staff == null
              ? 'Unavailable staff'
              : wireText(staff['name'], max: 120),
          clientId: client == null ? '' : wireText(client['id'], max: 80),
          clientName: row['appointmentHolderName'] is String
              ? wireText(row['appointmentHolderName'], max: 80)
              : client?['name'] == null
              ? null
              : wireText(client!['name'], max: 120),
          clientPhone: client?['phone'] == null
              ? null
              : wireText(client!['phone'], max: 32),
          serviceId: service == null ? '' : wireText(service['id'], max: 80),
          serviceName: service == null
              ? 'Unavailable service'
              : wireText(service['name'], max: 120),
          startsAt: start,
          endsAt: start.add(Duration(minutes: duration)),
          durationMinutes: duration,
          status: status,
          priceMinor: wireCount(row['priceMinor']),
          source: wireText(row['source'], max: 20),
        );
      }, 20);
  final int total;
  final List<CalendarEntry> bookings;
}

class BusinessProfile {
  BusinessProfile.fromJson(Map<String, dynamic> json)
    : name = wireText(json['name'], max: 120),
      city = json['city'] == null ? '' : wireText(json['city'], max: 80),
      timezone = wireText(json['timezone'], max: 80),
      published = wireBool(json['published']),
      slotIncrementMinutes = wireCount(json['slotIncrementMinutes']),
      profile = Map.unmodifiable({
        for (final key in [
          'tagline',
          'about',
          'neighbourhood',
          'addressLine',
          'logoUrl',
          'coverUrl',
          'themeColor',
        ])
          key: wireMap(json['profile'] ?? <String, dynamic>{})[key] == null
              ? ''
              : wireText(wireMap(json['profile'])[key], max: 2000),
      }) {
    try {
      businessTime(DateTime.now(), timezone: timezone);
    } on Exception {
      throw const FormatException('Invalid timezone');
    }
    if (![5, 10, 15, 30].contains(slotIncrementMinutes)) {
      throw const FormatException('Invalid slot size');
    }
  }
  final String name, city, timezone;
  final bool published;
  final int slotIncrementMinutes;
  final Map<String, String> profile;
}
