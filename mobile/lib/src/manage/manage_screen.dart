import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api_client.dart';
import '../core/load_error.dart';
import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../events/event.dart';
import '../meetings/meeting_links.dart';
import '../meetings/meeting_view.dart';
import '../screens/prejoin_screen.dart';
import 'manage_api.dart';

/// A meeting's own page, for its owner: what the web's `/dashboard/e/<slug>`
/// offers, on the phone — rename and reschedule, the waiting room, the End
/// PIN, hosts and cohosts by KingsChat handle, recordings and their
/// transcripts, the AI summary, the link and its QR code, and deleting it.
///
/// Every section loads on its own and fails on its own: a recordings
/// listing that times out must not hide the waiting-room switch.
class ManageMeetingScreen extends ConsumerStatefulWidget {
  const ManageMeetingScreen({super.key, required this.slug, this.title});

  final String slug;
  final String? title;

  @override
  ConsumerState<ManageMeetingScreen> createState() => _ManageMeetingScreenState();
}

class _ManageMeetingScreenState extends ConsumerState<ManageMeetingScreen> {
  late final ManageApi _api = ManageApi(ref.read(apiProvider));

  ManagedMeeting? _meeting;
  String? _meetingError;
  List<HandleRole>? _roles;
  String? _rolesError;
  List<MeetingRecording>? _recordings;
  String? _recordingsError;
  String? _summary;
  bool _summaryLoaded = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  String _say(Object e) => manageErrorMessage(e);

  Future<void> _load() async {
    try {
      final m = await _api.meeting(widget.slug);
      if (!mounted) return;
      setState(() {
        _meeting = m;
        _meetingError = null;
      });
      await Future.wait([_loadRoles(m.id), _loadRecordings(), _loadSummary(m.id)]);
    } catch (e) {
      if (mounted) setState(() => _meetingError = _say(e));
    }
  }

  Future<void> _loadRoles(String id) async {
    try {
      final r = await _api.handleRoles(id);
      if (!mounted) return;
      setState(() {
        _roles = r;
        _rolesError = null;
      });
    } catch (e) {
      if (mounted) setState(() => _rolesError = _say(e));
    }
  }

  Future<void> _loadRecordings() async {
    try {
      final r = await _api.recordings(slug: widget.slug);
      if (!mounted) return;
      setState(() {
        _recordings = r;
        _recordingsError = null;
      });
    } catch (e) {
      if (mounted) setState(() => _recordingsError = _say(e));
    }
  }

  Future<void> _loadSummary(String id) async {
    try {
      final s = await _api.summary(id);
      if (!mounted) return;
      setState(() {
        _summary = s;
        _summaryLoaded = true;
      });
    } catch (_) {
      if (mounted) setState(() => _summaryLoaded = true);
    }
  }

