import 'dart:async';

import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../events/languages.dart';
import '../room/translation_voice.dart' show phoneVoices;

/// "Hello" in each language live translation speaks, in its own script.
/// The bar cycles through them: it shows translation rather than saying it.
const liveTranslationGreetings = <String>[
  'Hello',
  'Hola',
  'Bonjour',
  'Hallo',
  'Olá',
  'Ciao',
  'Hoi',
  'こんにちは',
  '안녕하세요',
  '你好',
  'Привет',
  'Merhaba',
  'Cześć',
];

/// The banner fixed at the top of Home: live translation, what
/// NeoConference is for. Tapping it says how to turn it on in a meeting.
class LiveTranslationBar extends StatefulWidget {
  const LiveTranslationBar({super.key});

  @override
  State<LiveTranslationBar> createState() => _LiveTranslationBarState();
}

class _LiveTranslationBarState extends State<LiveTranslationBar> {
  Timer? _cycle;
  int _greeting = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Still for anyone who has asked their phone for less motion.
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (still) {
      _cycle?.cancel();
      _cycle = null;
    } else {
      _cycle ??= Timer.periodic(const Duration(milliseconds: 2200), (_) {
        if (mounted) setState(() => _greeting = (_greeting + 1) % liveTranslationGreetings.length);
      });
    }
  }

  @override
  void dispose() {
    _cycle?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    // Coat of Many lends its own colours; every other theme its primary.
    final a = p.spectrumAt(4) ?? p.primary;
    final b = p.spectrumAt(6) ?? p.info;
    final radius = BorderRadius.circular(NeoRadius.xl);

    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.sm, NeoSpace.xl, 0),
      child: Semantics(
        button: true,
        label: 'Live translation. Hear every speaker in your language. How it works.',
        excludeSemantics: true,
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: radius,
            boxShadow: [
              BoxShadow(color: a.withValues(alpha: p.isDark ? 0.22 : 0.14), blurRadius: 28, offset: const Offset(0, 8)),
            ],
          ),
          child: Material(
            color: Colors.transparent,
            borderRadius: radius,
            clipBehavior: Clip.antiAlias,
            child: Ink(
              decoration: BoxDecoration(
                borderRadius: radius,
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    Color.alphaBlend(a.withValues(alpha: p.isDark ? 0.20 : 0.12), p.surface),
                    Color.alphaBlend(b.withValues(alpha: p.isDark ? 0.14 : 0.08), p.surface),
                  ],
                ),
                border: Border.all(color: a.withValues(alpha: 0.35)),
              ),
              child: InkWell(
                onTap: () => neoSheet(context, builder: (_) => const LiveTranslationHowTo()),
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(NeoSpace.md, NeoSpace.md, NeoSpace.md, NeoSpace.md),
                  child: Row(
                    children: [
                      // The badge: the translate mark on the brand gradient.
                      Container(
                        width: 44,
                        height: 44,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          gradient: LinearGradient(
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                            colors: [a, b],
                          ),
                          boxShadow: [BoxShadow(color: a.withValues(alpha: 0.45), blurRadius: 14)],
                        ),
                        child: const Icon(Icons.translate_rounded, color: Colors.white, size: 22),
                      ),
                      const SizedBox(width: NeoSpace.md),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    'Live translation',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: text.titleSmall?.copyWith(
                                      color: p.text,
                                      fontWeight: FontWeight.w700,
                                      letterSpacing: -0.1,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: NeoSpace.sm),
                                _LiveMark(colour: a),
                              ],
                            ),
                            const SizedBox(height: 3),
                            Text(
                              // Short enough to fit beside the greeting pill
                              // on a 360-dp phone.
                              'Hear it in your language',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: text.bodySmall?.copyWith(color: p.textMuted),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: NeoSpace.sm),
                      // "Hello" in a new language every couple of seconds.
                      Container(
                        padding: const EdgeInsets.fromLTRB(12, 7, 8, 7),
                        decoration: BoxDecoration(
                          color: p.bg.withValues(alpha: p.isDark ? 0.45 : 0.7),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: a.withValues(alpha: 0.30)),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            // One width for every greeting: the card must not
                            // shift each time the word changes.
                            SizedBox(
                              width: 78,
                              child: AnimatedSwitcher(
                                duration: const Duration(milliseconds: 420),
                                switchInCurve: Curves.easeOutCubic,
                                switchOutCurve: Curves.easeInCubic,
                                transitionBuilder: (child, anim) => FadeTransition(
                                  opacity: anim,
                                  child: SlideTransition(
                                    position: Tween(begin: const Offset(0, 0.35), end: Offset.zero).animate(anim),
                                    child: child,
                                  ),
                                ),
                                child: FittedBox(
                                  key: ValueKey(_greeting),
                                  fit: BoxFit.scaleDown,
                                  child: Text(
                                    liveTranslationGreetings[_greeting],
                                    maxLines: 1,
                                    textAlign: TextAlign.center,
                                    style: text.labelLarge?.copyWith(color: a, fontWeight: FontWeight.w700),
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 2),
                            Icon(Icons.chevron_right_rounded, size: 18, color: p.textMuted),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A small "LIVE" tag with a glowing dot.
class _LiveMark extends StatelessWidget {
  const _LiveMark({required this.colour});
  final Color colour;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: colour.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              color: colour,
              shape: BoxShape.circle,
              boxShadow: [BoxShadow(color: colour.withValues(alpha: 0.8), blurRadius: 6)],
            ),
          ),
          const SizedBox(width: 4),
          Text(
            'LIVE',
            style: TextStyle(color: colour, fontSize: 10, fontWeight: FontWeight.w800, letterSpacing: 0.8),
          ),
        ],
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
                // The popular ones and how many more: all of them would
                // fill the sheet with a hundred-odd chips.
                for (final l in meetingLanguages)
                  Chip(
                    label: Text(l.native, style: const TextStyle(fontSize: 12)),
                    visualDensity: VisualDensity.compact,
                  ),
                // A button, not a label: on build 3181 it was a plain Chip,
                // and tapping it to see the rest did nothing at all.
                ActionChip(
                  avatar: Icon(Icons.add_rounded, size: 16, color: p.primary),
                  label: Text(
                    '${translationLanguages.length - meetingLanguages.length} more',
                    style: TextStyle(fontSize: 12, color: p.primary),
                  ),
                  visualDensity: VisualDensity.compact,
                  onPressed: () => neoSheet(
                    context,
                    fullHeight: true,
                    builder: (_) => const AllLanguagesSheet(),
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

/// Every language live translation can speak, searchable: what the
/// how-to's "more" opens. Browsing only — a listener picks theirs inside
/// a meeting, where the choice belongs.
class AllLanguagesSheet extends StatefulWidget {
  const AllLanguagesSheet({super.key});

  @override
  State<AllLanguagesSheet> createState() => _AllLanguagesSheetState();
}

class _AllLanguagesSheetState extends State<AllLanguagesSheet> {
  String _query = '';

  /// What this phone can read aloud; null until known (or in a test).
  Set<String>? _voices;

  @override
  void initState() {
    super.initState();
    phoneVoices().then((v) {
      if (mounted) setState(() => _voices = v);
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final shown = [for (final l in translationLanguages) if (l.matches(_query)) l];
    final voices = _voices;
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.8,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.sm, NeoSpace.xl, NeoSpace.xs),
              child: Text('${translationLanguages.length} languages', style: text.titleLarge),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoSpace.xl, 0, NeoSpace.xl, NeoSpace.sm),
              child: Text(
                voices == null
                    ? 'Pick yours in a meeting: More, then Live translation.'
                    : 'This phone can read ${voices.length} of them aloud; the others '
                        'show as text. Pick yours in a meeting: More, then Live translation.',
                style: text.bodySmall?.copyWith(color: p.textMuted),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoSpace.xl, 0, NeoSpace.xl, NeoSpace.sm),
              child: TextField(
                onChanged: (v) => setState(() => _query = v),
                textInputAction: TextInputAction.search,
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search_rounded),
                  hintText: 'Search languages',
                  isDense: true,
                ),
              ),
            ),
            Expanded(
              child: shown.isEmpty
                  ? Padding(
                      padding: const EdgeInsets.all(NeoSpace.xl),
                      child: Text(
                        'No language matches "${_query.trim()}".',
                        style: TextStyle(color: p.textMuted),
                      ),
                    )
                  : ListView(
                      children: [
                        for (final l in shown)
                          ListTile(
                            dense: true,
                            title: Text(l.native),
                            subtitle: l.native == l.label ? null : Text(l.label),
                            trailing: voices == null
                                ? null
                                : voices.contains(l.code)
                                    ? Icon(Icons.volume_up_rounded, size: 20, color: p.primary)
                                    : Text('text only', style: TextStyle(color: p.textMuted, fontSize: 12)),
                          ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
