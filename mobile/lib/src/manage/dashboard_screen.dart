import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/load_error.dart';
import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../events/event.dart';
import 'manage_api.dart';
import 'manage_screen.dart';

/// Every recording the signed-in person made, newest first.
final myRecordingsProvider = FutureProvider.autoDispose<List<MeetingRecording>>((ref) async {
  final list = await ManageApi(ref.watch(apiProvider)).recordings();
  return [...list]..sort((a, b) => (b.recordedAt ?? DateTime(0)).compareTo(a.recordedAt ?? DateTime(0)));
});

/// The numbers that matter for someone's meetings, as the web dashboard
/// leads with them: how many, what is live, what was recorded and what has
/// a transcript. Then the meetings live now and the latest recordings.
class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final events = ref.watch(eventsProvider);
    final recordings = ref.watch(myRecordingsProvider);

    final all = events.valueOrNull ?? const <NeoEvent>[];
    final live = all.where((e) => e.state == 'live' || e.state == 'waiting').toList();
    final recs = recordings.valueOrNull;
    final names = {for (final e in all) e.slug: e.name};

    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(eventsProvider);
            ref.invalidate(myRecordingsProvider);
            await Future.wait([
              ref.read(eventsProvider.future).then((_) {}, onError: (_) {}),
              ref.read(myRecordingsProvider.future).then((_) {}, onError: (_) {}),
            ]);
          },
          child: ListView(
            padding: const EdgeInsets.all(NeoSpace.xl),
            children: [
              Text('Dashboard', style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: NeoSpace.lg),
              if (events.hasError)
                Padding(
                  padding: const EdgeInsets.only(bottom: NeoSpace.lg),
                  child: NeoBanner(
                    icon: Icons.cloud_off_rounded,
                    tone: NeoBannerTone.warning,
                    message: describeLoadError(events.error!),
                    action: () => ref.invalidate(eventsProvider),
                    actionLabel: 'Retry',
                  ),
                ),
              GridView.count(
                crossAxisCount: 2,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: NeoSpace.md,
                crossAxisSpacing: NeoSpace.md,
                childAspectRatio: 1.6,
                children: [
                  DashboardStat(
                    label: 'Meetings',
                    value: events.hasValue ? '${all.length}' : null,
                    icon: Icons.event_rounded,
                    color: p.spectrumAt(0) ?? p.primary,
                  ),
                  DashboardStat(
                    label: 'Live now',
                    value: events.hasValue ? '${live.length}' : null,
                    icon: Icons.sensors_rounded,
                    color: p.spectrumAt(3) ?? p.success,
                  ),
                  DashboardStat(
                    label: 'Recordings',
                    value: recs == null ? (recordings.hasError ? '—' : null) : '${recs.length}',
                    icon: Icons.videocam_rounded,
                    color: p.spectrumAt(5) ?? p.info,
                  ),
                  DashboardStat(
                    label: 'Transcripts',
                    value: recs == null
                        ? (recordings.hasError ? '—' : null)
                        : '${recs.where((r) => r.transcribed).length}',
                    icon: Icons.subtitles_rounded,
                    color: p.spectrumAt(6) ?? p.accent,
                  ),
                ],
              ),
              NeoSection(
                title: 'Live now',
                child: !events.hasValue
                    ? const NeoSkeleton(height: 64)
                    : live.isEmpty
                        ? NeoCard(child: Text('None of your meetings is live.', style: TextStyle(color: p.textMuted)))
                        : Column(
                            children: [
                              for (final e in live)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: NeoSpace.sm),
                                  child: NeoCard(
                                    onTap: () => _manage(context, e.slug, e.name),
                                    child: Row(
                                      children: [
                                        Expanded(child: Text(e.name, style: Theme.of(context).textTheme.titleSmall)),
                                        NeoPill('Live', color: p.success, dot: true),
                                        Icon(Icons.chevron_right_rounded, color: p.textFaint),
                                      ],
                                    ),
                                  ),
                                ),
                            ],
                          ),
              ),
              NeoSection(
                title: 'Recent recordings',
                child: recordings.hasError
                    ? NeoCard(child: Text(describeLoadError(recordings.error!), style: TextStyle(color: p.warning)))
                    : recs == null
                        ? const NeoSkeleton(height: 96)
                        : recs.isEmpty
                            ? NeoCard(child: Text('No recordings yet.', style: TextStyle(color: p.textMuted)))
                            : Column(
                                children: [
                                  for (final r in recs.take(5))
                                    Padding(
                                      padding: const EdgeInsets.only(bottom: NeoSpace.sm),
                                      child: GestureDetector(
                                        onTap: r.slug == null ? null : () => _manage(context, r.slug!, names[r.slug]),
                                        child: RecordingTile(
                                          recording: r,
                                          meetingLabel: names[r.slug] ?? r.slug,
                                          onTranscribe: () => _transcribe(context, ref, r),
                                        ),
                                      ),
                                    ),
                                ],
                              ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _manage(BuildContext context, String slug, String? title) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ManageMeetingScreen(slug: slug, title: title),
    ));
  }

  Future<void> _transcribe(BuildContext context, WidgetRef ref, MeetingRecording r) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ManageApi(ref.read(apiProvider)).transcribe(r.key);
      messenger.showSnackBar(const SnackBar(content: Text('Transcribing — it will show here when done.')));
      ref.invalidate(myRecordingsProvider);
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(describeLoadError(e))));
    }
  }
}

/// One number on the dashboard. A null [value] is still loading.
class DashboardStat extends StatelessWidget {
  const DashboardStat({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  final String label;
  final String? value;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return NeoCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: color),
              const SizedBox(width: NeoSpace.xs),
              Flexible(child: Text(label, style: TextStyle(color: p.textMuted), overflow: TextOverflow.ellipsis)),
            ],
          ),
          value == null
              ? const NeoSkeleton(height: 28, width: 48)
              : Text(value!, style: Theme.of(context).textTheme.headlineMedium?.copyWith(color: p.text)),
        ],
      ),
    );
  }
}
