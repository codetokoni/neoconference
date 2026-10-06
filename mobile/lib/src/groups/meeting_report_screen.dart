import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/config.dart';
import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/when.dart';
import 'group_reports_api.dart';
import 'group_reports_tab.dart' show reportWhen, shareSpreadsheet;
import 'groups_api.dart';

/// One meeting's report: who was invited and who came, for how long, the
/// calls made, the recording and the AI summary; Export XLSX for Hosts and
/// the Owner. The web's MeetingReportView.
class MeetingReportScreen extends ConsumerStatefulWidget {
  const MeetingReportScreen({super.key, required this.groupId, required this.eventId, required this.canExport});

  final String groupId;
  final String eventId;
  final bool canExport;

  @override
  ConsumerState<MeetingReportScreen> createState() => _MeetingReportScreenState();
}

enum _Sort { status, name, joined, attended }

class _MeetingReportScreenState extends ConsumerState<MeetingReportScreen> {
  late Future<MeetingReport> _report = _load();
  _Sort _sort = _Sort.status;
  bool _exporting = false;

  GroupReportsApi get _api => GroupReportsApi(ref.read(groupsApiProvider).api);

  Future<MeetingReport> _load() => GroupReportsApi(ref.read(groupsApiProvider).api).report(widget.groupId, widget.eventId);

