import 'package:flutter/material.dart';

import 'tokens.dart';

/// Type scale.
///
/// Sizes are absolute and never hard-coded at call sites, so raising the
/// system font size scales the whole app rather than overflowing the
/// screens that happened to use a literal. Nothing here sets
/// TextScaler.noScaling; text that must not clip is laid out to wrap.
TextTheme _textTheme(NeoPalette p) {
  const family = null; // Platform default: SF on iOS, Roboto on Android.
  TextStyle base(double size, FontWeight weight, {double? height, double? spacing}) =>
      TextStyle(
        fontFamily: family,
        fontSize: size,
        fontWeight: weight,
        height: height,
        letterSpacing: spacing,
        color: p.text,
      );

  return TextTheme(
    displaySmall: base(32, FontWeight.w700, height: 1.15, spacing: -0.6),
    headlineMedium: base(26, FontWeight.w700, height: 1.2, spacing: -0.4),
    headlineSmall: base(22, FontWeight.w600, height: 1.25, spacing: -0.3),
    titleLarge: base(18, FontWeight.w600, height: 1.3),
    titleMedium: base(16, FontWeight.w600, height: 1.35),
    titleSmall: base(14, FontWeight.w600, height: 1.35),
    bodyLarge: base(16, FontWeight.w400, height: 1.45),
    bodyMedium: base(14, FontWeight.w400, height: 1.45),
    bodySmall: base(12, FontWeight.w400, height: 1.4).copyWith(color: p.textMuted),
    labelLarge: base(15, FontWeight.w600, height: 1.2),
    labelMedium: base(13, FontWeight.w600, height: 1.2),
    labelSmall: base(11, FontWeight.w600, height: 1.2, spacing: 0.4)
        .copyWith(color: p.textMuted),
  );
}

