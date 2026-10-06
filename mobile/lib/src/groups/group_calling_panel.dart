import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../events/event.dart';
import 'groups_api.dart';

/// One person a group meeting has been calling (`GET /api/events/<id>/calls`).
class CallPerson {
  const CallPerson({required this.userId, required this.name, required this.status, required this.attempts});

  final String userId;
  final String name;

  /// not_called | ringing | answered | joined | declined | missed | busy
  final String status;
  final int attempts;

  /// Anyone not already in (or on their way in) can be rung again.
  bool get canRingAgain => status != 'joined' && status != 'answered';

  /// The web's words for each (GroupCallingPanel.tsx).
  String get label => switch (status) {
    'ringing' => 'Ringing',
    'answered' => 'Joining',
    'joined' => 'Joined',
    'declined' => 'Declined',
    'missed' => 'Missed',
    'busy' => 'In another meeting',
    _ => 'Not rung yet',
  };
}

/// For a host in a group meeting: who has been rung and how it went, with
/// "Ring again"; and adding people to the meeting. Shown in the room's
/// participants sheet; renders nothing in a meeting that is not a group's,
/// or for someone who may not manage its calls. Refreshes every 5 s while
/// open, as the web's panel does.
class GroupCallingSection extends ConsumerStatefulWidget {
  const GroupCallingSection({super.key, required this.slug, this.myUserId});

  final String slug;

  /// Left out of the list: whoever started the call is never rung, and
  /// "Ring again" on yourself (the server lists every invitee) means
  /// nothing.
  final String? myUserId;

  static Duration every = const Duration(seconds: 5);

  @override
  ConsumerState<GroupCallingSection> createState() => _GroupCallingSectionState();
}

class _GroupCallingSectionState extends ConsumerState<GroupCallingSection> {
  List<CallPerson>? _people;
  int _maxAttempts = 0;
  bool _hidden = false;
  String? _ringing;
  String? _message;
  Timer? _timer;

  /// Add people: members not yet in a private call, and whether adding is
  /// allowed at all (`GET /api/events/<id>/participants`).
  bool _canAdd = false;
  String _kind = 'scheduled';
  List<({String userId, String name})> _candidates = const [];

  ApiClient get _api => ref.read(apiProvider);
  String get _slug => Uri.encodeComponent(widget.slug);

