import 'package:flutter/material.dart';

import 'design/brand.dart';
import 'design/neo_theme.dart';
import 'design/tokens.dart';
import 'screens/app_shell.dart';
import 'screens/welcome_screen.dart';

/// The app, its themes, and the one decision the root makes.
///
/// themeMode follows the system rather than offering a switch here: people
/// set light or dark once, for every app, and a per-app override is a
/// setting most will never find. Settings exposes it for the minority who
/// want it.
class NeoConferenceApp extends StatelessWidget {
  const NeoConferenceApp({super.key, this.signedIn = true});

  final bool signedIn;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NeoConference',
      debugShowCheckedModeBanner: false,
      theme: neoThemeData(NeoPalette.light),
      darkTheme: neoThemeData(NeoPalette.dark),
      themeMode: ThemeMode.system,
      builder: (context, child) {
        final palette = Theme.of(context).brightness == Brightness.dark
            ? NeoPalette.dark
            : NeoPalette.light;
        return NeoTheme(
          palette: palette,
          child: MediaQuery(
            // Text scaling is honoured, but a 3× system setting turns a
            // meeting control bar into a stack of words. Clamping keeps the
            // app usable at the large end without ignoring the preference.
            data: MediaQuery.of(context).copyWith(
              textScaler: MediaQuery.of(context)
                  .textScaler
                  .clamp(minScaleFactor: 0.85, maxScaleFactor: 1.6),
            ),
            child: child ?? const SizedBox.shrink(),
          ),
        );
      },
      home: signedIn ? const AppShell() : const WelcomeScreen(),
    );
  }
}
