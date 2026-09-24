import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'src/auth/auth_controller.dart';
import 'src/auth/sign_in_screen.dart';
import 'src/core/theme.dart';
import 'src/events/events_screen.dart';

void main() {
  runApp(const ProviderScope(child: NeoConferenceApp()));
}

class NeoConferenceApp extends StatelessWidget {
  const NeoConferenceApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NeoConference',
      debugShowCheckedModeBanner: false,
      theme: neoTheme(),
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
    return auth.signedIn ? const EventsScreen() : const SignInScreen();
  }
}
