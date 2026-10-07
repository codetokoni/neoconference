import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../design/brand.dart';
import '../design/tokens.dart';

/// Whether the introduction still has to be shown on this phone.
enum IntroState {
  /// Not read from the phone yet.
  unknown,
  show,
  seen,
}

/// The first-launch introduction: shown once, before sign-in, then
/// remembered on the phone.
class IntroController extends StateNotifier<IntroState> {
  IntroController() : super(IntroState.unknown) {
    unawaited(_restore());
  }

  /// Public so tests bind to the real key.
  static const storageKey = 'neo.intro.seen.v1';

  Future<void> _restore() async {
    try {
      // A phone whose storage never answers must not hold the app on a
      // spinner: after two seconds, go on as if it had been seen.
      final prefs = await SharedPreferences.getInstance().timeout(const Duration(seconds: 2));
      state = prefs.getBool(storageKey) == true ? IntroState.seen : IntroState.show;
    } catch (_) {
      state = IntroState.seen;
    }
  }

  /// Done or skipped. Moves on at once; remembering it is not awaited, so
  /// the button never waits on the phone's storage.
  void finish() {
    state = IntroState.seen;
    unawaited(() async {
      try {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setBool(storageKey, true);
      } catch (_) {
        // Seen for this run even if the phone refuses to remember it.
      }
    }());
  }
}

final introProvider = StateNotifierProvider<IntroController, IntroState>((ref) => IntroController());

/// What someone signed out sees: the introduction the first time, then
/// [signIn]. The app's root uses this, so the tests drive the real choice.
class SignedOutEntry extends ConsumerWidget {
  const SignedOutEntry({super.key, required this.signIn});

  final Widget signIn;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return switch (ref.watch(introProvider)) {
      IntroState.unknown => const Scaffold(body: Center(child: CircularProgressIndicator())),
      IntroState.show => OnboardingScreen(onDone: ref.read(introProvider.notifier).finish),
      IntroState.seen => signIn,
    };
  }
}

/// One page of the introduction.
@immutable
class IntroPage {
  const IntroPage({required this.icon, required this.title, required this.body, this.spectrumIndex = 0});
  final IconData icon;
  final String title;
  final String body;

  /// Its colour in a theme of many (Coat of Many); the primary otherwise.
  final int spectrumIndex;
}

/// What the app does, in the words the website uses — each checked against
/// the product: translation on every plan, recording on Pro and above.
const introPages = <IntroPage>[
  IntroPage(
    icon: Icons.videocam_rounded,
    title: 'Welcome to NeoConference',
    body: 'Video meetings for everyone. Start a meeting in one tap, schedule one '
        'for later, or join from a link someone sends you.',
    spectrumIndex: 2,
  ),
  IntroPage(
    icon: Icons.translate_rounded,
    title: 'Hear every speaker in your language',
    body: 'Live translation speaks each speaker\'s words to you in the language '
        'you choose, with the original voice quietly underneath. On every plan.',
    spectrumIndex: 4,
  ),
  IntroPage(
    icon: Icons.subtitles_rounded,
    title: 'Captions, recordings and summaries',
    body: 'Follow along with live captions. Record a meeting, then read its '
        'transcript and an AI summary of what was said. Recording is on Pro and '
        'above.',
    spectrumIndex: 5,
  ),
  IntroPage(
    icon: Icons.admin_panel_settings_rounded,
    title: 'You run the room',
    body: 'Let people in from the waiting room, add hosts and moderators by their '
        'KingsChat handle, and mute or remove anyone.',
    spectrumIndex: 7,
  ),
  IntroPage(
    icon: Icons.share_rounded,
    title: 'Invite in a tap',
    body: 'Share a meeting to WhatsApp, KingsChat or anywhere else, or show its '
        'QR code. Meeting links open straight in this app.',
    spectrumIndex: 3,
  ),
];

/// The introduction: swipe through, or skip; "Get started" at the end.
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key, required this.onDone, this.doneLabel = 'Get started'});

  /// Called by Skip and by the last page's button.
  final VoidCallback onDone;

  /// "Get started" on first launch; "Done" when reopened from Profile.
  final String doneLabel;

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  final _pages = PageController();
  int _index = 0;

  bool get _last => _index == introPages.length - 1;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  void _next() {
    if (_last) {
      widget.onDone();
      return;
    }
    _pages.nextPage(duration: const Duration(milliseconds: 280), curve: Curves.easeOut);
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.md, NeoSpace.md, 0),
              child: Row(
                children: [
                  const NeoLogo(markSize: 32, fontSize: 18),
                  const Spacer(),
                  if (!_last) TextButton(onPressed: widget.onDone, child: const Text('Skip')),
                ],
              ),
            ),
            Expanded(
              child: PageView.builder(
                controller: _pages,
                itemCount: introPages.length,
                onPageChanged: (i) => setState(() => _index = i),
                itemBuilder: (context, i) {
                  final page = introPages[i];
                  final colour = p.spectrumAt(page.spectrumIndex) ?? p.primary;
                  return Padding(
                    padding: const EdgeInsets.symmetric(horizontal: NeoSpace.xxl),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Container(
                          width: 120,
                          height: 120,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: colour.withValues(alpha: 0.16),
                            border: Border.all(color: colour.withValues(alpha: 0.5), width: 2),
                          ),
                          child: Icon(page.icon, size: 56, color: colour),
                        ),
                        const SizedBox(height: NeoSpace.xxl),
                        Text(page.title, textAlign: TextAlign.center, style: text.headlineSmall),
                        const SizedBox(height: NeoSpace.lg),
                        Text(
                          page.body,
                          textAlign: TextAlign.center,
                          style: text.bodyLarge?.copyWith(color: p.textMuted, height: 1.5),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(NeoSpace.xl, 0, NeoSpace.xl, NeoSpace.xl),
              child: Column(
                children: [
                  Semantics(
                    label: 'Page ${_index + 1} of ${introPages.length}',
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        for (var i = 0; i < introPages.length; i++)
                          AnimatedContainer(
                            duration: const Duration(milliseconds: 200),
                            margin: const EdgeInsets.symmetric(horizontal: 4),
                            width: i == _index ? 22 : 8,
                            height: 8,
                            decoration: BoxDecoration(
                              color: i == _index ? p.primary : p.textFaint,
                              borderRadius: BorderRadius.circular(4),
                            ),
                          ),
                      ],
                    ),
                  ),
                  const SizedBox(height: NeoSpace.xl),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _next,
                      style: FilledButton.styleFrom(minimumSize: const Size(0, 52)),
                      child: Text(_last ? widget.doneLabel : 'Next'),
                    ),
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
