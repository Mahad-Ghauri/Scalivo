import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../api/api_client.dart';
import '../theme.dart';
import 'image_slot.dart';

/// The portfolio: up to [galleryMax] photos, each with a required caption (it
/// is the alt text — read by screen readers and search engines), reordered
/// with buttons so it works without drag gestures.
class PortfolioEditor extends StatefulWidget {
  const PortfolioEditor({
    super.key,
    required this.api,
    required this.businessId,
    required this.initial,
    this.picker = pickWithPlatform,
  });

  final ApiClient api;
  final String businessId;
  final List<GalleryPhoto> initial;
  final PickImage picker;

  @override
  State<PortfolioEditor> createState() => _PortfolioEditorState();
}

class _PortfolioEditorState extends State<PortfolioEditor> {
  late List<GalleryPhoto> _photos = [...widget.initial];
  bool _busy = false;
  String? _error;

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on ApiException catch (err) {
      if (mounted) setState(() => _error = err.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _askCaption({String initial = '', required String title}) =>
      showDialog<String>(
        context: context,
        builder: (_) => _CaptionDialog(title: title, initial: initial),
      );

  Future<void> _add(ImageSource source) async {
    setState(() => _error = null);
    final XFile? file;
    try {
      file = await widget.picker(source);
    } on Object {
      setState(
        () => _error = 'Photos are not available. Allow access in Settings.',
      );
      return;
    }
    if (file == null || !mounted) return;
    final read = await readPicked(file);
    if (read.error != null) return setState(() => _error = read.error);
    if (!mounted) return;
    final caption = await _askCaption(title: 'Describe this photo');
    if (caption == null || caption.isEmpty || !mounted) return;
    await _run(() async {
      final image = await widget.api.uploadImage(
        widget.businessId,
        const ImageTarget.gallery(),
        read.bytes!,
        contentType: read.type!,
        caption: caption,
      );
      if (mounted) {
        setState(
          () => _photos = [
            ..._photos,
            GalleryPhoto(url: image.url, alt: caption, imageId: image.id),
          ],
        );
      }
    });
  }

  Future<void> _caption(GalleryPhoto photo) async {
    final caption = await _askCaption(
      initial: photo.alt,
      title: 'Edit caption',
    );
    if (caption == null || caption.isEmpty || caption == photo.alt) return;
    await _run(() async {
      await widget.api.captionGalleryPhoto(
        widget.businessId,
        photo.imageId!,
        caption,
      );
      if (mounted) {
        setState(
          () => _photos = [
            for (final p in _photos)
              p.imageId == photo.imageId
                  ? GalleryPhoto(url: p.url, alt: caption, imageId: p.imageId)
                  : p,
          ],
        );
      }
    });
  }

  Future<void> _move(int index, int by) async {
    final previous = _photos;
    final next = [..._photos];
    final moved = next.removeAt(index);
    next.insert(index + by, moved);
    setState(() => _photos = next); // optimistic
    await _run(() async {
      try {
        await widget.api.reorderGallery(widget.businessId, [
          for (final p in next)
            if (p.imageId != null) p.imageId!,
        ]);
      } on ApiException {
        if (mounted) setState(() => _photos = previous);
        rethrow;
      }
    });
  }

  Future<void> _delete(GalleryPhoto photo) async {
    await _run(() async {
      await widget.api.deleteImage(
        widget.businessId,
        ImageTarget.galleryItem(photo.imageId!),
      );
      if (mounted) {
        setState(
          () => _photos = _photos
              .where((p) => p.imageId != photo.imageId)
              .toList(),
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final full = _photos.length >= galleryMax;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '${_photos.length} of $galleryMax photos. Each needs a short caption.',
          style: const TextStyle(fontSize: 12.5, color: Sc.slate),
        ),
        const SizedBox(height: 10),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: 0.78,
          children: [
            for (final (index, photo) in _photos.indexed)
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: Image.network(
                        photo.url,
                        fit: BoxFit.cover,
                        semanticLabel: photo.alt,
                        errorBuilder: (_, _, _) => const ColoredBox(
                          color: Sc.divider,
                          child: Icon(
                            Icons.broken_image_outlined,
                            color: Sc.slate,
                          ),
                        ),
                      ),
                    ),
                  ),
                  Text(
                    photo.alt,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12.5),
                  ),
                  if (photo.imageId != null)
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        IconButton(
                          tooltip: 'Move earlier',
                          visualDensity: VisualDensity.compact,
                          onPressed: _busy || index == 0
                              ? null
                              : () => _move(index, -1),
                          icon: const Icon(Icons.chevron_left, size: 20),
                        ),
                        IconButton(
                          tooltip: 'Move later',
                          visualDensity: VisualDensity.compact,
                          onPressed: _busy || index == _photos.length - 1
                              ? null
                              : () => _move(index, 1),
                          icon: const Icon(Icons.chevron_right, size: 20),
                        ),
                        IconButton(
                          tooltip: 'Edit caption',
                          visualDensity: VisualDensity.compact,
                          onPressed: _busy ? null : () => _caption(photo),
                          icon: const Icon(Icons.edit_outlined, size: 18),
                        ),
                        IconButton(
                          tooltip: 'Delete photo',
                          visualDensity: VisualDensity.compact,
                          onPressed: _busy ? null : () => _delete(photo),
                          icon: const Icon(
                            Icons.delete_outline,
                            size: 18,
                            color: Sc.dangerText,
                          ),
                        ),
                      ],
                    ),
                ],
              ),
          ],
        ),
        const SizedBox(height: 8),
        if (_busy) const LinearProgressIndicator(color: Sc.teal),
        if (!full)
          Wrap(
            spacing: 4,
            children: [
              TextButton.icon(
                key: const Key('portfolio-add'),
                onPressed: _busy ? null : () => _add(ImageSource.gallery),
                icon: const Icon(Icons.add_photo_alternate_outlined, size: 18),
                label: const Text('Add photo'),
              ),
              TextButton.icon(
                onPressed: _busy ? null : () => _add(ImageSource.camera),
                icon: const Icon(Icons.photo_camera_outlined, size: 18),
                label: const Text('Take photo'),
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

/// Owns its controller, so it is disposed when the dialog widget is — after
/// the closing animation — not when the Future completes, which is while the
/// field is still on screen.
class _CaptionDialog extends StatefulWidget {
  const _CaptionDialog({required this.title, required this.initial});
  final String title, initial;

  @override
  State<_CaptionDialog> createState() => _CaptionDialogState();
}

class _CaptionDialogState extends State<_CaptionDialog> {
  late final _controller = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.title),
    content: TextField(
      key: const Key('portfolio-caption'),
      controller: _controller,
      autofocus: true,
      maxLength: 200,
      decoration: const InputDecoration(hintText: 'e.g. Bridal makeup'),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Cancel'),
      ),
      TextButton(
        onPressed: () => Navigator.pop(context, _controller.text.trim()),
        child: const Text('Save'),
      ),
    ],
  );
}
