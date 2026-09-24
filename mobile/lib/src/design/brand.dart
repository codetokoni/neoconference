import 'package:flutter/material.dart';

import 'tokens.dart';

/// The NeoConference mark, drawn from the website's own vector.
///
/// The path below is copied verbatim from the inline SVG in
/// src/app/layout.tsx — the camera glyph sitting in the header tile — so
/// the app shows the real logo rather than a video-camera icon that merely
/// resembles it. Scaled from its 24×24 viewBox.
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
    return Container(
      height: size,
      width: size,
      decoration: BoxDecoration(
        gradient: NeoPalette.markGradient,
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
        child: SizedBox(
          height: size * 0.5,
          width: size * 0.5,
          child: CustomPaint(painter: _MarkPainter()),
        ),
      ),
    );
  }
}

class _MarkPainter extends CustomPainter {
  // text-slate-900 on the website's tile.
  static const _fill = Color(0xFF0F172A);

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      // Body: M3 7.5 A2.5 2.5 0 0 1 5.5 5 h7 A2.5 2.5 0 0 1 15 7.5 v9
      //       A2.5 2.5 0 0 1 12.5 19 h-7 A2.5 2.5 0 0 1 3 16.5 v-9 Z
      ..addRRect(
        RRect.fromLTRBR(3, 5, 15, 19, const Radius.circular(2.5)),
      )
      // Lens: the wedge to the right of the body.
      ..moveTo(17, 8.7)
      ..lineTo(20.3, 6.7)
      ..cubicTo(21.0, 6.3, 21.8, 6.8, 21.8, 7.56)
      ..lineTo(21.8, 16.44)
      ..cubicTo(21.8, 17.2, 21.0, 17.7, 20.3, 17.3)
      ..lineTo(17, 15.3)
      ..close();

    // The viewBox is 24×24; scale to whatever we were given.
    final scale = size.width / 24.0;
    canvas.save();
    canvas.scale(scale);
    canvas.drawPath(path, Paint()..color = _fill);
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _MarkPainter oldDelegate) => false;
}

/// "Neo" in solid brand text, "Conference" in the site's gradient.
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
        ShaderMask(
          shaderCallback: (bounds) =>
              NeoPalette.wordmarkGradient.createShader(bounds),
          blendMode: BlendMode.srcIn,
          child: Text(style: style.copyWith(color: Colors.white), 'Conference'),
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
