import 'package:flutter/material.dart';

import 'brand.dart';
import 'tokens.dart';

/// A titled section, used to give every screen the same rhythm.
class NeoSection extends StatelessWidget {
  const NeoSection({
    super.key,
    required this.title,
    this.action,
    required this.child,
    this.padding = const EdgeInsets.only(bottom: NeoSpace.xxl),
  });

  final String title;
  final Widget? action;
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Padding(
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: NeoSpace.md),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    title.toUpperCase(),
                    style: Theme.of(context)
                        .textTheme
                        .labelSmall
                        ?.copyWith(color: p.textMuted, letterSpacing: 0.8),
                  ),
                ),
                ?action,
              ],
            ),
          ),
          child,
        ],
      ),
    );
  }
}

/// A card that can be tapped. The whole surface is the target, so nobody
/// has to aim at a chevron.
class NeoCard extends StatelessWidget {
  const NeoCard({
    super.key,
    required this.child,
    this.onTap,
    this.padding = const EdgeInsets.all(NeoSpace.lg),
    this.highlighted = false,
  });

  final Widget child;
  final VoidCallback? onTap;
  final EdgeInsets padding;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Material(
      color: p.surfaceAlt,
      borderRadius: BorderRadius.circular(NeoRadius.lg),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(NeoRadius.lg),
        child: Ink(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(NeoRadius.lg),
            border: Border.all(
              color: highlighted ? p.primary : p.border,
              width: highlighted ? 1.5 : 1,
            ),
          ),
          child: Padding(padding: padding, child: child),
        ),
      ),
    );
  }
}

/// Small status word: Live, Scheduled, Ended, Recording.
class NeoPill extends StatelessWidget {
  const NeoPill(this.label, {super.key, required this.color, this.dot = false});

  final String label;
  final Color color;
  final bool dot;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: NeoSpace.sm + 2,
        vertical: 3,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(NeoRadius.sm),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot) ...[
            Container(
              height: 6,
              width: 6,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
            const SizedBox(width: NeoSpace.xs + 2),
          ],
          Text(
            label,
            style: Theme.of(context)
                .textTheme
                .labelSmall
                ?.copyWith(color: color, letterSpacing: 0.2),
          ),
        ],
      ),
    );
  }
}

/// Someone's initial in a brand-coloured circle.
///
/// Colour is derived from the name so the same person is the same colour
/// everywhere — in the grid, the participant list and the chat — which is
/// what makes an avatar useful at a glance.
class NeoAvatar extends StatelessWidget {
  const NeoAvatar({super.key, required this.name, this.size = 40});

  final String name;
  final double size;

  static const _palette = [
    [Color(0xFF22D3EE), Color(0xFF3B82F6)],
    [Color(0xFF818CF8), Color(0xFFC084FC)],
    [Color(0xFF34D399), Color(0xFF14B8A6)],
    [Color(0xFFFBBF24), Color(0xFFF97316)],
    [Color(0xFFF472B6), Color(0xFFEC4899)],
    [Color(0xFF38BDF8), Color(0xFF6366F1)],
  ];

  @override
  Widget build(BuildContext context) {
    final trimmed = name.trim();
    final initial = trimmed.isEmpty ? '?' : trimmed[0].toUpperCase();
    final colors = _palette[trimmed.hashCode.abs() % _palette.length];

    return Container(
      height: size,
      width: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(
          colors: colors,
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Center(
        child: Text(
          initial,
          style: TextStyle(
            fontSize: size * 0.42,
            fontWeight: FontWeight.w700,
            color: const Color(0xFF03181C),
          ),
        ),
      ),
    );
  }
}

/// A round control with a label beneath it.
///
/// Labelled on purpose: an unlabelled icon row is the usual way meeting
/// apps become guesswork under pressure, and the label is also what a
/// screen reader announces. The tap target is the whole column, always at
/// least 44pt wide.
class NeoControlButton extends StatelessWidget {
  const NeoControlButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onPressed,
    this.active = false,
    this.danger = false,
    this.badge = 0,
    this.enabled = true,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final bool active;
  final bool danger;
  final int badge;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final Color fg;
    final Color bg;
    if (!enabled) {
      fg = p.textFaint;
      bg = p.surfaceAlt.withValues(alpha: 0.5);
    } else if (danger) {
      fg = Colors.white;
      bg = p.danger;
    } else if (active) {
      fg = p.onPrimary;
      bg = p.primary;
    } else {
      fg = p.text;
      bg = p.surfaceHigh;
    }

