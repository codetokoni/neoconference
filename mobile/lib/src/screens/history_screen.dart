import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../mock/sample_data.dart';
import 'meeting_sheets.dart';

/// Past meetings, and the recordings this account is allowed to see.
///
/// Recordings are not shown by row unless one exists and the viewer may
/// have it: an inert "Recording" label on a meeting nobody can replay is
/// worse than silence.
class HistoryScreen extends StatelessWidget {
  const HistoryScreen({super.key, this.canViewRecordings = true});

  final bool canViewRecordings;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);

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
            _MeetingList(),
            canViewRecordings
                ? _RecordingList()
                : const NeoEmptyState(
                    icon: Icons.lock_outline_rounded,
                    title: 'No access to recordings',
                    message:
                        'Recordings are available to the meeting owner, host '
                        'and co-hosts.',
                  ),
          ],
        ),
      ),
    );
  }
}

class _MeetingList extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return ListView.separated(
      padding: const EdgeInsets.all(NeoSpace.xl),
      itemCount: sampleRecent.length,
      separatorBuilder: (_, _) => const SizedBox(height: NeoSpace.md),
      itemBuilder: (context, i) {
        final m = sampleRecent[i];
        return NeoCard(
          onTap: () => neoSheet(
            context,
            builder: (_) => MeetingDetailsSheet(meeting: m),
          ),
          child: Row(
            children: [
              NeoAvatar(name: m.host, size: 42),
              const SizedBox(width: NeoSpace.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      m.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: text.titleSmall,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${sampleWhen(m.startsAt)} · ${m.durationMinutes} min '
                      '· ${m.participants.length} people',
                      style: text.bodySmall?.copyWith(color: p.textMuted),
                    ),
                  ],
                ),
              ),
              if (m.hasRecording)
                Icon(Icons.play_circle_fill_rounded, color: p.primary),
            ],
          ),
        );
      },
    );
  }
}

class _RecordingList extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final recordings = sampleRecent.where((m) => m.hasRecording).toList();

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
          onTap: () {},
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
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(m.title, style: text.titleSmall),
                          const SizedBox(height: 2),
                          Text(
                            '${sampleWhen(m.startsAt)} · '
                            '${m.durationMinutes} min',
                            style:
                                text.bodySmall?.copyWith(color: p.textMuted),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'Download',
                      icon: const Icon(Icons.download_rounded),
                      onPressed: () {},
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
