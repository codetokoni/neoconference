import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'brand.dart';
import 'themes.dart';
import 'tokens.dart';

/// Choosing a theme by looking at it.
///
/// Swatches rather than a list of names: nobody knows what "Amethyst" is
/// until they see it, and a theme picker that makes you apply each one to
/// find out is a theme picker nobody uses twice. Each swatch shows the
/// three colours that actually decide how a screen feels — background,
/// surface, and the primary action.
///
/// Lives in the design system because both the production app and the
/// showcase offer it, and two copies would drift the first time a palette
/// was added to one of them.
class NeoThemePicker extends ConsumerWidget {
  const NeoThemePicker({super.key, this.title = 'Theme'});

  final String title;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final current = ref.watch(neoThemeProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: NeoSpace.md),
          child: Text(title, style: Theme.of(context).textTheme.titleSmall),
        ),
        SizedBox(
          height: 112,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: neoThemeOptions.length,
            separatorBuilder: (_, _) => const SizedBox(width: NeoSpace.md),
            itemBuilder: (context, i) {
              final option = neoThemeOptions[i];
              return _ThemeSwatch(
                option: option,
                selected: option.choice == current,
                onTap: () =>
                    ref.read(neoThemeProvider.notifier).select(option.choice),
              );
            },
          ),
        ),
        const SizedBox(height: NeoSpace.sm),
        Text(
          neoThemeOption(current).description,
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: p.textMuted),
        ),
      ],
    );
  }
}

class _ThemeSwatch extends StatelessWidget {
  const _ThemeSwatch({
    required this.option,
    required this.selected,
    required this.onTap,
  });

  final NeoThemeOption option;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    // "Match system" has no palette of its own; preview it with whichever
    // the device is currently using, which is what it would give you.
    final preview = option.palette ??
        (MediaQuery.of(context).platformBrightness == Brightness.dark
            ? NeoPalette.dark
            : NeoPalette.light);

    return Semantics(
      button: true,
      selected: selected,
      label: '${option.name}. ${option.description}',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(NeoRadius.lg),
        child: SizedBox(
          width: 92,
          child: Column(
            children: [
              AnimatedContainer(
                duration: NeoMotion.fast,
                curve: NeoMotion.curve,
                height: 68,
                width: 92,
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: preview.bg,
                  borderRadius: BorderRadius.circular(NeoRadius.md),
                  border: Border.all(
                    color: selected ? p.primary : p.border,
                    width: selected ? 2 : 1,
                  ),
                ),
                child: Stack(
                  children: [
                    Positioned(
                      left: 10,
                      top: 12,
                      right: 26,
                      child: Container(
                        height: 10,
                        decoration: BoxDecoration(
                          color: preview.surfaceAlt,
                          borderRadius: BorderRadius.circular(3),
                        ),
                      ),
                    ),
                    Positioned(
                      left: 10,
                      top: 28,
                      right: 40,
                      child: Container(
                        height: 8,
                        decoration: BoxDecoration(
                          color: preview.textMuted.withValues(alpha: 0.5),
                          borderRadius: BorderRadius.circular(3),
                        ),
                      ),
                    ),
                    Positioned(
                      left: 10,
                      bottom: 10,
                      child: Container(
                        height: 18,
                        width: 34,
                        decoration: BoxDecoration(
                          color: preview.primary,
                          borderRadius: BorderRadius.circular(5),
                        ),
                      ),
                    ),
                    if (selected)
                      Positioned(
                        right: 6,
                        top: 6,
                        child: Icon(
                          Icons.check_circle_rounded,
                          size: 16,
                          color: preview.primary,
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: NeoSpace.sm),
              Text(
                option.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                      color: selected ? p.primary : p.textMuted,
                    ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
