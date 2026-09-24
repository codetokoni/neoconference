import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/neo_theme.dart';
import 'package:neoconference/src/design/themes.dart';
import 'package:neoconference/src/design/tokens.dart';

/// What the theme migration was for.
///
/// The screens themselves need a signed-in session and a live room to
/// build, so this tests the thing that actually broke: whether a chosen
/// palette reaches the places the old code painted by hand. A screen that
/// reads `NeoTheme.of(context)` is correct by construction; one that
/// reaches past it is what these guard against.
void main() {
  const palettes = <String, NeoPalette>{
    'dark': NeoPalette.dark,
    'light': NeoPalette.light,
    'ocean': NeoPalette.ocean,
    'amethyst': NeoPalette.amethyst,
    'carbon': NeoPalette.carbon,
    'sandstone': NeoPalette.sandstone,
  };

  group('every palette themes the shared surfaces', () {
    for (final entry in palettes.entries) {
      test('${entry.key} carries its own colours into ThemeData', () {
        final t = neoThemeData(entry.value);
        final p = entry.value;

        // The three the old code hard-coded to cyan and near-black.
        expect(t.colorScheme.primary, p.primary);
        expect(t.scaffoldBackgroundColor, p.bg);
        expect(t.appBarTheme.backgroundColor, p.bg);

        // Sheets and dialogs stopped passing backgroundColor themselves, so
        // these are now the only thing colouring them.
        expect(t.bottomSheetTheme.backgroundColor, p.surface);
        expect(t.dialogTheme.backgroundColor, p.surface);

        // A fixed brand cyan here left Amethyst and Ocean with cyan links.
        expect(
          t.textButtonTheme.style?.foregroundColor?.resolve({}),
          p.primary,
        );
        expect(
          t.outlinedButtonTheme.style?.foregroundColor?.resolve({}),
          p.primary,
        );
      });
    }
  });

  testWidgets('a palette reaches a dialog, which builds under the Navigator',
      (tester) async {
    // The reason NeoTheme is an InheritedTheme. Without wrap(), the meeting
    // could force itself dark while its own sheets came back light.
    late NeoPalette seenInDialog;

    await tester.pumpWidget(
      MaterialApp(
        theme: neoThemeData(NeoPalette.amethyst),
        home: NeoTheme(
          palette: NeoPalette.amethyst,
          child: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (context) {
                  seenInDialog = NeoTheme.of(context);
                  return const SizedBox.shrink();
                },
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(seenInDialog, NeoPalette.amethyst);
  });

  testWidgets('a subtree can override the palette, and its dialogs follow',
      (tester) async {
    // This is the meeting: a light theme app, a room that insists on dark.
    late NeoPalette seenInSheet;

    await tester.pumpWidget(
      MaterialApp(
        theme: neoThemeData(NeoPalette.light),
        home: NeoTheme(
          palette: NeoPalette.light,
          child: NeoTheme(
            palette: NeoPalette.dark,
            child: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showModalBottomSheet<void>(
                  context: context,
                  builder: (context) {
                    seenInSheet = NeoTheme.of(context);
                    return const SizedBox.shrink();
                  },
                ),
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(seenInSheet, NeoPalette.dark);
    expect(seenInSheet, isNot(NeoPalette.light));
  });

  testWidgets('a context above the override does not carry it', (tester) async {
    // Found on a real phone, not here: the meeting wrapped itself in a dark
    // palette but asked for its leave confirmation with the State's own
    // context, which sits above that wrapper. The dialog came back white
    // over the video.
    //
    // This pins the mechanism rather than the bug — a route captures the
    // themes between the context it is handed and the Navigator, so a
    // context above the override never sees it. RoomScreen fixes it with a
    // Builder; this is the assertion that says why one is needed.
    late NeoPalette fromAbove;
    late NeoPalette fromBelow;
    final nav = GlobalKey<NavigatorState>();

    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: nav,
        theme: neoThemeData(NeoPalette.light),
        home: Builder(
          builder: (aboveContext) => NeoTheme(
            palette: NeoPalette.dark,
            child: Builder(
              builder: (belowContext) => Column(
                children: [
                  ElevatedButton(
                    onPressed: () => showDialog<void>(
                      context: aboveContext,
                      builder: (context) {
                        fromAbove = NeoTheme.of(context);
                        return const SizedBox.shrink();
                      },
                    ),
                    child: const Text('above'),
                  ),
                  ElevatedButton(
                    onPressed: () => showDialog<void>(
                      context: belowContext,
                      builder: (context) {
                        fromBelow = NeoTheme.of(context);
                        return const SizedBox.shrink();
                      },
                    ),
                    child: const Text('below'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('above'));
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();

    await tester.tap(find.text('below'));
    await tester.pumpAndSettle();

    expect(fromAbove, NeoPalette.light, reason: 'above the override');
    expect(fromBelow, NeoPalette.dark, reason: 'below the override');
  });

  test('every theme option a person can pick resolves to a palette', () {
    for (final option in neoThemeOptions) {
      // "Match system" is the one without a palette of its own.
      if (option.choice == NeoThemeChoice.system) {
        expect(option.palette, isNull);
        continue;
      }
      expect(option.palette, isNotNull, reason: '${option.name} has no palette');
      expect(neoThemeOption(option.choice), option);
    }
    // Every choice in the enum is offered; one added without an option would
    // make neoThemeOption throw the first time it was restored from storage.
    expect(neoThemeOptions.length, NeoThemeChoice.values.length);
  });

  test('light palettes keep their primary readable on their own surface', () {
    // The reason the light palette does not use the website's #22D3EE: it
    // is about 1.9:1 on white, which is unreadable as a text colour.
    for (final entry in palettes.entries) {
      final p = entry.value;
      if (p.isDark) continue;
      final contrast = _contrast(p.primary, p.surface);
      expect(
        contrast,
        greaterThan(4.5),
        reason: '${entry.key} primary is $contrast:1 on its surface',
      );
    }
  });
}

/// WCAG relative-luminance contrast ratio.
double _contrast(Color a, Color b) {
  final la = _luminance(a);
  final lb = _luminance(b);
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

double _luminance(Color c) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}
