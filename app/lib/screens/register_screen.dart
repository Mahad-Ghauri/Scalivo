import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../api/api_client.dart';
import '../state/auth_controller.dart';
import '../widgets/auth_layout.dart';
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

    // No entrance animation: this screen is reached from the Sign up tab with a
    // cross-fade, and replaying the sheet sliding up would break the illusion of
    // one screen switching tabs.
    return SheetScaffold(
      heroHeight: authHeroHeight(context),
      overlap: 0,
      sheetRadius: authSheetRadius,
      hero: const AuthHero(),
      sheetPadding: EdgeInsets.fromLTRB(26, 28, 26, 24 + MediaQuery.paddingOf(context).bottom),
      sheet: SingleChildScrollView(
        child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AuthTabs(
                    selected: AuthTab.signUp,
                    enabled: !busy,
                    onSelect: (_) {
                      context.read<AuthController>().clearError();
                      Navigator.of(context).pop();
                    },
                  ),
                  const SizedBox(height: 28),
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
                  EntranceItem(index: 0, child: ScField(
                    label: 'Business name',
                    icon: Icons.storefront_outlined,
                    controller: _businessName,
                    hint: 'Business name',
                    enabled: !busy,
                    errorText: _errors['businessName'],
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                  )),
                  const SizedBox(height: 14),
                  EntranceItem(index: 1, child: LayoutBuilder(builder: (context, constraints) {
                    final stacked = constraints.maxWidth < 300 || MediaQuery.textScalerOf(context).scale(14) > 20;
                    final width = stacked ? constraints.maxWidth : (constraints.maxWidth - 12) / 2;
                    return Wrap(spacing: 12, runSpacing: 14, children: [
                      SizedBox(width: width, child: ScDropdown<String>(
                        label: 'Category', icon: Icons.category_outlined, value: _category, items: _categories.keys.toList(),
                        itemLabel: (k) => _categories[k]!, enabled: !busy,
                        onChanged: (v) => setState(() => _category = v ?? _category))),
                      SizedBox(width: width, child: ScDropdown<String>(
                        label: 'City', icon: Icons.place_outlined, value: _city, items: _cities, itemLabel: (c) => c,
                        enabled: !busy, onChanged: (v) => setState(() => _city = v ?? _city))),
                    ]);
                  })),
                  const SizedBox(height: 14),
                  EntranceItem(index: 2, child: ScField(
                    label: 'Owner name',
                    icon: Icons.person_outline_rounded,
                    controller: _ownerName,
                    hint: 'Your name',
                    enabled: !busy,
                    errorText: _errors['ownerName'],
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                  )),
                  const SizedBox(height: 14),
                  EntranceItem(index: 3, child: ScField(
                    label: 'Email',
                    icon: Icons.mail_outline_rounded,
                    controller: _email,
                    hint: 'you@business.com',
                    enabled: !busy,
                    errorText: _errors['email'],
                    keyboardType: TextInputType.emailAddress,
                    textInputAction: TextInputAction.next,
                  )),
                  const SizedBox(height: 14),
                  EntranceItem(index: 4, child: ScField(
                    label: 'Password',
                    icon: Icons.lock_outline_rounded,
                    hint: 'Password',
                    controller: _password,
                    password: true,
                    enabled: !busy,
                    errorText: _errors['password'],
                    helper: 'Minimum 8 characters',
                  )),
                  const SizedBox(height: 14),
                  EntranceItem(index: 5, child: ScField(
                    label: 'Confirm password',
                    icon: Icons.lock_outline_rounded,
                    hint: 'Confirm password',
                    controller: _confirm,
                    password: true,
                    enabled: !busy,
                    errorText: _errors['confirm'],
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => _submit(),
                  )),
                  const SizedBox(height: 26),
                  EntranceItem(index: 6, child: ScButton(
                    label: 'Sign up',
                    loadingLabel: 'Creating',
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
}
