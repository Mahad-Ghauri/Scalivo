import 'growth_models.dart';

class AgentSettings {
  AgentSettings.fromJson(Map<String, dynamic> json)
    : enabled = wireBool(json['enabled']),
      hour = wireCount(json['hour']) {
    if (hour < 5 || hour > 11) {
      throw const FormatException('Invalid briefing hour');
    }
  }
  final bool enabled;
  final int hour;
}

class BriefingAction {
  BriefingAction.fromJson(Map<String, dynamic> json)
    : label = wireText(json['label'], max: 120),
      href = wireText(json['href'], max: 200);
  final String label, href;
}

class Briefing {
  Briefing.fromJson(Map<String, dynamic> json)
    : id = wireText(json['id'], max: 24),
      kind = wireText(json['kind'], max: 10),
      headline = wireText(json['headline'], max: 200),
      body = wireText(json['body'], max: 700),
      scheduledFor = wireDate(json['scheduledFor']),
      phrasedBy = wireText(json['phrasedBy'], max: 10),
      readAt = json['readAt'] == null ? null : wireDate(json['readAt']),
      actions = wireList(json['actions'], BriefingAction.fromJson, 4) {
    if (!RegExp(r'^[a-fA-F0-9]{24}$').hasMatch(id) ||
        !['daily', 'weekly', 'alert'].contains(kind) ||
        !['gemini', 'template'].contains(phrasedBy)) {
      throw const FormatException('Invalid briefing');
    }
  }
  final String id, kind, headline, body, phrasedBy;
  final DateTime scheduledFor;
  final DateTime? readAt;
  final List<BriefingAction> actions;
}

class BriefingFeed {
  BriefingFeed.fromJson(Map<String, dynamic> json)
    : settings = AgentSettings.fromJson(wireMap(json['settings'])),
      briefings = wireList(json['briefings'], Briefing.fromJson, 20),
      unread = wireCount(json['unread']);
  final AgentSettings settings;
  final List<Briefing> briefings;
  final int unread;
}
