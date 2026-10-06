import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/when.dart';
import 'group_reports_api.dart';
import 'group_reports_tab.dart' show reportWhen;
import 'groups_api.dart';

/// Your own attendance at your groups' meetings, newest first — the web's
/// "My meeting reports" (/dashboard/reports). Only your own row of each;
/// meetings of groups you have since left are still here.
class MyMeetingsScreen extends ConsumerStatefulWidget {
  const MyMeetingsScreen({super.key});

  @override
  ConsumerState<MyMeetingsScreen> createState() => _MyMeetingsScreenState();
}

class _MyMeetingsScreenState extends ConsumerState<MyMeetingsScreen> {
  final _items = <MyMeeting>[];
  int? _cursor;
  bool _done = false;
  bool _loading = false;
  String? _error;

  GroupReportsApi get _api => GroupReportsApi(ref.read(groupsApiProvider).api);

  @override
  void initState() {
    super.initState();
    _more();
  }

  Future<void> _more() async {
    if (_loading || _done) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      var cursor = _cursor;
      final got = <MyMeeting>[];
      do {
        final page = await _api.mine(cursor: cursor);
        got.addAll(page.items);
        cursor = page.nextCursor;
      } while (got.isEmpty && cursor != null);
      if (!mounted) return;
      setState(() {
        _items.addAll(got);
        _cursor = cursor;
        _done = cursor == null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = groupLoadText(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: const Text('My meeting reports')),
      body: ListView(
        padding: const EdgeInsets.all(NeoSpace.xl),
        children: [
          for (final m in _items)
            Padding(
              padding: const EdgeInsets.only(bottom: NeoSpace.sm),
              child: NeoCard(
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => MyMeetingScreen(eventId: m.eventId, title: m.title))),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(m.title, style: Theme.of(context).textTheme.titleSmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                          const SizedBox(height: 2),
                          Text(
                            [m.groupName, if (m.date != null) reportWhen(m.date!)].where((s) => s.isNotEmpty).join(' · '),
                            style: TextStyle(color: p.textMuted, fontSize: 13),
                          ),
                        ],
                      ),
                    ),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        NeoPill(
                          m.present ? 'Present' : (m.declined ? 'Declined' : 'Absent'),
                          color: m.present ? p.success : (m.declined ? p.danger : p.warning),
                        ),
                        if (m.present) ...[
                          const SizedBox(height: 2),
                          Text(attendedText(m.attendedMs), style: TextStyle(color: p.textFaint, fontSize: 11)),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ),
          if (_error != null) Text(_error!, style: TextStyle(color: p.warning)),
          if (_loading)
            const NeoSkeleton(height: 64)
          else if (!_done)
            TextButton(onPressed: _more, child: const Text('Load more'))
          else if (_items.isEmpty)
            const NeoEmptyState(
              icon: Icons.assignment_outlined,
              title: 'No reports yet',
              message: 'Your attendance shows here after your groups\' meetings end.',
            ),
        ],
      ),
    );
  }
}

/// Your own part in one meeting.
class MyMeetingScreen extends ConsumerWidget {
  const MyMeetingScreen({super.key, required this.eventId, required this.title});

  final String eventId;
  final String title;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis)),
      body: Builder(
        builder: (context) {
          final snap = ref.watch(myMeetingProvider(eventId));
          if (snap.hasError) {
            return Padding(
              padding: const EdgeInsets.all(NeoSpace.xl),
              child: NeoBanner(icon: Icons.cloud_off_rounded, tone: NeoBannerTone.warning, message: groupLoadText(snap.error!), action: () => ref.invalidate(myMeetingProvider(eventId)), actionLabel: 'Retry'),
            );
          }
          final d = snap.valueOrNull;
          if (d == null) return const Center(child: CircularProgressIndicator());
          final me = d.me;
          Widget line(String label, String value) => Padding(
                padding: const EdgeInsets.symmetric(vertical: NeoSpace.xs),
                child: Row(
                  children: [
                    Expanded(child: Text(label, style: TextStyle(color: p.textMuted))),
                    Text(value, style: TextStyle(color: p.text, fontWeight: FontWeight.w600)),
                  ],
                ),
              );
          return ListView(
            padding: const EdgeInsets.all(NeoSpace.xl),
            children: [
              Text(d.meeting.title, style: Theme.of(context).textTheme.headlineSmall),
              Text(
                [d.meeting.groupName, if (d.meeting.date != null) reportWhen(d.meeting.date!)].where((s) => s.isNotEmpty).join(' · '),
                style: TextStyle(color: p.textMuted),
              ),
              if (d.hosts.isNotEmpty) Text('Hosted by ${d.hosts.join(', ')}', style: TextStyle(color: p.textMuted)),
              const SizedBox(height: NeoSpace.lg),
              NeoCard(
                child: Column(
                  children: [
                    line('You were', me.present ? 'Present' : (me.declined ? 'Declined' : 'Absent')),
                    line('Joined', me.joinedAt == null ? '—' : neoClock(me.joinedAt!)),
                    line('Left', me.leftAt == null ? '—' : neoClock(me.leftAt!)),
                    line('Time in the meeting', attendedText(me.attendedMs)),
                    line('Times you joined', '${me.entries}'),
                    line('Calls to you', me.callAttempts == 0 ? '—' : '${me.callAttempts} · ${me.missedCalls} missed'),
                    line('Meeting length', d.meeting.durationMin > 0 ? '${d.meeting.durationMin} min' : '—'),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

/// Your part in one meeting, fetched once while its screen is open.
final myMeetingProvider = FutureProvider.autoDispose.family<MyMeetingDetail, String>(
  (ref, eventId) => GroupReportsApi(ref.watch(groupsApiProvider).api).myMeeting(eventId),
);