  @override
  void initState() {
    super.initState();
    _load();
    _loadParticipants();
    _timer = Timer.periodic(GroupCallingSection.every, (_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    if (_hidden) return;
    try {
      final body = await _api.get('/api/events/$_slug/calls') as Map;
      if (!mounted) return;
      setState(() {
        _maxAttempts = (body['maxAttempts'] as num?)?.toInt() ?? 0;
        _people = [
          for (final p in (body['people'] as List? ?? const []).whereType<Map>())
            if (p['userId'] != widget.myUserId)
              CallPerson(
                userId: p['userId'] as String? ?? '',
                name: p['name'] as String? ?? '',
                status: p['status'] as String? ?? 'not_called',
                attempts: (p['attempts'] as num?)?.toInt() ?? 0,
              ),
        ];
      });
    } on ApiException catch (e) {
      // Not a group meeting (404), or not this person's to manage (403).
      if (e.status == 404 || e.status == 403) {
        _timer?.cancel();
        if (mounted) setState(() => _hidden = true);
      }
    } catch (_) {
      // The next refresh tries again.
    }
  }

  Future<void> _loadParticipants() async {
    try {
      final body = await _api.get('/api/events/$_slug/participants') as Map;
      if (!mounted) return;
      setState(() {
        _canAdd = body['canAdd'] == true;
        _kind = body['kind'] as String? ?? 'scheduled';
        _candidates = [
          for (final c in (body['candidates'] as List? ?? const []).whereType<Map>())
            (userId: c['userId'] as String? ?? '', name: c['name'] as String? ?? ''),
        ];
      });
    } catch (_) {
      // Adding stays hidden.
    }
  }

  Future<void> _ringAgain(CallPerson p) async {
    setState(() {
      _ringing = p.userId;
      _message = null;
    });
    try {
      final body =
          await _api.post('/api/events/$_slug/ring', {
                'userIds': [p.userId],
              })
              as Map;
      final busy = (body['busy'] as List? ?? const []).contains(p.userId);
      setState(() => _message = busy ? '${p.name} is in another meeting.' : 'Ringing ${p.name} again.');
      await _load();
    } catch (e) {
      if (mounted) setState(() => _message = groupErrorText(e));
    } finally {
      if (mounted) setState(() => _ringing = null);
    }
  }

  Future<void> _add() async {
    final result = await showDialog<({List<String> userIds, List<String> emails})>(
      context: context,
      builder: (_) => _AddPeopleDialog(call: _kind == 'call', candidates: _candidates),
    );
    if (result == null || (result.userIds.isEmpty && result.emails.isEmpty)) return;
    try {
      final body =
          await _api.post('/api/events/$_slug/participants', {
                if (result.userIds.isNotEmpty) 'userIds': result.userIds,
                if (result.emails.isNotEmpty) 'emails': result.emails,
              })
              as Map;
      final n = (body['added'] as List? ?? const []).length;
      if (mounted) {
        setState(() => _message = n == 0 ? 'They were already invited.' : 'Added $n. They are being rung.');
      }
      await _loadParticipants();
      await _load();
    } catch (e) {
      if (mounted) setState(() => _message = groupErrorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final people = _people;
    if (_hidden || people == null) return const SizedBox.shrink();
    final joined = people.where((x) => x.status == 'joined').length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoSpace.lg, NeoSpace.sm, NeoSpace.lg, NeoSpace.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  people.isEmpty ? 'Calling' : 'Calling · $joined of ${people.length} joined',
                  style: TextStyle(color: p.text, fontWeight: FontWeight.w600),
                ),
              ),
              if (_canAdd)
                TextButton.icon(
                  onPressed: _add,
                  icon: const Icon(Icons.person_add_alt_rounded, size: 18),
                  label: const Text('Add people'),
                ),
            ],
          ),
          for (final person in people)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: NeoSpace.xs),
              child: Row(
                children: [
                  NeoAvatar(name: person.name, size: 30),
                  const SizedBox(width: NeoSpace.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          person.name,
                          style: TextStyle(color: p.text),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          person.attempts > 0
                              ? '${person.label} · rung ${person.attempts}/$_maxAttempts'
                              : person.label,
                          style: TextStyle(color: _statusColor(p, person.status), fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                  if (person.canRingAgain)
                    TextButton(
                      onPressed: _ringing == null ? () => _ringAgain(person) : null,
                      child: Text(_ringing == person.userId ? '…' : 'Ring again'),
                    ),
                ],
              ),
            ),
          if (_message != null) Text(_message!, style: TextStyle(color: p.textMuted, fontSize: 12)),
          Divider(color: p.border),
        ],
      ),
    );
  }

  static Color _statusColor(NeoPalette p, String status) => switch (status) {
    'joined' || 'answered' => p.success,
    'declined' => p.danger,
    'missed' || 'busy' => p.warning,
    'ringing' => p.info,
    _ => p.textMuted,
  };
}

/// Pick members not yet in a private call, and/or type email addresses.
class _AddPeopleDialog extends StatefulWidget {
  const _AddPeopleDialog({required this.call, required this.candidates});

  final bool call;
  final List<({String userId, String name})> candidates;

  @override
  State<_AddPeopleDialog> createState() => _AddPeopleDialogState();
}

class _AddPeopleDialogState extends State<_AddPeopleDialog> {
  final _chosen = <String>{};
  final _emails = TextEditingController();

  @override
  void dispose() {
    _emails.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return AlertDialog(
      title: const Text('Add people'),
      content: SizedBox(
        width: double.maxFinite,
        child: ListView(
          shrinkWrap: true,
          children: [
            if (widget.call && widget.candidates.isNotEmpty)
              for (final c in widget.candidates)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _chosen.contains(c.userId),
                  onChanged: (on) => setState(() => on == true ? _chosen.add(c.userId) : _chosen.remove(c.userId)),
                  title: Text(c.name),
                )
            else if (!widget.call)
              Text(
                'Everyone in the group is already invited. Add people from outside it by email.',
                style: TextStyle(color: p.textMuted),
              ),
            TextField(
              controller: _emails,
              keyboardType: TextInputType.emailAddress,
              autocorrect: false,
              decoration: const InputDecoration(labelText: 'Email addresses'),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: () => Navigator.pop(context, (
            userIds: _chosen.toList(),
            emails: [
              for (final e in _emails.text.split(RegExp(r'[\s,;]+')))
                if (e.trim().isNotEmpty) e.trim(),
            ],
          )),
          child: const Text('Add to meeting'),
        ),
      ],
    );
  }
}