    final button = Semantics(
      button: true,
      enabled: enabled,
      label: label,
      child: InkWell(
        onTap: enabled ? onPressed : null,
        borderRadius: BorderRadius.circular(NeoRadius.lg),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: NeoSpace.xs,
            vertical: NeoSpace.sm,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              AnimatedContainer(
                duration: NeoMotion.fast,
                curve: NeoMotion.curve,
                height: 48,
                width: 48,
                decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
                child: Icon(icon, color: fg, size: 22),
              ),
              const SizedBox(height: NeoSpace.xs + 2),
              // No fixed width: the caller decides how much room this gets,
              // usually by wrapping it in Expanded. A hard-coded width here
              // pushed the Leave button off a 393pt screen — the one
              // control that must always be reachable.
              Text(
                label,
                maxLines: 1,
                textAlign: TextAlign.center,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: enabled ? p.textMuted : p.textFaint,
                    ),
              ),
            ],
          ),
        ),
      ),
    );

    if (badge <= 0) return button;
    return Badge(
      label: Text('$badge'),
      backgroundColor: p.danger,
      offset: const Offset(-6, 6),
      child: button,
    );
  }
}

/// What to show when there is nothing to show.
class NeoEmptyState extends StatelessWidget {
  const NeoEmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: NeoSpace.xxxl,
          vertical: NeoSpace.huge,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              height: 64,
              width: 64,
              decoration: BoxDecoration(
                color: p.surfaceAlt,
                shape: BoxShape.circle,
                border: Border.all(color: p.border),
              ),
              child: Icon(icon, color: p.textMuted, size: 28),
            ),
            const SizedBox(height: NeoSpace.lg),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: NeoSpace.sm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(context)
                  .textTheme
                  .bodyMedium
                  ?.copyWith(color: p.textMuted),
            ),
            if (action != null) ...[
              const SizedBox(height: NeoSpace.xxl),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}

/// A shimmering placeholder, so loading reads as "coming" rather than
/// "broken". Deliberately calm: no spinner storms.
class NeoSkeleton extends StatefulWidget {
  const NeoSkeleton({
    super.key,
    this.height = 16,
    this.width,
    this.radius = NeoRadius.sm,
  });

  final double height;
  final double? width;
  final double radius;

  @override
  State<NeoSkeleton> createState() => _NeoSkeletonState();
}

class _NeoSkeletonState extends State<NeoSkeleton>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) => Container(
        height: widget.height,
        width: widget.width,
        decoration: BoxDecoration(
          color: Color.lerp(p.surfaceAlt, p.surfaceHigh, _controller.value),
          borderRadius: BorderRadius.circular(widget.radius),
        ),
      ),
    );
  }
}

/// A banner for conditions the person needs to act on or wait out —
/// permission denied, weak connection, reconnecting.
class NeoBanner extends StatelessWidget {
  const NeoBanner({
    super.key,
    required this.icon,
    required this.message,
    required this.tone,
    this.action,
    this.actionLabel,
  });

  final IconData icon;
  final String message;
  final NeoBannerTone tone;
  final VoidCallback? action;
  final String? actionLabel;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final color = switch (tone) {
      NeoBannerTone.info => p.info,
      NeoBannerTone.warning => p.warning,
      NeoBannerTone.danger => p.danger,
      NeoBannerTone.success => p.success,
    };

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: NeoSpace.md,
        vertical: NeoSpace.md,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(NeoRadius.md),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          Icon(icon, color: color, size: 18),
          const SizedBox(width: NeoSpace.md),
          Expanded(
            child: Text(
              message,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: p.text),
            ),
          ),
          if (action != null && actionLabel != null) ...[
            const SizedBox(width: NeoSpace.sm),
            TextButton(
              onPressed: action,
              style: TextButton.styleFrom(foregroundColor: color),
              child: Text(actionLabel!),
            ),
          ],
        ],
      ),
    );
  }
}

enum NeoBannerTone { info, warning, danger, success }

/// Confirmation for anything that cannot be taken back — leaving, ending
/// for everyone, removing someone.
Future<bool> neoConfirm(
  BuildContext context, {
  required String title,
  required String message,
  required String confirmLabel,
  bool destructive = true,
}) async {
  final p = NeoTheme.of(context);
  final result = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: destructive
              ? FilledButton.styleFrom(
                  backgroundColor: p.danger,
                  foregroundColor: Colors.white,
                )
              : null,
          onPressed: () => Navigator.pop(context, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return result ?? false;
}

/// The standard sheet presentation, so every sheet in the app behaves the
/// same way.
Future<T?> neoSheet<T>(
  BuildContext context, {
  required WidgetBuilder builder,
  bool fullHeight = false,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    constraints: fullHeight
        ? BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.92,
          )
        : null,
    builder: builder,
  );
}
