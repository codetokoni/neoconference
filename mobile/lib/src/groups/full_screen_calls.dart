import 'package:flutter/material.dart';

import '../design/components.dart';
import '../design/tokens.dart';
import 'incoming_call.dart';

/// Asks for full-screen calls where the phone has them switched off for
/// this app (Android 14+; ColorOS ships that way): a group calling then
/// shows only as a notification banner, easy to miss, and not over the
/// lock screen. "Allow" opens the phone's switch; the banner goes once it
/// is on, checked again each time the app comes back to the front.
class FullScreenCallsBanner extends StatefulWidget {
  const FullScreenCallsBanner({super.key});

  @override
  State<FullScreenCallsBanner> createState() => _FullScreenCallsBannerState();
}

class _FullScreenCallsBannerState extends State<FullScreenCallsBanner> with WidgetsBindingObserver {
  bool _blocked = false;
  bool _noSettings = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _check();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _check();
  }

  Future<void> _check() async {
    final ok = await CallRinger.canFullScreen();
    if (mounted && _blocked == ok) setState(() => _blocked = !ok);
  }

  Future<void> _allow() async {
    final opened = await CallRinger.openFullScreenSettings();
    if (mounted && !opened) setState(() => _noSettings = true);
  }

  @override
  Widget build(BuildContext context) {
    if (!_blocked) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: NeoSpace.lg),
      child: NeoBanner(
        icon: Icons.ring_volume_rounded,
        tone: NeoBannerTone.warning,
        message: _noSettings
            ? 'Calls from your groups show only as a notification. In your phone\'s settings, '
                'allow NeoConference to use full-screen notifications.'
            : 'Calls from your groups show only as a notification. '
                'Allow full-screen calls so they ring like a phone call, even when the phone is locked.',
        action: _noSettings ? null : _allow,
        actionLabel: 'Allow',
      ),
    );
  }
}
