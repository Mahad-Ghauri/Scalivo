import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:path_provider/path_provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import 'package:share_plus/share_plus.dart';

import '../theme.dart';
import '../widgets/sc_button.dart';

/// A public customer booking QR. It never contains session credentials or pairing codes.
class PosterScreen extends StatefulWidget {
  const PosterScreen({super.key, required this.name, required this.link});
  final String name, link;
  @override
  State<PosterScreen> createState() => _PosterScreenState();
}

class _PosterScreenState extends State<PosterScreen> {
  final _posterKey = GlobalKey();
  bool _busy = false;

  Future<void> _export(BuildContext origin) async {
    if (_busy) return;
    setState(() => _busy = true);
    ui.Image? image;
    try {
      await WidgetsBinding.instance.endOfFrame;
      final boundary =
          _posterKey.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      image = await boundary.toImage(pixelRatio: 3);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      if (bytes == null) throw const FormatException('No poster image');
      final directory = await getTemporaryDirectory().timeout(
        const Duration(seconds: 10),
      );
      // One fixed public poster file per installation, not an unbounded cache of exports.
      final file = File('${directory.path}/scalivo-booking-poster.png');
      await file
          .writeAsBytes(bytes.buffer.asUint8List(), flush: true)
          .timeout(const Duration(seconds: 10));
      if (!mounted || !origin.mounted) return;
      final box = origin.findRenderObject() as RenderBox?;
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path, mimeType: 'image/png')],
          title: 'Booking poster',
          sharePositionOrigin: box == null
              ? null
              : box.localToGlobal(Offset.zero) & box.size,
        ),
      );
    } on Object {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Couldn’t share the poster. Try again.'),
          ),
        );
      }
    } finally {
      image?.dispose();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Sc.paper,
    appBar: AppBar(
      title: const Text('QR poster'),
      backgroundColor: Sc.paper,
      surfaceTintColor: Sc.paper,
    ),
    body: ListView(
      padding: const EdgeInsets.all(22),
      children: [
        Center(
          child: RepaintBoundary(
            key: _posterKey,
            child: SizedBox(width: 360, child: _poster()),
          ),
        ),
        const SizedBox(height: 24),
        const Text(
          'Share or save this image from your phone’s share sheet. Print it for your counter. This QR opens customer booking; it does not link a WhatsApp device.',
          style: TextStyle(color: Sc.slate),
        ),
        const SizedBox(height: 20),
        Builder(
          builder: (origin) => ScButton(
            label: 'Share poster',
            loading: _busy,
            loadingLabel: 'Preparing poster',
            onPressed: _busy ? null : () => _export(origin),
          ),
        ),
      ],
    ),
  );

  Widget _poster() => ColoredBox(
    color: Colors.white,
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        children: [
          const Text(
            'BOOK YOUR NEXT VISIT',
            style: TextStyle(color: Sc.slate, letterSpacing: 1),
          ),
          const SizedBox(height: 12),
          Text(
            widget.name,
            textAlign: TextAlign.center,
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w600,
              color: Sc.ink,
            ),
          ),
          const SizedBox(height: 20),
          Semantics(
            label: 'Scan this QR code to book with ${widget.name}',
            image: true,
            child: QrImageView(
              data: widget.link,
              errorCorrectionLevel: QrErrorCorrectLevel.M,
              size: 280,
              padding: const EdgeInsets.all(32),
              backgroundColor: Colors.white,
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Scan to book an appointment',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 18, color: Sc.ink),
          ),
          const SizedBox(height: 8),
          const Text(
            'Choose a service and a time that suits you.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Sc.slate),
          ),
        ],
      ),
    ),
  );
}
