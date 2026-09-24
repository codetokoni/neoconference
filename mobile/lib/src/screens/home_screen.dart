import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/meeting_board.dart';
import '../meetings/meeting_view.dart';
import '../meetings/when.dart';
import 'join_sheet.dart';
import 'prejoin_screen.dart';
import 'schedule_screen.dart';

/// The dashboard.
///
/// Ordered by what someone opening the app at 9am actually needs: the
/// meeting about to start, then the three things they might want to do,
/// then everything else. Join comes first among the actions because it is
/// the one people arrive in a hurry to do.
///
/// Reads [meetingBoardProvider], which the entrypoint supplies — the real
/// account's meetings in production, sample data in the showcase. The
/// layout is the same either way, which is the point: the design is
/// reviewed against the shapes real data comes in.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.watch(meetingBoardProvider);
    final name = ref.watch(homeGreetingNameProvider);
    final now = ref.watch(nowProvider);
    final p = NeoTheme.of(context);

    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () => ref.refresh(meetingBoardProvider.future),
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
              _Greeting(name: name, now: now),
              const SizedBox(height: NeoSpace.xl),
              ...board.when(
                loading: () => const [_LoadingBlock()],
                error: (e, _) => [
                  const _QuickActions(),
                  const SizedBox(height: NeoSpace.xxl),
                  NeoEmptyState(
                    icon: Icons.cloud_off_rounded,
                    title: 'Could not load your meetings',
                    message: '$e',
                    action: FilledButton(
                      onPressed: () => ref.invalidate(meetingBoardProvider),
                      child: const Text('Try again'),
                    ),
                  ),
                ],
                data: (board) => _board(context, ref, board, now),
              ),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _board(
    BuildContext context,
    WidgetRef ref,
    MeetingBoard board,
    DateTime now,
  ) {
    final next = board.next;

    if (board.isEmpty) {
      return [
        const _QuickActions(),
        const SizedBox(height: NeoSpace.xxl),
        NeoEmptyState(
          icon: Icons.event_available_rounded,
          title: 'Nothing scheduled',
          message: 'When you schedule a meeting or someone invites you, '
              'it appears here.',
          action: FilledButton.icon(
            onPressed: () => _schedule(context),
            icon: const Icon(Icons.calendar_month_rounded, size: 18),
            label: const Text('Schedule a meeting'),
          ),
        ),
      ];
    }

    return [
      if (next != null) ...[
        _NextUp(meeting: next, now: now),
        const SizedBox(height: NeoSpace.xxl),
      ],
      const _QuickActions(),
      const SizedBox(height: NeoSpace.xxl),

      if (board.personalRoom != null)
        NeoSection(
          title: 'Your room',
          child: _MeetingRow(meeting: board.personalRoom!, now: now),
        ),

      if (board.upcoming.length > 1)
        NeoSection(
          title: 'Upcoming',
          child: Column(
            children: [
              for (final m in board.upcoming.where((m) => m != next))
                Padding(
                  padding: const EdgeInsets.only(bottom: NeoSpace.md),
                  child: _MeetingRow(meeting: m, now: now),
                ),
            ],
          ),
        ),

      if (board.openRooms.isNotEmpty)
        NeoSection(
          title: 'Still open',
          child: Column(
            children: [
              for (final m in board.openRooms.take(5))
                Padding(
                  padding: const EdgeInsets.only(bottom: NeoSpace.md),
                  child: _MeetingRow(meeting: m, now: now),
                ),
            ],
          ),
        ),

      if (board.recent.isNotEmpty)
        NeoSection(
          title: 'Recent',
          child: Column(
            children: [
              for (final m in board.recent.take(5))
                Padding(
                  padding: const EdgeInsets.only(bottom: NeoSpace.md),
                  child: _MeetingRow(meeting: m, now: now, past: true),
                ),
            ],
          ),
        ),
    ];
  }

  static void _schedule(BuildContext context) => Navigator.of(context).push(
        MaterialPageRoute(builder: (_) => const ScheduleScreen()),
      );
}

/// The name in the greeting, and the clock the screens read.
///
/// Both are overridden by the showcase so its screenshots are stable.
final homeGreetingNameProvider = Provider<String?>((ref) => null);
final nowProvider = Provider<DateTime>((ref) => DateTime.now());