ThemeData neoThemeData(NeoPalette p) {
  final text = _textTheme(p);

  final scheme = ColorScheme(
    brightness: p.brightness,
    primary: p.primary,
    onPrimary: p.onPrimary,
    secondary: p.accent,
    onSecondary: p.isDark ? const Color(0xFF0B1020) : Colors.white,
    error: p.danger,
    onError: Colors.white,
    surface: p.surface,
    onSurface: p.text,
    surfaceContainerHighest: p.surfaceHigh,
    outline: p.borderStrong,
    outlineVariant: p.border,
  );

  OutlineInputBorder border(Color c, [double w = 1]) => OutlineInputBorder(
        borderRadius: BorderRadius.circular(NeoRadius.md),
        borderSide: BorderSide(color: c, width: w),
      );

  return ThemeData(
    useMaterial3: true,
    brightness: p.brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: p.bg,
    canvasColor: p.bg,
    textTheme: text,
    splashFactory: InkSparkle.splashFactory,

    appBarTheme: AppBarTheme(
      backgroundColor: p.bg,
      surfaceTintColor: Colors.transparent,
      foregroundColor: p.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: text.titleLarge,
    ),

    cardTheme: CardThemeData(
      color: p.surfaceAlt,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(NeoRadius.lg),
        side: BorderSide(color: p.border),
      ),
    ),

    dividerTheme: DividerThemeData(color: p.border, thickness: 1, space: 1),

    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: p.isDark ? p.surfaceAlt : p.surface,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: NeoSpace.lg,
        vertical: NeoSpace.lg,
      ),
      hintStyle: text.bodyMedium?.copyWith(color: p.textFaint),
      labelStyle: text.bodyMedium?.copyWith(color: p.textMuted),
      border: border(p.border),
      enabledBorder: border(p.border),
      focusedBorder: border(p.primary, 1.5),
      errorBorder: border(p.danger),
      focusedErrorBorder: border(p.danger, 1.5),
    ),

    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: p.primary,
        foregroundColor: p.onPrimary,
        disabledBackgroundColor: p.primary.withValues(alpha: 0.35),
        disabledForegroundColor: p.onPrimary.withValues(alpha: 0.6),
        minimumSize: const Size(NeoSpace.minTouch, 52),
        padding: const EdgeInsets.symmetric(horizontal: NeoSpace.xxl),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(NeoRadius.md),
        ),
        textStyle: text.labelLarge,
      ),
    ),

    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        // The palette's own primary, not a fixed cyan: with several dark
        // themes a hard-coded brand colour leaves Amethyst and Ocean with
        // cyan links they never asked for.
        foregroundColor: p.primary,
        minimumSize: const Size(NeoSpace.minTouch, 52),
        padding: const EdgeInsets.symmetric(horizontal: NeoSpace.xxl),
        side: BorderSide(color: p.borderStrong),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(NeoRadius.md),
        ),
        textStyle: text.labelLarge,
      ),
    ),

    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        // The palette's own primary, not a fixed cyan: with several dark
        // themes a hard-coded brand colour leaves Amethyst and Ocean with
        // cyan links they never asked for.
        foregroundColor: p.primary,
        minimumSize: const Size(NeoSpace.minTouch, NeoSpace.minTouch),
        textStyle: text.labelMedium,
      ),
    ),

    iconButtonTheme: IconButtonThemeData(
      style: IconButton.styleFrom(
        foregroundColor: p.textMuted,
        minimumSize: const Size(NeoSpace.minTouch, NeoSpace.minTouch),
      ),
    ),

    segmentedButtonTheme: SegmentedButtonThemeData(
      style: ButtonStyle(
        backgroundColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? p.primary : p.surfaceAlt),
        foregroundColor: WidgetStateProperty.resolveWith((s) =>
            s.contains(WidgetState.selected) ? p.onPrimary : p.textMuted),
        side: WidgetStatePropertyAll(BorderSide(color: p.border)),
        textStyle: WidgetStatePropertyAll(text.labelMedium),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(NeoRadius.md),
          ),
        ),
      ),
    ),

    bottomSheetTheme: BottomSheetThemeData(
      backgroundColor: p.surface,
      surfaceTintColor: Colors.transparent,
      modalBarrierColor: p.scrim,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(
          top: Radius.circular(NeoRadius.sheet),
        ),
      ),
      showDragHandle: true,
      dragHandleColor: p.textFaint,
    ),

    dialogTheme: DialogThemeData(
      backgroundColor: p.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(NeoRadius.xl),
        side: BorderSide(color: p.border),
      ),
      titleTextStyle: text.titleLarge,
      contentTextStyle: text.bodyMedium?.copyWith(color: p.textMuted),
    ),

    snackBarTheme: SnackBarThemeData(
      backgroundColor: p.surfaceHigh,
      contentTextStyle: text.bodyMedium?.copyWith(color: p.text),
      behavior: SnackBarBehavior.floating,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(NeoRadius.md),
      ),
    ),

    chipTheme: ChipThemeData(
      backgroundColor: p.surfaceAlt,
      side: BorderSide(color: p.border),
      labelStyle: text.labelMedium!.copyWith(color: p.text),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(NeoRadius.pill),
      ),
    ),

    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) =>
          s.contains(WidgetState.selected) ? p.onPrimary : p.textFaint),
      trackColor: WidgetStateProperty.resolveWith((s) =>
          s.contains(WidgetState.selected) ? p.primary : p.surfaceHigh),
    ),

    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: p.primary,
      linearTrackColor: p.surfaceHigh,
      circularTrackColor: p.surfaceHigh,
    ),

    listTileTheme: ListTileThemeData(
      titleTextStyle: text.titleSmall,
      subtitleTextStyle: text.bodySmall,
      iconColor: p.textMuted,
      minVerticalPadding: NeoSpace.md,
    ),

    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        // Each platform's own idiom: a horizontal slide on iOS, a
        // fade-through on Android. Using one everywhere is the quickest way
        // to make an app feel foreign on one of them.
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        TargetPlatform.android: FadeUpwardsPageTransitionsBuilder(),
      },
    ),
  );
}
