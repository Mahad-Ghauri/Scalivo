/// Owner-facing Phase 2 contracts. Validate wire data before it reaches widgets.
library;

Map<String, dynamic> wireMap(dynamic value) {
  if (value is! Map<String, dynamic>) {
    throw const FormatException('Invalid object');
  }
  return value;
}

String wireText(dynamic value, {int max = 2000}) {
  if (value is! String || value.length > max) {
    throw const FormatException('Invalid text');
  }
  return value;
}

int wireCount(dynamic value) {
  if (value is! int || value < 0 || value > 9007199254740991) {
    throw const FormatException('Invalid count');
  }
  return value;
}

bool wireBool(dynamic value) {
  if (value is! bool) throw const FormatException('Invalid boolean');
  return value;
}

double? wireRate(dynamic value) {
  if (value == null) return null;
  if (value is! num || !value.isFinite || value < 0 || value > 1) {
    throw const FormatException('Invalid rate');
  }
  return value.toDouble();
}

List<T> wireList<T>(
  dynamic value,
  T Function(Map<String, dynamic>) parse,
  int max,
) {
  if (value is! List || value.length > max) {
    throw const FormatException('Invalid list');
  }
  return value.map((row) => parse(wireMap(row))).toList(growable: false);
}

DateTime wireDate(dynamic value) {
  final parsed = DateTime.tryParse(wireText(value, max: 40));
  if (parsed == null) throw const FormatException('Invalid date');
  return parsed;
}

class RevenuePoint {
  RevenuePoint.fromJson(Map<String, dynamic> json)
    : period = wireText(json['period'], max: 20),
      revenueMinor = wireCount(json['revenueMinor']),
      completed = wireCount(json['completed']);
  final String period;
  final int revenueMinor;
  final int completed;
}

class RankedRevenue {
  RankedRevenue.fromService(Map<String, dynamic> json)
    : name = wireText(json['name'], max: 120),
      amountMinor = wireCount(json['revenueMinor']),
      visits = wireCount(json['completed']);
  RankedRevenue.fromClient(Map<String, dynamic> json)
    : name = wireText(json['name'], max: 120),
      amountMinor = wireCount(json['lifetimeSpendMinor']),
      visits = wireCount(json['totalVisits']);
  final String name;
  final int amountMinor;
  final int visits;
}

class AnalyticsReport {
  AnalyticsReport.fromJson(Map<String, dynamic> json)
    : revenueMinor = wireCount(json['revenueMinor']),
      series = wireList(json['series'], RevenuePoint.fromJson, 367),
      volume = Map.unmodifiable({
        for (final key in [
          'total',
          'completed',
          'noShow',
          'cancelled',
          'upcoming',
        ])
          key: wireCount(wireMap(json['volume'])[key]),
      }),
      noShowRate = wireRate(json['noShowRate']),
      topServices = wireList(json['topServices'], RankedRevenue.fromService, 5),
      topClients = wireList(json['topClients'], RankedRevenue.fromClient, 5),
      forecastMinor = wireCount(wireMap(json['forecast'])['revenueMinor']),
      forecastBookings = wireCount(wireMap(json['forecast'])['bookings']);
  final int revenueMinor;
  final List<RevenuePoint> series;
  final Map<String, int> volume;
  final double? noShowRate;
  final List<RankedRevenue> topServices;
  final List<RankedRevenue> topClients;
  final int forecastMinor;
  final int forecastBookings;
}

class OwnerReview {
  OwnerReview.fromJson(Map<String, dynamic> json)
    : id = wireText(json['id'], max: 80),
      authorName = wireText(json['authorName'], max: 120),
      clientId = json['clientId'] == null
          ? null
          : wireText(json['clientId'], max: 80),
      rating = wireCount(json['rating']),
      comment = wireText(json['comment'], max: 500),
      serviceName = json['serviceName'] == null
          ? null
          : wireText(json['serviceName'], max: 120),
      published = wireBool(json['published']),
      flagged = wireBool(json['flagged']),
      createdAt = wireDate(json['createdAt']) {
    if (rating < 1 || rating > 5) throw const FormatException('Invalid rating');
  }
  final String id, authorName, comment;
  final String? serviceName, clientId;
  final int rating;
  final bool published, flagged;
  final DateTime createdAt;
}

class ReviewSummary {
  ReviewSummary.fromJson(Map<String, dynamic> json)
    : requested = wireCount(json['requested']),
      answered = wireCount(json['answered']),
      flagged = wireCount(json['flagged']),
      captureRate = wireRate(json['captureRate']) ?? 0,
      averageRating = json['averageRating'] == null
          ? null
          : (json['averageRating'] as num).toDouble() {
    if (averageRating != null &&
        (!averageRating!.isFinite ||
            averageRating! < 1 ||
            averageRating! > 5)) {
      throw const FormatException('Invalid rating');
    }
  }
  final int requested, answered, flagged;
  final double captureRate;
  final double? averageRating;
}

class ReviewPage {
  ReviewPage.fromJson(Map<String, dynamic> json)
    : reviews = wireList(json['reviews'], OwnerReview.fromJson, 20),
      total = wireCount(json['total']);
  final List<OwnerReview> reviews;
  final int total;
}

