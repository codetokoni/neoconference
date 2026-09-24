// lib/main_showcase.dart
//
// The design showcase entrypoint.
//
//   flutter run -t lib/main_showcase.dart
//
// Runs the new UI against lib/src/mock/sample_data.dart so every screen and
// state can be navigated, reviewed and screenshotted without a backend, a
// signed-in account, or a live meeting.
//
// This is NOT the production entrypoint. lib/main.dart is, and it stays
// wired to Clerk, the neoconference.app API routes and LiveKit. Keeping the
// two separate is what stops sample participants and invented meetings
// reaching a real build.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'src/app.dart';
import 'src/meetings/meeting_board.dart';
import 'src/mock/sample_data.dart';
import 'src/screens/history_screen.dart';
import 'src/screens/home_screen.dart';
import 'src/screens/join_sheet.dart';
import 'src/screens/meeting_screen.dart';
import 'src/screens/prejoin_screen.dart';

/// Where the showcase keeps what it remembers.
///
/// Both entrypoints ship under the same applicationId, so installing one
/// replaces the other and they inherit each other's stored preferences.
/// That is not hypothetical: reviewing themes in the showcase left
/// `neo.theme` behind, and the next production build opened on Amethyst
/// without anyone having chosen it there.
///
/// Namespacing the showcase rather than production means nobody's real app
/// needs its settings migrated — production keeps reading the keys it
/// always wrote, and the showcase simply stops sharing them.
const showcasePrefix = 'flutter.showcase.';

void main() {
  // Must happen before anything calls getInstance, which the theme
  // controller does on its first build.
  SharedPreferences.setPrefix(showcasePrefix);
  runApp(
    ProviderScope(
      // The screens are shared with production and read their data from
      // providers. These are the overrides that make them show sample
      // meetings instead of an account's, and they exist only in this
      // file — nothing under lib/src/screens imports the mock.
      overrides: [
        meetingBoardProvider.overrideWith((ref) async => sampleBoard),
        nowProvider.overrideWithValue(sampleNow),
        homeGreetingNameProvider.overrideWithValue('Adaeze'),
        recordingsAvailableProvider.overrideWithValue(true),
        joinSuggestionsProvider.overrideWithValue(
          sampleUpcoming.take(2).map(sampleAsView).toList(growable: false),
        ),
        meetingLauncherProvider.overrideWithValue(_showSampleMeeting),
      ],
      child: const NeoConferenceApp(),
    ),
  );
}

/// The showcase enters its own sample meeting rather than a real room.
void _showSampleMeeting(
  BuildContext context,
  meeting, {
  required bool micOn,
  required bool cameraOn,
  required bool instant,
}) {
  Navigator.of(context).pushReplacement(
    MaterialPageRoute(
      builder: (_) => MeetingScreen(
        meeting: sampleUpcoming.first,
        startMuted: !micOn,
        startCameraOff: !cameraOn,
        myRole: instant ? SampleRole.owner : SampleRole.attendee,
      ),
    ),
  );
}
