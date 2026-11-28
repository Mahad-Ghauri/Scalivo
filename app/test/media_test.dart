import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:image_picker/image_picker.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:provider/provider.dart';
import 'package:scalivo_owner/screens/photos_screen.dart';
import 'package:scalivo_owner/screens/staff_screen.dart';
import 'package:scalivo_owner/state/auth_controller.dart';
import 'package:scalivo_owner/theme.dart';
import 'package:scalivo_owner/widgets/image_slot.dart';
import 'package:scalivo_owner/widgets/portfolio_editor.dart';

const business = '6b0a767d8acd2ef8bf290460';
const staffId = '6b0a767d8acd2ef8bf290461';
final jpeg = Uint8List.fromList([
  0xff,
  0xd8,
  0xff,
  0xe0,
  ...List.filled(64, 7),
]);

String imageId(int n) => n.toRadixString(16).padLeft(32, 'a');

Map<String, dynamic> uploaded(String kind, int n) => {
  'image': {
    'id': imageId(n),
    'url': 'https://pub-x.r2.dev/b/$business/$kind/${imageId(n)}/512.webp',
    'variants': [
      {
        'width': 512,
        'height': 512,
        'url': 'https://pub-x.r2.dev/b/$business/$kind/${imageId(n)}/512.webp',
      },
    ],
  },
};

/// Image.network shows a spinner that never resolves in widget tests (there is
/// no network), so pumpAndSettle would wait forever: pump a fixed while instead.
///
/// The API calls themselves run on real time (runAsync): the HTTP client's
/// stream plumbing does not complete under the test's fake clock.
Future<void> settleNetwork(WidgetTester tester) async {
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 200)),
  );
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<XFile?> pickJpeg(ImageSource _) async =>
    XFile.fromData(jpeg, name: 'photo.jpg', mimeType: 'image/jpeg');

