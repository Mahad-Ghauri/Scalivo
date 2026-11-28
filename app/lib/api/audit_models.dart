/// The audit report: the same one the web dashboard and the PDF show.
class AuditEvent {
  const AuditEvent({
    required this.at,
    required this.category,
    required this.title,
    required this.detail,
    required this.actor,
    required this.tone,
  });

  final DateTime at;
  final String category, title, detail, actor;

  /// ok | warning | problem
  final String tone;

  factory AuditEvent.fromJson(Map<String, dynamic> json) => AuditEvent(
    at: DateTime.parse(json['at'] as String),
    category: json['category'] as String? ?? '',
    title: json['title'] as String? ?? '',
    detail: json['detail'] as String? ?? '',
    actor: json['actor'] as String? ?? '',
    tone: json['tone'] as String? ?? 'ok',
  );
}

class AuditReport {
  const AuditReport({
    required this.summary,
    required this.events,
    required this.truncated,
  });

  final Map<String, dynamic> summary;
  final List<AuditEvent> events;
  final bool truncated;

  int count(String key) => (summary[key] as num?)?.toInt() ?? 0;
  int bySource(String key) =>
      ((summary['bySource'] as Map?)?[key] as num?)?.toInt() ?? 0;
  num? maybe(String key) => summary[key] as num?;

  factory AuditReport.fromJson(Map<String, dynamic> json) => AuditReport(
    summary: (json['summary'] as Map?)?.cast<String, dynamic>() ?? const {},
    events: [
      for (final e in (json['events'] as List? ?? const []))
        AuditEvent.fromJson((e as Map).cast<String, dynamic>()),
    ],
    truncated: json['truncated'] == true,
  );
}

const auditCategories = <(String, String)>[
  ('', 'Everything'),
  ('booking', 'Bookings'),
  ('message', 'Messages'),
  ('payment', 'Payments'),
  ('whatsapp', 'WhatsApp'),
  ('review', 'Reviews'),
  ('marketing', 'Marketing'),
  ('services', 'Services'),
  ('staff', 'Staff'),
  ('customers', 'Customers'),
  ('calendar', 'Calendar'),
  ('settings', 'Settings'),
];
