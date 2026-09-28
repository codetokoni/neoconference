import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:neoconference/src/design/brand.dart';
import 'package:neoconference/src/design/neo_theme.dart';
import 'package:neoconference/src/design/tokens.dart';

/// The logo inside the app is the same mark as the app icon: the "N" with
/// its teal upper-right stroke and the camera lens. It used to be a plain
/// camera, so the icon on the home screen and the logo on the app's own
/// screens did not match.
void main() {
  testWidgets('the in-app mark is the N, the teal stroke and the lens', (tester) async {
    const tile = 200.0;
    final key = GlobalKey();
    await tester.pumpWidget(MaterialApp(
      theme: neoThemeData(NeoPalette.dark),
      home: Center(
        child: RepaintBoundary(
          key: key,
          child: const NeoTheme(
            palette: NeoPalette.dark,
            child: NeoLogoMark(size: tile, glow: false),
          ),
        ),
      ),
    ));

    final pixels = await tester.runAsync(() async {
      final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await boundary.toImage();
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      return (image.width, data!);
    });
    final (width, data) = pixels!;

    // A point of the mark, in the favicon coordinates it is drawn in, to
    // the colour of the pixel it lands on. The mark is half the tile wide,
    // centred.
    Color at(double gx, double gy) {
      const scale = tile * 0.5 / 68.5;
      final x = (tile / 2 - tile * 0.25 + (gx - 56) * scale).round();
      final y = (tile / 2 - 45 * scale / 2 + (gy - 68) * scale).round();
      final i = (y * width + x) * 4;
      return Color.fromARGB(data.getUint8(i + 3), data.getUint8(i), data.getUint8(i + 1), data.getUint8(i + 2));
    }

    const navy = Color(0xFF01183A);
    const teal = Color(0xFF0C7AAA);
    expect(at(65, 90), navy, reason: 'left stroke');
    expect(at(94, 72), teal, reason: 'right stroke, above the diagonal');
    expect(at(95, 108), navy, reason: 'right stroke, below the diagonal');
    expect(at(116, 90), navy, reason: 'lens');
    // The notch between the strokes above the diagonal is the tile.
    expect(at(80, 70), isNot(anyOf(navy, teal)), reason: 'notch');
  });
}
