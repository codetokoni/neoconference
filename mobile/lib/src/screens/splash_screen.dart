import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/tokens.dart';

/// Held only while the stored session is checked.
///
/// Deliberately brief and not a "brand moment": the fastest splash is the
/// one nobody notices. The mark fades and lifts slightly rather than
/// bouncing, so it reads as the app waking up rather than a loading screen
/// asking to be admired.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: NeoMotion.slow,
  )..forward();

  late final _fade = CurvedAnimation(
    parent: _controller,
    curve: NeoMotion.curve,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      body: Center(
        child: FadeTransition(
          opacity: _fade,
          child: SlideTransition(
            position: Tween(
              begin: const Offset(0, 0.06),
              end: Offset.zero,
            ).animate(_fade),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const NeoLogoMark(size: 72),
                const SizedBox(height: NeoSpace.xl),
                const NeoWordmark(fontSize: 24),
                const SizedBox(height: NeoSpace.xxxl),
                SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: p.primary,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
