# Scalivo owner app

Flutter owner app for bookings, customers, services, staff, and WhatsApp connection recovery.

## Mobile business tools

Open **Settings → Your business** for analytics, reviews, Grow, and customer import.
These screens use the existing authenticated backend APIs. Deposits are excluded.

- Analytics shows completed revenue, appointment outcomes, trends, and booked revenue ahead.
- Reviews separates published feedback from private alerts and links flagged reviews to customer profiles.
- Grow shares booking links and QR posters, manages listing boosts and rebooking nudges, and previews campaigns before sending. Delivery counts come from acknowledgements.
- Import selects a UTF-8 CSV on the device, maps columns, previews server validation, and requires confirmation before applying changes. Files are capped at 1 MB and 2,000 customers; imports send no messages.

Use a Flutter SDK with Dart 3.13.1 or newer. Start the backend using the
[repository setup instructions](../README.md), then run on a connected device:

```sh
cd app
flutter pub get
flutter devices
flutter run -d <device-id> --dart-define=SCALIVO_API=https://your-api.example
```

For local development, use an API address reachable from the device. A phone's
`localhost` refers to the phone. Configure the backend's existing `WEB_URL` with
a customer-reachable public booking URL before sharing links or posters.

File selection, image sharing, and native notifications require device acceptance
testing in addition to the automated tests below. File selection uses the platform
picker; poster exports use one file in the app's temporary directory, without broad
storage permission. New packages provide native picker/sharing/QR support and
quoted CSV parsing, which Flutter's standard library and the existing dependencies
do not supply. `path_provider` was already transitive and is now used directly.

## Run in a browser

Use a Flutter SDK with Dart 3.13.1 or newer to satisfy `pubspec.yaml`. Start the
backend using the [repository setup instructions](../README.md), then run:

```sh
cd app
flutter pub get
flutter run -d chrome --web-port=8085 --dart-define=SCALIVO_API=http://localhost:3000
```

For a browser served separately from Flutter's Chrome launcher:

```sh
flutter run -d web-server --web-hostname=127.0.0.1 --web-port=8085 --dart-define=SCALIVO_API=http://localhost:3000
```

Open `http://127.0.0.1:8085`. The backend accepts loopback browser origins in
development. Set `SCALIVO_API` to your backend URL when using another environment.
Use HTTPS for a hosted app and API; browser token storage requires a secure context
(localhost is supported for development).

Browser push notifications are not verified by this setup. The existing Android
notification channels remain native-only. The JavaScript web build is supported;
the current secure-storage dependency does not support a WebAssembly build.

## Build and check

```sh
flutter build web --dart-define=SCALIVO_API=http://localhost:3000
flutter analyze
flutter test
```

The web build is written to `build/web`. Serve that directory over HTTP; opening
`index.html` directly as a file does not run the app correctly.
