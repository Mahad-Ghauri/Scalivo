# Scalivo owner app

Flutter owner app for bookings, customers, services, staff, and WhatsApp connection recovery.

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
