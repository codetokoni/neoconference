import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../events/languages.dart';
import '../mock/sample_data.dart';

/// Scheduling a meeting.
///
/// Grouped so the required part is answerable in seconds and everything
/// optional is below it. Defaults are the safe ones: unlisted rather than
/// public, wait-for-host on.
class ScheduleScreen extends StatefulWidget {
  const ScheduleScreen({super.key});

  @override
  State<ScheduleScreen> createState() => _ScheduleScreenState();
}

class _ScheduleScreenState extends State<ScheduleScreen> {
  final _title = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  DateTime _date = sampleNow.add(const Duration(days: 1));
  TimeOfDay _time = const TimeOfDay(hour: 10, minute: 0);
  int _durationMinutes = 45;
  String _visibility = 'unlisted';
  bool _waitingRoom = false;
  bool _waitForHost = true;
  bool _record = false;
  final _languages = <String>{};
  final _invited = <String>['Marcus Feldman', 'Priya Raghunathan'];

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(
        title: const Text('Schedule'),
        leading: IconButton(
          icon: const Icon(Icons.close_rounded),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(
            NeoSpace.xl,
            NeoSpace.sm,
            NeoSpace.xl,
            NeoSpace.huge,
          ),
          children: [
            TextFormField(
              controller: _title,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'Meeting name',
                hintText: 'Product sync — Q4 roadmap',
              ),
              validator: (v) =>
                  (v ?? '').trim().isEmpty ? 'Give the meeting a name' : null,
            ),
            const SizedBox(height: NeoSpace.xl),

            NeoSection(
              title: 'When',
              child: Column(
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: _Field(
                          icon: Icons.calendar_today_rounded,
                          label: 'Date',
                          value: '${_date.day}/${_date.month}/${_date.year}',
                          onTap: _pickDate,
                        ),
                      ),
                      const SizedBox(width: NeoSpace.md),
                      Expanded(
                        child: _Field(
                          icon: Icons.schedule_rounded,
                          label: 'Time',
                          value: _time.format(context),
                          onTap: _pickTime,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: NeoSpace.md),
                  SegmentedButton<int>(
                    segments: const [
                      ButtonSegment(value: 15, label: Text('15m')),
                      ButtonSegment(value: 30, label: Text('30m')),
                      ButtonSegment(value: 45, label: Text('45m')),
                      ButtonSegment(value: 60, label: Text('1h')),
                    ],
                    selected: {_durationMinutes},
                    onSelectionChanged: (s) =>
                        setState(() => _durationMinutes = s.first),
                  ),
                ],
              ),
            ),

            NeoSection(
              title: 'Participants',
              action: TextButton.icon(
                onPressed: _addParticipant,
                icon: const Icon(Icons.person_add_alt_rounded, size: 16),
                label: const Text('Add'),
              ),
              child: Wrap(
                spacing: NeoSpace.sm,
                runSpacing: NeoSpace.sm,
                children: [
                  for (final name in _invited)
                    Chip(
                      avatar: NeoAvatar(name: name, size: 22),
                      label: Text(name),
                      onDeleted: () => setState(() => _invited.remove(name)),
                    ),
                  if (_invited.isEmpty)
                    Text(
                      'Anyone with the link can join.',
                      style: text.bodySmall?.copyWith(color: p.textMuted),
                    ),
                ],
              ),
            ),

            NeoSection(
              title: 'Options',
              child: Column(
                children: [
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'public', label: Text('Public')),
                      ButtonSegment(value: 'unlisted', label: Text('Unlisted')),
                      ButtonSegment(value: 'private', label: Text('Private')),
                    ],
                    selected: {_visibility},
                    onSelectionChanged: (s) =>
                        setState(() => _visibility = s.first),
                  ),
                  const SizedBox(height: NeoSpace.sm),
                  _SwitchRow(
                    title: 'Waiting room',
                    subtitle: 'Every join is admitted by a host',
                    value: _waitingRoom,
                    onChanged: (v) => setState(() => _waitingRoom = v),
                  ),
                  _SwitchRow(
                    title: 'Wait for a host',
                    subtitle: 'Nobody enters before a host arrives',
                    value: _waitForHost,
                    onChanged: (v) => setState(() => _waitForHost = v),
                  ),
                  _SwitchRow(
                    title: 'Record automatically',
                    subtitle: 'Everyone is told when recording begins',
                    value: _record,
                    onChanged: (v) => setState(() => _record = v),
                  ),
                ],
              ),
            ),

            NeoSection(
              title: 'Live translation',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(bottom: NeoSpace.md),
                    child: Text(
                      'Attendees choose from the languages you pick here.',
                      style: text.bodySmall?.copyWith(color: p.textMuted),
                    ),
                  ),
                  Wrap(
                    spacing: NeoSpace.sm,
                    runSpacing: NeoSpace.sm,
                    children: [
                      for (final lang in meetingLanguages.take(8))
                        FilterChip(
                          label: Text(lang.label),
                          selected: _languages.contains(lang.code),
                          onSelected: (on) => setState(() {
                            on
                                ? _languages.add(lang.code)
                                : _languages.remove(lang.code);
                          }),
                        ),
                    ],
                  ),
                ],
              ),
            ),

            FilledButton(
              onPressed: () {
                if (_formKey.currentState?.validate() ?? false) {
                  Navigator.of(context).pop();
                }
              },
              child: const Text('Schedule meeting'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: sampleNow,
      lastDate: sampleNow.add(const Duration(days: 365)),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: _time);
    if (picked != null) setState(() => _time = picked);
  }

  void _addParticipant() {
    final candidates = [
      'Adaeze Okonkwo',
      'Tolu Adeyemi',
      'Jonas Lindqvist',
      'Amara Nwosu',
      'Sam Whitfield',
      'Chinwe Balogun',
    ].where((n) => !_invited.contains(n)).toList();

    neoSheet(
      context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final name in candidates)
              ListTile(
                leading: NeoAvatar(name: name, size: 36),
                title: Text(name),
                onTap: () {
                  setState(() => _invited.add(name));
                  Navigator.pop(sheetContext);
                },
              ),
            const SizedBox(height: NeoSpace.md),
          ],
        ),
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({
    required this.icon,
    required this.label,
    required this.value,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final String value;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return NeoCard(
      onTap: onTap,
      padding: const EdgeInsets.symmetric(
        horizontal: NeoSpace.md,
        vertical: NeoSpace.md,
      ),
      child: Row(
        children: [
          Icon(icon, size: 18, color: NeoTheme.of(context).textMuted),
          const SizedBox(width: NeoSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: Theme.of(context).textTheme.labelSmall),
                Text(value, style: Theme.of(context).textTheme.titleSmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SwitchRow extends StatelessWidget {
  const _SwitchRow({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.onChanged,
  });

  final String title;
  final String subtitle;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      contentPadding: EdgeInsets.zero,
      value: value,
      onChanged: onChanged,
      title: Text(title, style: Theme.of(context).textTheme.titleSmall),
      subtitle: Text(subtitle, style: Theme.of(context).textTheme.bodySmall),
    );
  }
}
