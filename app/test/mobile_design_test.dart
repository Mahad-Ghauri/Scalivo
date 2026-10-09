import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';
import 'package:scalivo_owner/api/api_client.dart';
import 'package:scalivo_owner/api/models.dart';
import 'package:scalivo_owner/format.dart';
import 'package:scalivo_owner/screens/home_screen.dart';
import 'package:scalivo_owner/screens/login_screen.dart';
import 'package:scalivo_owner/screens/register_screen.dart';
import 'package:scalivo_owner/state/auth_controller.dart';
import 'package:scalivo_owner/theme.dart';
import 'package:scalivo_owner/widgets/appointment_card.dart';
import 'package:scalivo_owner/widgets/sc_button.dart';
import 'package:scalivo_owner/widgets/sc_field.dart';

AuthController fixtureAuth({bool setupMissing = false}) {
  final api = ApiClient(
    client: MockClient((request) async {
      final path = request.url.path;
      final Object data;
      if (path.endsWith('/calendar')) {
        data = {
          'timezone': 'Asia/Karachi',
          'staff': <Object>[],
          'days': [
            {
              'date': isoDate(startOfToday()),
              'entries': <Object>[],
              'blocks': <Object>[],
            },
          ],
        };
      } else if (path.endsWith('/services')) {
        data = {'services': <Object>[]};
      } else if (path.endsWith('/staff')) {
        data = {'staff': <Object>[]};
      } else if (path.endsWith('/setup')) {
        data = {
          'bookable': false,
          'steps': setupMissing
              ? [
                  {
                    'id': 'services',
                    'done': false,
                    'detail': 'Add a service customers can book.',
                  },
                  {
                    'id': 'staff',
                    'done': false,
                    'detail': 'Add someone to carry out the service.',
                  },
                ]
              : <Object>[],
        };
      } else if (path.endsWith('/clients')) {
        data = {'clients': <Object>[], 'total': 0};
      } else if (path.endsWith('/whatsapp')) {
        data = {'status': 'disconnected', 'intent': 'live'};
      } else {
        data = {'name': 'The Courtyard Studio', 'timezone': 'Asia/Karachi'};
      }
      return http.Response(
        jsonEncode(data),
        200,
        headers: {'content-type': 'application/json'},
      );
    }),
  );
  return AuthController(api: api)
    ..status = AuthStatus.signedIn
    ..me = const Me(
      name: 'Owner',
      email: 'owner@example.test',
      businesses: [
        BusinessSummary(
          id: 'test',
          name: 'The Courtyard Studio',
          category: 'salon',
          whatsappStatus: 'disconnected',
          whatsappIntent: 'live',
        ),
      ],
    );
}

