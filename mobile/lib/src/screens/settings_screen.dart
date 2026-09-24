import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/themes.dart';
import '../design/tokens.dart';
import '../mock/sample_data.dart';
import 'meeting_screen.dart';
import 'prejoin_screen.dart';

/// Profile and settings.
///
/// Also the way into the state gallery — the permission-denied, weak,
/// reconnecting and ended screens are real states of the app, and being
/// able to open them directly is what makes them reviewable rather than
/// theoretical.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  bool _joinMuted = true;
  bool _joinCameraOff = true;
  bool _hdVideo = false;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(
          NeoSpace.xl,
          NeoSpace.sm,
          NeoSpace.xl,
          NeoSpace.huge,
        ),
        children: [
          Row(
            children: [
              const NeoAvatar(name: 'Adaeze Okonkwo', size: 56),
              const SizedBox(width: NeoSpace.lg),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Adaeze Okonkwo', style: text.titleMedium),
                    Text(
                      'adaeze@neoconference.app',
                      style: text.bodySmall?.copyWith(color: p.textMuted),
                    ),
                  ],
                ),
              ),
              NeoPill('Business', color: p.primary),
            ],
          ),
          const SizedBox(height: NeoSpace.xxl),

          NeoSection(
            title: 'Meetings',
            child: Column(
              children: [
                _Row(
                  title: 'Join muted',
                  subtitle: 'Your microphone starts off',
                  trailing: Switch(
                    value: _joinMuted,
                    onChanged: (v) => setState(() => _joinMuted = v),
                  ),
                ),
                _Row(
                  title: 'Join with camera off',
                  trailing: Switch(
                    value: _joinCameraOff,
                    onChanged: (v) => setState(() => _joinCameraOff = v),
                  ),
                ),
                _Row(
                  title: 'HD video',
                  subtitle: 'Uses more data on mobile networks',
                  trailing: Switch(
                    value: _hdVideo,
                    onChanged: (v) => setState(() => _hdVideo = v),
                  ),
                ),
              ],
            ),
          ),

          NeoSection(
            title: 'Appearance',
            child: Column(
              children: [
                const _ThemePicker(),
                _Row(
                  title: 'Text size',
                  subtitle: 'Follows your system setting',
                  trailing: Icon(
                    Icons.chevron_right_rounded,
                    color: p.textFaint,
                  ),
                ),
              ],
            ),
          ),

          NeoSection(
            title: 'States (for review)',
            child: Column(
              children: [
                _Row(
                  title: 'Permission denied',
                  subtitle: 'Pre-join with camera and mic blocked',
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => PreJoinScreen(
                        meeting: sampleUpcoming.first,
                        permissionDenied: true,
                      ),
                    ),
                  ),
                ),
                _Row(
                  title: 'Weak connection',
                  onTap: () => _openMeeting(context, MeetingLink.weak),
                ),
                _Row(
                  title: 'Reconnecting',
                  onTap: () => _openMeeting(context, MeetingLink.reconnecting),
                ),
                _Row(
                  title: 'Meeting ended',
                  onTap: () => _openMeeting(context, MeetingLink.ended),
                ),
              ],
            ),
          ),

          NeoSection(
            title: 'Roles (for review)',
            child: Column(
              children: [
                for (final role in [
                  SampleRole.owner,
                  SampleRole.host,
                  SampleRole.cohost,
                  SampleRole.moderator,
                  SampleRole.attendee,
                ])
                  _Row(
                    title: 'Join as ${_label(role)}',
                    subtitle: role == SampleRole.moderator
                        ? 'No recording controls'
                        : null,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => MeetingScreen(
                          meeting: sampleUpcoming.first,
                          myRole: role,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),

          OutlinedButton.icon(
            onPressed: () {},
            icon: Icon(Icons.logout_rounded, color: p.danger),
            label: Text('Sign out', style: TextStyle(color: p.danger)),
            style: OutlinedButton.styleFrom(
              side: BorderSide(color: p.danger.withValues(alpha: 0.5)),
            ),
          ),
        ],
      ),
    );
  }

  static String _label(SampleRole role) => switch (role) {
        SampleRole.owner => 'Owner',
        SampleRole.host => 'Host',
        SampleRole.cohost => 'Co-host',
        SampleRole.moderator => 'Moderator',
        SampleRole.speaker => 'Speaker',
        SampleRole.attendee => 'Attendee',
      };

  void _openMeeting(BuildContext context, MeetingLink link) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => MeetingScreen(
          meeting: sampleUpcoming.first,
          myRole: SampleRole.host,
          link: link,
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
  });

  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: NeoSpace.sm),
      child: NeoCard(
        onTap: onTap,
        padding: const EdgeInsets.symmetric(
          horizontal: NeoSpace.lg,
          vertical: NeoSpace.md,
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleSmall),
                  if (subtitle != null)
                    Text(
                      subtitle!,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                ],
              ),
            ),
            trailing ??
                (onTap != null
                    ? Icon(Icons.chevron_right_rounded, color: p.textFaint)
                    : const SizedBox.shrink()),
          ],
        ),
      ),
    );
  }
}

/// Choosing a theme by looking at it.
///
/// Swatches rather than a list of names: nobody knows what "Amethyst" is
/// until they see it, and a theme picker that makes you apply each one to
/// find out is a theme picker nobody uses twice. Each swatch shows the
/// three colours that actually decide how a screen feels — background,
/// surface, and the primary action.
class _ThemePicker extends ConsumerWidget {
  const _ThemePicker();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final current = ref.watch(neoThemeProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: NeoSpace.md),
          child: Text(
            'Theme',
            style: Theme.of(context).textTheme.titleSmall,
          ),
        ),
        SizedBox(
          height: 112,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: neoThemeOptions.length,
            separatorBuilder: (_, _) => const SizedBox(width: NeoSpace.md),
            itemBuilder: (context, i) {
              final option = neoThemeOptions[i];
              final selected = option.choice == current;
              return _ThemeSwatch(
                option: option,
                selected: selected,
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
        const SizedBox(height: NeoSpace.md),
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
            crossAxisAlignment: CrossAxisAlignment.center,
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
