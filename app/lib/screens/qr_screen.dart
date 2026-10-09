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
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _requestQr());
  }

  @override
  void dispose() {
    _generation++;
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _requestQr() async {
    if (!mounted) return;
    final generation = ++_generation;
    _poll?.cancel();
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
      if (!mounted || generation != _generation) return;
      _show(result);
    } on ApiException catch (err) {
      if (!mounted || generation != _generation) return;
      setState(() {
        // A 409 here means precisely one thing — no session exists yet — and
        // that is a state the owner can act on themselves, not a dead end.
        _stage = err.kind == ApiErrorKind.conflict ? _Stage.noSession : _Stage.failed;
        _failure = err.message;
      });
    } on Object {
      if (!mounted || generation != _generation) return;
      _fail();
    }
  }

  /// Creates the session, then shows its QR.
  ///
  /// Behind an explicit tap rather than run on open like [_requestQr]: this
  /// allocates a real browser session on the gateway — measured at ~777 MiB, so
  /// roughly two per instance — and a screen that provisions merely by being
  /// looked at would spend that on every accidental visit.
  Future<void> _provision() async {
    if (!mounted || _stage == _Stage.requesting) return;
    final generation = ++_generation;
    _poll?.cancel();
    final auth = context.read<AuthController>();
    final business = auth.business;
    if (business == null) return;

    setState(() {
      _stage = _Stage.requesting;
      _failure = null;
    });

    try {
      final result = await auth.api.provisionWhatsApp(business.id);
      if (!mounted || generation != _generation) return;
      _show(result);
    } on ApiException catch (err) {
      if (!mounted || generation != _generation) return;
      // `already_linked` — someone provisioned from another device between this
      // screen opening and the tap. Nothing is wrong and the QR is one call
      // away, so fetch it rather than reporting a conflict the owner cannot act on.
      if (err.kind == ApiErrorKind.conflict) {
        await _requestQr();
        return;
      }
      setState(() {
        _stage = _Stage.failed;
        _failure = err.message;
      });
    } on Object {
      if (!mounted || generation != _generation) return;
      _fail();
    }
  }

  /// Shared by both paths, because they return the same shape and drifting
  /// apart would mean one of them mishandling the no-QR case below.
  void _show(LinkResult result) {
    if (!mounted) return;
    const statuses = {
      'created', 'initializing', 'qr_ready', 'authenticating',
      'ready', 'disconnected', 'action_required', 'failed',
    };
    if (!statuses.contains(result.status) || result.status == 'failed') {
      _fail();
      return;
    }

    // No QR and a ready status is success, not an empty response: a session
    // whose credentials survived comes back with nothing to scan (spike
    // proof #9 — restart recovery took ~7s and emitted zero QR events).
    final qr = result.qrCode == null ? null : _decodeDataUrl(result.qrCode!);
    if (result.status != 'ready' && result.qrCode != null && qr == null) {
      _fail();
      return;
    }
    setState(() {
      _qr = result.status == 'ready' ? null : qr;
      _stage = result.status == 'ready' ? _Stage.live : _Stage.awaitingScan;
    });
    if (_stage == _Stage.awaitingScan) {
      _startPolling();
    } else {
      unawaited(context.read<AuthController>().refreshSession());
    }
  }

  /// Polls rather than waiting for a push, because the scan happens on a
  /// different phone — nothing on this device knows it worked.
  void _startPolling() {
    _poll?.cancel();
    final generation = _generation;
    _poll = Timer(const Duration(seconds: 3), () => _refreshQr(generation));
  }

  Future<void> _refreshQr(int generation) async {
    if (!mounted || generation != _generation) return;
    final auth = context.read<AuthController>();
    final business = auth.business;
    if (business == null) {
      _fail();
      return;
    }
    try {
      final current = await auth.api.whatsappState(business.id, business);
      if (!mounted || generation != _generation) return;
      if (current.whatsappStatus == 'failed') {
        _fail();
        return;
      }
      if (current.health == SessionHealth.live) {
        setState(() {
          _qr = null;
          _stage = _Stage.live;
        });
        await auth.refreshSession();
        return;
      }
      final code = await auth.api.whatsappQr(business.id);
      if (!mounted || generation != _generation) return;
      final qr = code == null ? null : _decodeDataUrl(code);
      if (code != null && qr == null) {
        _fail();
        return;
      }
      setState(() => _qr = qr);
      // Schedule only after both calls finish: slow requests cannot overlap.
      _startPolling();
    } on Object {
      if (!mounted || generation != _generation) return;
      _fail();
    }
  }

  void _fail() {
    _poll?.cancel();
    setState(() {
      _qr = null;
      _stage = _Stage.failed;
      _failure = 'Could not refresh the connection. Try again.';
    });
  }

  static Uint8List? _decodeDataUrl(String value) {
    const prefix = 'data:image/png;base64,';
    if (value.length > 175000 || !value.startsWith(prefix)) return null;
    final payload = value.substring(prefix.length);
    if (!RegExp(r'^[A-Za-z0-9+/]+={0,2}$').hasMatch(payload)) return null;
    try {
      final bytes = base64Decode(payload);
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (bytes.length < 33) return null;
      for (var i = 0; i < signature.length; i++) {
        if (bytes[i] != signature[i]) return null;
      }
      final header = ByteData.sublistView(bytes);
      if (header.getUint32(8) != 13 || header.getUint32(12) != 0x49484452) return null;
      final width = header.getUint32(16);
      final height = header.getUint32(20);
      if (width < 1 || height < 1 || width > 1024 || height > 1024) return null;
      return bytes;
    } on FormatException {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      heroHeight: 116 + MediaQuery.paddingOf(context).top + (MediaQuery.textScalerOf(context).scale(14) > 20 ? 48 : 0),
      overlap: 0,
      hero: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 20),
          child: Row(
            children: [
              Material(
                color: Sc.yellow,
                shape: const CircleBorder(),
                child: InkWell(
                  onTap: () => Navigator.of(context).pop(),
                  customBorder: const CircleBorder(),
                  child: const SizedBox(
                    width: 48,
                    height: 48,
                    child: Icon(Icons.arrow_back_rounded, size: 20, color: Sc.teal900),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              const Expanded(child: Text(
                'Connect WhatsApp',
                style: TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w500,
                  color: Colors.white,
                  letterSpacing: -0.2,
                ),
              )),
            ],
          ),
        ),
      ),
      sheetPadding: const EdgeInsets.fromLTRB(26, 28, 26, 26),
      sheet: switch (_stage) {
        _Stage.requesting => const _Centered(
            child: CircularProgressIndicator(color: Sc.teal),
          ),
        _Stage.live => _connected(context),
        _Stage.noSession => _setUp(),
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
                  ? Image.memory(
                      _qr!,
                      width: 184,
                      height: 184,
                      filterQuality: FilterQuality.none,
                      errorBuilder: (_, error, stackTrace) => const SizedBox(
                        width: 184,
                        height: 184,
                        child: Center(child: Text('Could not display code. Try again.')),
                      ),
                    )
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

  /// The first-run state: a business that has never had a number.
  ///
  /// It used to say support would do this, which was true of the API and false
  /// of the product — an owner cannot set up their own business if the one step
  /// that turns it on happens somewhere they cannot reach.
  Widget _setUp() {
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
              child: const Icon(Icons.qr_code_2_rounded, size: 38, color: Sc.teal900),
            ),
          ),
          const SizedBox(height: 18),
          const Text(
            'Connect your number',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w700,
              color: Sc.ink,
              letterSpacing: -0.4,
            ),
          ),
          const SizedBox(height: 7),
          const Text(
            'This is the number your customers will message to book. '
            'We will show you a code to scan with it.',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 14, color: Sc.slate, height: 1.5),
          ),
          const SizedBox(height: 22),
          const ScBanner(
            title: 'Use a dedicated business number',
            message: 'Whichever number you scan becomes the business number, and '
                'moving it later means telling every customer again. Do not use '
                'your personal WhatsApp.',
            tone: ScBannerTone.warning,
          ),
          const SizedBox(height: 26),
          ScButton(label: 'Set up my number', onPressed: _provision),
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