void main() {
  late List<http.Request> requests;
  late ApiClient api;
  late int next;

  setUp(() {
    requests = [];
    next = 1;
    api = ApiClient(
      client: MockClient((request) async {
        requests.add(request);
        if (request.method == 'DELETE' ||
            request.method == 'PATCH' ||
            request.url.path.endsWith('/order')) {
          return http.Response('', 204);
        }
        if (request.url.path.endsWith('/images/logo') &&
            request.bodyBytes.length > 1000) {
          return http.Response(
            jsonEncode({
              'error': 'Images must be under 8 MB.',
              'reason': 'too_large',
            }),
            413,
          );
        }
        final kind = request.url.path.contains('/staff/')
            ? 'staff'
            : request.url.path.contains('gallery')
            ? 'gallery'
            : 'logo';
        return http.Response(jsonEncode(uploaded(kind, next++)), 201);
      }),
    )..token = 'test-token';
  });

  group('api', () {
    test('uploads the raw bytes with their type, to the right path', () async {
      final image = await api.uploadImage(
        business,
        const ImageTarget.logo(),
        jpeg,
        contentType: 'image/jpeg',
      );
      final r = requests.single;
      expect(r.method, 'PUT');
      expect(r.url.path, endsWith('/businesses/$business/images/logo'));
      expect(r.headers['Content-Type'], 'image/jpeg');
      expect(r.headers['Authorization'], 'Bearer test-token');
      expect(r.bodyBytes, jpeg);
      expect(image.id, imageId(1));
      expect(image.url, startsWith('https://'));
    });

    test('portfolio sends the caption; staff sends consent', () async {
      await api.uploadImage(
        business,
        const ImageTarget.gallery(),
        jpeg,
        contentType: 'image/jpeg',
        caption: ' Bridal ',
      );
      expect(requests.last.method, 'POST');
      expect(requests.last.url.queryParameters, {'alt': 'Bridal'});

      await api.uploadImage(
        business,
        ImageTarget.staff(staffId),
        jpeg,
        contentType: 'image/jpeg',
        staffConsent: true,
      );
      expect(requests.last.url.queryParameters, {'consent': 'true'});
    });

    test('refuses wrong types, oversize files, missing captions and bad ids before sending', () async {
      Future<void> expectRefused(Future<void> Function() call) async {
        await expectLater(call(), throwsA(isA<ApiException>()));
      }

      await expectRefused(
        () => api.uploadImage(
          business,
          const ImageTarget.logo(),
          jpeg,
          contentType: 'image/svg+xml',
        ),
      );
      await expectRefused(
        () => api.uploadImage(
          business,
          const ImageTarget.logo(),
          Uint8List(maxImageBytes + 1),
          contentType: 'image/jpeg',
        ),
      );
      await expectRefused(
        () => api.uploadImage(
          business,
          const ImageTarget.gallery(),
          jpeg,
          contentType: 'image/jpeg',
        ),
      );
      expect(requests, isEmpty);
      expect(() => ImageTarget.service('../../etc'), throwsArgumentError);
      expect(() => ImageTarget.galleryItem('not-hex'), throwsArgumentError);
    });

    test("the backend's refusal message reaches the owner", () async {
      await expectLater(
        api.uploadImage(
          business,
          const ImageTarget.logo(),
          Uint8List(2000),
          contentType: 'image/jpeg',
        ),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'Images must be under 8 MB.',
          ),
        ),
      );
    });

    test('delete, caption and reorder', () async {
      await api.deleteImage(business, const ImageTarget.cover());
      expect(
        [requests.last.method, requests.last.url.path],
        ['DELETE', '/businesses/$business/images/cover'],
      );
      await api.captionGalleryPhoto(business, imageId(3), 'New');
      expect(jsonDecode(requests.last.body), {'alt': 'New'});
      await api.reorderGallery(business, [imageId(2), imageId(1)]);
      expect(jsonDecode(requests.last.body), {
        'imageIds': [imageId(2), imageId(1)],
      });
    });

    test('ignores non-https or malformed upload responses', () {
      expect(
        () => UploadedImage.fromJson({
          'image': {
            'id': imageId(1),
            'url': 'http://insecure/x.webp',
            'variants': [],
          },
        }),
        throwsFormatException,
      );
      expect(
        GalleryPhoto.listFrom([
          {'url': 'javascript:alert(1)', 'alt': 'x'},
          {'url': 'https://ok/x.webp', 'alt': 'ok', 'imageId': imageId(1)},
        ]).map((g) => g.url),
        ['https://ok/x.webp'],
      );
    });
  });

  Widget host(Widget child) => MaterialApp(
    theme: buildScalivoTheme(),
    home: Scaffold(body: SingleChildScrollView(child: child)),
  );

  testWidgets('image slot: pick, upload, show Remove, remove', (tester) async {
    List<int>? sent;
    var removed = false;
    await tester.pumpWidget(
      host(
        ImageSlot(
          label: 'Logo',
          url: null,
          aspectRatio: 1,
          picker: pickJpeg,
          onUpload: (bytes, type) async {
            sent = bytes;
            expect(type, 'image/jpeg');
            return 'https://pub-x.r2.dev/b/$business/logo/${imageId(9)}/512.webp';
          },
          onRemove: () async => removed = true,
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('Logo-choose')));
    await settleNetwork(tester);
    expect(sent, jpeg);
    expect(find.text('Replace'), findsOneWidget);
    await tester.tap(find.byKey(const Key('Logo-remove')));
    await tester.pumpAndSettle();
    expect(removed, isTrue);
    expect(find.text('Choose photo'), findsOneWidget);
  });

  testWidgets('staff photo needs consent before anything is uploaded', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildScalivoTheme(),
        home: StaffEditScreen(
          api: api,
          businessId: business,
          services: const [],
          member: const StaffMember(
            id: staffId,
            name: 'Ayesha',
            serviceIds: [],
            workingHours: [],
            active: true,
          ),
          picker: pickJpeg,
        ),
      ),
    );
    await tester.tap(find.byKey(const Key('Photo (optional)-choose')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Switch on consent first'), findsOneWidget);
    expect(requests, isEmpty);

    await tester.tap(find.byKey(const Key('staff-photo-consent')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('Photo (optional)-choose')));
    await settleNetwork(tester);
    expect(
      requests.single.url.path,
      '/businesses/$business/staff/$staffId/photo',
    );
    expect(requests.single.url.queryParameters['consent'], 'true');
  });

  testWidgets('portfolio: add with a caption, then delete', (tester) async {
    await tester.pumpWidget(
      host(
        PortfolioEditor(
          api: api,
          businessId: business,
          initial: const [],
          picker: pickJpeg,
        ),
      ),
    );
    expect(
      find.text('0 of 12 photos. Each needs a short caption.'),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('portfolio-add')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const Key('portfolio-caption')),
      'Balayage',
    );
    await tester.tap(find.text('Save'));
    await settleNetwork(tester);
    expect(requests.single.method, 'POST');
    expect(requests.single.url.queryParameters['alt'], 'Balayage');
    expect(find.text('Balayage'), findsOneWidget);
    expect(
      find.text('1 of 12 photos. Each needs a short caption.'),
      findsOneWidget,
    );

    await tester.tap(find.byTooltip('Delete photo'));
    await settleNetwork(tester);
    expect(requests.last.method, 'DELETE');
    expect(
      requests.last.url.path,
      '/businesses/$business/images/gallery/${imageId(1)}',
    );
    expect(
      find.text('0 of 12 photos. Each needs a short caption.'),
      findsOneWidget,
    );
  });

  testWidgets('photos screen loads the current logo, cover and portfolio', (
    tester,
  ) async {
    // Tall enough that the list builds the portfolio section too.
    tester.view.physicalSize = const Size(1080, 5000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final profileApi = ApiClient(
      client: MockClient((request) async {
        expect(request.url.path, '/businesses/$business');
        return http.Response(
          jsonEncode({
            'name': 'Glow',
            'city': 'Multan',
            'timezone': 'Asia/Karachi',
            'published': true,
            'slotIncrementMinutes': 15,
            'profile': {
              'logoUrl':
                  'https://pub-x.r2.dev/b/$business/logo/${imageId(1)}/512.webp',
              'coverUrl': null,
              'gallery': [
                {
                  'url':
                      'https://pub-x.r2.dev/b/$business/gallery/${imageId(2)}/1600.webp',
                  'alt': 'Balayage',
                  'imageId': imageId(2),
                },
                {'url': 'https://example.com/old.jpg', 'alt': 'Pasted earlier'},
              ],
            },
          }),
          200,
        );
      }),
    )..token = 'test-token';
    final auth = AuthController(api: profileApi)
      ..status = AuthStatus.signedIn
      ..me = const Me(
        name: 'Owner',
        email: 'owner@example.test',
        businesses: [
          BusinessSummary(
            id: business,
            name: 'Glow',
            category: 'salon',
            whatsappStatus: 'ready',
            whatsappIntent: 'live',
          ),
        ],
      );
    addTearDown(auth.dispose);
    await tester.pumpWidget(
      ChangeNotifierProvider<AuthController>.value(
        value: auth,
        child: MaterialApp(
          theme: buildScalivoTheme(),
          home: const PhotosScreen(picker: pickJpeg),
        ),
      ),
    );
    await settleNetwork(tester);
    expect(find.text('Logo and cover'), findsOneWidget);
    expect(find.text('Replace'), findsOneWidget); // logo present
    expect(find.text('Choose photo'), findsOneWidget); // cover empty
    expect(
      find.text('2 of 12 photos. Each needs a short caption.'),
      findsOneWidget,
    );
    // A pasted photo is shown but cannot be managed from the app.
    expect(find.byTooltip('Delete photo'), findsOneWidget);
  });
}