  Future<void> _export() async {
    setState(() => _exporting = true);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Preparing the spreadsheet…')));
    try {
      await shareSpreadsheet(await _api.reportXlsx(widget.groupId, widget.eventId));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(groupErrorText(e))));
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  List<ReportPerson> _sorted(List<ReportPerson> people) {
    final list = [...people];
    int byName(ReportPerson a, ReportPerson b) => a.name.toLowerCase().compareTo(b.name.toLowerCase());
    list.sort(switch (_sort) {
      _Sort.status => (a, b) => a.present == b.present ? byName(a, b) : (a.present ? -1 : 1),
      _Sort.name => byName,
      _Sort.joined => (a, b) => (a.joinedAt ?? DateTime(9999)).compareTo(b.joinedAt ?? DateTime(9999)),
      _Sort.attended => (a, b) => b.attendedMs.compareTo(a.attendedMs),
    });
    return list;
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(
        title: const Text('Meeting report'),
        actions: [
          if (widget.canExport)
            // The spreadsheet can take the server a while to build (15 s on
            // a cold start); a dimmed icon alone looked like nothing.
            _exporting
                ? const Padding(
                    padding: EdgeInsets.all(NeoSpace.lg),
                    child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                  )
                : IconButton(
                    tooltip: 'Export XLSX',
                    onPressed: _export,
                    icon: const Icon(Icons.table_view_rounded),
                  ),
        ],
      ),
      body: FutureBuilder<MeetingReport>(
        future: _report,
        builder: (context, snap) {
          if (snap.hasError) {
            return Padding(
              padding: const EdgeInsets.all(NeoSpace.xl),
              child: NeoBanner(
                icon: Icons.cloud_off_rounded,
                tone: NeoBannerTone.warning,
                message: groupLoadText(snap.error!),
                action: () => setState(() => _report = _load()),
                actionLabel: 'Retry',
              ),
            );
          }
          final r = snap.data;
          if (r == null) return const Center(child: CircularProgressIndicator());
          final started = r.actualStart ?? r.scheduledStart;
          return ListView(
            padding: const EdgeInsets.all(NeoSpace.xl),
            children: [
              Text(r.title, style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: NeoSpace.xs),
              Text(
                [r.groupName, if (started != null) reportWhen(started)].where((s) => s.isNotEmpty).join(' · '),
                style: TextStyle(color: p.textMuted),
              ),
              if (r.hosts.isNotEmpty) Text('Hosted by ${r.hosts.join(', ')}', style: TextStyle(color: p.textMuted)),
              if (r.scheduledStart != null && r.actualStart != null && r.scheduledStart != r.actualStart)
                Text(
                  'Scheduled ${neoClock(r.scheduledStart!)} · started ${neoClock(r.actualStart!)}',
                  style: TextStyle(color: p.textFaint, fontSize: 12),
                ),
              const SizedBox(height: NeoSpace.lg),
              GridView.count(
                crossAxisCount: 3,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                mainAxisSpacing: NeoSpace.sm,
                crossAxisSpacing: NeoSpace.sm,
                childAspectRatio: 1.3,
                children: [
                  _Stat('Invited', '${r.invited}'),
                  _Stat('Attended', '${r.attended}', color: p.success),
                  _Stat('Absent', '${r.absent}', color: r.absent > 0 ? p.warning : null),
                  _Stat('Duration', r.durationMin > 0 ? '${r.durationMin} min' : '—'),
                  _Stat('Call attempts', '${r.callAttempts}'),
                  _Stat('Missed calls', '${r.missedCalls}'),
                ],
              ),
              const SizedBox(height: NeoSpace.lg),
              Text('First to join: ${r.firstToJoin ?? '—'}', style: TextStyle(color: p.text)),
              Text('Last to leave: ${r.lastToLeave ?? '—'}', style: TextStyle(color: p.text)),
              const SizedBox(height: NeoSpace.sm),
              if (r.recordingUrl != null)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: () => launchUrl(Uri.parse('${Config.site}${r.recordingUrl}'), mode: LaunchMode.externalApplication),
                    icon: const Icon(Icons.play_circle_outline_rounded),
                    label: const Text('Watch the replay'),
                  ),
                )
              else
                Text(r.recorded ? 'Recorded; the replay is not open to watch.' : 'Not recorded.', style: TextStyle(color: p.textMuted)),
              if (r.aiSummary != null && r.aiSummary!.trim().isNotEmpty) ...[
                const SizedBox(height: NeoSpace.lg),
                NeoSection(title: 'Summary', child: NeoCard(child: Text(r.aiSummary!, style: TextStyle(color: p.text)))),
              ],
              NeoSection(
                title: 'Attendance',
                action: PopupMenuButton<_Sort>(
                  tooltip: 'Sort',
                  initialValue: _sort,
                  onSelected: (s) => setState(() => _sort = s),
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: _Sort.status, child: Text('Present first')),
                    PopupMenuItem(value: _Sort.name, child: Text('By name')),
                    PopupMenuItem(value: _Sort.joined, child: Text('By time joined')),
                    PopupMenuItem(value: _Sort.attended, child: Text('Longest attended')),
                  ],
                  icon: Icon(Icons.sort_rounded, color: p.textMuted),
                ),
                child: Column(
                  children: [for (final person in _sorted(r.people)) _PersonRow(person: person)],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value, {this.color});
  final String label;
  final String value;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return NeoCard(
      padding: const EdgeInsets.all(NeoSpace.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label.toUpperCase(), style: TextStyle(color: p.textFaint, fontSize: 10, letterSpacing: 0.8), maxLines: 1, overflow: TextOverflow.ellipsis),
          Text(value, style: TextStyle(color: color ?? p.text, fontSize: 20, fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}

class _PersonRow extends StatelessWidget {
  const _PersonRow({required this.person});
  final ReportPerson person;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final x = person;
    final status = x.present ? 'Present' : (x.declined ? 'Declined' : 'Absent');
    final details = [
      if (x.joinedAt != null) 'joined ${neoClock(x.joinedAt!)}',
      if (x.present) attendedText(x.attendedMs),
      if (x.entries > 1) '${x.entries} times',
      if (x.callAttempts > 0) '${x.callAttempts} rung · ${x.missedCalls} missed',
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: NeoSpace.xs),
      child: Row(
        children: [
          NeoAvatar(name: x.name, size: 32),
          const SizedBox(width: NeoSpace.sm),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(x.name.isEmpty ? x.email : x.name, style: TextStyle(color: p.text), maxLines: 1, overflow: TextOverflow.ellipsis),
                if (details.isNotEmpty) Text(details, style: TextStyle(color: p.textMuted, fontSize: 12)),
              ],
            ),
          ),
          NeoPill(status, color: x.present ? p.success : (x.declined ? p.danger : p.warning)),
        ],
      ),
    );
  }
}
