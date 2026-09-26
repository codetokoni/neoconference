import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../billing/upgrade.dart';
import '../core/api_client.dart';
import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../events/create_meeting_screen.dart' show createdSlug;
import '../events/event.dart' show apiProvider;
import '../events/languages.dart';
import '../meetings/meeting_board.dart';

/// The moment a date and a time of day picked on this phone refer to.
DateTime scheduledFor(DateTime day, TimeOfDay time) =>
    DateTime(day.year, day.month, day.day, time.hour, time.minute);

/// Why a meeting cannot be scheduled for [when], or null when it can.
String? scheduleProblem(DateTime when, DateTime now) =>
    when.isAfter(now) ? null : 'Pick a time that has not passed yet.';

/// Scheduling a meeting.
///
/// Grouped so the required part is answerable in seconds and everything
/// optional is below it. Defaults are the safe ones: unlisted rather than
/// public, wait-for-host on.
///
/// This screen used to create nothing. "Schedule meeting" closed it, and it
/// listed two invitees who do not exist, picked from sample data. It now
/// calls the same /api/events/create as Start and the website, and offers
/// only what that route keeps: a length, automatic recording and a
/// participant list had nowhere to go on the server, so they are gone
/// rather than pretending. People are invited with the link it hands back.
class ScheduleScreen extends ConsumerStatefulWidget {
  const ScheduleScreen({super.key});

  @override
  ConsumerState<ScheduleScreen> createState() => _ScheduleScreenState();
}

class _ScheduleScreenState extends ConsumerState<ScheduleScreen> {
  static const _origin = 'https://www.neoconference.app';

  final _title = TextEditingController();
  final _formKey = GlobalKey<FormState>();

  DateTime _date = DateTime.now().add(const Duration(days: 1));
  TimeOfDay _time = const TimeOfDay(hour: 10, minute: 0);
  String _visibility = 'unlisted';
  bool _waitingRoom = false;
  bool _waitForHost = true;
  final _languages = <String>{};
  bool _busy = false;
  String? _error;

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
              child: Row(
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
                      'Attendees choose from the languages you pick here. '
                      'Available on Pro and above.',
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

            Padding(
              padding: const EdgeInsets.only(bottom: NeoSpace.lg),
              child: Text(
                "You'll get the meeting's link to send to the people you "
                'want there. Anyone with it can join.',
                style: text.bodySmall?.copyWith(color: p.textMuted),
              ),
            ),

            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: NeoSpace.lg),
                child: NeoBanner(
                  icon: Icons.error_outline_rounded,
                  tone: NeoBannerTone.danger,
                  message: _error!,
                ),
              ),

            FilledButton(
              onPressed: _busy ? null : _schedule,
              child: _busy
                  ? const SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Schedule meeting'),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _schedule() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final when = scheduledFor(_date, _time);
    final problem = scheduleProblem(when, DateTime.now());
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final body = await ref.read(apiProvider).post('/api/events/create', {
        'name': _title.text.trim(),
        'visibility': _visibility,
        'waitingRoomEnabled': _waitingRoom,
        'waitForHost': _waitForHost,
        // UTC on the wire: the server and the website read it as an
        // instant, and the phone's own zone means nothing to them.
        'scheduledAt': when.toUtc().toIso8601String(),
        if (_languages.isNotEmpty) 'languages': _languages.toList(),
      });
      final slug = createdSlug(body);
      // Upcoming on the home screen comes from the account's meetings.
      ref.read(reloadMeetingBoardProvider)();
      if (!mounted) return;
      setState(() => _busy = false);
      if (slug == null) {
        setState(() => _error =
            'The meeting was scheduled but no link came back. It is in your '
            'upcoming meetings.');
        return;
      }
      await _showLink('$_origin/$slug', when);
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      setState(() => _busy = false);
      // 402 with a named feature means the plan, not the request, is the
      // problem — offer the way out, as Start does.
      if (e.status == 402 && e.code == 'plan_upgrade_required') {
        if (!mounted) return;
        showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          builder: (_) => UpgradeSheet(
            reason: e.message,
            currentPlan: e.body['plan'] as String?,
          ),
        );
        return;
      }
      setState(() => _error = e.message);
    } catch (e) {
      setState(() {
        _busy = false;
        _error = 'Could not schedule the meeting: $e';
      });
    }
  }

  Future<void> _showLink(String link, DateTime when) {
    final text = Theme.of(context).textTheme;
    return showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Meeting scheduled'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${when.day}/${when.month}/${when.year} at '
              '${TimeOfDay.fromDateTime(when).format(context)}',
              style: text.bodyMedium,
            ),
            const SizedBox(height: NeoSpace.md),
            SelectableText(link, style: text.bodyMedium),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: link));
              if (!dialogContext.mounted) return;
              ScaffoldMessenger.of(dialogContext).showSnackBar(
                const SnackBar(content: Text('Link copied')),
              );
            },
            child: const Text('Copy link'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Done'),
          ),
        ],
      ),
    );
  }

  Future<void> _pickDate() async {
    final today = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(today.year, today.month, today.day),
      lastDate: today.add(const Duration(days: 365)),
    );
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: _time);
    if (picked != null) setState(() => _time = picked);
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
