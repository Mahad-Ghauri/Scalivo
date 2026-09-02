import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../api/models.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/sc_banner.dart';
import '../widgets/sc_button.dart';
import '../widgets/sheet_scaffold.dart';

enum _Stage { requesting, awaitingScan, live, noSession, failed }

/// Linking — and re-linking — the business WhatsApp number.
///
/// This is where a Session Health alert lands. It requests a QR on open rather
/// than waiting for a tap: an owner arriving here has already been told
/// something is wrong, and making them press another button to start fixing it
/// wastes the minutes the alert bought.
class QrScreen extends StatefulWidget {
  const QrScreen({super.key});

  @override
  State<QrScreen> createState() => _QrScreenState();
}

class _QrScreenState extends State<QrScreen> {
  _Stage _stage = _Stage.requesting;
  Uint8List? _qr;
  String? _failure;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _requestQr());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _requestQr() async {
    final auth = context.read<AuthController>();
    final business = auth.business;
    if (business == null) {
      setState(() => _stage = _Stage.noSession);
      return;
    }

    setState(() {
      _stage = _Stage.requesting;
      _failure = null;
    });

    try {
      final result = await auth.api.linkWhatsApp(business.id);
      if (!mounted) return;

      // No QR and a ready status is success, not an empty response: a session
      // whose credentials survived comes back with nothing to scan (spike
      // proof #9 — restart recovery took ~7s and emitted zero QR events).
      if (result.qrCode == null) {
        setState(() => _stage = result.status == 'ready' ? _Stage.live : _Stage.awaitingScan);
        _startPolling();
        return;
      }

      setState(() {
        _qr = _decodeDataUrl(result.qrCode!);
        _stage = _Stage.awaitingScan;
      });
      _startPolling();
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() {
        _stage = err.kind == ApiErrorKind.conflict ? _Stage.noSession : _Stage.failed;
        _failure = err.message;
      });
    }
  }

  /// Polls rather than waiting for a push, because the scan happens on a
  /// different phone — nothing on this device knows it worked.
  void _startPolling() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 3), (_) async {
      final auth = context.read<AuthController>();
      await auth.refreshSession();
      if (!mounted) return;
      if (auth.health == SessionHealth.live) {
        _poll?.cancel();
        setState(() => _stage = _Stage.live);
      }
    });
  }

  static Uint8List? _decodeDataUrl(String value) {
    final comma = value.indexOf(',');
    final payload = comma >= 0 ? value.substring(comma + 1) : value;
    try {
      return base64Decode(payload);
    } on FormatException {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      heroHeight: 148,
      overlap: 30,
      hero: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
          child: Row(
            children: [
              Material(
                color: Sc.yellow,
                shape: const CircleBorder(),
                child: InkWell(
                  onTap: () => Navigator.of(context).pop(),
                  customBorder: const CircleBorder(),
                  child: const SizedBox(
                    width: 44,
                    height: 44,
                    child: Icon(Icons.arrow_back_rounded, size: 20, color: Sc.teal900),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              const Text(
                'Connect WhatsApp',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                  color: Colors.white,
                  letterSpacing: -0.2,
                ),
              ),
            ],
          ),
        ),
      ),
      sheetPadding: const EdgeInsets.fromLTRB(26, 46, 26, 26),
      sheet: switch (_stage) {
        _Stage.requesting => const _Centered(
            child: CircularProgressIndicator(color: Sc.teal),
          ),
        _Stage.live => _connected(context),
        _Stage.noSession => _problem(
            title: 'No WhatsApp number set up yet',
            message: 'This business has no messaging session provisioned. '
                'Scalivo support sets that up before you can link a number.',
            retry: false,
          ),
        _Stage.failed => _problem(
            title: "Couldn't reach WhatsApp",
            message: _failure ?? 'Try again in a moment.',
            retry: true,
          ),
        _Stage.awaitingScan => _scanning(),
      },
    );
  }

  Widget _scanning() {
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: Sc.hairline, width: 1.5),
              ),
              child: _qr != null
                  ? Image.memory(_qr!, width: 184, height: 184, filterQuality: FilterQuality.none)
                  : const SizedBox(
                      width: 184,
                      height: 184,
                      child: Center(child: CircularProgressIndicator(color: Sc.teal)),
                    ),
            ),
          ),
          const SizedBox(height: 14),
          const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              SizedBox(
                width: 15,
                height: 15,
                child: CircularProgressIndicator(strokeWidth: 2, color: Sc.teal),
              ),
              SizedBox(width: 9),
              Text(
                'Waiting for you to scan',
                style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500, color: Sc.inkMuted),
              ),
            ],
          ),
          const SizedBox(height: 24),
          const _Step(1, 'Open WhatsApp on your ', bold: 'business phone'),
          const SizedBox(height: 13),
          const _Step(2, 'Tap ', bold: 'Settings → Linked devices'),
          const SizedBox(height: 13),
          const _Step(3, 'Tap ', bold: 'Link a device', tail: ' and scan this code'),
          const SizedBox(height: 20),
          const ScBanner(
            title: 'Use the phone with your business SIM',
            message: "You can't scan this code with the phone you're reading it on — "
                'the code has to appear on a different screen.',
            tone: ScBannerTone.warning,
          ),
          const SizedBox(height: 20),
          Center(
            child: TextButton(
              onPressed: _requestQr,
              style: TextButton.styleFrom(foregroundColor: Sc.teal900),
              child: const Text(
                'Get a new code',
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _connected(BuildContext context) {
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 6),
          Center(
            child: Container(
              width: 82,
              height: 82,
              decoration: const BoxDecoration(color: Sc.tealSoft, shape: BoxShape.circle),
              alignment: Alignment.center,
              child: Container(
                width: 58,
                height: 58,
                decoration: const BoxDecoration(color: Sc.teal, shape: BoxShape.circle),
                child: const Icon(Icons.check_rounded, size: 30, color: Colors.white),
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            "You're live",
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 26,
              fontWeight: FontWeight.w700,
              color: Sc.ink,
              letterSpacing: -0.5,
            ),
          ),
          const SizedBox(height: 7),
          const Text(
            'Customers can now book by messaging your number.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: Sc.slate, height: 1.5),
          ),
          const SizedBox(height: 24),
          const ScBanner(
            title: 'Now tell people about it',
            message: 'Put the number in your Instagram bio, print the QR poster for '
                'reception, and set an away message on your old number.',
            tone: ScBannerTone.warning,
          ),
          const SizedBox(height: 28),
          ScButton(label: 'Done', onPressed: () => Navigator.of(context).pop()),
        ],
      ),
    );
  }

  Widget _problem({required String title, required String message, required bool retry}) {
    return SingleChildScrollView(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ScBanner(title: title, message: message),
          const SizedBox(height: 24),
          if (retry) ScButton(label: 'Try again', onPressed: _requestQr),
        ],
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step(this.number, this.lead, {required this.bold, this.tail});

  final int number;
  final String lead;
  final String bold;
  final String? tail;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 23,
          height: 23,
          decoration: const BoxDecoration(color: Sc.tealSoft, shape: BoxShape.circle),
          alignment: Alignment.center,
          child: Text(
            '$number',
            style: const TextStyle(
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
              color: Color(0xFF3F7D76),
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text.rich(
              TextSpan(
                style: const TextStyle(fontSize: 13.5, color: Sc.inkMuted, height: 1.45),
                children: [
                  TextSpan(text: lead),
                  TextSpan(
                    text: bold,
                    style: const TextStyle(fontWeight: FontWeight.w600, color: Sc.ink),
                  ),
                  if (tail != null) TextSpan(text: tail),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Centered extends StatelessWidget {
  const _Centered({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Center(child: child);
}
