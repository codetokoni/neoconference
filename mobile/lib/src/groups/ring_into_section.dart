import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../design/brand.dart';
import '../design/tokens.dart';
import '../events/event.dart';
import 'groups_api.dart';

/// Bumped when people are rung into this meeting, so the Calling section
/// (which hid itself: nobody was being called) looks again.
final ringIntoChanged = ValueNotifier<int>(0);

/// A group this person may call from, with its members (themselves left out).
class CallableGroup {
  const CallableGroup({required this.id, required this.name, required this.members});
  final String id;
  final String name;
  final List<({String userId, String name})> members;

  static List<CallableGroup> listFrom(Object? body) => [
        for (final g in ((body as Map?)?['groups'] as List? ?? const []).whereType<Map>())
          CallableGroup(
            id: g['id'] as String? ?? '',
            name: g['name'] as String? ?? '',
            members: [
              for (final m in (g['members'] as List? ?? const []).whereType<Map>())
                (userId: m['userId'] as String? ?? '', name: m['name'] as String? ?? ''),
            ],
          ),
      ];
}

/// "Call people in", in the room's participants sheet, for a meeting that is
/// not a group meeting (your room, a meeting from History): ring members of
/// one of your groups into this meeting, now (`POST /api/events/<id>/ring-in`).
/// The web's RingIntoMeeting. Renders nothing for anyone who may not invite
/// people into the meeting, for a group meeting, or once it is over.
class RingIntoSection extends ConsumerStatefulWidget {
  const RingIntoSection({super.key, required this.slug});
  final String slug;

  @override
  ConsumerState<RingIntoSection> createState() => _RingIntoSectionState();
}

class _RingIntoSectionState extends ConsumerState<RingIntoSection> {
  List<CallableGroup>? _groups;
  bool _open = false;
  String? _message;

  ApiClient get _api => ref.read(apiProvider);
  String get _slug => Uri.encodeComponent(widget.slug);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final body = await _api.get('/api/events/$_slug/ring-in') as Map;
      if (!mounted) return;
      setState(() {
        _open = body['open'] == true;
        _groups = CallableGroup.listFrom(body);
      });
    } catch (_) {
      // A group meeting, or not this person's to call into: stays hidden.
    }
  }

  Future<void> _call() async {
    final groups = _groups ?? const <CallableGroup>[];
    final picked = await showDialog<({String groupId, List<String> userIds})>(
      context: context,
      builder: (_) => RingIntoDialog(groups: groups),
    );
    if (picked == null || picked.userIds.isEmpty) return;
    try {
      final body = await _api.post('/api/events/$_slug/ring-in', {
        'groupId': picked.groupId,
        'userIds': picked.userIds,
      }) as Map;
      final rung = (body['rung'] as List? ?? const []).length;
      final busy = (body['busy'] as List? ?? const []).length;
      if (!mounted) return;
      setState(() => _message = ringIntoResultText(rung, busy));
      ringIntoChanged.value++;
    } catch (e) {
      if (mounted) setState(() => _message = groupErrorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    if (!_open || _groups == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoSpace.lg, NeoSpace.sm, NeoSpace.lg, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FilledButton.icon(
            onPressed: _groups!.isEmpty ? null : _call,
            icon: const Icon(Icons.ring_volume_rounded),
            label: const Text('Call people in'),
          ),
          if (_groups!.isEmpty)
            Text('Calling people in uses your groups. Make a group first.', style: TextStyle(color: p.textMuted, fontSize: 12)),
          if (_message != null)
            Padding(
              padding: const EdgeInsets.only(top: NeoSpace.xs),
              child: Text(_message!, style: TextStyle(color: p.textMuted, fontSize: 12)),
            ),
        ],
      ),
    );
  }
}

/// What a ring-in did, as the web says it.
String ringIntoResultText(int rung, int busy) {
  final parts = [
    if (rung > 0) 'Ringing $rung ${rung == 1 ? 'person' : 'people'}.',
    if (busy > 0) '$busy ${busy == 1 ? 'is' : 'are'} in another meeting and got a message instead.',
  ];
  return parts.isEmpty ? 'They have already joined or answered.' : parts.join(' ');
}

/// Choose a group, then people in it (or everyone), to call in.
class RingIntoDialog extends StatefulWidget {
  const RingIntoDialog({super.key, required this.groups});
  final List<CallableGroup> groups;

  @override
  State<RingIntoDialog> createState() => _RingIntoDialogState();
}

class _RingIntoDialogState extends State<RingIntoDialog> {
  late CallableGroup _group = widget.groups.first;
  final _chosen = <String>{};

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final members = _group.members;
    final everyone = members.isNotEmpty && members.every((m) => _chosen.contains(m.userId));
    return AlertDialog(
      title: const Text('Call people in'),
      content: SizedBox(
        width: double.maxFinite,
        child: ListView(
          shrinkWrap: true,
          children: [
            if (widget.groups.length > 1)
              DropdownButtonFormField<String>(
                initialValue: _group.id,
                decoration: const InputDecoration(labelText: 'From group'),
                items: [
                  for (final g in widget.groups) DropdownMenuItem(value: g.id, child: Text('${g.name} (${g.members.length})')),
                ],
                onChanged: (id) => setState(() {
                  _group = widget.groups.firstWhere((g) => g.id == id);
                  _chosen.clear();
                }),
              )
            else
              Text('From ${_group.name}', style: TextStyle(color: p.textMuted)),
            if (members.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: NeoSpace.md),
                child: Text('There is no one else in this group yet.', style: TextStyle(color: p.textMuted)),
              )
            else ...[
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: everyone,
                onChanged: (on) => setState(() {
                  _chosen.clear();
                  if (on == true) _chosen.addAll(members.map((m) => m.userId));
                }),
                title: Text('Everyone in ${_group.name}', style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
              for (final m in members)
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _chosen.contains(m.userId),
                  onChanged: (on) => setState(() => on == true ? _chosen.add(m.userId) : _chosen.remove(m.userId)),
                  title: Text(m.name.isEmpty ? 'Member' : m.name, maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: _chosen.isEmpty ? null : () => Navigator.pop(context, (groupId: _group.id, userIds: _chosen.toList())),
          child: Text(_chosen.isEmpty ? 'Call' : 'Call ${_chosen.length}'),
        ),
      ],
    );
  }
}
