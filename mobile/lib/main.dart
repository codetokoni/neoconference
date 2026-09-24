import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart' as lk;
import 'package:logging/logging.dart';

import 'src/auth/auth_controller.dart';
import 'src/auth/sign_in_screen.dart';
import 'src/design/brand.dart';
import 'src/design/neo_theme.dart';
import 'src/design/themes.dart';
import 'src/design/tokens.dart';
import 'src/home/landing_screen.dart';

void main() {
  _enableLiveKitLogsInDebug();
  runApp(const ProviderScope(child: NeoConferenceApp()));
}

/// Turns on the LiveKit SDK's own logging, in debug builds only.
///
/// The SDK reports the interesting things at FINE — including whether the
/// server ever opens the reliable data channel toward this client, and
/// whether an arriving packet is dropped as a duplicate. Both are silent
/// otherwise, which is why the reliable-channel problem took so long to
/// pin down. Release builds do not print, so this is gated rather than
/// left on.
void _enableLiveKitLogsInDebug() {
  if (!kDebugMode) return;
  // Required before any non-root logger's level can be set, which is the
  // first thing setLoggingLevel does — without it this throws at startup
  // and no LiveKit logging happens at all.
  hierarchicalLoggingEnabled = true;
  lk.setLoggingLevel(lk.LoggerLevel.kALL);
  // Subscribed on the SDK's own logger rather than the root, so the output
  // is only LiveKit's and not every package that happens to log.
  Logger('livekit').onRecord.listen((record) {
    debugPrint('[lk] ${record.level.name}: ${record.message}');
  });
}

class NeoConferenceApp extends ConsumerWidget {
  const NeoConferenceApp({super.key});

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
      themeMode: chosen == null
          ? ThemeMode.system
          : (chosen.isDark ? ThemeMode.dark : ThemeMode.light),
      builder: (context, child) {
        final palette = chosen ??
            (Theme.of(context).brightness == Brightness.dark
                ? NeoPalette.dark
                : NeoPalette.light);
        return NeoTheme(
          palette: palette,
          child: MediaQuery(
            // Text scaling is honoured, but a 3x system setting turns a
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
      home: const _Root(),
    );
  }
}

/// Signed in or not — the only decision this layer makes.
class _Root extends ConsumerWidget {
  const _Root();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authProvider);

    if (auth.restoring) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }
    return auth.signedIn ? const LandingScreen() : const SignInScreen();
  }
}
