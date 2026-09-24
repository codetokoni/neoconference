import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import 'auth_controller.dart';

class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key});

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _showPassword = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  void _submit() {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    FocusScope.of(context).unfocus();
    ref.read(authProvider.notifier).signInWithPassword(
          _email.text,
          _password.text,
        );
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authProvider);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _Wordmark(),
                    const SizedBox(height: 40),
                    TextFormField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Email',
                        prefixIcon: Icon(Icons.alternate_email),
                      ),
                      validator: (v) => (v ?? '').contains('@')
                          ? null
                          : 'Enter your email address',
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _password,
                      obscureText: !_showPassword,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _submit(),
                      decoration: InputDecoration(
                        labelText: 'Password',
                        prefixIcon: const Icon(Icons.lock_outline),
                        suffixIcon: IconButton(
                          icon: Icon(_showPassword
                              ? Icons.visibility_off_outlined
                              : Icons.visibility_outlined),
                          onPressed: () =>
                              setState(() => _showPassword = !_showPassword),
                          tooltip: _showPassword ? 'Hide password' : 'Show password',
                        ),
                      ),
                      validator: (v) =>
                          (v ?? '').isEmpty ? 'Enter your password' : null,
                    ),
                    if (auth.error != null) ...[
                      const SizedBox(height: 16),
                      _ErrorNote(auth.error!),
                    ],
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: auth.busy ? null : _submit,
                      child: auth.busy
                          ? const SizedBox(
                              height: 20,
                              width: 20,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Text('Sign in'),
                    ),
                    const SizedBox(height: 28),
                    const _Or(),
                    const SizedBox(height: 20),
                    _ProviderButton(
                      label: 'Continue with KingsChat',
                      icon: Icons.chat_bubble_outline,
                      onPressed: auth.busy
                          ? null
                          : () => ref
                              .read(authProvider.notifier)
                              .signInWithProvider('kingschat'),
                    ),
                    const SizedBox(height: 12),
                    _ProviderButton(
                      label: 'Continue with Neomail',
                      icon: Icons.mail_outline,
                      onPressed: auth.busy
                          ? null
                          : () => ref
                              .read(authProvider.notifier)
                              .signInWithProvider('neoemail'),
                    ),
                    const SizedBox(height: 28),
                    Text(
                      'New here? Create your account on neoconference.app, '
                      'then sign in.',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: NeoTheme.of(context).textMuted,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Wordmark extends StatelessWidget {
  const _Wordmark();

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Column(
      children: [
        // The site's own mark, rather than the video-camera stand-in that
        // used to sit here. The glow belongs on a dark surface and reads as
        // a smudge on a light one, so it follows the palette.
        NeoLogoMark(size: 72, glow: p.isDark),
        const SizedBox(height: 20),
        const NeoWordmark(fontSize: 26),
        const SizedBox(height: 6),
        Text(
          'Join and run your meetings',
          style: TextStyle(color: p.textMuted),
        ),
      ],
    );
  }
}

class _Or extends StatelessWidget {
  const _Or();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const Expanded(child: Divider()),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(
            'or',
            style: TextStyle(color: NeoTheme.of(context).textMuted),
          ),
        ),
        const Expanded(child: Divider()),
      ],
    );
  }
}

class _ProviderButton extends StatelessWidget {
  const _ProviderButton({
    required this.label,
    required this.icon,
    required this.onPressed,
  });

  final String label;
  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return OutlinedButton.icon(
      onPressed: onPressed,
      icon: Icon(icon, size: 20),
      label: Text(label),
      style: OutlinedButton.styleFrom(
        foregroundColor: p.primary,
        minimumSize: const Size.fromHeight(50),
        side: BorderSide(color: p.borderStrong),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }
}

class _ErrorNote extends StatelessWidget {
  const _ErrorNote(this.message);
  final String message;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: p.danger.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: p.danger.withValues(alpha: 0.33)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline, color: p.danger, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: TextStyle(color: p.text, fontSize: 13),
            ),
          ),
        ],
      ),
    );
  }
}
