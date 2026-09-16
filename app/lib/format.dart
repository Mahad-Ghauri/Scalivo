/// Dates, times and money, formatted by hand.
///
/// `intl` is not a dependency and is not worth becoming one: it is a large
/// package carrying every locale on earth, and this app needs five formats in
/// one locale. The trade is deliberate — see the dependency note in pubspec.
///
/// Everything here takes a LOCAL DateTime. The API layer converts on the way in
/// (`_utc` in models.dart), so nothing below ever calls toLocal itself.
library;

const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _daysLong = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
];
const _months = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

String _two(int n) => n.toString().padLeft(2, '0');

/// 'YYYY-MM-DD' — the only date form the calendar API accepts.
String isoDate(DateTime d) => '${d.year}-${_two(d.month)}-${_two(d.day)}';

DateTime parseIsoDate(String date) {
  final parts = date.split('-');
  return DateTime(int.parse(parts[0]), int.parse(parts[1]), int.parse(parts[2]));
}

/// Midnight today, in the phone's zone. The anchor every date jump starts from.
DateTime startOfToday() {
  final now = DateTime.now();
  return DateTime(now.year, now.month, now.day);
}

bool isSameDay(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;

/// '4:30 PM'. Twelve-hour because every price list and shop sign in the market
/// this is built for is twelve-hour.
String hhmm(DateTime d) {
  final hour = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '$hour:${_two(d.minute)} ${d.hour < 12 ? 'AM' : 'PM'}';
}

/// 'Tue, 3 Mar'
String dayLabel(DateTime d) => '${_days[d.weekday - 1]}, ${d.day} ${_months[d.month - 1]}';

/// 'Tuesday 3 March' — the calendar header, where there is room for it.
String dayLabelLong(DateTime d) => '${_daysLong[d.weekday - 1]} ${d.day} ${_months[d.month - 1]}';

/// 'Today', 'Tomorrow', 'Yesterday', or the date. Used anywhere a bare date
/// would make the owner count days in their head.
String relativeDay(DateTime d) {
  final today = startOfToday();
  final diff = DateTime(d.year, d.month, d.day).difference(today).inDays;
  return switch (diff) {
    0 => 'Today',
    1 => 'Tomorrow',
    -1 => 'Yesterday',
    _ => dayLabel(d),
  };
}

/// 'Rs 8,000'. Minor units are paisa and are never shown — the backend's
/// formatPrice does the same, and the two must agree or the confirmation
/// message and the calendar disagree about the price of the same appointment.
String money(int priceMinor) {
  final rupees = (priceMinor / 100).round();
  final digits = rupees.toString();

  final buffer = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
    buffer.write(digits[i]);
  }
  return 'Rs $buffer';
}

/// '45 min', '1h', '1h 30m'. An hour written as '60 min' reads as a mistake.
String duration(int minutes) {
  if (minutes < 60) return '$minutes min';
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  return rest == 0 ? '${hours}h' : '${hours}h ${rest}m';
}

/// How a reminder lead time is offered in settings.
String leadLabel(int minutes) {
  if (minutes % 1440 == 0) {
    final days = minutes ~/ 1440;
    return days == 1 ? '1 day before' : '$days days before';
  }
  if (minutes % 60 == 0) {
    final hours = minutes ~/ 60;
    return hours == 1 ? '1 hour before' : '$hours hours before';
  }
  return '$minutes minutes before';
}

/// 'never', '3 days ago', '2 months ago'. The CRM's at-a-glance recency.
String agoLabel(DateTime? when) {
  if (when == null) return 'never';
  final days = startOfToday().difference(DateTime(when.year, when.month, when.day)).inDays;
  if (days <= 0) return 'today';
  if (days == 1) return 'yesterday';
  if (days < 30) return '$days days ago';
  final months = (days / 30).floor();
  if (months < 12) return months == 1 ? 'a month ago' : '$months months ago';
  final years = (days / 365).floor();
  return years == 1 ? 'a year ago' : '$years years ago';
}
