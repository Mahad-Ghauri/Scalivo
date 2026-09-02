import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/sc_banner.dart';
import '../widgets/sc_button.dart';
import '../widgets/sc_field.dart';
import '../widgets/sheet_scaffold.dart';
import 'register_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _passwordFocus = FocusNode();

  bool _remember = true;
  String? _emailError;
  String? _passwordError;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  /// Client-side checks are the ones that need no round trip.
  ///
  /// Note there is no minimum length here even though the mock shows one:
  /// enforcing 8 characters at login would lock out anyone who registered under
  /// an older rule. Length belongs on the register screen, where it is a rule
  /// about a password being created.
  bool _validate() {
    final email = _email.text.trim();
    setState(() {
      _emailError = email.isEmpty
          ? 'Enter your email address'
          : (RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email)
              ? null
              : 'Enter a valid email address');
      _passwordError = _password.text.isEmpty ? 'Enter your password' : null;
    });
    return _emailError == null && _passwordError == null;
  }

  Future<void> _submit() async {
    final auth = context.read<AuthController>();
    auth.clearError();
    if (!_validate()) return;

    FocusScope.of(context).unfocus();
    await auth.login(_email.text, _password.text, remember: _remember);

    // A rejected login can carry field-keyed detail; surface it where it belongs.
    final fields = auth.error?.fieldErrors ?? const <String, String>{};
    if (fields.isNotEmpty && mounted) {
      setState(() {
        _emailError = fields['email'] ?? _emailError;
        _passwordError = fields['password'] ?? _passwordError;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthController>();
    final busy = auth.busy;

    // Give the keyboard room by shrinking the hero rather than squashing the form.
    final keyboardUp = MediaQuery.viewInsetsOf(context).bottom > 0;
    final heroHeight = keyboardUp ? 210.0 : 396.0;

    // 105 is the overlap from the canvas. It has to come down with the hero:
    // at 210 tall the sheet would ride straight over "Welcome Back!".
    final overlap = keyboardUp ? 40.0 : 105.0;

    return SheetScaffold(
      heroHeight: heroHeight,
      overlap: overlap,
      hero: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 36),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (!keyboardUp) ...[
                const LogoMark(size: 104),
                const SizedBox(height: 20),
              ],
              const Text(
                'Welcome Back!',
                style: TextStyle(
                  fontSize: 30,
                  fontWeight: FontWeight.w700,
                  color: Colors.white,
                  letterSpacing: -0.3,
                ),
              ),
            ],
          ),
        ),
      ),
      sheetPadding: const EdgeInsets.fromLTRB(26, 34, 26, 26),
      sheet: Column(
        children: [
          Expanded(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (auth.error != null && auth.error!.fieldErrors.isEmpty) ...[
                    ScBanner(
                      title: auth.error!.message,
                      message: switch (auth.error!.kind) {
                        ApiErrorKind.unauthorized => 'Check your details and try again.',
                        ApiErrorKind.network => 'Reconnect and tap Login again.',
                        _ => null,
                      },
                      tone: auth.error!.kind == ApiErrorKind.network
                          ? ScBannerTone.warning
                          : ScBannerTone.danger,
                    ),
                    const SizedBox(height: 22),
                  ],
                  ScField(
                    label: 'Email Address',
                    controller: _email,
                    hint: 'you@business.com',
                    enabled: !busy,
                    errorText: _emailError,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                    onSubmitted: (_) => _passwordFocus.requestFocus(),
                  ),
                  const SizedBox(height: 24),
                  ScField(
                    label: 'Password',
                    controller: _password,
                    password: true,
                    enabled: !busy,
                    errorText: _passwordError,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 8),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: busy ? null : () => _showResetHelp(context),
                      style: TextButton.styleFrom(
                        minimumSize: const Size(0, 44),
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        foregroundColor: Sc.inkMuted,
                      ),
                      child: const Text(
                        'Forgot Password?',
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  _rememberMe(busy),
                  const SizedBox(height: 26),
                  ScButton(
                    label: 'Login',
                    loadingLabel: 'Logging in',
                    loading: busy,
                    onPressed: _submit,
                  ),
                  const SizedBox(height: 20),
                ],
              ),
            ),
          ),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Text(
                "Don't have an account?",
                style: TextStyle(fontSize: 13.5, color: Sc.inkMuted),
              ),
              TextButton(
                onPressed: busy
                    ? null
                    : () {
                        context.read<AuthController>().clearError();
                        Navigator.of(context).push(
                          MaterialPageRoute<void>(builder: (_) => const RegisterScreen()),
                        );
                      },
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 44),
                  foregroundColor: Sc.teal900,
                ),
                child: const Text(
                  'SIGN UP',
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _rememberMe(bool busy) {
    return GestureDetector(
      onTap: busy ? null : () => setState(() => _remember = !_remember),
      behavior: HitTestBehavior.opaque,
      child: SizedBox(
        height: 44,
        child: Row(
          children: [
            Container(
              width: 20,
              height: 20,
              decoration: BoxDecoration(
                color: _remember ? Sc.teal : Colors.transparent,
                borderRadius: BorderRadius.circular(5),
                border: Border.all(
                  color: _remember ? Sc.teal : const Color(0xFFCDD6D5),
                  width: 1.5,
                ),
              ),
              child: _remember
                  ? const Icon(Icons.check_rounded, size: 14, color: Colors.white)
                  : null,
            ),
            const SizedBox(width: 10),
            const Text(
              'Remember me',
              style: TextStyle(fontSize: 13.5, color: Sc.inkMuted),
            ),
          ],
        ),
      ),
    );
  }

  /// Password reset needs outbound email, which does not exist yet. Saying so
  /// beats a link that silently does nothing.
  void _showResetHelp(BuildContext context) {
    showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: const Text(
          'Reset your password',
          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: Sc.ink),
        ),
        content: const Text(
          'Self-service reset is not available yet. Contact Scalivo support and '
          'we will reset it for you.',
          style: TextStyle(fontSize: 14, color: Sc.inkMuted, height: 1.5),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            style: TextButton.styleFrom(foregroundColor: Sc.teal900),
            child: const Text('OK', style: TextStyle(fontWeight: FontWeight.w600)),
          ),
        ],
      ),
    );
  }
}
