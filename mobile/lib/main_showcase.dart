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

import 'src/app.dart';

void main() => runApp(const ProviderScope(child: NeoConferenceApp()));
