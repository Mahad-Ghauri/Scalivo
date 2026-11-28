import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:timezone/timezone.dart' as tz;

import '../api/api_client.dart';
import '../api/owner_booking_models.dart';
import '../format.dart';
import '../state/auth_controller.dart';
import '../widgets/owner_report_widgets.dart';
import '../widgets/sc_button.dart';
import '../widgets/sc_dropdown.dart';
import '../widgets/sc_field.dart';

class BusinessProfileScreen extends StatefulWidget {
  const BusinessProfileScreen({super.key});
  @override
  State<BusinessProfileScreen> createState() => _BusinessProfileScreenState();
}

class _BusinessProfileScreenState extends State<BusinessProfileScreen> {
  static const _fields = {
    'name': ('Business name', 120),
    'city': ('City', 80),
    'tagline': ('Tagline', 120),
    'about': ('About', 2000),
    'neighbourhood': ('Neighbourhood', 80),
    'addressLine': ('Address', 200),
    'themeColor': ('Accent colour (#1a2b3c)', 7),
  };
  final _controllers = {
    for (final key in _fields.keys) key: TextEditingController(),
  };
  BusinessProfile? _profile;
  ApiException? _error;
  bool _loading = true, _saving = false;
  String _timezone = 'Asia/Karachi';
  int _increment = 15;
  late final AuthController _auth = context.read<AuthController>();
  late final String _businessId = _auth.business!.id;
  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    if (_saving) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final profile = await _auth.api.businessProfile(_businessId);
      if (!mounted) return;
      for (final key in _controllers.keys) {
        _controllers[key]!.text = key == 'name'
            ? profile.name
            : key == 'city'
            ? profile.city
            : profile.profile[key] ?? '';
      }
      // Initializes the app's existing timezone database before offering valid zones.
      businessTime(DateTime.now(), timezone: profile.timezone);
      setState(() {
        _profile = profile;
        _timezone = profile.timezone;
        _increment = profile.slotIncrementMinutes;
        _loading = false;
      });
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err;
        _loading = false;
      });
    }
  }

  Future<void> _save() async {
    if (_saving || _loading) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final updated = await _auth.api.saveBusinessProfile(
        _businessId,
        name: _controllers['name']!.text.trim(),
        city: _controllers['city']!.text.trim(),
        timezone: _timezone,
        slotIncrementMinutes: _increment,
        profile: {
          for (final key in _controllers.keys.where(
            (k) => !['name', 'city'].contains(k),
          ))
            key: _controllers[key]!.text.trim(),
        },
      );
      if (!mounted) return;
      setState(() => _profile = updated);
      await _auth.reloadBusinesses();
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Business details saved')));
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() => _error = err);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _visibility() async {
    if (_saving || _profile == null) return;
    if (_profile!.published) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Hide your listing?'),
          content: const Text(
            'Customers will no longer find your public booking page.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Keep live'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Hide listing'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final profile = await _auth.api.setPublished(
        _businessId,
        !_profile!.published,
      );
      if (!mounted) return;
      setState(() => _profile = profile);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            profile.published ? 'Listing published' : 'Listing hidden',
          ),
        ),
      );
    } on ApiException catch (err) {
      if (mounted) setState(() => _error = err);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final zones = tz.timeZoneDatabase.locations.keys.toList()..sort();
    return OwnerReportPage(
      title: 'Business profile',
      loading: _loading,
      error: _error,
      onRefresh: _load,
      children: [
        if (_profile != null) ...[
          ReportSection(
            title: 'Marketplace listing',
            children: [
              Text(_profile!.published ? 'Live' : 'Hidden'),
              const Text(
                'Save your details before publishing. Publishing requires services, staff, working hours, city and tagline.',
              ),
              ScButton(
                label: _profile!.published ? 'Hide listing' : 'Publish listing',
                onPressed: _saving || _loading ? null : _visibility,
              ),
            ],
          ),
          for (final e in _fields.entries)
            Padding(
              padding: const EdgeInsets.only(bottom: 18),
              child: ScField(
                label: e.value.$1,
                controller: _controllers[e.key]!,
                maxLength: e.value.$2,
                enabled: !_saving && !_loading,
                errorText:
                    _error?.fieldErrors[e.key] ??
                    _error?.fieldErrors['profile.${e.key}'],
              ),
            ),
          ScDropdown<String>(
            key: ValueKey(_timezone),
            label: 'Business timezone',
            value: _timezone,
            items: zones,
            itemLabel: (zone) => zone,
            onChanged: _saving || _loading
                ? null
                : (zone) {
                    if (zone != null) setState(() => _timezone = zone);
                  },
          ),
          const SizedBox(height: 18),
          ScDropdown<int>(
            key: ValueKey(_increment),
            label: 'Slot interval (minutes)',
            value: _increment,
            items: const [5, 10, 15, 30],
            itemLabel: (value) => '$value',
            errorText: _error?.fieldErrors['slotIncrementMinutes'],
            onChanged: _saving || _loading
                ? null
                : (value) {
                    if (value != null) setState(() => _increment = value);
                  },
          ),
          const Text(
            'The slot interval cannot change while upcoming bookings use the current grid.',
          ),
          const SizedBox(height: 24),
          ScButton(
            label: 'Save details',
            loading: _saving,
            onPressed: _loading ? null : _save,
          ),
        ],
      ],
    );
  }
}
