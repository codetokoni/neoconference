import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../events/languages.dart';

/// The bar fixed at the top of Home: live translation, what NeoConference
/// is for. Tapping it says how to turn it on in a meeting.
class LiveTranslationBar extends StatelessWidget {
  const LiveTranslationBar({super.key});

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final colour = p.spectrumAt(4) ?? p.primary;
    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.sm, NeoSpace.xl, 0),
      child: Material(
        color: colour.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(NeoRadius.lg),
        child: InkWell(
          borderRadius: BorderRadius.circular(NeoRadius.lg),
          onTap: () => neoSheet(context, builder: (_) => const LiveTranslationHowTo()),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: NeoSpace.lg, vertical: NeoSpace.md),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(NeoRadius.lg),
              border: Border.all(color: colour.withValues(alpha: 0.45)),
            ),
            child: Row(
              children: [
                Icon(Icons.translate_rounded, color: colour),
                const SizedBox(width: NeoSpace.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Live translation',
                        style: Theme.of(context).textTheme.titleSmall?.copyWith(color: p.text),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Hear every speaker in your language · ${translationLanguages.length} languages',
                        style: TextStyle(color: p.textMuted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                Icon(Icons.chevron_right_rounded, color: p.textMuted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// How to use live translation, in the words of the meeting screen.
class LiveTranslationHowTo extends StatelessWidget {
  const LiveTranslationHowTo({super.key});

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    Widget step(int n, String line) => Padding(
          padding: const EdgeInsets.only(bottom: NeoSpace.md),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                radius: 12,
                backgroundColor: p.primary.withValues(alpha: 0.18),
                child: Text('$n', style: TextStyle(color: p.primary, fontSize: 12)),
              ),
              const SizedBox(width: NeoSpace.md),
              Expanded(child: Text(line, style: text.bodyMedium?.copyWith(color: p.text, height: 1.4))),
            ],
          ),
        );
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.md, NeoSpace.xl, NeoSpace.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Hear every speaker in your language', style: text.titleLarge),
            const SizedBox(height: NeoSpace.sm),
            Text(
              'NeoConference speaks each speaker\'s words to you in the language you choose, '
              'with the original voice quietly underneath. Everyone picks their own. It is on '
              'every plan.',
              style: text.bodyMedium?.copyWith(color: p.textMuted, height: 1.4),
            ),
            const SizedBox(height: NeoSpace.lg),
            step(1, 'Join or start a meeting.'),
            step(2, 'The host turns on Live captions: translation works from them.'),
            step(3, 'Tap More, then Live translation, and pick your language.'),
            const SizedBox(height: NeoSpace.sm),
            Wrap(
              spacing: NeoSpace.xs,
              runSpacing: NeoSpace.xs,
              children: [
                for (final l in translationLanguages)
                  Chip(
                    label: Text(l.native, style: const TextStyle(fontSize: 12)),
                    visualDensity: VisualDensity.compact,
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
