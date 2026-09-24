import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'tokens.dart';

/// The themes someone can choose between.
///
/// Every one is built from the brand's own colours rather than picked for
/// variety: Midnight and Daylight are the website's palette and its
/// daylight counterpart, Ocean leads with `--neo-blue`, Amethyst with
/// `--neo-purple`, and Carbon spends colour only where it carries meaning.
/// A theme that abandons the brand is a different product wearing its
/// name.
enum NeoThemeChoice { system, midnight, daylight, ocean, amethyst, carbon, sandstone }

@immutable
class NeoThemeOption {
  const NeoThemeOption({
    required this.choice,
    required this.name,
    required this.description,
    required this.palette,
  });

  final NeoThemeChoice choice;
  final String name;
  final String description;

  /// Null for [NeoThemeChoice.system], which resolves at build time.
  final NeoPalette? palette;
}

const neoThemeOptions = <NeoThemeOption>[
  NeoThemeOption(
    choice: NeoThemeChoice.system,
    name: 'Match system',
    description: 'Midnight at night, Daylight by day',
    palette: null,
  ),
  NeoThemeOption(
    choice: NeoThemeChoice.midnight,
    name: 'Midnight',
    description: "The website's own palette",
    palette: NeoPalette.dark,
  ),
  NeoThemeOption(
    choice: NeoThemeChoice.daylight,
    name: 'Daylight',
    description: 'Cool and bright',
    palette: NeoPalette.light,
  ),
  NeoThemeOption(
    choice: NeoThemeChoice.ocean,
    name: 'Ocean',
    description: 'Deep blue, calmer than cyan',
    palette: NeoPalette.ocean,
  ),
  NeoThemeOption(
    choice: NeoThemeChoice.amethyst,
    name: 'Amethyst',
    description: 'Violet, from the wordmark gradient',
    palette: NeoPalette.amethyst,
  ),
  NeoThemeOption(
    choice: NeoThemeChoice.carbon,
    name: 'Carbon',
    description: 'Near-monochrome for low light',
    palette: NeoPalette.carbon,
  ),
  NeoThemeOption(
    choice: NeoThemeChoice.sandstone,
    name: 'Sandstone',
    description: 'Warm light, easier than white',
    palette: NeoPalette.sandstone,
  ),
];

NeoThemeOption neoThemeOption(NeoThemeChoice choice) =>
    neoThemeOptions.firstWhere((o) => o.choice == choice);

/// Remembers the chosen theme.
///
/// Persisted, because a theme that resets on every launch is worse than
/// not offering one. Storage failing is not fatal — the app falls back to
/// following the system, which is what it did before any of this existed.
class NeoThemeController extends StateNotifier<NeoThemeChoice> {
  NeoThemeController() : super(NeoThemeChoice.system) {
    _restore();
  }

  /// Public so the tests can bind to the real key rather than a copy of it.
  ///
  /// The showcase and production entrypoints ship under one applicationId
  /// and so share a preference store; the showcase namespaces itself with
  /// [showcasePrefix] rather than spelling this key differently.
  static const storageKey = 'neo.theme';

  Future<void> _restore() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final stored = prefs.getString(storageKey);
      if (stored == null) return;
      final found = NeoThemeChoice.values
          .where((c) => c.name == stored)
          .firstOrNull;
      if (found != null) state = found;
    } catch (_) {
      // Keep following the system.
    }
  }

  Future<void> select(NeoThemeChoice choice) async {
    state = choice;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(storageKey, choice.name);
    } catch (_) {
      // Chosen for this run even if the phone refuses to remember it.
    }
  }
}

final neoThemeProvider =
    StateNotifierProvider<NeoThemeController, NeoThemeChoice>(
  (ref) => NeoThemeController(),
);
