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
import 'src/events/create_meeting_screen.dart';
import 'src/meetings/meeting_board.dart';
import 'src/meetings/meeting_view.dart';
import 'src/room/room_screen.dart';
import 'src/screens/app_shell.dart';
import 'src/screens/history_screen.dart';
import 'src/screens/home_screen.dart';
import 'src/screens/prejoin_screen.dart';
import 'src/settings/meeting_defaults.dart';
import 'src/settings/settings_screen.dart';

void main() {
  _enableLiveKitLogsInDebug();
  runApp(
    ProviderScope(
      // The designed screens read their data from providers so that one set
      // of layouts serves both this app and the showcase. These are the
      // overrides that point them at the real account.
      overrides: [
        ...realMeetingBoardOverrides(),
        homeGreetingNameProvider.overrideWith(
          (ref) => ref.watch(authProvider.select((s) => s.displayName)),
        ),
        meetingLauncherProvider.overrideWithValue(_openRoom),
      ],
      child: const NeoConferenceApp(),
    ),
  );
}

/// Enter the real room.
///
/// An instant meeting has to exist before it can be joined, so "Start"
/// goes to the create screen, which creates it and joins in one step. The
/// mic and camera chosen at pre-join are written to the join defaults so
/// the room applies them on connect — the room reads its settings from
/// there rather than being handed them, which is what keeps a reconnect
/// from arriving with a different microphone state than the join did.
Future<void> _openRoom(
  BuildContext context,
  MeetingView meeting, {
  required bool micOn,
  required bool cameraOn,
  required bool instant,
}) async {
  await MeetingDefaults.setJoinMuted(!micOn);
  await MeetingDefaults.setJoinCameraOff(!cameraOn);
  if (!context.mounted) return;

  Navigator.of(context).pushReplacement(
    MaterialPageRoute(
      builder: (_) => instant
          ? const CreateMeetingScreen()
          : RoomScreen(slug: meeting.code, title: meeting.title),
    ),
  );
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

    // A purchase completes in the browser and returns on the App Link, so
    // the confirmation is raised here — the sheet that started it closed
    // when the browser opened, and the screen it was raised from before
    // this is no longer guaranteed to be the one on top.
    ref.listen(authProvider.select((s) => s.upgradedTo), (_, upgraded) {
      if (upgraded == null) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('Upgraded to $upgraded.')));
      ref.read(authProvider.notifier).acknowledgeUpgrade();
    });

    // A cancelled payment comes back the same way and is reported for the
    // same reason: the person left, went through a checkout, and returned.
    // Reappearing in silence reads like the app lost the attempt.
    ref.listen(authProvider.select((s) => s.error), (_, error) {
      if (error == null) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(error)));
      ref.read(authProvider.notifier).clearError();
    });

    if (auth.restoring) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }
    return auth.signedIn ? AppShell(tabs: _tabs) : const SignInScreen();
  }

  /// Three destinations, not the showcase's four.
  ///
  /// Alerts is missing on purpose: nothing serves notifications to the app
  /// yet, and a tab that can only ever be empty is worse than no tab. It
  /// comes back when there is something true to put in it.
  static const _tabs = [
    NeoTab(
      icon: Icons.home_outlined,
      selectedIcon: Icons.home_rounded,
      label: 'Home',
      screen: HomeScreen(),
    ),
    NeoTab(
      icon: Icons.history_outlined,
      selectedIcon: Icons.history_rounded,
      label: 'History',
      screen: HistoryScreen(),
    ),
    NeoTab(
      icon: Icons.person_outline_rounded,
      selectedIcon: Icons.person_rounded,
      label: 'Profile',
      screen: SettingsScreen(),
    ),
  ];
}
