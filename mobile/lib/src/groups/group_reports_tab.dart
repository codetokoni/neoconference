import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/meeting_share.dart' show shareSheet;
import '../meetings/when.dart';
import 'group_models.dart';
import 'group_reports_api.dart';
import 'groups_api.dart';
import 'meeting_report_screen.dart';

/// Hands a spreadsheet to the phone's share menu (save to Files, Drive,
/// WhatsApp, email…). The bytes go as they came; nothing is kept here.
Future<void> shareSpreadsheet(({List<int> bytes, String filename, String mimeType}) file) => shareSheet(
      ShareParams(
        files: [XFile.fromData(Uint8List.fromList(file.bytes), mimeType: file.mimeType, name: file.filename)],
        fileNameOverrides: [file.filename],
        subject: file.filename,
      ),
    );

/// `Tue 6 Oct 2026, 21:38`.
String reportWhen(DateTime d) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${days[d.weekday - 1]} ${d.day} ${months[d.month - 1]} ${d.year}, ${neoClock(d)}';
}

/// A group's meeting reports, newest first, between two days if chosen;
/// Export XLSX for the range, for Hosts and the Owner. Mirrors the web's
/// ReportsTab.
class GroupReportsTab extends ConsumerStatefulWidget {
  const GroupReportsTab({super.key, required this.detail});

  final GroupDetail detail;

  @override
  ConsumerState<GroupReportsTab> createState() => _GroupReportsTabState();
}

class _GroupReportsTabState extends ConsumerState<GroupReportsTab> {
  DateTimeRange? _range;
  final _items = <ReportItem>[];
  int? _cursor;
  bool _done = false;
  bool _loading = false;
  bool _exporting = false;
  String? _error;
  int _generation = 0;

  GroupDetail get d => widget.detail;
  GroupReportsApi get _api => GroupReportsApi(ref.read(groupsApiProvider).api);

  @override
  void initState() {
    super.initState();
    _more();
  }

  Future<void> _more() async {
    if (_loading || _done) return;
    final generation = _generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      var cursor = _cursor;
      final got = <ReportItem>[];
      do {
        final page = await _api.list(d.group.id, from: _range?.start, to: _range?.end, cursor: cursor);
        got.addAll(page.items);
        cursor = page.nextCursor;
      } while (got.isEmpty && cursor != null);
      if (!mounted || generation != _generation) return;
      setState(() {
        _items.addAll(got);
        _cursor = cursor;
        _done = cursor == null;
      });
    } catch (e) {
      if (mounted && generation == _generation) setState(() => _error = groupLoadText(e));
    } finally {
      if (mounted && generation == _generation) setState(() => _loading = false);
    }
  }

  void _restart() {
    setState(() {
      _generation++;
      _items.clear();
      _cursor = null;
      _done = false;
      _loading = false;
    });
    _more();
  }

  Future<void> _pickRange() async {
    final now = DateTime.now();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 3),
      lastDate: now,
      initialDateRange: _range,
      helpText: 'Meetings between',
    );
    if (picked == null) return;
    setState(() => _range = picked);
    _restart();
  }

  Future<void> _export() async {
    final range = _range;
    if (range == null) return;
    setState(() => _exporting = true);
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Preparing the spreadsheet…')));
    try {
      await shareSpreadsheet(await _api.rangeXlsx(d.group.id, range.start, range.end));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(groupErrorText(e))));
      }
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final range = _range;
    return ListView(
      padding: const EdgeInsets.all(NeoSpace.xl),
      children: [
        Wrap(
          spacing: NeoSpace.sm,
          runSpacing: NeoSpace.sm,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            OutlinedButton.icon(
              onPressed: _pickRange,
              icon: const Icon(Icons.date_range_rounded, size: 18),
              label: Text(range == null ? 'All dates' : '${reportDay(range.start)} – ${reportDay(range.end)}'),
            ),
            if (range != null)
              TextButton(
                onPressed: () {
                  setState(() => _range = null);
                  _restart();
                },
                child: const Text('Clear'),
              ),
            if (range != null && d.capabilities.exportReports)
              FilledButton.icon(
                onPressed: _exporting ? null : _export,
                icon: const Icon(Icons.table_view_rounded, size: 18),
                label: Text(_exporting ? 'Exporting…' : 'Export XLSX'),
              ),
          ],
        ),
        if (range == null && d.capabilities.exportReports)
          Padding(
            padding: const EdgeInsets.only(top: NeoSpace.xs),
            child: Text('Choose dates to export them as a spreadsheet.', style: TextStyle(color: p.textMuted, fontSize: 12)),
          ),
        const SizedBox(height: NeoSpace.lg),
        for (final r in _items)
          Padding(
            padding: const EdgeInsets.only(bottom: NeoSpace.sm),
            child: NeoCard(
              onTap: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => MeetingReportScreen(groupId: d.group.id, eventId: r.eventId, canExport: d.capabilities.exportReports),
              )),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(r.title, style: Theme.of(context).textTheme.titleSmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                        const SizedBox(height: 2),
                        Text(
                          [
                            if (r.date != null) reportWhen(r.date!),
                            '${r.durationMin} min',
                            if (r.kind == 'call') 'private call',
                          ].join(' · '),
                          style: TextStyle(color: p.textMuted, fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text('${r.attended}/${r.invited}', style: TextStyle(color: p.success, fontWeight: FontWeight.w700)),
                      Text('attended', style: TextStyle(color: p.textFaint, fontSize: 11)),
                    ],
                  ),
                  Icon(Icons.chevron_right_rounded, color: p.textFaint),
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
          NeoCard(
            child: Text(
              range == null ? 'No finished meetings yet.' : 'No meetings between those days.',
              style: TextStyle(color: p.textMuted),
            ),
          ),
      ],
    );
  }
}
