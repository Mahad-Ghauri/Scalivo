import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/owner_booking_models.dart';
import '../state/auth_controller.dart';
import '../widgets/image_slot.dart';
import '../widgets/owner_report_widgets.dart';
import '../widgets/portfolio_editor.dart';

/// Logo, cover and portfolio. Each change is saved the moment it is made, so
/// there is no Save button — and no form here that could overwrite a photo
/// with a stale value.
class PhotosScreen extends StatefulWidget {
  const PhotosScreen({super.key, this.picker = pickWithPlatform});

  /// Injectable for widget tests.
  final PickImage picker;

  @override
  State<PhotosScreen> createState() => _PhotosScreenState();
}

class _PhotosScreenState extends State<PhotosScreen> {
  late final AuthController _auth = context.read<AuthController>();
  late final String _businessId = _auth.business!.id;
  BusinessProfile? _profile;
  ApiException? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final profile = await _auth.api.businessProfile(_businessId);
      if (mounted) {
        setState(() {
          _profile = profile;
          _loading = false;
        });
      }
    } on ApiException catch (err) {
      if (mounted) {
        setState(() {
          _error = err;
          _loading = false;
        });
      }
    }
  }

  Future<String> _upload(
    ImageTarget target,
    List<int> bytes,
    String type,
  ) async => (await _auth.api.uploadImage(
    _businessId,
    target,
    bytes,
    contentType: type,
  )).url;

  @override
  Widget build(BuildContext context) {
    final profile = _profile;
    return OwnerReportPage(
      title: 'Photos',
      loading: _loading,
      error: _error,
      onRefresh: _load,
      children: [
        if (profile != null) ...[
          const Text(
            'Saved as soon as you upload. Location and camera details are '
            'removed from every photo before it is published.',
            style: TextStyle(fontSize: 12.5),
          ),
          const SizedBox(height: 18),
          ReportSection(
            title: 'Logo and cover',
            children: [
              ImageSlot(
                label: 'Logo',
                hint: 'Square works best.',
                url: _nonEmpty(profile.profile['logoUrl']),
                aspectRatio: 1,
                picker: widget.picker,
                onUpload: (bytes, type) =>
                    _upload(const ImageTarget.logo(), bytes, type),
                onRemove: () => _auth.api.deleteImage(
                  _businessId,
                  const ImageTarget.logo(),
                ),
              ),
              const SizedBox(height: 18),
              ImageSlot(
                label: 'Cover photo',
                hint: 'Shown at the top of your page and when your link is shared. Landscape.',
                url: _nonEmpty(profile.profile['coverUrl']),
                aspectRatio: 1.5,
                picker: widget.picker,
                onUpload: (bytes, type) =>
                    _upload(const ImageTarget.cover(), bytes, type),
                onRemove: () => _auth.api.deleteImage(
                  _businessId,
                  const ImageTarget.cover(),
                ),
              ),
            ],
          ),
          ReportSection(
            title: 'Portfolio',
            children: [
              PortfolioEditor(
                api: _auth.api,
                businessId: _businessId,
                initial: profile.gallery,
                picker: widget.picker,
              ),
            ],
          ),
        ],
      ],
    );
  }
}

String? _nonEmpty(String? value) =>
    value == null || value.isEmpty ? null : value;