  /// Runs a change, says how it went, and reloads what it touched.
  /// [said], when given, words the toast from what the action returned —
  /// for a change whose outcome is more than "done".
  Future<void> _change<T>(
    Future<T> Function() action,
    String done, {
    bool reload = true,
    String Function(T result)? said,
  }) async {
    setState(() => _busy = true);
    try {
      final result = await action();
      _toast(said?.call(result) ?? done);
      // The meetings lists show names, times and the waiting room.
      ref.invalidate(eventsProvider);
      if (reload) await _load();
    } catch (e) {
      _toast(_say(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _toast(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final m = _meeting;
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(
        backgroundColor: p.bg,
        title: Text(m?.name ?? widget.title ?? widget.slug),
        bottom: _busy
            ? const PreferredSize(preferredSize: Size.fromHeight(2), child: LinearProgressIndicator(minHeight: 2))
            : null,
      ),
      body: m == null
          ? Center(
              child: _meetingError == null
                  ? const CircularProgressIndicator()
                  : Padding(
                      padding: const EdgeInsets.all(NeoSpace.xl),
                      child: NeoBanner(
                        icon: Icons.error_outline_rounded,
                        tone: NeoBannerTone.warning,
                        message: _meetingError!,
                        action: _load,
                        actionLabel: 'Try again',
                      ),
                    ),
            )
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(NeoSpace.xl),
                children: [
                  _header(m),
                  _details(m),
                  _access(m),
                  _people(m),
                  _recordingsSection(),
                  _summarySection(m),
                  _danger(m),
                ],
              ),
            ),
    );
  }

  // ---- Link, QR, join ----------------------------------------------------

  Widget _header(ManagedMeeting m) {
    final p = NeoTheme.of(context);
    final link = meetingShareLink(m.slug);
    return NeoSection(
      title: 'Meeting',
      child: NeoCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                NeoPill(_stateLabel(m), color: m.isLive ? p.success : p.textMuted, dot: m.isLive),
                const Spacer(),
                Text(m.slug, style: TextStyle(color: p.textMuted, fontSize: 12)),
              ],
            ),
            const SizedBox(height: NeoSpace.md),
            SelectableText(link, style: TextStyle(color: p.primary)),
            const SizedBox(height: NeoSpace.md),
            Wrap(
              spacing: NeoSpace.sm,
              runSpacing: NeoSpace.sm,
              children: [
                OutlinedButton.icon(
                  icon: const Icon(Icons.copy_rounded, size: 18),
                  label: const Text('Copy link'),
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: link));
                    _toast('Link copied.');
                  },
                ),
                OutlinedButton.icon(
                  icon: const Icon(Icons.qr_code_rounded, size: 18),
                  label: const Text('QR code'),
                  onPressed: () => neoSheet(context, builder: (_) => _QrSheet(slug: m.slug)),
                ),
                FilledButton.icon(
                  icon: const Icon(Icons.videocam_rounded, size: 18),
                  label: Text(m.isLive ? 'Join' : 'Open'),
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => PreJoinScreen(
                      meeting: MeetingView(
                        eventId: m.id,
                        title: m.name,
                        code: m.slug,
                        status: m.isLive
                            ? MeetingStatus.live
                            : (m.state == 'ended' ? MeetingStatus.ended : MeetingStatus.scheduled),
                        canJoin: m.state != 'archived',
                      ),
                    ),
                  )),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  String _stateLabel(ManagedMeeting m) {
    if (m.isPermanent) return 'Always open';
    return switch (m.state) {
      'live' || 'waiting' => 'Live',
      'ended' => 'Ended',
      'archived' => 'Archived',
      _ => 'Scheduled',
    };
  }

  // ---- Name and time -----------------------------------------------------

  Widget _details(ManagedMeeting m) {
    final p = NeoTheme.of(context);
    return NeoSection(
      title: 'Details',
      child: NeoCard(
        padding: EdgeInsets.zero,
        child: Column(
          children: [
            ListTile(
              leading: const Icon(Icons.edit_rounded),
              title: const Text('Name'),
              subtitle: Text(m.name, style: TextStyle(color: p.textMuted)),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => _rename(m),
            ),
            if (!m.isPermanent)
              ListTile(
                leading: const Icon(Icons.schedule_rounded),
                title: const Text('Scheduled for'),
                subtitle: Text(
                  m.scheduledAt == null ? 'Not scheduled' : _when(m.scheduledAt!),
                  style: TextStyle(color: p.textMuted),
                ),
                trailing: const Icon(Icons.chevron_right_rounded),
                onTap: () => _reschedule(m),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _rename(ManagedMeeting m) async {
    final name = await _ask(title: 'Rename meeting', initial: m.name, label: 'Name');
    if (name == null || name.trim().isEmpty || name.trim() == m.name) return;
    await _change(() => _api.update(m.id, name: name.trim()), 'Renamed.');
  }

  Future<void> _reschedule(ManagedMeeting m) async {
    final now = DateTime.now();
    final start = m.scheduledAt ?? now.add(const Duration(hours: 1));
    final day = await showDatePicker(
      context: context,
      initialDate: start.isBefore(now) ? now : start,
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: now.add(const Duration(days: 730)),
    );
    if (day == null || !mounted) return;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(start));
    if (time == null) return;
    final at = DateTime(day.year, day.month, day.day, time.hour, time.minute);
    await _change(() => _api.update(m.id, scheduledAt: at), 'Rescheduled for ${_when(at)}.');
  }

  // ---- Waiting room and End PIN -----------------------------------------

  Widget _access(ManagedMeeting m) {
    final p = NeoTheme.of(context);
    return NeoSection(
      title: 'Access',
      child: NeoCard(
        padding: EdgeInsets.zero,
        child: Column(
          children: [
            SwitchListTile(
              value: m.waitingRoomEnabled,
              onChanged: _busy
                  ? null
                  : (on) => _change(
                        () => _api.setWaitingRoom(m.slug, on),
                        on ? 'Waiting room on.' : 'Waiting room off.',
                      ),
              title: const Text('Waiting room'),
              subtitle: Text(
                m.waitingRoomEnabled
                    ? 'People wait for you to let them in. Hosts and cohosts go straight in.'
                    : 'Anyone with the link comes straight in.',
                style: TextStyle(color: p.textMuted),
              ),
            ),
            ListTile(
              leading: const Icon(Icons.pin_rounded),
              title: const Text('End Meeting PIN'),
              subtitle: Text(
                m.endPinSet ? 'Set — needed to end the meeting for everyone' : 'Not set',
                style: TextStyle(color: p.textMuted),
              ),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => _pin(m),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _pin(ManagedMeeting m) async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(m.endPinSet ? 'Change End Meeting PIN' : 'Set End Meeting PIN'),
        content: TextField(
          controller: controller,
          autofocus: true,
          obscureText: true,
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'New PIN (4 or more digits)'),
        ),
        actions: [
          if (m.endPinSet)
            TextButton(onPressed: () => Navigator.pop(context, ''), child: const Text('Remove PIN')),
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, controller.text.trim()), child: const Text('Save')),
        ],
      ),
    );
    if (result == null) return;
    if (result.isNotEmpty && result.length < 4) {
      _toast('The PIN needs at least 4 digits.');
      return;
    }
    await _change(
      () => _api.update(m.id, endPin: result),
      result.isEmpty ? 'End Meeting PIN removed.' : 'End Meeting PIN saved.',
    );
  }

  // ---- Hosts and cohosts ------------------------------------------------

  Widget _people(ManagedMeeting m) {
    final p = NeoTheme.of(context);
    final roles = _roles;
    return NeoSection(
      title: 'Hosts & cohosts',
      action: TextButton.icon(
        icon: const Icon(Icons.person_add_alt_1_rounded, size: 18),
        label: const Text('Add'),
        onPressed: _busy ? null : () => _addRole(m),
      ),
      child: NeoCard(
        padding: EdgeInsets.zero,
        child: _rolesError != null
            ? Padding(padding: const EdgeInsets.all(NeoSpace.lg), child: Text(_rolesError!, style: TextStyle(color: p.warning)))
            : roles == null
                ? const Padding(padding: EdgeInsets.all(NeoSpace.lg), child: LinearProgressIndicator())
                : roles.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.all(NeoSpace.lg),
                        child: Text(
                          'No one yet. Add a KingsChat handle to make someone a host or cohost — '
                          'they skip the waiting room and can help run the meeting.',
                          style: TextStyle(color: p.textMuted),
                        ),
                      )
                    : Column(
                        children: [
                          for (final r in roles)
                            ListTile(
                              leading: NeoAvatar(name: r.handle, size: 36),
                              title: Text('@${r.handle}'),
                              subtitle: Text(r.label, style: TextStyle(color: p.textMuted)),
                              trailing: TextButton(
                                onPressed: _busy
                                    ? null
                                    : () => _change(() => _api.revokeHandleRole(m.id, r.handle), 'Removed @${r.handle}.'),
                                child: Text('Revoke', style: TextStyle(color: p.danger)),
                              ),
                            ),
                        ],
                      ),
      ),
    );
  }

  Future<void> _addRole(ManagedMeeting m) async {
    final handle = TextEditingController();
    var role = 'moderator';
    var message = true;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setLocal) => AlertDialog(
          title: const Text('Add host or cohost'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(
                controller: handle,
                autofocus: true,
                decoration: const InputDecoration(labelText: 'KingsChat handle', prefixText: '@'),
              ),
              const SizedBox(height: NeoSpace.md),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'host', label: Text('Host')),
                  ButtonSegment(value: 'moderator', label: Text('Cohost')),
                ],
                selected: {role},
                onSelectionChanged: (s) => setLocal(() => role = s.first),
              ),
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: message,
                onChanged: (v) => setLocal(() => message = v ?? true),
                title: const Text('Tell them on KingsChat'),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Add')),
          ],
        ),
      ),
    );
    final h = handle.text.trim().replaceFirst(RegExp(r'^@'), '');
    if (ok != true || h.isEmpty) return;
    await _change(
      () => _api.addHandleRole(m.id, h, role, message: message),
      '',
      said: (r) => inviteOutcome(h, role, asked: message, sent: r.sent, reason: r.reason),
    );
  }

  // ---- Recordings -------------------------------------------------------

  Widget _recordingsSection() {
    final p = NeoTheme.of(context);
    final list = _recordings;
    return NeoSection(
      title: 'Recordings',
      child: _recordingsError != null
          ? NeoCard(child: Text(_recordingsError!, style: TextStyle(color: p.warning)))
          : list == null
              ? const NeoCard(child: LinearProgressIndicator())
              : list.isEmpty
                  ? NeoCard(child: Text('No recordings yet. Press Record in the meeting to make one.', style: TextStyle(color: p.textMuted)))
                  : Column(
                      children: [
                        for (final r in list)
                          Padding(
                            padding: const EdgeInsets.only(bottom: NeoSpace.sm),
                            child: RecordingTile(
                              recording: r,
                              onTranscribe: _busy
                                  ? null
                                  : () => _change(
                                        () => _api.transcribe(r.key),
                                        'Transcribing — it will appear here when done.',
                                      ),
                            ),
                          ),
                      ],
                    ),
    );
  }

  // ---- AI summary -------------------------------------------------------

  Widget _summarySection(ManagedMeeting m) {
    final p = NeoTheme.of(context);
    return NeoSection(
      title: 'AI summary',
      action: TextButton(
        onPressed: _busy
            ? null
            : () async {
                setState(() => _busy = true);
                try {
                  final s = await _api.generateSummary(m.id);
                  if (mounted) setState(() => _summary = s);
                } catch (e) {
                  _toast(_say(e));
                } finally {
                  if (mounted) setState(() => _busy = false);
                }
              },
        child: Text(_summary == null ? 'Generate' : 'Regenerate'),
      ),
      child: NeoCard(
        child: !_summaryLoaded
            ? const LinearProgressIndicator()
            : Text(
                _summary ?? 'No summary yet. Generate one after the meeting has a transcript or chat.',
                style: TextStyle(color: _summary == null ? p.textMuted : p.text, height: 1.4),
              ),
      ),
    );
  }

  // ---- Delete -----------------------------------------------------------

  Widget _danger(ManagedMeeting m) {
    final p = NeoTheme.of(context);
    return NeoSection(
      title: 'Danger zone',
      child: NeoCard(
        padding: EdgeInsets.zero,
        child: ListTile(
          leading: Icon(Icons.delete_forever_rounded, color: p.danger),
          title: Text('Delete meeting', style: TextStyle(color: p.danger)),
          subtitle: Text('Its link stops working. Recording files are kept.', style: TextStyle(color: p.textMuted)),
          onTap: _busy ? null : () => _delete(m),
        ),
      ),
    );
  }

  Future<void> _delete(ManagedMeeting m) async {
    final typed = await _ask(
      title: 'Delete ${m.name}?',
      label: 'Type ${m.slug} to confirm',
      destructive: 'Delete',
    );
    if (typed == null) return;
    if (typed.trim().toLowerCase() != m.slug) {
      _toast('That does not match the meeting address. Nothing was deleted.');
      return;
    }
    setState(() => _busy = true);
    try {
      await _api.delete(m.slug);
      ref.invalidate(eventsProvider);
      if (!mounted) return;
      Navigator.of(context).pop();
      _toast('Deleted ${m.name}.');
    } catch (e) {
      _toast(_say(e));
      if (mounted) setState(() => _busy = false);
    }
  }

  // ---- Helpers ----------------------------------------------------------

  Future<String?> _ask({required String title, required String label, String? initial, String? destructive}) {
    final controller = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: TextField(controller: controller, autofocus: true, decoration: InputDecoration(labelText: label)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            style: destructive == null ? null : FilledButton.styleFrom(backgroundColor: NeoTheme.of(context).danger),
            onPressed: () => Navigator.pop(context, controller.text),
            child: Text(destructive ?? 'Save'),
          ),
        ],
      ),
    );
  }
}

