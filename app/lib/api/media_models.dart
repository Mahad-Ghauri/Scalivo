/// Image upload targets and results. Mirrors backend/src/images/routes.ts.
library;

/// The backend's limits — checked here so a wrong file fails instantly; the
/// backend is the real check.
const maxImageBytes = 8 * 1024 * 1024;
const galleryMax = 12;
const acceptedImageTypes = {'image/jpeg', 'image/png', 'image/webp'};

final _objectId = RegExp(r'^[0-9a-f]{24}$');
final _imageId = RegExp(r'^[0-9a-f]{32}$');

/// Where an image goes. Built only through these constructors, so a screen
/// can never produce an arbitrary path.
class ImageTarget {
  const ImageTarget._(this.path, this.uploadMethod, {this.minSide = 128});

  const ImageTarget.logo() : this._('/images/logo', 'PUT');
  const ImageTarget.cover() : this._('/images/cover', 'PUT', minSide: 400);
  const ImageTarget.gallery() : this._('/images/gallery', 'POST', minSide: 300);

  factory ImageTarget.service(String serviceId) {
    if (!_objectId.hasMatch(serviceId)) {
      throw ArgumentError('invalid service id');
    }
    return ImageTarget._('/services/$serviceId/image', 'PUT', minSide: 300);
  }

  factory ImageTarget.staff(String staffId) {
    if (!_objectId.hasMatch(staffId)) throw ArgumentError('invalid staff id');
    return ImageTarget._('/staff/$staffId/photo', 'PUT');
  }

  /// One portfolio photo, for caption edits and deletion.
  factory ImageTarget.galleryItem(String imageId) {
    if (!_imageId.hasMatch(imageId)) throw ArgumentError('invalid image id');
    return ImageTarget._('/images/gallery/$imageId', 'PATCH');
  }

  final String path;
  final String uploadMethod;
  final int minSide;

  bool get isStaff => path.startsWith('/staff/');
}

class ImageVariant {
  const ImageVariant({
    required this.width,
    required this.height,
    required this.url,
  });
  final int width, height;
  final String url;
}

class UploadedImage {
  const UploadedImage({
    required this.id,
    required this.url,
    required this.variants,
  });

  final String id;
  final String url;
  final List<ImageVariant> variants;

  factory UploadedImage.fromJson(Map<String, dynamic> json) {
    final image = json['image'];
    if (image is! Map<String, dynamic>) {
      throw const FormatException('Invalid upload response');
    }
    final id = image['id'], url = image['url'];
    if (id is! String ||
        !_imageId.hasMatch(id) ||
        url is! String ||
        !_isHttps(url)) {
      throw const FormatException('Invalid upload response');
    }
    return UploadedImage(
      id: id,
      url: url,
      variants: [
        for (final v in (image['variants'] as List<dynamic>? ?? const []))
          if (v is Map<String, dynamic> &&
              v['url'] is String &&
              _isHttps(v['url'] as String))
            ImageVariant(
              width: (v['width'] as num?)?.toInt() ?? 0,
              height: (v['height'] as num?)?.toInt() ?? 0,
              url: v['url'] as String,
            ),
      ],
    );
  }
}

/// A portfolio photo. [imageId] is null for an old pasted link, which can be
/// shown but not reordered, captioned or deleted from the app.
class GalleryPhoto {
  const GalleryPhoto({required this.url, required this.alt, this.imageId});
  final String url, alt;
  final String? imageId;

  static List<GalleryPhoto> listFrom(Object? raw) => [
    for (final g in (raw is List ? raw : const []))
      if (g is Map && g['url'] is String && _isHttps(g['url'] as String))
        GalleryPhoto(
          url: g['url'] as String,
          alt: g['alt'] is String ? g['alt'] as String : '',
          imageId:
              g['imageId'] is String &&
                  _imageId.hasMatch(g['imageId'] as String)
              ? g['imageId'] as String
              : null,
        ),
  ];
}

bool _isHttps(String url) {
  final uri = Uri.tryParse(url);
  return uri != null &&
      uri.scheme == 'https' &&
      uri.host.isNotEmpty &&
      uri.userInfo.isEmpty;
}

/// The MIME type from a file name, for the formats the backend accepts.
String? imageContentType(String fileName) {
  final ext = fileName.toLowerCase().split('.').last;
  return switch (ext) {
    'jpg' || 'jpeg' => 'image/jpeg',
    'png' => 'image/png',
    'webp' => 'image/webp',
    _ => null,
  };
}
