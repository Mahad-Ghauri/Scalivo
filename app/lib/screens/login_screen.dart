import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/auth_layout.dart';
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

    return SheetScaffold(
      animateIn: true,
      heroHeight: authHeroHeight(context),
      overlap: 0,
      sheetRadius: authSheetRadius,
      hero: const AuthHero(),
      sheetPadding: EdgeInsets.fromLTRB(26, 28, 26, 20 + MediaQuery.paddingOf(context).bottom),
      sheet: SingleChildScrollView(
        child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  EntranceItem(index: 0, child: AuthTabs(
                    selected: AuthTab.signIn,
                    enabled: !busy,
                    onSelect: (_) {
                      context.read<AuthController>().clearError();
                      Navigator.of(context).push(authTabRoute(const RegisterScreen()));
                    },
                  )),
                  const SizedBox(height: 28),
                  if (auth.error != null && auth.error!.fieldErrors.isEmpty) ...[
                    ScBanner(
                      title: auth.error!.message,
                      message: switch (auth.error!.kind) {
                        ApiErrorKind.unauthorized => 'Check your details and try again.',
                        ApiErrorKind.network => 'Reconnect and tap Sign in again.',
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
                    icon: Icons.mail_outline_rounded,
                    controller: _email,
                    hint: 'you@business.com',
                    enabled: !busy,
                    errorText: _emailError,
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                    onSubmitted: (_) => _passwordFocus.requestFocus(),
                  )),
                  const SizedBox(height: 14),
                  EntranceItem(index: 3, child: ScField(
                    label: 'Password',
                    icon: Icons.lock_outline_rounded,
                    hint: 'Password',
                    controller: _password,
                    password: true,
                    enabled: !busy,
                    errorText: _passwordError,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submit(),
                  )),
                  const SizedBox(height: 10),
                  EntranceItem(index: 4, child: Row(children: [
                    Expanded(child: _rememberMe(busy)),
                    TextButton(
                      onPressed: busy ? null : () => _showResetHelp(context),
                      style: TextButton.styleFrom(
                        minimumSize: const Size(0, 48),
                        padding: const EdgeInsets.symmetric(horizontal: 4),
                        foregroundColor: Sc.teal,
                      ),
                      child: const Text(
                        'Forgot password?',
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                      ),
                    ),
                  ])),
                  const SizedBox(height: 18),
                  EntranceItem(index: 5, child: ScButton(
                    label: 'Sign in',
                    loadingLabel: 'Signing in',
                    loading: busy,
                    tone: ScButtonTone.forest,
                    arrow: true,
                    onPressed: _submit,
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