class _Greeting extends StatelessWidget {
  const _Greeting({required this.name, required this.now});

  final String? name;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final trimmed = name?.trim();

    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                neoGreeting(now),
                style: text.bodyMedium?.copyWith(color: p.textMuted),
              ),
              const SizedBox(height: 2),
              // Without a name the greeting stands on its own rather than
              // addressing someone as "there".
              if (trimmed != null && trimmed.isNotEmpty)
                Text(trimmed, style: text.headlineSmall),
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
  const _NextUp({required this.meeting, required this.now});

  final MeetingView meeting;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final soon = meeting.status == MeetingStatus.startingSoon;
    final live = meeting.isLive;
    final starts = meeting.startsAt;

    final detail = <String>[
      if (starts != null) neoClock(starts),
      if (meeting.durationMinutes != null) '${meeting.durationMinutes} min',
      if (meeting.host != null) meeting.host!,
    ].join(' · ');

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
                live
                    ? 'Live now'
                    : soon && starts != null
                        ? 'Starts ${neoWhen(starts, now: now)}'
                        : 'Next up',
                color: p.primary,
                dot: soon || live,
              ),
              const Spacer(),
              if (meeting.recurring)
                Icon(Icons.repeat_rounded, size: 16, color: p.textMuted),
            ],
          ),
          const SizedBox(height: NeoSpace.md),
          Text(meeting.title, style: text.titleLarge),
          if (detail.isNotEmpty) ...[
            const SizedBox(height: NeoSpace.xs + 2),
            Text(detail, style: text.bodySmall?.copyWith(color: p.textMuted)),
          ],
          const SizedBox(height: NeoSpace.lg),
          Row(
            children: [
              if (meeting.participants.isNotEmpty)
                _AvatarStack(names: meeting.participants)
              else if (starts != null)
                Text(
                  neoWhen(starts, now: now),
                  style: text.bodySmall?.copyWith(color: p.textMuted),
                ),
              const Spacer(),
              FilledButton(
                onPressed: meeting.canJoin
                    ? () => Navigator.of(context).push(
                          MaterialPageRoute(
                            builder: (_) => PreJoinScreen(meeting: meeting),
                          ),
                        )
                    : null,
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
                builder: (_) => const PreJoinScreen(instant: true),
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
  const _MeetingRow({
    required this.meeting,
    required this.now,
    this.past = false,
  });

  final MeetingView meeting;
  final DateTime now;
  final bool past;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final starts = meeting.startsAt;
    final invited = meeting.knownParticipants;

    // A permanent room has a last-used time, not a start time. Printing
    // "6 days ago" under a room that is open right now reads as though it
    // closed six days ago.
    final detail = meeting.recurring
        ? 'Always open · ${meeting.code}'
        : <String>[
            if (starts != null) neoWhen(starts, now: now),
            if (past && meeting.durationMinutes != null)
              '${meeting.durationMinutes} min'
            else if (!past && invited != null)
              '$invited invited',
            if (starts == null) meeting.code,
          ].join(' · ');

    return NeoCard(
      onTap: meeting.canJoin
          ? () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => PreJoinScreen(meeting: meeting),
                ),
              )
          : null,
      child: Row(
        children: [
          Container(
            height: 44,
            width: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: p.surfaceHigh,
              borderRadius: BorderRadius.circular(NeoRadius.md),
            ),
            child: starts != null && !meeting.recurring
                ? Text(
                    neoClock(starts),
                    style: text.labelMedium?.copyWith(
                      color: past ? p.textMuted : p.primary,
                    ),
                  )
                : Icon(
                    meeting.recurring
                        ? Icons.meeting_room_rounded
                        : Icons.event_rounded,
                    size: 20,
                    color: past ? p.textMuted : p.primary,
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
                if (detail.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          detail,
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
                        Icon(
                          Icons.translate_rounded,
                          size: 14,
                          color: p.textMuted,
                        ),
                      ],
                    ],
                  ),
                ],
              ],
            ),
          ),
          if (meeting.isLive)
            NeoPill('Live', color: p.primary, dot: true)
          else if (meeting.canJoin)
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