String _when(DateTime at) {
  // A plain, locale-free form that reads the same on every phone.
  final h = at.hour.toString().padLeft(2, '0');
  final min = at.minute.toString().padLeft(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${at.day} ${months[at.month - 1]} ${at.year}, $h:$min';
}

String sizeLabel(int bytes) {
  if (bytes >= 1024 * 1024 * 1024) return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB';
  if (bytes >= 1024 * 1024) return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  return '${(bytes / 1024).toStringAsFixed(0)} KB';
}

/// One recording: when, how big, its transcript, and what can be done.
class RecordingTile extends StatelessWidget {
  const RecordingTile({super.key, required this.recording, this.onTranscribe, this.meetingLabel});

  final MeetingRecording recording;
  final VoidCallback? onTranscribe;

  /// The meeting it belongs to, where a list mixes meetings.
  final String? meetingLabel;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final r = recording;
    final (label, color) = switch (r.transcriptStatus) {
      'done' => ('Transcribed', p.success),
      'running' || 'queued' => ('Transcribing…', p.info),
      'error' => ('Transcript failed', p.warning),
      _ => ('No transcript', p.textMuted),
    };
    return NeoCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (meetingLabel != null)
            Text(meetingLabel!, style: Theme.of(context).textTheme.titleSmall),
          Row(
            children: [
              Expanded(
                child: Text(
                  '${r.recordedAt == null ? 'Recording' : _when(r.recordedAt!)} · ${sizeLabel(r.size)}',
                  style: TextStyle(color: p.textMuted),
                ),
              ),
              NeoPill(label, color: color),
            ],
          ),
          if (r.transcriptStatus == 'error' && r.transcriptError != null) ...[
            const SizedBox(height: NeoSpace.xs),
            Text(r.transcriptError!, style: TextStyle(color: p.warning, fontSize: 12)),
          ],
          const SizedBox(height: NeoSpace.sm),
          Wrap(
            spacing: NeoSpace.sm,
            children: [
              if (!r.transcribed && r.transcriptStatus != 'running' && r.transcriptStatus != 'queued')
                OutlinedButton.icon(
                  icon: const Icon(Icons.subtitles_rounded, size: 18),
                  label: Text(r.transcriptStatus == 'error' ? 'Try again' : 'Transcribe'),
                  onPressed: onTranscribe,
                ),
              if (r.transcribed && (r.transcriptText?.trim().isNotEmpty ?? false))
                OutlinedButton.icon(
                  icon: const Icon(Icons.notes_rounded, size: 18),
                  label: const Text('Read transcript'),
                  onPressed: () => neoSheet(
                    context,
                    fullHeight: true,
                    builder: (_) => _TranscriptSheet(text: r.transcriptText!.trim()),
                  ),
                ),
              if (r.downloadUrl != null)
                OutlinedButton.icon(
                  icon: const Icon(Icons.download_rounded, size: 18),
                  label: const Text('Download'),
                  onPressed: () => launchUrl(Uri.parse(r.downloadUrl!), mode: LaunchMode.externalApplication),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// A recording's transcript, to read and copy. "Transcribed" with no way
/// to see the words read as if there were none.
class _TranscriptSheet extends StatelessWidget {
  const _TranscriptSheet({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.lg, NeoSpace.xl, NeoSpace.xl),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(child: Text('Transcript', style: Theme.of(context).textTheme.titleLarge)),
                TextButton.icon(
                  icon: const Icon(Icons.copy_rounded, size: 18),
                  label: const Text('Copy'),
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: text));
                    if (context.mounted) {
                      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Transcript copied.')));
                    }
                  },
                ),
              ],
            ),
            const SizedBox(height: NeoSpace.md),
            Expanded(
              child: SingleChildScrollView(
                child: SelectableText(text, style: TextStyle(color: p.text, height: 1.5)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The meeting's QR code, from the same endpoint the web page shows.
class _QrSheet extends StatelessWidget {
  const _QrSheet({required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(NeoSpace.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Scan to join', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: NeoSpace.lg),
            Container(
              padding: const EdgeInsets.all(NeoSpace.md),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(NeoRadius.lg)),
              child: Image.network(
                'https://www.neoconference.app/api/qr/${Uri.encodeComponent(slug)}?size=512',
                width: 240,
                height: 240,
                errorBuilder: (_, _, _) => SizedBox(
                  width: 240,
                  height: 240,
                  child: Center(child: Text('Could not load the QR code.', style: TextStyle(color: p.danger))),
                ),
              ),
            ),
            const SizedBox(height: NeoSpace.md),
            Text(meetingShareLink(slug), style: TextStyle(color: p.textMuted)),
          ],
        ),
      ),
    );
  }
}

/// The ⋯ on a meeting card that opens its Manage page. Absent for a
/// meeting with no server id (sample data), which has nothing to manage.
class ManageMeetingButton extends StatelessWidget {
  const ManageMeetingButton({super.key, required this.meeting});

  final MeetingView meeting;

  @override
  Widget build(BuildContext context) {
    if (meeting.eventId == null) return const SizedBox.shrink();
    return IconButton(
      tooltip: 'Manage meeting',
      icon: Icon(Icons.tune_rounded, color: NeoTheme.of(context).textMuted),
      onPressed: () => Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => ManageMeetingScreen(slug: meeting.code, title: meeting.title),
      )),
    );
  }
}

