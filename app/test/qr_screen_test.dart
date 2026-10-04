import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:scalivo_owner/screens/qr_screen.dart';
import 'package:scalivo_owner/state/auth_controller.dart';

const firstPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
const nextPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const prefix = 'data:image/png;base64,';

class FakeApi extends ApiClient {
  LinkResult link = const LinkResult(status: 'qr_ready', qrCode: '$prefix$firstPng');
  String? code = '$prefix$nextPng';
  bool ready = false;
  String? polledStatus;
  Completer<LinkResult>? pendingProvision;
  Completer<String?>? pendingQr;
  bool failQr = false;
  int statusCalls = 0;
  int qrCalls = 0;
  bool noSession = false;
  int provisionCalls = 0;
  Completer<BusinessSummary>? pending;

  @override
  Future<LinkResult> linkWhatsApp(String businessId) async {
    if (noSession) throw const ApiException(ApiErrorKind.conflict, 'No session');
    return link;
  }

  @override
  Future<LinkResult> provisionWhatsApp(String businessId) async {
    provisionCalls++;
    noSession = false;
    if (pendingProvision != null) return pendingProvision!.future;
    return link;
  }

  @override
  Future<BusinessSummary> whatsappState(String businessId, BusinessSummary current) async {
    statusCalls++;
    if (pending != null) return pending!.future;
    return BusinessSummary(
      id: current.id,
      name: current.name,
      category: current.category,
      whatsappStatus: polledStatus ?? (ready ? 'ready' : 'qr_ready'),
      whatsappIntent: ready ? 'live' : 'linking',
    );
  }

  @override
  Future<String?> whatsappQr(String businessId) async {
    qrCalls++;
    if (failQr) throw const ApiException(ApiErrorKind.network, 'private transport detail');
    if (pendingQr != null) return pendingQr!.future;
    return code;
  }
}

Future<void> openScreen(WidgetTester tester, FakeApi api) async {
  final auth = AuthController(api: api)
    ..me = const Me(
      name: null,
      email: '',
      businesses: [
        BusinessSummary(
          id: '65a000000000000000000010',
          name: 'Uxelerate',
          category: 'studio',
          whatsappStatus: 'qr_ready',
          whatsappIntent: 'linking',
        ),
      ],
    );
  await tester.pumpWidget(
    ChangeNotifierProvider.value(
      value: auth,
      child: const MaterialApp(home: QrScreen()),
    ),
  );
  await tester.pump();
  await tester.pump();
}

