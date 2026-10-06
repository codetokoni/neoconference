import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/when.dart';
import 'group_meetings_api.dart';

/// Schedule a group meeting, or change one: the web's ScheduleDialog.
/// Returns the filled-in meeting; the caller sends it.
///
/// Repeating and extra guests are offered only when scheduling — the web's
/// edit changes one meeting (or it and the ones after it), not the series'
/// pattern or who was invited.
class ScheduleGroupMeetingScreen extends StatefulWidget {
  const ScheduleGroupMeetingScreen({super.key, required this.groupName, this.editing, this.timezone});

  final String groupName;

  /// The meeting being changed, or null to schedule a new one.
  final GroupMeeting? editing;

  /// The phone's timezone, to say what the times are in.
  final String? timezone;

  @override
  State<ScheduleGroupMeetingScreen> createState() => _ScheduleGroupMeetingScreenState();
}

class _ScheduleGroupMeetingScreenState extends State<ScheduleGroupMeetingScreen> {
  static const durations = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 420, 480];
  static const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  late final _title = TextEditingController(text: widget.editing?.title ?? '${widget.groupName} meeting');
  late final _description = TextEditingController(text: widget.editing?.description ?? '');
  final _password = TextEditingController();
  final _emails = TextEditingController();
  late DateTime _start = widget.editing?.start ?? _nextHalfHour(DateTime.now());
  late int _duration = widget.editing?.durationMin ?? 60;
  late bool _waitingRoom = widget.editing?.waitingRoom ?? true;
  bool _clearPassword = false;

  /// none | daily | weekly | monthly
  String _repeat = 'none';
  int _every = 1;
  late final Set<int> _weekdays = {_start.weekday % 7};

  /// Ends after [_count] meetings, or on [_until].
  bool _endByCount = true;
  int _count = 4;
  DateTime? _until;
  String? _error;

  bool get _editing => widget.editing != null;

  static DateTime _nextHalfHour(DateTime now) {
    final base = DateTime(now.year, now.month, now.day, now.hour, now.minute < 30 ? 30 : 0);
    return now.minute < 30 ? base : base.add(const Duration(hours: 1));
  }

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    _password.dispose();
    _emails.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final day = await showDatePicker(
      context: context,
      initialDate: _start.isBefore(now) ? now : _start,
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: now.add(const Duration(days: 365)),
    );
    if (day == null) return;
    setState(() => _start = DateTime(day.year, day.month, day.day, _start.hour, _start.minute));
  }

  Future<void> _pickTime() async {
    final t = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_start));
    if (t == null) return;
    setState(() => _start = DateTime(_start.year, _start.month, _start.day, t.hour, t.minute));
  }

  Future<void> _pickUntil() async {
    final day = await showDatePicker(
      context: context,
      initialDate: _until ?? _start.add(const Duration(days: 28)),
      firstDate: DateTime(_start.year, _start.month, _start.day),
      lastDate: _start.add(const Duration(days: 365)),
    );
    if (day != null) setState(() => _until = day);
  }

  void _done() {
    final title = _title.text.trim();
    if (title.isEmpty) return setState(() => _error = 'Give the meeting a title.');
    if (!_start.isAfter(DateTime.now())) return setState(() => _error = 'Choose a time in the future.');
    Recurrence? recurrence;
    if (!_editing && _repeat != 'none') {
      if (_repeat == 'weekly' && _weekdays.isEmpty) return setState(() => _error = 'Choose at least one day.');
      if (!_endByCount && _until == null) return setState(() => _error = 'Choose the last day.');
      recurrence = Recurrence(
        freq: _repeat,
        interval: _every,
        byWeekday: _repeat == 'weekly' ? (_weekdays.toList()..sort()) : const [],
        count: _endByCount ? _count : null,
        until: _endByCount ? null : _ymd(_until!),
      );
    }
    final typed = _password.text.trim();
    Navigator.pop(
      context,
      MeetingDraft(
        title: title,
        description: _description.text.trim(),
        start: _start,
        durationMin: _duration,
        // On an edit: blank keeps the password, "remove" clears it.
        password: _clearPassword ? '' : (typed.isEmpty ? (_editing ? null : '') : typed),
        waitingRoom: _waitingRoom,
        extraEmails: [
          for (final e in _emails.text.split(RegExp(r'[\s,;]+')))
            if (e.trim().isNotEmpty) e.trim(),
        ],
        recurrence: recurrence,
      ),
    );
  }

  static String _ymd(DateTime d) =>
      '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  static String _dayText(DateTime d) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${weekdayNames[d.weekday % 7]} ${d.day} ${months[d.month - 1]} ${d.year}';
  }

  static String _durationText(int m) =>
      m < 60 ? '$m min' : (m % 60 == 0 ? '${m ~/ 60} h' : '${m ~/ 60} h ${m % 60} min');

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final unit = switch (_repeat) { 'daily' => 'day', 'weekly' => 'week', _ => 'month' };
    final edit = widget.editing;
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(
        title: Text(_editing ? 'Change meeting' : 'Schedule a meeting'),
        actions: [TextButton(onPressed: _done, child: Text(_editing ? 'Save' : 'Schedule'))],
      ),
      body: ListView(
        padding: const EdgeInsets.all(NeoSpace.xl),
        children: [
          TextField(controller: _title, maxLength: 120, decoration: const InputDecoration(labelText: 'Title')),
          TextField(
            controller: _description,
            maxLength: 2000,
            minLines: 1,
            maxLines: 4,
            decoration: const InputDecoration(labelText: 'Description (optional)'),
          ),
          NeoSection(
            title: 'When',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _pickDate,
                        icon: const Icon(Icons.calendar_today_rounded, size: 18),
                        label: Text(_dayText(_start)),
                      ),
                    ),
                    const SizedBox(width: NeoSpace.sm),
                    OutlinedButton.icon(
                      onPressed: _pickTime,
                      icon: const Icon(Icons.schedule_rounded, size: 18),
                      label: Text(neoClock(_start)),
                    ),
                  ],
                ),
                const SizedBox(height: NeoSpace.sm),
                DropdownButtonFormField<int>(
                  initialValue: durations.contains(_duration) ? _duration : null,
                  decoration: const InputDecoration(labelText: 'Lasts'),
                  items: [for (final d in durations) DropdownMenuItem(value: d, child: Text(_durationText(d)))],
                  onChanged: (v) => setState(() => _duration = v ?? _duration),
                ),
                if (widget.timezone != null)
                  Padding(
                    padding: const EdgeInsets.only(top: NeoSpace.sm),
                    child: Text('Times are in ${widget.timezone}.', style: TextStyle(color: p.textMuted, fontSize: 13)),
                  ),
              ],
            ),
          ),
          if (!_editing)
            NeoSection(
              title: 'Repeat',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'none', label: Text('Once')),
                      ButtonSegment(value: 'daily', label: Text('Daily')),
                      ButtonSegment(value: 'weekly', label: Text('Weekly')),
                      ButtonSegment(value: 'monthly', label: Text('Monthly')),
                    ],
                    selected: {_repeat},
                    onSelectionChanged: (s) => setState(() => _repeat = s.first),
                  ),
                  if (_repeat != 'none') ...[
                    const SizedBox(height: NeoSpace.md),
                    DropdownButtonFormField<int>(
                      initialValue: _every,
                      decoration: const InputDecoration(labelText: 'Every'),
                      items: [
                        for (var i = 1; i <= 12; i++)
                          DropdownMenuItem(value: i, child: Text(i == 1 ? '1 $unit' : '$i ${unit}s')),
                      ],
                      onChanged: (v) => setState(() => _every = v ?? 1),
                    ),
                    if (_repeat == 'weekly') ...[
                      const SizedBox(height: NeoSpace.md),
                      Wrap(
                        spacing: NeoSpace.xs,
                        children: [
                          for (var d = 0; d < 7; d++)
                            FilterChip(
                              label: Text(weekdayNames[d]),
                              selected: _weekdays.contains(d),
                              onSelected: (on) => setState(() => on ? _weekdays.add(d) : _weekdays.remove(d)),
                            ),
                        ],
                      ),
                    ],
                    const SizedBox(height: NeoSpace.md),
                    RadioGroup<bool>(
                      groupValue: _endByCount,
                      onChanged: (v) => setState(() => _endByCount = v ?? true),
                      child: Column(
                        children: [
                          Row(
                            children: [
                              const Radio<bool>(value: true),
                              const Text('End after'),
                              const SizedBox(width: NeoSpace.sm),
                              DropdownButton<int>(
                                value: _count,
                                items: [for (var i = 1; i <= 52; i++) DropdownMenuItem(value: i, child: Text('$i'))],
                                onChanged: _endByCount ? (v) => setState(() => _count = v ?? 4) : null,
                              ),
                              const SizedBox(width: NeoSpace.sm),
                              const Text('meetings'),
                            ],
                          ),
                          Row(
                            children: [
                              const Radio<bool>(value: false),
                              const Text('End on'),
                              const SizedBox(width: NeoSpace.sm),
                              TextButton(
                                onPressed: _endByCount ? null : _pickUntil,
                                child: Text(_until == null ? 'Choose a day' : _dayText(_until!)),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    Text(
                      'At most 12 meetings are made, none more than 90 days after the first.',
                      style: TextStyle(color: p.textMuted, fontSize: 12),
                    ),
                  ],
                ],
              ),
            ),
          NeoSection(
            title: 'Entry',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _waitingRoom,
                  onChanged: (v) => setState(() => _waitingRoom = v),
                  title: const Text('Waiting room'),
                  subtitle: const Text("Group members go straight in; anyone else waits for a host."),
                ),
                TextField(
                  controller: _password,
                  enabled: !_clearPassword,
                  maxLength: 80,
                  decoration: InputDecoration(
                    labelText: 'Password (optional)',
                    helperText: edit?.hasPassword == true ? 'Leave blank to keep the current password.' : null,
                  ),
                ),
                if (edit?.hasPassword == true)
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _clearPassword,
                    onChanged: (v) => setState(() => _clearPassword = v ?? false),
                    title: const Text('Remove the password'),
                  ),
              ],
            ),
          ),
          if (!_editing)
            NeoSection(
              title: 'Also invite',
              child: TextField(
                controller: _emails,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                minLines: 1,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Email addresses (optional)',
                  helperText: 'People outside the group. Everyone in the group is invited anyway.',
                ),
              ),
            ),
          if (_error != null) Text(_error!, style: TextStyle(color: p.danger)),
          const SizedBox(height: NeoSpace.md),
          FilledButton(onPressed: _done, child: Text(_editing ? 'Save changes' : 'Schedule')),
        ],
      ),
    );
  }
}
