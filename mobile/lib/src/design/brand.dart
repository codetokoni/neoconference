import 'package:flutter/material.dart';

import 'tokens.dart';

/// The NeoConference mark: a navy "N" whose right stroke is teal above the
/// diagonal, with a camera lens beside it, on the app icon's gradient tile.
///
/// The same shapes as the app icon (mobile/tool/launcher_icon.mjs), the
/// favicon and the website header (src/components/NeoMark.tsx), so the
/// logo inside the app matches the one on the home screen. Change all
/// three together.
class NeoLogoMark extends StatelessWidget {
  const NeoLogoMark({super.key, this.size = 32, this.glow = true});

  final double size;

  /// The header tile on the website carries a cyan glow. Worth keeping on
  /// dark surfaces and worth dropping on light ones, where it reads as a
  /// smudge rather than a light source.
  final bool glow;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    // Coat of Many gives the mark one colour of its own, not a blend.
    final solid = NeoTheme.of(context).spectrumAt(2);
    return Container(
      height: size,
      width: size,
      decoration: BoxDecoration(
        color: solid,
        gradient: solid == null ? NeoPalette.markGradient : null,
        borderRadius: BorderRadius.circular(size * 0.3),
        border: Border.all(color: Colors.white.withValues(alpha: 0.30)),
        boxShadow: glow && dark
            ? [
                BoxShadow(
                  color: const Color(0xFF22D3EE).withValues(alpha: 0.45),
                  blurRadius: size * 0.75,
                ),
              ]
            : null,
      ),
      child: Center(
        // The mark is half the tile's width, as on the icon.
        child: SizedBox(
          width: size * 0.5,
          height: size * 0.5 * _MarkPainter.height / _MarkPainter.width,
          child: CustomPaint(painter: _MarkPainter()),
        ),
      ),
    );
  }
}

/// Draws the mark in the coordinates of the 180px favicon it was measured
/// from (see launcher_icon.mjs), scaled to the size it is given.
class _MarkPainter extends CustomPainter {
  static const _navy = Color(0xFF01183A);
  static const _teal = Color(0xFF0C7AAA);

  // The mark's bounds in those coordinates.
  static const left = 56.0;
  static const top = 68.0;
  // NeoLinguaMeet: the bubbles reach 127 across and their tail 117 down.
  static const width = 71.0;
  static const height = 49.0;

  static const _r = Radius.circular(5);

  /// The N: both strokes and the diagonal as one outline, so no seam
  /// shows where they meet.
  static final Path _n = Path()
    ..moveTo(61, 68)
    ..lineTo(74.5, 68)
    ..lineTo(85.5, 78.45)
    ..lineTo(85.5, 68)
    ..lineTo(98, 68)
    ..arcToPoint(const Offset(103, 73), radius: _r)
    ..lineTo(103, 108)
    ..arcToPoint(const Offset(98, 113), radius: _r)
    ..lineTo(88, 113)
    ..lineTo(74.5, 100)
    ..lineTo(74.5, 108)
    ..arcToPoint(const Offset(69.5, 113), radius: _r)
    ..lineTo(61, 113)
    ..arcToPoint(const Offset(56, 108), radius: _r)
    ..lineTo(56, 73)
    ..arcToPoint(const Offset(61, 68), radius: _r)
    ..close();

  /// The right stroke above the diagonal, which is teal.
  static final Path _upperRight = Path()
    ..moveTo(85.5, 60)
    ..lineTo(110, 60)
    ..lineTo(110, 101.7)
    ..lineTo(85.5, 78.45)
    ..close();

  /// NeoLinguaMeet (2026-10-19): two speech bubbles where the camera lens
  /// was, teal over navy: two people talking, each in their own language.
  /// The upper one's tail points back at the N, the lower one's away. The
  /// same shapes as mobile/tool/neo_mark.mjs and the website's NeoMark.
  static final Path _bubbleTop = Path()
    ..addRRect(RRect.fromLTRBR(108, 68, 127, 86, const Radius.circular(4)))
    ..addPolygon(const [Offset(112, 85), Offset(117, 85), Offset(112, 90.5)], true);

  static final Path _bubbleBottom = Path()
    ..addRRect(RRect.fromLTRBR(108, 95, 127, 113, const Radius.circular(4)))
    ..addPolygon(const [Offset(127, 109), Offset(127, 117), Offset(121.5, 113)], true);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.save();
    canvas.scale(size.width / width);
    canvas.translate(-left, -top);
    canvas.drawPath(_n, Paint()..color = _navy);
    canvas.save();
    canvas.clipPath(_n);
    canvas.drawPath(_upperRight, Paint()..color = _teal);
    canvas.restore();
    canvas.drawPath(_bubbleTop, Paint()..color = _teal);
    canvas.drawPath(_bubbleBottom, Paint()..color = _navy);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _MarkPainter oldDelegate) => false;
}

/// "Neo" in solid brand text, "LinguaMeet" in the site's gradient.
class NeoWordmark extends StatelessWidget {
  const NeoWordmark({super.key, this.fontSize = 20});

  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final palette = NeoTheme.of(context);
    final style = TextStyle(
      fontSize: fontSize,
      fontWeight: FontWeight.w600,
      letterSpacing: -0.4,
      height: 1.1,
    );

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('Neo', style: style.copyWith(color: palette.text)),
        // ShaderMask reproduces background-clip:text, which is how the
        // website paints the second half of the wordmark.
        if (palette.spectrumAt(7) case final solid?)
          Text('LinguaMeet', style: style.copyWith(color: solid))
        else
          ShaderMask(
            shaderCallback: (bounds) => NeoPalette.wordmarkGradient.createShader(bounds),
            blendMode: BlendMode.srcIn,
            child: Text(style: style.copyWith(color: Colors.white), 'LinguaMeet'),
          ),
      ],
    );
  }
}

/// Mark and wordmark together, as the site header shows them.
class NeoLogo extends StatelessWidget {
  const NeoLogo({super.key, this.markSize = 32, this.fontSize = 20});

  final double markSize;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        NeoLogoMark(size: markSize),
        const SizedBox(width: NeoSpace.sm + 2),
        NeoWordmark(fontSize: fontSize),
      ],
    );
  }
}

/// Reaches the active palette from anywhere in the tree.
///
/// Flutter's ColorScheme cannot hold everything here — surfaceAlt, the two
/// border weights, three text weights — and stuffing them into its slots
/// would mean reading `onSurfaceVariant` and hoping. This keeps the names
/// the design uses.
class NeoTheme extends InheritedTheme {
  const NeoTheme({super.key, required this.palette, required super.child});

  final NeoPalette palette;

  /// Carried into routes, the way Theme is.
  ///
  /// A dialog or bottom sheet is built under the Navigator, not under the
  /// widget that opened it, so a plain InheritedWidget does not reach it.
  /// That matters where a subtree overrides the palette — the meeting keeps
  /// itself dark under a light theme, and its sheets have to agree with it
  /// rather than coming back white over the video.
  @override
  Widget wrap(BuildContext context, Widget child) =>
      NeoTheme(palette: palette, child: child);

  static NeoPalette of(BuildContext context) {
    final found = context.dependOnInheritedWidgetOfExactType<NeoTheme>();
    if (found != null) return found.palette;
    // A sensible answer rather than a crash if a widget is previewed
    // outside the app shell.
    return Theme.of(context).brightness == Brightness.dark
        ? NeoPalette.dark
        : NeoPalette.light;
  }

  @override
  bool updateShouldNotify(NeoTheme oldWidget) => palette != oldWidget.palette;
}
