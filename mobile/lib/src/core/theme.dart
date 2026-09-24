import 'package:flutter/material.dart';

/// The website's palette, in Flutter's terms.
///
/// Taken from src/app/globals.css so the app reads as the same product:
/// near-black navy, cyan for anything you can act on.
class NeoColors {
  const NeoColors._();

  static const cyan = Color(0xFF22D3EE);
  static const cyanSoft = Color(0xFF67E8F9);
  static const blue = Color(0xFF38BDF8);
  static const purple = Color(0xFF818CF8);
  static const bg0 = Color(0xFF03050A);
  static const bg1 = Color(0xFF060B18);
  static const bg2 = Color(0xFF0A1428);

  /// Body text on the dark background — the web uses a very pale cyan
  /// rather than pure white, which is easier to sit in front of.
  static const text = Color(0xFFE6FBFF);
  static const textDim = Color(0xB3CFFAFE);
  static const danger = Color(0xFFF87171);
}

ThemeData neoTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  const scheme = ColorScheme.dark(
    primary: NeoColors.cyan,
    onPrimary: Color(0xFF03181C),
    secondary: NeoColors.purple,
    surface: NeoColors.bg1,
    onSurface: NeoColors.text,
    error: NeoColors.danger,
  );

  return base.copyWith(
    colorScheme: scheme,
    scaffoldBackgroundColor: NeoColors.bg0,
    appBarTheme: const AppBarTheme(
      backgroundColor: NeoColors.bg0,
      surfaceTintColor: Colors.transparent,
      foregroundColor: NeoColors.text,
      elevation: 0,
      centerTitle: false,
    ),
    cardTheme: CardThemeData(
      color: NeoColors.bg2,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: Color(0x3322D3EE)),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: NeoColors.bg2,
      hintStyle: const TextStyle(color: Color(0x73CFFAFE)),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: Color(0x3367E8F9)),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: Color(0x3367E8F9)),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: NeoColors.cyan, width: 1.5),
      ),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: NeoColors.cyan,
        foregroundColor: const Color(0xFF03181C),
        minimumSize: const Size.fromHeight(50),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
    ),
    snackBarTheme: const SnackBarThemeData(
      backgroundColor: NeoColors.bg2,
      contentTextStyle: TextStyle(color: NeoColors.text),
      behavior: SnackBarBehavior.floating,
    ),
    dividerColor: const Color(0x2267E8F9),
  );
}
