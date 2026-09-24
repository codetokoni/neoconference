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

  /// Deep blue. The brand's own `--neo-blue` moved into the lead, for
  /// people who find the cyan too electric at length.
  static const ocean = NeoPalette(
    bg: Color(0xFF02060F),
    surface: Color(0xFF061120),
    surfaceAlt: Color(0xFF0A1B33),
    surfaceHigh: Color(0xFF10264A),
    border: Color(0x2238BDF8),
    borderStrong: Color(0x5538BDF8),
    text: Color(0xFFE8F4FF),
    textMuted: Color(0xB3C7E2F7),
    textFaint: Color(0x73C7E2F7),
    primary: Color(0xFF38BDF8), // --neo-blue
    onPrimary: Color(0xFF041426),
    accent: Color(0xFF22D3EE),
    info: Color(0xFF60A5FA),
    danger: Color(0xFFF87171),
    success: Color(0xFF34D399),
    warning: Color(0xFFFBBF24),
    scrim: Color(0xCC02060F),
    brightness: Brightness.dark,
  );

  /// Violet. Built from `--neo-purple`, which the site already uses as the
  /// last stop of the wordmark gradient.
  static const amethyst = NeoPalette(
    bg: Color(0xFF07050F),
    surface: Color(0xFF100C1F),
    surfaceAlt: Color(0xFF171233),
    surfaceHigh: Color(0xFF221B47),
    border: Color(0x26A5B4FC),
    borderStrong: Color(0x59A5B4FC),
    text: Color(0xFFF0EDFF),
    textMuted: Color(0xB3D4CFF5),
    textFaint: Color(0x73D4CFF5),
    primary: Color(0xFFA5B4FC),
    onPrimary: Color(0xFF13102B),
    accent: Color(0xFF22D3EE),
    info: Color(0xFF818CF8),
    danger: Color(0xFFFB7185),
    success: Color(0xFF34D399),
    warning: Color(0xFFFBBF24),
    scrim: Color(0xCC07050F),
    brightness: Brightness.dark,
  );

  /// Near-monochrome, for low-light rooms and long days. Colour is spent
  /// only where it carries meaning — the primary action, and the states.
  static const carbon = NeoPalette(
    bg: Color(0xFF060708),
    surface: Color(0xFF0D0F11),
    surfaceAlt: Color(0xFF15181B),
    surfaceHigh: Color(0xFF1F2327),
    border: Color(0x1FFFFFFF),
    borderStrong: Color(0x3DFFFFFF),
    text: Color(0xFFF2F4F5),
    textMuted: Color(0xB3C8CED3),
    textFaint: Color(0x73C8CED3),
    primary: Color(0xFF67E8F9), // --neo-cyan-soft, the one splash of brand
    onPrimary: Color(0xFF07171A),
    accent: Color(0xFFA5B4FC),
    info: Color(0xFF7DD3FC),
    danger: Color(0xFFF87171),
    success: Color(0xFF4ADE80),
    warning: Color(0xFFFBBF24),
    scrim: Color(0xCC060708),
    brightness: Brightness.dark,
  );

  /// Warm light, easier than pure white under bright office lighting.
  static const sandstone = NeoPalette(
    bg: Color(0xFFFBF7F2),
    surface: Color(0xFFFFFFFF),
    surfaceAlt: Color(0xFFF4EDE4),
    surfaceHigh: Color(0xFFEADFD1),
    border: Color(0x1A2A1F14),
    borderStrong: Color(0x332A1F14),
    text: Color(0xFF1C160F),
    textMuted: Color(0xFF5A4E41),
    textFaint: Color(0xFF8C7F70),
    primary: Color(0xFF0F766E), // teal-700: 5.9:1 on white
    onPrimary: Color(0xFFFFFFFF),
    accent: Color(0xFF7C3AED),
    info: Color(0xFF0369A1),
    danger: Color(0xFFB91C1C),
    success: Color(0xFF15803D),
    warning: Color(0xFF9A3412),
    scrim: Color(0x991C160F),
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
