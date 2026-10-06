import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/when.dart';
import 'group_join.dart';
import 'group_meetings_api.dart';
import 'group_models.dart';
import 'groups_api.dart';
import 'schedule_group_meeting_screen.dart';

/// Start a meeting now, schedule one, or call some members — each shown
/// only to someone whose role allows it, as the web's GroupActions.
class GroupMeetingActions extends ConsumerStatefulWidget {
  const GroupMeetingActions({super.key, required this.detail});

  final GroupDetail detail;

  @override
  ConsumerState<GroupMeetingActions> createState() => _GroupMeetingActionsState();
}

class _GroupMeetingActionsState extends ConsumerState<GroupMeetingActions> {
  bool _busy = false;

  GroupDetail get d => widget.detail;

  void _say(String text) => ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text)));

  void _refresh() {
    ref.invalidate(upcomingMeetingsProvider(d.group.id));
    ref.invalidate(groupDetailProvider(d.group.id));
  }

  Future<void> _start() async {
    final title = '${d.group.name} meeting';
    setState(() => _busy = true);
    try {
      final slug = await ref.read(groupMeetingsApiProvider).startNow(d.group.id, title);
      _refresh();
      if (mounted) await joinGroupMeeting(context, slug: slug, title: title, straightIn: true);
    } catch (e) {
      _say(groupErrorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _schedule() async {
    final tz = await deviceTimezone();
    if (!mounted) return;
    final draft = await Navigator.of(context).push<MeetingDraft>(
      MaterialPageRoute(builder: (_) => ScheduleGroupMeetingScreen(groupName: d.group.name, timezone: tz)),
    );
    if (draft == null) return;
    setState(() => _busy = true);
    try {
      await ref.read(groupMeetingsApiProvider).schedule(d.group.id, draft);
      _say(draft.recurrence == null ? 'Scheduled. Everyone in the group is invited.' : 'Scheduled the meetings. Everyone in the group is invited.');
      _refresh();
    } catch (e) {
      _say(groupErrorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _call() async {
    final others = [for (final m in d.members) if (m.userId != d.myUserId) m];
    if (others.isEmpty) {
      _say('Add people to the group first.');
      return;
    }
    final chosen = await showDialog<List<String>>(context: context, builder: (_) => MemberPickerDialog(members: others));
    if (chosen == null || chosen.isEmpty) return;
    setState(() => _busy = true);
    try {
      final slug = await ref.read(groupMeetingsApiProvider).call(d.group.id, chosen);
      _refresh();
      if (mounted) await joinGroupMeeting(context, slug: slug, title: 'Call · ${d.group.name}', straightIn: true);
    } catch (e) {
      _say(groupErrorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final caps = d.capabilities;
    if (!caps.start && !caps.schedule && !caps.call) return const SizedBox.shrink();
    return Wrap(
      spacing: NeoSpace.sm,
      runSpacing: NeoSpace.sm,
      children: [
        if (caps.start)
          FilledButton.icon(
            onPressed: _busy ? null : _start,
            icon: const Icon(Icons.videocam_rounded, size: 18),
            label: const Text('Start meeting'),
          ),
        if (caps.schedule)
          OutlinedButton.icon(
            onPressed: _busy ? null : _schedule,
            icon: const Icon(Icons.event_rounded, size: 18),
            label: const Text('Schedule'),
          ),
        if (caps.call)
          OutlinedButton.icon(
            onPressed: _busy ? null : _call,
            icon: const Icon(Icons.call_rounded, size: 18),
            label: const Text('Call'),
          ),
      ],
    );
  }
}

/// Choose who to call. Returns their user ids.
class MemberPickerDialog extends StatefulWidget {
  const MemberPickerDialog({super.key, required this.members});

  final List<GroupMember> members;

  @override
  State<MemberPickerDialog> createState() => _MemberPickerDialogState();
}

class _MemberPickerDialogState extends State<MemberPickerDialog> {
  final _chosen = <String>{};
  String _filter = '';

  @override
  Widget build(BuildContext context) {
    final q = _filter.toLowerCase();
    final shown = [
      for (final m in widget.members)
        if (q.isEmpty || m.displayName.toLowerCase().contains(q) || (m.email ?? '').toLowerCase().contains(q)) m,
    ];
    return AlertDialog(
      title: const Text('Call members'),
      content: SizedBox(
        width: double.maxFinite,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (widget.members.length > 6)
              TextField(
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search_rounded), hintText: 'Find someone'),
                onChanged: (v) => setState(() => _filter = v.trim()),
              ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                children: [
                  for (final m in shown)
                    CheckboxListTile(
                      contentPadding: EdgeInsets.zero,
                      value: _chosen.contains(m.userId),
                      onChanged: (on) => setState(() => on == true ? _chosen.add(m.userId) : _chosen.remove(m.userId)),
                      secondary: NeoAvatar(name: m.displayName, size: 32),
                      title: Text(m.displayName, maxLines: 1, overflow: TextOverflow.ellipsis),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: _chosen.isEmpty ? null : () => Navigator.pop(context, _chosen.toList()),
          child: Text(_chosen.isEmpty ? 'Call' : 'Call ${_chosen.length}'),
        ),
      ],
    );
  }
}

/// Live meetings, then coming up, then past ones a page at a time.
class GroupMeetingsTab extends ConsumerStatefulWidget {
  const GroupMeetingsTab({super.key, required this.detail, this.onOpenReport});

  final GroupDetail detail;

  /// Opens a past meeting's report, for those who may see reports.
  final void Function(GroupMeeting meeting)? onOpenReport;

  @override
  ConsumerState<GroupMeetingsTab> createState() => _GroupMeetingsTabState();
}

class _GroupMeetingsTabState extends ConsumerState<GroupMeetingsTab> {
  final _past = <GroupMeeting>[];
  int? _pastCursor;
  bool _pastDone = false;
  bool _pastLoading = false;
  String? _pastError;

  GroupDetail get d => widget.detail;
  GroupMeetingsApi get _api => ref.read(groupMeetingsApiProvider);

  @override
  void initState() {
    super.initState();
    _loadPast();
  }

  void _say(String text) => ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text)));

  /// Which load of the past list is current; a reload makes any page still
  /// on its way stale.
  int _generation = 0;

  Future<void> _loadPast() async {
    if (_pastLoading || _pastDone) return;
    final generation = _generation;
    setState(() {
      _pastLoading = true;
      _pastError = null;
    });
    try {
      // A page can come back short with more after it: keep going until
      // there is something to show or nothing more.
      var cursor = _pastCursor;
      final got = <GroupMeeting>[];
      do {
        final page = await _api.list(d.group.id, past: true, cursor: cursor);
        got.addAll(page.items);
        cursor = page.nextCursor;
      } while (got.isEmpty && cursor != null);
      if (!mounted || generation != _generation) return;
      setState(() {
        _past.addAll(got);
        _pastCursor = cursor;
        _pastDone = cursor == null;
      });
    } catch (e) {
      if (mounted && generation == _generation) setState(() => _pastError = groupLoadText(e));
    } finally {
      if (mounted && generation == _generation) setState(() => _pastLoading = false);
    }
  }

  /// Starts the past list over from its first page.
  void _reloadPast() {
    setState(() {
      _generation++;
      _past.clear();
      _pastCursor = null;
      _pastDone = false;
      _pastLoading = false;
      _pastError = null;
    });
    _loadPast();
  }

  /// "This meeting" or "this and the following ones", for one of a series.
  Future<bool?> _askScope(String verb) => showDialog<bool>(
        context: context,
        builder: (context) => SimpleDialog(
          title: Text('$verb which meetings?'),
          children: [
            SimpleDialogOption(onPressed: () => Navigator.pop(context, false), child: const Text('This meeting')),
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('This and the following ones'),
            ),
          ],
        ),
      );

  Future<void> _edit(GroupMeeting m) async {
    final following = m.repeats ? await _askScope('Change') : false;
    if (following == null || !mounted) return;
    final tz = await deviceTimezone();
    if (!mounted) return;
    final draft = await Navigator.of(context).push<MeetingDraft>(MaterialPageRoute(
      builder: (_) => ScheduleGroupMeetingScreen(groupName: d.group.name, editing: m, timezone: tz),
    ));
    if (draft == null) return;
    try {
      await _api.update(d.group.id, m.id, draft, following: following);
      _say('Changed. Everyone invited has been told.');
      ref.invalidate(upcomingMeetingsProvider(d.group.id));
    } catch (e) {
      _say(groupErrorText(e));
    }
  }

  Future<void> _cancel(GroupMeeting m) async {
    bool? following = false;
    if (m.repeats) {
      following = await _askScope('Cancel');
    } else {
      final p = NeoTheme.of(context);
      final ok = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text('Cancel "${m.title}"?'),
          content: const Text('Everyone invited is told it is off.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Keep it')),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text('Cancel meeting', style: TextStyle(color: p.danger)),
            ),
          ],
        ),
      );
      if (ok != true) following = null;
    }
    if (following == null) return;
    try {
      await _api.cancel(d.group.id, m.id, following: following);
      _say('Cancelled. Everyone invited has been told.');
      ref.invalidate(upcomingMeetingsProvider(d.group.id));
      ref.invalidate(groupDetailProvider(d.group.id));
    } catch (e) {
      _say(groupErrorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    ref.listen(groupRevisionProvider(d.group.id), (_, _) => _reloadPast());
    final upcoming = ref.watch(upcomingMeetingsProvider(d.group.id));
    final list = upcoming.valueOrNull;
    final live = [for (final m in list ?? const <GroupMeeting>[]) if (m.isLive) m];
    final next = [for (final m in list ?? const <GroupMeeting>[]) if (!m.isLive) m];
    final now = DateTime.now();

    return ListView(
      padding: const EdgeInsets.all(NeoSpace.xl),
      children: [
        GroupMeetingActions(detail: d),
        const SizedBox(height: NeoSpace.lg),
        if (upcoming.hasError && list == null)
          NeoBanner(
            icon: Icons.cloud_off_rounded,
            tone: NeoBannerTone.warning,
            message: groupLoadText(upcoming.error!),
            action: () => ref.invalidate(upcomingMeetingsProvider(d.group.id)),
            actionLabel: 'Retry',
          )
        else if (list == null)
          const NeoSkeleton(height: 72)
        else ...[
          if (live.isNotEmpty)
            NeoSection(
              title: 'Live now',
              child: Column(children: [for (final m in live) _MeetingCard(meeting: m, now: now)]),
            ),
          NeoSection(
            title: 'Coming up',
            child: next.isEmpty
                ? NeoCard(child: Text('Nothing scheduled.', style: TextStyle(color: p.textMuted)))
                : Column(
                    children: [
                      for (final m in next)
                        _MeetingCard(
                          meeting: m,
                          now: now,
                          onEdit: d.capabilities.schedule && m.editable ? () => _edit(m) : null,
                          onCancel: d.capabilities.schedule && m.editable ? () => _cancel(m) : null,
                        ),
                    ],
                  ),
          ),
        ],
        NeoSection(
          title: 'Past',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final m in _past)
                _MeetingCard(
                  meeting: m,
                  now: now,
                  past: true,
                  onTap: widget.onOpenReport != null && d.capabilities.viewReports ? () => widget.onOpenReport!(m) : null,
                ),
              if (_pastError != null) Text(_pastError!, style: TextStyle(color: p.warning)),
              if (_pastLoading)
                const NeoSkeleton(height: 56)
              else if (!_pastDone)
                TextButton(onPressed: _loadPast, child: const Text('Load more'))
              else if (_past.isEmpty)
                NeoCard(child: Text('No meetings yet.', style: TextStyle(color: p.textMuted))),
            ],
          ),
        ),
      ],
    );
  }
}

