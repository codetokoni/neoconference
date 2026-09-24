import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'design/brand.dart';
import 'design/neo_theme.dart';
import 'design/themes.dart';
import 'design/tokens.dart';
import 'mock/sample_data.dart';
import 'screens/app_shell.dart';
import 'screens/history_screen.dart';
import 'screens/home_screen.dart';
import 'screens/notifications_screen.dart';
import 'screens/settings_screen.dart';
import 'screens/welcome_screen.dart';

/// The showcase's four destinations.
///
/// Alerts is here and not in production because the design needs showing
/// and the backend does not exist. See lib/main.dart for the real set.
List<NeoTab> showcaseTabs(WidgetRef ref) => [
      const NeoTab(
        icon: Icons.home_outlined,
        selectedIcon: Icons.home_rounded,
        label: 'Home',
        screen: HomeScreen(),
      ),
      const NeoTab(
        icon: Icons.history_outlined,
        selectedIcon: Icons.history_rounded,
        label: 'History',
        screen: HistoryScreen(),
      ),
      NeoTab(
        icon: Icons.notifications_none_rounded,
        selectedIcon: Icons.notifications_rounded,
        label: 'Alerts',
        screen: const NotificationsScreen(),
        badge: sampleNotifications.where((n) => n.unread).length,
      ),
      const NeoTab(
        icon: Icons.person_outline_rounded,
        selectedIcon: Icons.person_rounded,
        label: 'Profile',
        screen: SettingsScreen(),
      ),
    ];

/// The app, its themes, and the one decision the root makes.
class NeoConferenceApp extends ConsumerWidget {
  const NeoConferenceApp({super.key, this.signedIn = true});

  final bool signedIn;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final choice = ref.watch(neoThemeProvider);
    final chosen = neoThemeOption(choice).palette;

    // "Match system" keeps Flutter's own light/dark switching. Any explicit
    // choice pins both slots to that palette, so the app does not flip out
    // from under someone who picked Amethyst because the sun went down.
    final light = chosen ?? NeoPalette.light;
    final dark = chosen ?? NeoPalette.dark;

    return MaterialApp(
      title: 'NeoConference',
      debugShowCheckedModeBanner: false,
      theme: neoThemeData(light),
      darkTheme: neoThemeData(dark),
      themeMode:
          chosen == null ? ThemeMode.system : (chosen.isDark ? ThemeMode.dark : ThemeMode.light),
      builder: (context, child) {
        final palette = chosen ??
            (Theme.of(context).brightness == Brightness.dark
                ? NeoPalette.dark
                : NeoPalette.light);
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
      home: signedIn ? AppShell(tabs: showcaseTabs(ref)) : const WelcomeScreen(),
    );
  }
}
