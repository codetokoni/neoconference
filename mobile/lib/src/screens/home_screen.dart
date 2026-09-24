import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../mock/sample_data.dart';
import 'join_sheet.dart';
import 'prejoin_screen.dart';
import 'schedule_screen.dart';

/// The dashboard.
///
/// Ordered by what someone opening the app at 9am actually needs: the
/// meeting about to start, then the three things they might want to do,
/// then everything else. Join comes first among the actions because it is
/// the one people arrive in a hurry to do.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, this.loading = false, this.empty = false});

  /// Both states are reachable in the real app; exposed here so they can be
  /// reviewed and screenshotted without waiting for a slow network.
  final bool loading;
  final bool empty;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {},
          color: p.primary,
          backgroundColor: p.surfaceAlt,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(
              NeoSpace.xl,
              NeoSpace.md,
              NeoSpace.xl,
              NeoSpace.huge,
            ),
            children: [
              const _Greeting(name: 'Adaeze'),
              const SizedBox(height: NeoSpace.xl),

              if (loading) ...[
                const _LoadingBlock(),
              ] else if (empty) ...[
                const _QuickActions(),
                const SizedBox(height: NeoSpace.xxl),
                NeoEmptyState(
                  icon: Icons.event_available_rounded,
                  title: 'Nothing scheduled',
                  message:
                      'When you schedule a meeting or someone invites you, '
                      'it appears here.',
                  action: FilledButton.icon(
                    onPressed: () => _schedule(context),
                    icon: const Icon(Icons.calendar_month_rounded, size: 18),
                    label: const Text('Schedule a meeting'),
                  ),
                ),
              ] else ...[
                _NextUp(meeting: sampleUpcoming.first),
                const SizedBox(height: NeoSpace.xxl),
                const _QuickActions(),
                const SizedBox(height: NeoSpace.xxl),

                NeoSection(
                  title: 'Upcoming',
                  action: TextButton(
                    onPressed: () {},
                    child: const Text('See all'),
                  ),
                  child: Column(
                    children: [
                      for (final m in sampleUpcoming.skip(1))
                        Padding(
                          padding: const EdgeInsets.only(bottom: NeoSpace.md),
                          child: _MeetingRow(meeting: m),
                        ),
                    ],
                  ),
                ),

                NeoSection(
                  title: 'Recent',
                  child: Column(
                    children: [
                      for (final m in sampleRecent)
                        Padding(
                          padding: const EdgeInsets.only(bottom: NeoSpace.md),
                          child: _MeetingRow(meeting: m, past: true),
                        ),
                    ],
                  ),
                ),

                Center(
                  child: Text(
                    'Sample data — not connected to your account',
                    style: text.labelSmall?.copyWith(color: p.textFaint),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  static void _schedule(BuildContext context) => Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const ScheduleScreen()),
      );
}

class _Greeting extends StatelessWidget {
  const _Greeting({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final hour = sampleNow.hour;
    final part = hour < 12
        ? 'Good morning'
        : hour < 18
            ? 'Good afternoon'
            : 'Good evening';

    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                part,
                style: Theme.of(context)
                    .textTheme
                    .bodyMedium
                    ?.copyWith(color: p.textMuted),
              ),
              const SizedBox(height: 2),
              Text(name, style: Theme.of(context).textTheme.headlineSmall),
            ],
          ),
        ),
        const NeoLogoMark(size: 36),
      ],
    );
  }
}

/// The meeting that is about to start, given the weight it deserves.
class _NextUp extends StatelessWidget {
  const _NextUp({required this.meeting});
  final SampleMeeting meeting;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final soon = meeting.status == SampleStatus.startingSoon;

    return Container(
      padding: const EdgeInsets.all(NeoSpace.xl),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(NeoRadius.xl),
        border: Border.all(color: p.primary.withValues(alpha: 0.45)),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            p.primary.withValues(alpha: p.isDark ? 0.16 : 0.10),
            p.accent.withValues(alpha: p.isDark ? 0.10 : 0.06),
          ],
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              NeoPill(
                soon ? 'Starts ${sampleWhen(meeting.startsAt)}' : 'Next up',
                color: p.primary,
                dot: soon,
              ),
              const Spacer(),
              if (meeting.recurring)
                Icon(Icons.repeat_rounded, size: 16, color: p.textMuted),
            ],
          ),
          const SizedBox(height: NeoSpace.md),
          Text(meeting.title, style: text.titleLarge),
          const SizedBox(height: NeoSpace.xs + 2),
          Text(
            '${sampleClock(meeting.startsAt)} · ${meeting.durationMinutes} min '
            '· ${meeting.host}',
            style: text.bodySmall?.copyWith(color: p.textMuted),
          ),
          const SizedBox(height: NeoSpace.lg),
          Row(
            children: [
              _AvatarStack(names: meeting.participants),
              const Spacer(),
              FilledButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => PreJoinScreen(meeting: meeting),
                  ),
                ),
                style: FilledButton.styleFrom(
                  minimumSize: const Size(0, NeoSpace.minTouch),
                  padding: const EdgeInsets.symmetric(
                    horizontal: NeoSpace.xxl,
                  ),
                ),
                child: const Text('Join'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _AvatarStack extends StatelessWidget {
  const _AvatarStack({required this.names});
  final List<String> names;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final shown = names.take(3).toList();
    final extra = names.length - shown.length;

    return Row(
      children: [
        SizedBox(
          height: 32,
          width: 32.0 + (shown.length - 1) * 21,
          child: Stack(
            children: [
              for (var i = 0; i < shown.length; i++)
                Positioned(
                  left: i * 21.0,
                  child: Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: p.bg, width: 2),
                    ),
                    child: NeoAvatar(name: shown[i], size: 28),
                  ),
                ),
            ],
          ),
        ),
        if (extra > 0) ...[
          const SizedBox(width: NeoSpace.sm),
          Text(
            '+$extra',
            style: Theme.of(context)
                .textTheme
                .labelMedium
                ?.copyWith(color: p.textMuted),
          ),
        ],
      ],
    );
  }
}