class _MeetingCard extends StatelessWidget {
  const _MeetingCard({
    required this.meeting,
    required this.now,
    this.past = false,
    this.onEdit,
    this.onCancel,
    this.onTap,
  });

  final GroupMeeting meeting;
  final DateTime now;
  final bool past;
  final VoidCallback? onEdit;
  final VoidCallback? onCancel;
  final VoidCallback? onTap;

  static String _when(DateTime d) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${days[d.weekday - 1]} ${d.day} ${months[d.month - 1]}, ${neoClock(d)}';
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final m = meeting;
    final kind = m.isCall ? 'Private call' : 'Group meeting';
    final line = past
        ? [
            if (m.start != null) _when(m.start!),
            '${m.durationMin} min',
            '${m.attendedCount ?? 0} / ${m.invitedCount} attended',
          ].join(' · ')
        : m.isLive
            ? '$kind · ${m.invitedCount} invited'
            : [
                if (m.start != null) '${_when(m.start!)} (${neoWhen(m.start!, now: now)})',
                '${m.durationMin} min',
                '${m.invitedCount} invited',
                if (m.repeats) 'repeats',
              ].join(' · ');
    return Padding(
      padding: const EdgeInsets.only(bottom: NeoSpace.sm),
      child: NeoCard(
        highlighted: m.isLive,
        onTap: onTap,
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      if (m.isLive) ...[NeoPill('Live', color: p.success, dot: true), const SizedBox(width: NeoSpace.sm)],
                      Expanded(
                        child: Text(m.title, style: Theme.of(context).textTheme.titleSmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(line, style: TextStyle(color: p.textMuted, fontSize: 13)),
                ],
              ),
            ),
            if (!past && m.joinableAt(now))
              Padding(
                padding: const EdgeInsets.only(left: NeoSpace.sm),
                child: FilledButton(
                  onPressed: () => joinGroupMeeting(context, slug: m.slug, title: m.title),
                  child: const Text('Join'),
                ),
              ),
            if (onEdit != null || onCancel != null)
              PopupMenuButton<String>(
                tooltip: 'Change ${m.title}',
                icon: Icon(Icons.more_vert_rounded, color: p.textMuted),
                onSelected: (v) => v == 'edit' ? onEdit?.call() : onCancel?.call(),
                itemBuilder: (_) => [
                  if (onEdit != null) const PopupMenuItem(value: 'edit', child: Text('Change')),
                  if (onCancel != null)
                    PopupMenuItem(value: 'cancel', child: Text('Cancel meeting', style: TextStyle(color: p.danger))),
                ],
              ),
            if (past && onTap != null) Icon(Icons.chevron_right_rounded, color: p.textFaint),
          ],
        ),
      ),
    );
  }
}
