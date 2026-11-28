import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../api/api_client.dart';
import '../theme.dart';

/// Picks a photo. Injectable so widget tests can supply bytes without a
/// platform picker.
typedef PickImage = Future<XFile?> Function(ImageSource source);

/// The real picker. `imageQuality` makes the platform RE-ENCODE to JPEG, which
/// is what turns an iPhone HEIC into something the backend accepts; the size
/// cap keeps a 48 MP photo from being uploaded at full size. The backend still
/// resizes, re-encodes and strips metadata — this only saves the owner data.
Future<XFile?> pickWithPlatform(ImageSource source) => ImagePicker().pickImage(
  source: source,
  maxWidth: 4096,
  maxHeight: 4096,
  imageQuality: 88,
  requestFullMetadata: false,
);

/// Reads a picked file and works out its type, or returns an error message.
Future<({List<int>? bytes, String? type, String? error})> readPicked(
  XFile file,
) async {
  final type = file.mimeType ?? imageContentType(file.name);
  if (type == null || !acceptedImageTypes.contains(type)) {
    return (
      bytes: null,
      type: null,
      error: 'Choose a JPEG, PNG or WebP photo.',
    );
  }
  final bytes = await file.readAsBytes();
  if (bytes.length > maxImageBytes) {
    return (bytes: null, type: null, error: 'Images must be under 8 MB.');
  }
  return (bytes: bytes, type: type, error: null);
}

/// One image: preview, choose, take, remove. Used for the logo, cover,
/// service photo and staff photo.
class ImageSlot extends StatefulWidget {
  const ImageSlot({
    super.key,
    required this.label,
    required this.url,
    required this.aspectRatio,
    required this.onUpload,
    required this.onRemove,
    this.hint,
    this.beforeUpload,
    this.picker = pickWithPlatform,
    this.circular = false,
  });

  final String label;
  final String? hint;
  final String? url;

  /// Width ÷ height of the preview: 1 for logo/staff, 1.5 cover, 4/3 service.
  final double aspectRatio;
  final bool circular;

  /// Uploads and returns the new URL. Throws [ApiException] on refusal.
  final Future<String> Function(List<int> bytes, String contentType) onUpload;
  final Future<void> Function() onRemove;

  /// Return a message to block the upload (e.g. staff consent not given).
  final String? Function()? beforeUpload;
  final PickImage picker;

  @override
  State<ImageSlot> createState() => _ImageSlotState();
}

class _ImageSlotState extends State<ImageSlot> {
  late String? _url = widget.url;
  bool _busy = false;
  String? _error;

  @override
  void didUpdateWidget(covariant ImageSlot old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) _url = widget.url;
  }

  Future<void> _pick(ImageSource source) async {
    final blocked = widget.beforeUpload?.call();
    if (blocked != null) return setState(() => _error = blocked);
    setState(() => _error = null);

    final XFile? file;
    try {
      file = await widget.picker(source);
    } on Object {
      if (mounted) {
        setState(
          () => _error = source == ImageSource.camera
              ? 'The camera is not available. Allow camera access in Settings.'
              : 'Photos are not available. Allow photo access in Settings.',
        );
      }
      return;
    }
    if (file == null || !mounted) return; // cancelled

    setState(() => _busy = true);
    final read = await readPicked(file);
    if (read.error != null) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = read.error;
        });
      }
      return;
    }
    try {
      final url = await widget.onUpload(read.bytes!, read.type!);
      if (mounted) {
        setState(() {
          _url = url;
          _busy = false;
        });
      }
    } on ApiException catch (err) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = err.message;
        });
      }
    }
  }

  Future<void> _remove() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.onRemove();
      if (mounted) {
        setState(() {
          _url = null;
          _busy = false;
        });
      }
    } on ApiException catch (err) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = err.message;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(widget.circular ? 999 : 12);
    final preview = AspectRatio(
      aspectRatio: widget.aspectRatio,
      child: ClipRRect(
        borderRadius: radius,
        child: DecoratedBox(
          decoration: BoxDecoration(color: Sc.divider, borderRadius: radius),
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (_url != null)
                Image.network(
                  _url!,
                  key: ValueKey(_url),
                  fit: BoxFit.cover,
                  semanticLabel: widget.label,
                  errorBuilder: (_, _, _) => const Center(
                    child: Icon(Icons.broken_image_outlined, color: Sc.slate),
                  ),
                  loadingBuilder: (_, child, progress) => progress == null
                      ? child
                      : const Center(
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                )
              else
                const Center(
                  child: Icon(
                    Icons.add_photo_alternate_outlined,
                    color: Sc.slate,
                    size: 32,
                  ),
                ),
              if (_busy)
                const ColoredBox(
                  color: Color(0x66FFFFFF),
                  child: Center(
                    child: CircularProgressIndicator(color: Sc.teal),
                  ),
                ),
            ],
          ),
        ),
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          widget.label,
          style: const TextStyle(fontWeight: FontWeight.w600, color: Sc.ink),
        ),
        if (widget.hint != null)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              widget.hint!,
              style: const TextStyle(fontSize: 12.5, color: Sc.slate),
            ),
          ),
        const SizedBox(height: 8),
        ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: widget.aspectRatio <= 1 ? 140 : 420,
          ),
          child: preview,
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 4,
          children: [
            TextButton.icon(
              key: Key('${widget.label}-choose'),
              onPressed: _busy ? null : () => _pick(ImageSource.gallery),
              icon: const Icon(Icons.photo_library_outlined, size: 18),
              label: Text(_url == null ? 'Choose photo' : 'Replace'),
            ),
            TextButton.icon(
              onPressed: _busy ? null : () => _pick(ImageSource.camera),
              icon: const Icon(Icons.photo_camera_outlined, size: 18),
              label: const Text('Take photo'),
            ),
            if (_url != null)
              TextButton(
                key: Key('${widget.label}-remove'),
                onPressed: _busy ? null : _remove,
                child: const Text(
                  'Remove',
                  style: TextStyle(color: Sc.dangerText),
                ),
              ),
          ],
        ),
        if (_error != null)
          Text(
            _error!,
            style: const TextStyle(color: Sc.dangerText, fontSize: 12.5),
          ),
      ],
    );
  }
}