Future<void> mount(
  WidgetTester tester,
  Widget child, {
  AuthController? auth,
  double scale = 1,
  double bottom = 0,
  double keyboard = 0,
}) async {
  tester.view.physicalSize = const Size(320, 568);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: buildScalivoTheme(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          textScaler: TextScaler.linear(scale),
          padding: EdgeInsets.only(bottom: bottom),
          viewInsets: EdgeInsets.only(bottom: keyboard),
        ),
        child: child!,
      ),
      home: auth == null
          ? child
          : ChangeNotifierProvider.value(value: auth, child: child),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() async {
    final fonts = FontLoader('Poppins');
    for (final weight in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
      fonts.addFont(rootBundle.load('assets/fonts/Poppins-$weight.ttf'));
    }
    await fonts.load();
  });

  test('functional ink and alerts meet normal-text contrast on their surfaces', () {
    double contrast(Color first, Color second) {
      final a = first.computeLuminance();
      final b = second.computeLuminance();
      return a > b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
    }
    for (final (ink, surface) in [
      (Sc.ink, Sc.paper), (Sc.slate, Sc.paper), (Sc.slateLight, Sc.paper),
      (Sc.warnBody, Sc.warnBg), (Sc.dangerBody, Sc.dangerBg),
      (Colors.white, Sc.teal), (Colors.white, Sc.dangerText),
      (Sc.teal900, Sc.tealDisabled), (Sc.onTealBright, Sc.teal900),
    ]) {
      expect(contrast(ink, surface), greaterThanOrEqualTo(4.5));
    }
    expect(contrast(Sc.teal, Sc.paper), greaterThanOrEqualTo(3));
  });

  testWidgets('primary action grows for large text and exposes a button', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    try {
    var pressed = false;
    await mount(
      tester,
      Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(24),
          child: ScButton(
            label: 'Reserve this appointment',
            onPressed: () => pressed = true,
          ),
        ),
      ),
      scale: 2,
    );
    expect(tester.takeException(), isNull);
    expect(tester.getSize(find.byType(ScButton)).height, greaterThan(56));
    expect(
      tester.getSemantics(find.byType(ScButton)),
      isSemantics(
        isButton: true,
        hasEnabledState: true,
        isEnabled: true,
        label: 'Reserve this appointment',
        hasTapAction: true,
      ),
    );
    await tester.tap(find.text('Reserve this appointment'));
    expect(pressed, isTrue);
    } finally { semantics.dispose(); }
  });

  testWidgets('field has an input label and accessible password toggle', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    try {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await mount(
      tester,
      Scaffold(
        body: ScField(
          label: 'Password',
          controller: controller,
          password: true,
        ),
      ),
    );
    expect(tester.getSemantics(find.byType(EditableText)),
      isSemantics(isTextField: true, label: 'Password'));
    expect(tester.getSemantics(find.byTooltip('Show password')),
      isSemantics(isButton: true, tooltip: 'Show password', hasTapAction: true));
    expect(
      tester.getSize(find.byTooltip('Show password')).height,
      greaterThanOrEqualTo(48),
    );
    await tester.tap(find.byTooltip('Show password'));
    await tester.pump();
    expect(
      tester.widget<TextField>(find.byType(TextField)).obscureText,
      isFalse,
    );
    } finally { semantics.dispose(); }
  });

  testWidgets('appointment remains readable at narrow width and double text', (
    tester,
  ) async {
    final entry = CalendarEntry(
      id: 'visit',
      staffId: 'staff',
      staffName: 'Ayesha Khan',
      clientId: 'client',
      clientName: 'Sana Malik',
      clientPhone: null,
      serviceId: 'cut',
      serviceName: 'Cut and finish consultation',
      startsAt: DateTime(2026, 10, 9, 11),
      endsAt: DateTime(2026, 10, 9, 11, 45),
      durationMinutes: 45,
      status: 'pending',
      priceMinor: 250000,
      source: 'whatsapp',
    );
    await mount(
      tester,
      Scaffold(
        body: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: AppointmentCard(entry: entry),
          ),
        ),
      ),
      scale: 2,
    );
    expect(tester.takeException(), isNull);
    expect(find.text('Sana Malik'), findsOneWidget);
    expect(find.text('UNCONFIRMED'), findsOneWidget);
    final time = tester.widget<Text>(find.textContaining('11:00').first);
    expect(time.maxLines, isNull);
    expect(time.style!.fontFeatures, isNotEmpty);
  });

  testWidgets('Today can scroll past connection and setup at double text', (
    tester,
  ) async {
    final auth = fixtureAuth(setupMissing: true);
    await mount(tester, const HomeScreen(), auth: auth, scale: 2);
    expect(tester.takeException(), isNull);
    expect(find.text("Customers can't book right now"), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('THE DAY’S DIARY'),
      200,
      scrollable: find
          .descendant(
            of: find.byType(CustomScrollView).first,
            matching: find.byType(Scrollable),
          )
          .first,
    );
    expect(tester.takeException(), isNull);
    expect(find.text('THE DAY’S DIARY'), findsOneWidget);
  });

  testWidgets('home keeps labelled navigation above the bottom inset', (
    tester,
  ) async {
    await mount(tester, const HomeScreen(), auth: fixtureAuth(), bottom: 34);
    final nav = find.text('Settings').last;
    expect(tester.getBottomLeft(nav).dy, lessThanOrEqualTo(568 - 34));
    expect(find.text('Walk-in'), findsOneWidget);
    await tester.tap(nav);
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Booking window'), 160,
      scrollable: find.byType(Scrollable).first);
    expect(find.text('Booking window'), findsOneWidget);
    expect(find.text('Walk-in'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('enlarged navigation preserves words and reserves notice space', (tester) async {
    await mount(tester, const HomeScreen(), auth: fixtureAuth(setupMissing: true), scale: 2);
    expect(tester.takeException(), isNull);
    for (final label in ['Today', 'Calendar', 'Clients', 'Settings']) {
      final text = find.text(label).last;
      final paragraph = tester.renderObject<RenderParagraph>(text);
      expect(paragraph.getMaxIntrinsicWidth(double.infinity),
        lessThanOrEqualTo(tester.getSize(text).width + 0.5), reason: '$label must fit without clipping');
    }
    final walkIn = tester.getRect(find.text('Walk-in'));
    final diary = find.byType(CustomScrollView).first;
    expect(tester.getRect(diary).bottom, lessThanOrEqualTo(walkIn.top));
    await tester.scrollUntilVisible(find.text('RECONNECT'), 100,
      scrollable: find.descendant(of: diary, matching: find.byType(Scrollable)).first);
    await tester.pumpAndSettle();
    expect(find.text('RECONNECT').hitTestable(), findsOneWidget);
    expect(tester.getRect(find.text('RECONNECT')).bottom, lessThan(walkIn.top));
    await tester.tap(find.text('Calendar').last);
    await tester.pumpAndSettle();
    final dateHeading = find.text(dayLabelLong(startOfToday()));
    final dateText = tester.widget<Text>(dateHeading);
    for (final word in dateText.data!.split(' ')) {
      final painter = TextPainter(text: TextSpan(text: word,
        style: dateText.style!.copyWith(fontFamily: 'Poppins')),
        textScaler: const TextScaler.linear(2), textDirection: TextDirection.ltr)..layout();
      expect(painter.width, lessThanOrEqualTo(tester.getSize(dateHeading).width + 0.5),
        reason: 'Calendar date word $word must fit');
      painter.dispose();
    }
    for (final label in ['Clients', 'Settings']) {
      await tester.tap(find.text(label).last);
      await tester.pumpAndSettle();
      final heading = find.byWidgetPredicate((widget) => widget is Text &&
        widget.data == label && widget.style?.fontSize != 11);
      final paragraph = tester.renderObject<RenderParagraph>(heading);
      expect(paragraph.getMaxIntrinsicWidth(double.infinity),
        lessThanOrEqualTo(tester.getSize(heading).width + 0.5),
        reason: '$label heading must remain one complete word');
    }

    expect(tester.takeException(), isNull);
  });

  testWidgets('registration selectors stack and retain selected text when enlarged', (tester) async {
    await mount(tester, const RegisterScreen(), auth: fixtureAuth(), scale: 2);
    expect(tester.takeException(), isNull);
    expect(tester.getTopLeft(find.text('City')).dy,
      greaterThan(tester.getBottomLeft(find.text('Category')).dy));
    final city = find.text('Multan').first;
    final paragraph = tester.renderObject<RenderParagraph>(city);
    expect(paragraph.getMaxIntrinsicWidth(double.infinity),
      lessThanOrEqualTo(tester.getSize(city).width + 0.5));
  });

  for (final keyboard in [0.0, 280.0]) {
    testWidgets(
      'login form stays scrollable at double text with inset $keyboard',
      (tester) async {
        final semantics = tester.ensureSemantics();
        try {
        await mount(
          tester,
          const LoginScreen(),
          auth: fixtureAuth(),
          scale: 2,
          keyboard: keyboard,
        );
        expect(tester.takeException(), isNull);
        await tester.scrollUntilVisible(
          find.text('Login'),
          180,
          scrollable: find
              .descendant(
                of: find.byType(SingleChildScrollView),
                matching: find.byType(Scrollable),
              )
              .first,
        );
        expect(tester.takeException(), isNull);
        expect(find.text('Login').hitTestable(), findsOneWidget);
        expect(tester.getSemantics(find.text('Remember me')),
          isSemantics(label: 'Remember me', hasCheckedState: true));
        } finally { semantics.dispose(); }
      },
    );
  }
}
