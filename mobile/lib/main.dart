import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart' as lk;
import 'package:logging/logging.dart';

import 'src/auth/auth_controller.dart';
import 'src/auth/sign_in_screen.dart';
import 'src/core/api_client.dart';
import 'src/events/event.dart';
import 'src/design/brand.dart';
import 'src/design/neo_theme.dart';
import 'src/design/themes.dart';
import 'src/design/tokens.dart';
import 'src/events/create_meeting_screen.dart';
import 'src/groups/groups_screen.dart';
import 'src/manage/dashboard_screen.dart';
import 'src/meetings/meeting_board.dart';
import 'src/meetings/meeting_links.dart';
import 'src/meetings/meeting_view.dart';
import 'src/onboarding/onboarding.dart';
import 'src/room/room_screen.dart';
import 'src/screens/app_shell.dart';
import 'src/screens/history_screen.dart';
import 'src/screens/home_screen.dart';
import 'src/screens/prejoin_screen.dart';
import 'src/settings/meeting_defaults.dart';
import 'src/settings/settings_screen.dart';

void main() {
  _enableLiveKitLogsInDebug();
  // Before the first frame, so the link that launched the app is caught —
  // and after the binding, which the platform channel needs.
  WidgetsFlutterBinding.ensureInitialized();
  IncomingMeetingLinks.instance.start();
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
  final container = ProviderScope.containerOf(context, listen: false);

  // One of your own meetings (it has an event id: it came from your list)
  // is reopened before it is joined — the same call as "Restart event" on
  // the web. Joining alone brings back a meeting that only emptied, but
  // one somebody ended stays ended, with the owner in it as an attendee.
  //
  // Live ones too: the list can be minutes old, and a meeting shown live
  // may have been ended since — that is how the emulator check found it.
  // Reopening a meeting that is live does nothing. A scheduled one is left
  // alone: joining early is a look at the room, not a start.
  if (!instant && meeting.eventId != null && (meeting.isPast || meeting.isLive)) {
    try {
      await container.read(apiProvider).post('/api/events/${meeting.eventId}/start', {});
      container.invalidate(eventsProvider);
    } catch (e) {
      // Shown live: it may well still be, so go in anyway.
      if (meeting.isPast) {
        if (!context.mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              e is ApiException
                  ? "Couldn't reopen this meeting: ${e.message}"
                  : "Couldn't reopen this meeting. Check your connection and try again.",
            ),
          ),
        );
        return;
      }
    }
  }

  await MeetingDefaults.setJoinMuted(!micOn);
  await MeetingDefaults.setJoinCameraOff(!cameraOn);
  if (!context.mounted) return;

  await Navigator.of(context).pushReplacement(
    MaterialPageRoute(
      builder: (_) => instant
          ? const CreateMeetingScreen()
          : RoomScreen(slug: meeting.code, title: meeting.title),
    ),
  );
  // Back from the meeting: what it left behind (ended, still open) is not
  // what the list last saw. Nothing else refreshes it.
  container.invalidate(eventsProvider);
}

/// Turns on the LiveKit SDK's own logging, in debug builds only.
///
/// The SDK reports the interesting things at FINE — including whether the
/// server ever opens the reliable data channel toward this client, and
/// whether an arriving packet is dropped as a duplicate. Both are silent
/// otherwise, which is why the data-channel problem took so long to pin
/// down. The SDK's logging is verbose, so it is gated to debug builds.
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
    // A meeting link waits through sign-in and opens once someone is in.
    // Signed out, the first launch shows what the app is before sign-in.
    return auth.signedIn
        ? MeetingLinkOpener(child: AppShell(tabs: _tabs))
        : const SignedOutEntry(signIn: SignInScreen());
  }

  /// Five destinations: Dashboard is the web's /dashboard, in brief, and
  /// Groups its /dashboard/groups.
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
      icon: Icons.groups_outlined,
      selectedIcon: Icons.groups_rounded,
      label: 'Groups',
      screen: GroupsScreen(),
    ),
    NeoTab(
      icon: Icons.space_dashboard_outlined,
      selectedIcon: Icons.space_dashboard_rounded,
      label: 'Dashboard',
      screen: DashboardScreen(),
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
