import 'package:flutter/material.dart';

import '../auth/sign_in_screen.dart';
import '../design/brand.dart';
import '../design/tokens.dart';

/// First run: what this is, then out of the way.
///
/// The copy is the website's own voice ("Meetings reimagined. Cinematic.
/// Instant. Yours.") rather than newly invented marketing, so someone who
/// arrives from neoconference.app recognises where they are.
class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Scaffold(
      backgroundColor: p.bg,
      body: Stack(
        children: [
          // A single soft brand glow rather than a decorated background:
          // it gives the screen depth without competing with the copy.
          Positioned(
            top: -160,
            right: -120,
            child: Container(
              height: 420,
              width: 420,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(
                  colors: [
                    p.primary.withValues(alpha: p.isDark ? 0.22 : 0.16),
                    p.bg.withValues(alpha: 0),
                  ],
                ),
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(
                NeoSpace.xxl,
                NeoSpace.xxl,
                NeoSpace.xxl,
                NeoSpace.xxl,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const NeoLogo(markSize: 40, fontSize: 22),
                  const Spacer(),
                  Text('Meetings\nreimagined.', style: text.displaySmall),
                  const SizedBox(height: NeoSpace.md),
                  Text(
                    'Cinematic. Instant. Yours.',
                    style: text.titleMedium?.copyWith(color: p.primary),
                  ),
                  const SizedBox(height: NeoSpace.xl),
                  Text(
                    'Host and join meetings with live translation, '
                    'recording and host controls — from your phone.',
                    style: text.bodyLarge?.copyWith(color: p.textMuted),
                  ),
                  const Spacer(),
                  const _Highlights(),
                  const SizedBox(height: NeoSpace.xxl),
                  FilledButton(
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute(builder: (_) => const SignInScreen()),
                    ),
                    child: const Text('Get started'),
                  ),
                  const SizedBox(height: NeoSpace.md),
                  Center(
                    child: TextButton(
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute(builder: (_) => const SignInScreen()),
                      ),
                      child: const Text('I already have an account'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Highlights extends StatelessWidget {
  const _Highlights();

  @override
  Widget build(BuildContext context) {
    const items = [
      (Icons.translate_rounded, 'Live translation'),
      (Icons.hd_rounded, 'HD video'),
      (Icons.shield_moon_rounded, 'Host controls'),
    ];
    return Row(
      children: [
        for (final (icon, label) in items)
          Expanded(child: _Highlight(icon: icon, label: label)),
      ],
    );
  }
}

class _Highlight extends StatelessWidget {
  const _Highlight({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Column(
      children: [
        Icon(icon, color: p.primary, size: 22),
        const SizedBox(height: NeoSpace.sm),
        Text(
          label,
          textAlign: TextAlign.center,
          style: Theme.of(context)
              .textTheme
              .labelSmall
              ?.copyWith(color: p.textMuted),
        ),
      ],
    );
  }
}
