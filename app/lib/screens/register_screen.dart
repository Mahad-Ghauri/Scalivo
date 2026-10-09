import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../state/auth_controller.dart';
import '../theme.dart';
import '../widgets/sc_banner.dart';
import '../widgets/sc_button.dart';
import '../widgets/sc_dropdown.dart';
import '../widgets/sc_field.dart';
import '../widgets/sheet_scaffold.dart';

/// The categories the backend accepts. Kept in lockstep with the zod enum in
/// `backend/src/auth/routes.ts` — a value that isn't there is a 400.
const _categories = <String, String>{
  'salon': 'Salon',
  'gym': 'Gym',
  'clinic': 'Clinic',
};

/// Where the pilots are, then the rest of the country by size. A city missing
/// from this list blocks a signup, so it is meant to be extended freely.
const _cities = <String>[
  'Multan',
  'Lahore',
  'Karachi',
  'Islamabad',
  'Rawalpindi',
  'Faisalabad',
  'Peshawar',
  'Quetta',
  'Hyderabad',
  'Gujranwala',
  'Sialkot',
  'Bahawalpur',
];

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _businessName = TextEditingController();
  final _ownerName = TextEditingController();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _confirm = TextEditingController();

  String _category = 'salon';
  String _city = 'Multan';

  final Map<String, String?> _errors = {};

  @override
  void dispose() {
    for (final c in [_businessName, _ownerName, _email, _password, _confirm]) {
      c.dispose();
    }
    super.dispose();
  }

  bool _validate() {
    final email = _email.text.trim();

    setState(() {
      _errors
        ..clear()
        ..['businessName'] =
            _businessName.text.trim().isEmpty ? 'Business name is required' : null
        ..['ownerName'] = _ownerName.text.trim().isEmpty ? 'Owner name is required' : null
        ..['email'] = email.isEmpty
            ? 'Email is required'
            : (RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email)
                ? null
                : 'Enter a valid email address')
        ..['password'] = _password.text.length < 8
            ? 'Password must be at least 8 characters'
            : null
        ..['confirm'] =
            _confirm.text == _password.text ? null : "Passwords don't match";
    });

    return _errors.values.every((v) => v == null);
  }

  Future<void> _submit() async {
    final auth = context.read<AuthController>();
    auth.clearError();
    if (!_validate()) return;

    FocusScope.of(context).unfocus();

    final ok = await auth.register(
      businessName: _businessName.text,
      category: _category,
      city: _city,
      ownerName: _ownerName.text,
      email: _email.text,
      password: _password.text,
    );

    if (!mounted) return;

    if (ok) {
      // The root widget swaps to Home on its own once the status flips; this
      // just clears the register route off the stack behind it.
      Navigator.of(context).pop();
      return;
    }

    final fields = auth.error?.fieldErrors ?? const <String, String>{};
    if (fields.isNotEmpty) setState(() => _errors.addAll(fields));
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthController>();
    final busy = auth.busy;
    final banner = auth.error;
    final fieldCount = _errors.values.where((v) => v != null).length;

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
                  onTap: busy ? null : () => Navigator.of(context).pop(),
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
                'Create account',
                style: TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.w500,
                  color: Colors.white,
                  letterSpacing: -0.2,
                ),
              )),
            ],
          ),
        ),
      ),
      sheetPadding: const EdgeInsets.fromLTRB(26, 28, 26, 24),
      sheet: SingleChildScrollView(
        child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (banner != null) ...[
                    ScBanner(
                      title: banner.kind == ApiErrorKind.network
                          ? 'No internet connection'
                          : "Couldn't create your account",
                      message: banner.kind == ApiErrorKind.network
                          ? 'Reconnect and tap Sign up again.'
                          : (fieldCount > 0
                              ? 'Fix the $fieldCount highlighted ${fieldCount == 1 ? 'field' : 'fields'} below.'
                              : banner.message),
                      tone: banner.kind == ApiErrorKind.network
                          ? ScBannerTone.warning
                          : ScBannerTone.danger,
                    ),
                    const SizedBox(height: 18),
                  ],
                  ScField(
                    label: 'Business name',
                    controller: _businessName,
                    hint: 'Skinare Aesthetics',
                    enabled: !busy,
                    errorText: _errors['businessName'],
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                  ),
                  const SizedBox(height: 19),
                  LayoutBuilder(builder: (context, constraints) {
                    final stacked = constraints.maxWidth < 300 || MediaQuery.textScalerOf(context).scale(14) > 20;
                    final width = stacked ? constraints.maxWidth : (constraints.maxWidth - 18) / 2;
                    return Wrap(spacing: 18, runSpacing: 19, children: [
                      SizedBox(width: width, child: ScDropdown<String>(
                        label: 'Category', value: _category, items: _categories.keys.toList(),
                        itemLabel: (k) => _categories[k]!, enabled: !busy,
                        onChanged: (v) => setState(() => _category = v ?? _category))),
                      SizedBox(width: width, child: ScDropdown<String>(
                        label: 'City', value: _city, items: _cities, itemLabel: (c) => c,
                        enabled: !busy, onChanged: (v) => setState(() => _city = v ?? _city))),
                    ]);
                  }),
                  const SizedBox(height: 19),
                  ScField(
                    label: 'Owner name',
                    controller: _ownerName,
                    hint: 'Hina Nawaz',
                    enabled: !busy,
                    errorText: _errors['ownerName'],
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                  ),
                  const SizedBox(height: 19),
                  ScField(
                    label: 'Email',
                    controller: _email,
                    hint: 'you@business.com',
                    enabled: !busy,
                    errorText: _errors['email'],
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                  ),
                  const SizedBox(height: 19),
                  ScField(
                    label: 'Password',
                    controller: _password,
                    password: true,
                    enabled: !busy,
                    errorText: _errors['password'],
                    helper: 'Minimum 8 characters',
                  ),
                  const SizedBox(height: 19),
                  ScField(
                    label: 'Confirm password',
                    controller: _confirm,
                    password: true,
                    enabled: !busy,
                    errorText: _errors['confirm'],
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 26),
                  ScButton(
                    label: 'Sign up',
                    loadingLabel: 'Creating',
                    loading: busy,
                    onPressed: _submit,
                  ),
                  const SizedBox(height: 16),
          Wrap(
            alignment: WrapAlignment.center,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Text(
                'Already have an account?',
                style: TextStyle(fontSize: 13, color: Sc.inkMuted),
              ),
              TextButton(
                onPressed: busy ? null : () => Navigator.of(context).pop(),
                style: TextButton.styleFrom(
                  minimumSize: const Size(0, 48),
                  foregroundColor: Sc.teal900,
                ),
                child: const Text(
                  'LOG IN',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        ],
      ),
      ),
    );
  }
}