/// What adding a host or cohost did. The role is always given; the
/// KingsChat message often is not — someone who has never signed in here
/// with KingsChat cannot be messaged — and saying "done" then would leave
/// the host waiting for a person who was never told.
String inviteOutcome(String handle, String role, {required bool asked, required bool sent, String? reason}) {
  final given = '@$handle is now ${role == 'host' ? 'a host' : 'a cohost'}';
  if (!asked) return '$given.';
  if (sent) return '$given, and was told on KingsChat.';
  final why = switch (reason) {
    'recipient_never_signed_in' => "they haven't signed in to NeoConference with KingsChat yet",
    'sender_not_linked' => 'your KingsChat is not linked — sign in with KingsChat once',
    _ => 'KingsChat did not accept it',
  };
  return '$given. No KingsChat message was sent: $why. Send them the link yourself.';
}

/// A refusal in words. The routes answer with codes the web maps to text;
/// these are the ones the Manage page can meet.
///
/// A known code is named before the status is looked at: the summary and
/// transcription routes answer "not set up" and "the AI failed" with 5xx,
/// and those deserve their own words, not "NeoConference is having trouble".
String manageErrorMessage(Object e) {
  final known = e is ApiException
      ? switch (e.code) {
          'forbidden' => "Only the meeting's owner can change this.",
          'not_found' => 'That meeting no longer exists.',
          'pin_too_short' => 'The PIN needs at least 4 digits.',
          'invalid_name' => 'Give the meeting a name up to 200 characters.',
          'invalid_scheduledAt' => 'That date and time could not be read.',
          'invalid_role' || 'missing_handle' || 'missing_fields' => 'Enter a KingsChat handle and pick Host or Cohost.',
          'ai_not_configured' => 'AI summaries are not set up on this server.',
          'no_content' => 'There is nothing to summarise yet — no transcript or chat.',
          'ai_failed' || 'empty_summary' => 'The AI could not write a summary just now. Try again.',
          'transcribe_not_configured' => 'Transcription is not set up on this server.',
          _ => null,
        }
      : null;
  if (known != null) return known;
  if (e is! ApiException || e.status == 401 || e.status >= 500) return describeLoadError(e);
  return e.message;
}
