import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/meeting_board.dart';
import '../meetings/meeting_view.dart';
import '../meetings/when.dart';
import 'home_screen.dart' show nowProvider;

/// Whether this build can list recordings.
///
/// False in production: recordings are made by the server's egress, but
/// nothing exposes them to the app yet, so the tab says so instead of
/// showing an empty list that looks like "you have none". The showcase
/// turns it on to show the design.
final recordingsAvailableProvider = Provider<bool>((ref) => false);

/// Past meetings, and the recordings this account is allowed to see.
///
/// Recordings are not shown by row unless one exists and the viewer may
/// have it: an inert "Recording" label on a meeting nobody can replay is
/// worse than silence.
class HistoryScreen extends ConsumerWidget {
  const HistoryScreen({super.key, this.canViewRecordings = true});

  final bool canViewRecordings;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final listed = ref.watch(recordingsAvailableProvider);

    return DefaultTabController(
      length: 2,
      child: Scaffold(
        backgroundColor: p.bg,
        appBar: AppBar(
          title: const Text('History'),
          bottom: TabBar(
            labelColor: p.primary,
            unselectedLabelColor: p.textMuted,
            indicatorColor: p.primary,
            tabs: const [Tab(text: 'Meetings'), Tab(text: 'Recordings')],
          ),
        ),
        body: TabBarView(
          children: [
            const _MeetingList(),
            if (!canViewRecordings)
              const NeoEmptyState(
                icon: Icons.lock_outline_rounded,
                title: 'No access to recordings',
                message: 'Recordings are available to the meeting owner, host '
                    'and co-hosts.',
              )
            else if (!listed)
              const NeoEmptyState(
                icon: Icons.videocam_off_rounded,
                title: 'Recordings are not in the app yet',
                message: 'Meetings you record are stored on your account. '
                    'Open neoconference.app on the web to watch or download '
                    'them.',
              )
            else
              const _RecordingList(),
          ],
        ),
      ),
    );
  }
}

class _MeetingList extends ConsumerWidget {
  const _MeetingList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final board = ref.watch(meetingBoardProvider);
    final now = ref.watch(nowProvider);

    return board.when(
      loading: () => ListView(
        padding: const EdgeInsets.all(NeoSpace.xl),
        children: const [
          NeoSkeleton(height: 76, radius: NeoRadius.lg),
          SizedBox(height: NeoSpace.md),
          NeoSkeleton(height: 76, radius: NeoRadius.lg),
          SizedBox(height: NeoSpace.md),
          NeoSkeleton(height: 76, radius: NeoRadius.lg),
        ],
      ),
      error: (e, _) => NeoEmptyState(
        icon: Icons.cloud_off_rounded,
        title: 'Could not load your meetings',
        message: '$e',
        action: FilledButton(
          onPressed: () => ref.invalidate(meetingBoardProvider),
          child: const Text('Try again'),
        ),
      ),
      data: (board) {
        final past = board.recent;
        if (past.isEmpty) {
          return const NeoEmptyState(
            icon: Icons.history_rounded,
            title: 'No past meetings',
            message: 'Meetings you have finished appear here.',
          );
        }
        return RefreshIndicator(
          onRefresh: () => ref.refresh(meetingBoardProvider.future),
          child: ListView.separated(
            padding: const EdgeInsets.all(NeoSpace.xl),
            itemCount: past.length,
            separatorBuilder: (_, _) => const SizedBox(height: NeoSpace.md),
            itemBuilder: (context, i) => _PastRow(meeting: past[i], now: now),
          ),
        );
      },
    );
  }
}

class _PastRow extends StatelessWidget {
  const _PastRow({required this.meeting, required this.now});

  final MeetingView meeting;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    final detail = <String>[
      if (meeting.startsAt case final at?) neoWhen(at, now: now),
      if (meeting.durationMinutes case final d?) '$d min',
      if (meeting.knownParticipants case final n?) '$n people',
      if (meeting.startsAt == null) meeting.code,
    ].join(' · ');

    return NeoCard(
      child: Row(
        children: [
          NeoAvatar(name: meeting.host ?? meeting.title, size: 42),
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
                  Text(
                    detail,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: text.bodySmall?.copyWith(color: p.textMuted),
                  ),
                ],
              ],
            ),
          ),
          if (meeting.hasRecording)
            Icon(Icons.play_circle_fill_rounded, color: p.primary),
        ],
      ),
    );
  }
}

class _RecordingList extends ConsumerWidget {
  const _RecordingList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final now = ref.watch(nowProvider);
    final board = ref.watch(meetingBoardProvider).valueOrNull;
    final recordings =
        board?.recent.where((m) => m.hasRecording).toList() ?? const [];

    if (recordings.isEmpty) {
      return const NeoEmptyState(
        icon: Icons.videocam_off_rounded,
        title: 'No recordings yet',
        message: 'Recordings you make or are given access to appear here.',
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.all(NeoSpace.xl),
      itemCount: recordings.length,
      separatorBuilder: (_, _) => const SizedBox(height: NeoSpace.md),
      itemBuilder: (context, i) {
        final m = recordings[i];
        return NeoCard(
          padding: EdgeInsets.zero,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AspectRatio(
                aspectRatio: 16 / 9,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    borderRadius: const BorderRadius.vertical(
                      top: Radius.circular(NeoRadius.lg),
                    ),
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [
                        p.primary.withValues(alpha: 0.25),
                        p.accent.withValues(alpha: 0.35),
                      ],
                    ),
                  ),
                  child: Center(
                    child: Icon(
                      Icons.play_circle_fill_rounded,
                      size: 46,
                      color: Colors.white.withValues(alpha: 0.92),
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(NeoSpace.lg),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(m.title, style: text.titleSmall),
                    const SizedBox(height: 2),
                    Text(
                      [
                        if (m.startsAt case final at?) neoWhen(at, now: now),
                        if (m.durationMinutes case final d?) '$d min',
                      ].join(' · '),
                      style: text.bodySmall?.copyWith(color: p.textMuted),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
