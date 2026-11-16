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

    final keyboardUp = MediaQuery.viewInsetsOf(context).bottom > 0;
    final largeText = MediaQuery.textScalerOf(context).scale(14) > 20;
    final heroHeight = (keyboardUp ? 104.0 : largeText ? 200.0 : 236.0) + MediaQuery.paddingOf(context).top;
    const overlap = 0.0;

    return SheetScaffold(
      animateIn: true,
      heroHeight: heroHeight,
      overlap: overlap,
      hero: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Row(children: [
                if (!keyboardUp) ...[const LogoMark(size: 36), const SizedBox(width: 12)],
                Expanded(child: Text('scalivo', style: TextStyle(fontSize: keyboardUp || largeText ? 18 : 24,
                  fontWeight: FontWeight.w500, color: Colors.white, letterSpacing: -0.8))),
              ]),
              if (!keyboardUp && !largeText) ...[
                const SizedBox(height: 24),
                const Text('A little order.\nA better day.', style: TextStyle(fontSize: 30,
                  fontWeight: FontWeight.w500, color: Colors.white, height: 1.2, letterSpacing: -1)),
              ],
            ],
          ),
        ),
      ),
      sheetPadding: EdgeInsets.fromLTRB(26, 28, 26, 20 + MediaQuery.paddingOf(context).bottom),
      sheet: SingleChildScrollView(
        child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const EntranceItem(index: 0, child: Text('Sign in', style: TextStyle(fontSize: 25, fontWeight: FontWeight.w500, letterSpacing: -0.7))),
                  const SizedBox(height: 5),
                  const EntranceItem(index: 1, child: Text('Your diary, people and bookings.', style: TextStyle(fontSize: 13, color: Sc.slate))),
                  const SizedBox(height: 24),
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
                  EntranceItem(index: 2, child: ScField(
                    label: 'Email Address',
                    controller: _email,
                    hint: 'you@business.com',
                    enabled: !busy,
                    errorText: _emailError,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                    onSubmitted: (_) => _passwordFocus.requestFocus(),
                  )),
                  const SizedBox(height: 24),
                  EntranceItem(index: 3, child: ScField(
                    label: 'Password',
                    controller: _password,
                    password: true,
                    enabled: !busy,
                    errorText: _passwordError,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submit(),
                  )),
                  const SizedBox(height: 8),
                  EntranceItem(index: 4, child: Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: busy ? null : () => _showResetHelp(context),
                      style: TextButton.styleFrom(
                        minimumSize: const Size(0, 48),
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        foregroundColor: Sc.inkMuted,
                      ),
                      child: const Text(
                        'Forgot Password?',
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
                      ),
                    ),
                  )),
                  const SizedBox(height: 8),
                  EntranceItem(index: 5, child: _rememberMe(busy)),
                  const SizedBox(height: 26),
                  EntranceItem(index: 6, child: ScButton(
                    label: 'Login',
                    loadingLabel: 'Logging in',
                    loading: busy,
                    onPressed: _submit,
                  )),
                  const SizedBox(height: 20),
          EntranceItem(index: 7, child: Wrap(
            alignment: WrapAlignment.center,
            crossAxisAlignment: WrapCrossAlignment.center,
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
                  minimumSize: const Size(0, 48),
                  foregroundColor: Sc.teal900,
                ),
                child: const Text(
                  'SIGN UP',
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          )),
        ],
      ),
      ),
    );
  }

  Widget _rememberMe(bool busy) {
    return Semantics(checked: _remember, enabled: !busy,
      child: GestureDetector(
      onTap: busy ? null : () => setState(() => _remember = !_remember),
      behavior: HitTestBehavior.opaque,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48),
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
            const Expanded(child: Text(
              'Remember me',
              style: TextStyle(fontSize: 13.5, color: Sc.inkMuted),
            )),
          ],
        ),
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
        content: const SelectableText(
          'Email hello@scalivo.app for password recovery. '
          'Include your business name and account email.',
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