/// Join, Start, Schedule — the three things the dashboard exists for.
class _QuickActions extends StatelessWidget {
  const _QuickActions();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: _Action(
            icon: Icons.add_link_rounded,
            label: 'Join',
            filled: true,
            onTap: () => neoSheet(context, builder: (_) => const JoinSheet()),
          ),
        ),
        const SizedBox(width: NeoSpace.md),
        Expanded(
          child: _Action(
            icon: Icons.videocam_rounded,
            label: 'Start',
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => PreJoinScreen(
                  meeting: SampleMeeting(
                    title: 'Instant meeting',
                    code: 'instant',
                    host: 'You',
                    startsAt: sampleNow,
                    durationMinutes: 0,
                    participants: const ['You'],
                    status: SampleStatus.live,
                  ),
                  instant: true,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: NeoSpace.md),
        Expanded(
          child: _Action(
            icon: Icons.calendar_month_rounded,
            label: 'Schedule',
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const ScheduleScreen()),
            ),
          ),
        ),
      ],
    );
  }
}

class _Action extends StatelessWidget {
  const _Action({
    required this.icon,
    required this.label,
    required this.onTap,
    this.filled = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final fg = filled ? p.onPrimary : p.text;

    return Material(
      color: filled ? p.primary : p.surfaceAlt,
      borderRadius: BorderRadius.circular(NeoRadius.lg),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(NeoRadius.lg),
        child: Ink(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(NeoRadius.lg),
            border: Border.all(color: filled ? Colors.transparent : p.border),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: NeoSpace.lg),
            child: Column(
              children: [
                Icon(icon, color: fg, size: 22),
                const SizedBox(height: NeoSpace.sm),
                Text(
                  label,
                  style: Theme.of(context)
                      .textTheme
                      .labelMedium
                      ?.copyWith(color: fg),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _MeetingRow extends StatelessWidget {
  const _MeetingRow({required this.meeting, this.past = false});

  final SampleMeeting meeting;
  final bool past;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return NeoCard(
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => PreJoinScreen(meeting: meeting)),
      ),
      child: Row(
        children: [
          Container(
            height: 44,
            width: 44,
            decoration: BoxDecoration(
              color: p.surfaceHigh,
              borderRadius: BorderRadius.circular(NeoRadius.md),
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  sampleClock(meeting.startsAt),
                  style: text.labelMedium?.copyWith(
                    color: past ? p.textMuted : p.primary,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: NeoSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  meeting.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: text.titleSmall,
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        past
                            ? '${sampleWhen(meeting.startsAt)} · '
                                '${meeting.durationMinutes} min'
                            : '${sampleWhen(meeting.startsAt)} · '
                                '${meeting.participants.length} invited',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: text.bodySmall?.copyWith(color: p.textMuted),
                      ),
                    ),
                    if (meeting.hasRecording) ...[
                      const SizedBox(width: NeoSpace.sm),
                      Icon(
                        Icons.play_circle_outline_rounded,
                        size: 14,
                        color: p.textMuted,
                      ),
                    ],
                    if (meeting.languages.isNotEmpty) ...[
                      const SizedBox(width: NeoSpace.sm),
                      Icon(Icons.translate_rounded, size: 14, color: p.textMuted),
                    ],
                  ],
                ),
              ],
            ),
          ),
          Icon(Icons.chevron_right_rounded, color: p.textFaint),
        ],
      ),
    );
  }
}

class _LoadingBlock extends StatelessWidget {
  const _LoadingBlock();

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const NeoSkeleton(height: 148, radius: NeoRadius.xl),
        const SizedBox(height: NeoSpace.xxl),
        Row(
          children: [
            for (var i = 0; i < 3; i++) ...[
              const Expanded(
                child: NeoSkeleton(height: 82, radius: NeoRadius.lg),
              ),
              if (i < 2) const SizedBox(width: NeoSpace.md),
            ],
          ],
        ),
        const SizedBox(height: NeoSpace.xxl),
        for (var i = 0; i < 3; i++) ...[
          const NeoSkeleton(height: 76, radius: NeoRadius.lg),
          const SizedBox(height: NeoSpace.md),
        ],
      ],
    );
  }
}