enum CampaignAudience { atRisk, lapsed }

class CampaignOutcome {
  CampaignOutcome.fromJson(Map<String, dynamic> json)
    : counts = Map.unmodifiable({
        for (final key in [
          'sends',
          'delivered',
          'undelivered',
          'queued',
          'skipped',
          'replied',
          'rebooked',
          'optedOut',
        ])
          key: wireCount(json[key]),
      });
  final Map<String, int> counts;
}

class NudgeReport {
  NudgeReport.fromJson(Map<String, dynamic> json)
    : enabled = wireBool(json['enabled']),
      outcome = CampaignOutcome.fromJson(wireMap(json['outcome']));
  final bool enabled;
  final CampaignOutcome outcome;
}

class AudiencePreview {
  AudiencePreview.fromJson(Map<String, dynamic> json)
    : matched = wireCount(json['matched']),
      reachable = wireCount(json['reachable']),
      coldContacts = wireCount(json['coldContacts']),
      remainingToday = wireCount(wireMap(json['remainingToday'])['total']),
      suggested = wireText(json['suggested'], max: 600),
      excluded = Map.unmodifiable({
        for (final key in ['optedOut', 'recentlyMessaged', 'noAddress'])
          key: wireCount(wireMap(json['excluded'])[key]),
      });
  final int matched, reachable, coldContacts, remainingToday;
  final String suggested;
  final Map<String, int> excluded;
}

class CampaignSummary {
  CampaignSummary.fromJson(Map<String, dynamic> json)
    : id = wireText(json['id'], max: 80),
      audience = wireText(json['audience'], max: 20),
      message = wireText(json['message'], max: 600),
      status = wireText(json['status'], max: 20),
      targeted = wireCount(json['targeted']),
      createdAt = wireDate(json['createdAt']),
      outcome = CampaignOutcome.fromJson(wireMap(json['outcome'])) {
    if (!['sending', 'sent', 'cancelled'].contains(status) ||
        !['at_risk', 'lapsed'].contains(audience)) {
      throw const FormatException('Invalid campaign');
    }
  }
  final String id, audience, message, status;
  final int targeted;
  final DateTime createdAt;
  final CampaignOutcome outcome;
}

class FunnelReport {
  FunnelReport.fromJson(Map<String, dynamic> json)
    : totals = Map.unmodifiable({
        for (final key in ['views', 'starts', 'bookings'])
          key: wireCount(wireMap(json['totals'])[key]),
      }),
      whatsappBookings = wireCount(json['whatsappBookings']);
  final Map<String, int> totals;
  final int whatsappBookings;
}

class BoostState {
  BoostState.fromJson(Map<String, dynamic> json)
    : active = wireBool(json['active']),
      until = json['until'] == null ? null : wireDate(json['until']);
  final bool active;
  final DateTime? until;
}

class GrowthBusiness {
  GrowthBusiness.fromJson(Map<String, dynamic> json)
    : name = wireText(json['name'], max: 120),
      slug = wireText(json['slug'], max: 120),
      published = wireBool(json['published']),
      bookingUrl = json['bookingUrl'] == null
          ? null
          : wireText(json['bookingUrl'], max: 1000) {
    if (bookingUrl != null) {
      final uri = Uri.tryParse(bookingUrl!);
      if (uri == null ||
          !['https', 'http'].contains(uri.scheme) ||
          uri.host.isEmpty ||
          uri.userInfo.isNotEmpty ||
          (uri.scheme == 'http' &&
              !['localhost', '127.0.0.1', '::1'].contains(uri.host))) {
        throw const FormatException('Invalid booking URL');
      }
    }
  }
  final String name, slug;
  final String? bookingUrl;
  final bool published;
}

class ClientImportResult {
  ClientImportResult.fromJson(Map<String, dynamic> json)
    : dryRun = wireBool(json['dryRun']),
      counts = Map.unmodifiable({
        for (final key in [
          'created',
          'linked',
          'updated',
          'duplicate',
          'invalid',
        ])
          key: wireCount(wireMap(json['counts'])[key]),
      }),
      problems = wireList(json['rows'], ImportRowResult.fromJson, 2000)
          .where(
            (row) => row.outcome == 'invalid' || row.outcome == 'duplicate',
          )
          .toList(growable: false);
  final bool dryRun;
  final Map<String, int> counts;
  final List<ImportRowResult> problems;
  int get valid => counts['created']! + counts['linked']! + counts['updated']!;
}

class ImportRowResult {
  ImportRowResult.fromJson(Map<String, dynamic> json)
    : row = wireCount(json['row']),
      outcome = wireText(json['outcome'], max: 20),
      reason = json['reason'] == null
          ? null
          : wireText(json['reason'], max: 2000) {
    if (![
      'created',
      'linked',
      'updated',
      'duplicate',
      'invalid',
    ].contains(outcome)) {
      throw const FormatException('Invalid outcome');
    }
  }
  final int row;
  final String outcome;
  final String? reason;
}
