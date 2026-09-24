import 'package:flutter/material.dart';

/// The design tokens everything else is built from.
///
/// The dark palette is not invented: it is the website's own, read from
/// src/app/globals.css, so the app and the site are recognisably one
/// product. The light palette is derived from it — the site has no light
/// theme — and its foreground colours were picked for contrast rather than
/// by lightening the dark ones, which is how light themes usually end up
/// unreadable.
@immutable
class NeoPalette {
  const NeoPalette({
    required this.bg,
    required this.surface,
    required this.surfaceAlt,
    required this.surfaceHigh,
    required this.border,
    required this.borderStrong,
    required this.text,
    required this.textMuted,
    required this.textFaint,
    required this.primary,
    required this.onPrimary,
    required this.accent,
    required this.info,
    required this.danger,
    required this.success,
    required this.warning,
    required this.scrim,
    required this.brightness,
  });

  final Color bg;
  final Color surface;
  final Color surfaceAlt;
  final Color surfaceHigh;
  final Color border;
  final Color borderStrong;
  final Color text;
  final Color textMuted;
  final Color textFaint;
  final Color primary;
  final Color onPrimary;
  final Color accent;
  final Color info;
  final Color danger;
  final Color success;
  final Color warning;
  final Color scrim;
  final Brightness brightness;

  bool get isDark => brightness == Brightness.dark;

  /// The website's palette, verbatim from globals.css.
  static const dark = NeoPalette(
    bg: Color(0xFF03050A), // --neo-bg-0
    surface: Color(0xFF060B18), // --neo-bg-1
    surfaceAlt: Color(0xFF0A1428), // --neo-bg-2
    surfaceHigh: Color(0xFF0E1B33),
    border: Color(0x2267E8F9),
    borderStrong: Color(0x5567E8F9),
    text: Color(0xFFE6FBFF),
    textMuted: Color(0xB3CFFAFE),
    textFaint: Color(0x73CFFAFE),
    primary: Color(0xFF22D3EE), // --neo-cyan
    onPrimary: Color(0xFF03181C),
    accent: Color(0xFF818CF8), // --neo-purple
    info: Color(0xFF38BDF8), // --neo-blue
    danger: Color(0xFFF87171),
    success: Color(0xFF34D399),
    warning: Color(0xFFFBBF24),
    scrim: Color(0xCC03050A),
    brightness: Brightness.dark,
  );

  /// Derived for daylight. The primary is deliberately darker than the
  /// website's cyan: #22D3EE on white is about 1.9:1, which is unreadable
  /// as a text or icon colour however on-brand it looks.
  static const light = NeoPalette(
    bg: Color(0xFFF5F9FB),
    surface: Color(0xFFFFFFFF),
    surfaceAlt: Color(0xFFEDF5F9),
    surfaceHigh: Color(0xFFE2EEF4),
    border: Color(0x1A0A1428),
    borderStrong: Color(0x330A1428),
    text: Color(0xFF071021),
    textMuted: Color(0xFF47596B),
    textFaint: Color(0xFF7A8A99),
    primary: Color(0xFF0E7490), // cyan-700: 5.7:1 on white
    onPrimary: Color(0xFFFFFFFF),
    accent: Color(0xFF4F46E5),
    info: Color(0xFF0369A1),
    danger: Color(0xFFDC2626),
    success: Color(0xFF047857),
    warning: Color(0xFFB45309),
    scrim: Color(0x99071021),
    brightness: Brightness.light,
  );

  /// The wordmark gradient, from `.neo-gradient-text` in globals.css.
  static const wordmarkGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [
      Color(0xFFA5F3FC),
      Color(0xFF67E8F9),
      Color(0xFF38BDF8),
      Color(0xFF818CF8),
    ],
    stops: [0.0, 0.35, 0.65, 1.0],
  );

  /// The logo tile gradient, from the header mark's Tailwind classes
  /// (from-cyan-300 via-cyan-400 to-blue-500).
  static const markGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF67E8F9), Color(0xFF22D3EE), Color(0xFF3B82F6)],
  );
}

/// One scale, used everywhere. Values are multiples of 4 so that vertical
/// rhythm survives being nudged by a hurried edit.
@immutable
class NeoSpace {
  const NeoSpace._();
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 20.0;
  static const xxl = 24.0;
  static const xxxl = 32.0;
  static const huge = 40.0;

  /// Below this, a control is hard to hit accurately. Every interactive
  /// element in the app is laid out to at least this, per the 44pt
  /// guidance both platforms give.
  static const minTouch = 44.0;
}

@immutable
class NeoRadius {
  const NeoRadius._();
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 20.0;
  static const sheet = 28.0;
  static const pill = 999.0;
}

/// Motion should confirm what happened, not delay it. Anything on the path
/// of a core action — muting, joining, leaving — uses [fast] or nothing.
@immutable
class NeoMotion {
  const NeoMotion._();
  static const fast = Duration(milliseconds: 120);
  static const base = Duration(milliseconds: 200);
  static const slow = Duration(milliseconds: 320);
  static const curve = Curves.easeOutCubic;
  static const emphasized = Curves.easeOutBack;
}