void main() {
  testWidgets('a new tenant provisions only after the owner taps setup', (tester) async {
    final api = FakeApi()..noSession = true;
    await openScreen(tester, api);
    expect(api.provisionCalls, 0);
    await tester.tap(find.text('SET UP MY NUMBER'));
    await tester.pump();
    await tester.pump();
    expect(api.provisionCalls, 1);
    expect(find.byType(Image), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('refreshes the displayed code and clears a code no longer offered', (tester) async {
    final api = FakeApi();
    await openScreen(tester, api);
    expect(
      (tester.widget<Image>(find.byType(Image)).image as MemoryImage).bytes,
      base64Decode(firstPng),
    );
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(
      (tester.widget<Image>(find.byType(Image)).image as MemoryImage).bytes,
      base64Decode(nextPng),
    );
    api.code = null;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.byType(Image), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('stops polling and removes the QR when the scan succeeds', (tester) async {
    final api = FakeApi();
    await openScreen(tester, api);
    api.ready = true;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text("You're live"), findsOneWidget);
    expect(find.byType(Image), findsNothing);
    expect(api.qrCalls, 0);
    final calls = api.statusCalls;
    await tester.pump(const Duration(seconds: 30));
    expect(api.statusCalls, calls);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an already ready session never starts a polling timer', (tester) async {
    final api = FakeApi()..link = const LinkResult(status: 'ready', qrCode: null);
    await openScreen(tester, api);
    await tester.pump(const Duration(seconds: 30));
    expect(find.text("You're live"), findsOneWidget);
    expect(api.statusCalls, 0);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('slow polls do not overlap and disposal ignores an in-flight reply', (tester) async {
    final api = FakeApi()..pending = Completer<BusinessSummary>();
    await openScreen(tester, api);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump(const Duration(seconds: 30));
    expect(api.statusCalls, 1);
    await tester.pumpWidget(const SizedBox());
    api.pending!.complete(
      const BusinessSummary(
        id: '65a000000000000000000010',
        name: 'Uxelerate',
        category: 'studio',
        whatsappStatus: 'qr_ready',
        whatsappIntent: 'linking',
      ),
    );
    await tester.pump();
    expect(api.qrCalls, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('failed refresh removes the old QR and shows a generic retry', (tester) async {
    final api = FakeApi()..failQr = true;
    await openScreen(tester, api);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.byType(Image), findsNothing);
    expect(find.text('TRY AGAIN'), findsOneWidget);
    expect(find.textContaining('private'), findsNothing);
    final calls = api.statusCalls;
    await tester.pump(const Duration(seconds: 30));
    expect(api.statusCalls, calls);
    api.failQr = false;
    await tester.tap(find.text('TRY AGAIN'));
    await tester.pump();
    await tester.pump();
    expect(find.byType(Image), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('rejects malformed, oversized, non-PNG and oversized-dimension images', (
    tester,
  ) async {
    final hugeDimensions = base64Decode(firstPng);
    hugeDimensions[16] = 1;
    for (final code in [
      '$prefix%%%bad',
      'data:image/svg+xml;base64,$firstPng',
      '$prefix${'A' * 175000}',
      '$prefix${base64Encode(hugeDimensions)}',
    ]) {
      final api = FakeApi()..link = LinkResult(status: 'qr_ready', qrCode: code);
      await openScreen(tester, api);
      expect(find.byType(Image), findsNothing);
      expect(find.text('TRY AGAIN'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets('failed and unknown statuses show a retry without polling', (tester) async {
    for (final status in ['failed', 'unexpected']) {
      final api = FakeApi()..link = LinkResult(status: status, qrCode: null);
      await openScreen(tester, api);
      expect(find.text('TRY AGAIN'), findsOneWidget);
      await tester.pump(const Duration(seconds: 30));
      expect(api.statusCalls, 0);
      await tester.pumpWidget(const SizedBox());
    }
  });

  testWidgets('a terminal failure during polling removes the QR and stops requests', (
    tester,
  ) async {
    final api = FakeApi()..polledStatus = 'failed';
    await openScreen(tester, api);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(find.text('TRY AGAIN'), findsOneWidget);
    expect(find.byType(Image), findsNothing);
    expect(api.qrCalls, 0);
    await tester.pump(const Duration(minutes: 1));
    expect(api.statusCalls, 1);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('rapid setup taps cannot create duplicate gateway sessions', (tester) async {
    final api = FakeApi()
      ..noSession = true
      ..pendingProvision = Completer<LinkResult>();
    await openScreen(tester, api);
    await tester.tap(find.text('SET UP MY NUMBER'));
    await tester.tap(find.text('SET UP MY NUMBER'));
    await tester.pump();
    expect(api.provisionCalls, 1);
    await tester.pumpWidget(const SizedBox());
    api.pendingProvision!.complete(api.link);
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('a QR reply after disposal cannot update or restart the screen', (tester) async {
    final api = FakeApi()..pendingQr = Completer<String?>();
    await openScreen(tester, api);
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    expect(api.qrCalls, 1);
    await tester.pumpWidget(const SizedBox());
    api.pendingQr!.complete('$prefix$nextPng');
    await tester.pump();
    await tester.pump(const Duration(minutes: 1));
    expect(api.statusCalls, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('80 rotations and absent codes recover with exactly one poll per interval', (
    tester,
  ) async {
    final api = FakeApi();
    await openScreen(tester, api);
    for (var i = 0; i < 80; i++) {
      api.code = i % 3 == 0 ? null : '$prefix${i.isEven ? firstPng : nextPng}';
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();
      expect(api.statusCalls, i + 1);
      expect(api.qrCalls, i + 1);
      expect(find.byType(Image), api.code == null ? findsNothing : findsOneWidget);
      expect(tester.takeException(), isNull);
    }
    api.ready = true;
    await tester.pump(const Duration(seconds: 3));
    await tester.pump();
    final callsAfterConnecting = api.statusCalls;
    await tester.pump(const Duration(minutes: 5));
    expect(api.statusCalls, callsAfterConnecting);
    expect(api.qrCalls, 80);
    expect(find.text("You're live"), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
  });
}
