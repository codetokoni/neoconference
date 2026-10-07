import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/tokens.dart';
import 'group_models.dart';
import 'groups_api.dart';

/// Someone who could be put in a group: from a meeting's report or from the
/// people in a meeting.
@immutable
class GroupCandidate {
  const GroupCandidate({
    required this.name,
    this.detail = '',
    this.userId,
    this.email,
    this.kcHandle,
    this.attended = false,
    this.selected = false,
  });

  final String name;

  /// A line under the name: "Came · 42 min", "Invited, didn't come".
  final String detail;
  final String? userId;
  final String? email;
  final String? kcHandle;

  /// Was in the meeting (so a new group can take them straight away).
  final bool attended;

  /// Ticked when the sheet opens.
  final bool selected;
}

/// Splits typed text into KingsChat handles and emails. "ada@x.com" is an
/// email; "@ada" and "ada" are handles.
({List<String> emails, List<String> handles}) splitPeople(String text) {
  final emails = <String>[];
  final handles = <String>[];
  for (final raw in text.split(RegExp(r'[\s,;]+'))) {
    final s = raw.trim();
    if (s.isEmpty) continue;
    if (s.indexOf('@') > 0) {
      emails.add(s.toLowerCase());
    } else {
      final h = s.replaceFirst(RegExp(r'^@'), '').toLowerCase();
      if (h.isNotEmpty) handles.add(h);
    }
  }
  return (emails: emails, handles: handles);
}

/// Opens the sheet: choose people, then a group of yours (Moderator and up)
/// or a new one. Returns a sentence saying what happened, or null if closed.
///
/// [fromEventId] is the meeting the people came from: a new group takes the
/// ones who attended directly, and records where it came from.
Future<String?> showAddToGroupSheet(
  BuildContext context, {
  required List<GroupCandidate> people,
  required String suggestedName,
  String? fromEventId,
  bool startNew = false,
}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => AddToGroupSheet(
      people: people,
      suggestedName: suggestedName,
      fromEventId: fromEventId,
      startNew: startNew,
    ),
  );
}

class AddToGroupSheet extends ConsumerStatefulWidget {
  const AddToGroupSheet({
    super.key,
    required this.people,
    required this.suggestedName,
    this.fromEventId,
    this.startNew = false,
  });

  final List<GroupCandidate> people;
  final String suggestedName;
  final String? fromEventId;
  final bool startNew;

  @override
  ConsumerState<AddToGroupSheet> createState() => _AddToGroupSheetState();
}

/// The new group, in the group choice.
const _newGroup = '';

class _AddToGroupSheetState extends ConsumerState<AddToGroupSheet> {
  late final Set<int> _picked = {
    for (var i = 0; i < widget.people.length; i++)
      if (widget.people[i].selected) i,
  };
  late final _name = TextEditingController(text: widget.suggestedName);
  final _typed = TextEditingController();

  /// The chosen group's id; [_newGroup] for a new one; null until chosen.
  String? _target;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (widget.startNew) _target = _newGroup;
  }

  @override
  void dispose() {
    _name.dispose();
    _typed.dispose();
    super.dispose();
  }

  bool get _creating => _target == _newGroup;

  Future<void> _submit() async {
    final api = ref.read(groupsApiProvider);
    final chosen = [for (final i in _picked) widget.people[i]];
    final typed = splitPeople(_typed.text);
    final userIds = {for (final c in chosen) if (c.userId != null) c.userId!};
    final emails = {
      for (final c in chosen) if (c.userId == null && (c.email ?? '').isNotEmpty) c.email!,
      ...typed.emails,
    };
    final handles = {
      for (final c in chosen) if (c.userId == null && (c.email ?? '').isEmpty && c.kcHandle != null) c.kcHandle!,
      ...typed.handles,
    };

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      String message;
      if (_creating) {
        final name = _name.text.trim();
        // People who were in the meeting go in with the group itself; the
        // server checks they attended. Everyone else is added after.
        final atOnce = widget.fromEventId == null
            ? <String>{}
            : {for (final c in chosen) if (c.attended && c.userId != null) c.userId!};
        final group = await api.create(name: name, fromEventId: widget.fromEventId, memberUserIds: atOnce.toList());
        final rest = userIds.difference(atOnce);
        AddMembersResult? more;
        if (rest.isNotEmpty || emails.isNotEmpty || handles.isNotEmpty) {
          more = await api.addPeople(group.id,
              userIds: rest.toList(), emails: emails.toList(), kcHandles: handles.toList());
        }
        final count = atOnce.length + (more?.added.length ?? 0);
        message = 'Created “${group.name}” with ${count == 1 ? '1 person' : '$count people'}.';
        if (more != null && more.pending.isNotEmpty) {
          message += ' ${more.pending.length == 1 ? '1 person' : '${more.pending.length} people'} without an account yet will join when they sign up.';
        }
      } else {
        final result = await api.addPeople(_target!,
            userIds: userIds.toList(), emails: emails.toList(), kcHandles: handles.toList());
        message = result.summary;
      }
      ref.invalidate(groupsProvider);
      if (mounted) Navigator.of(context).pop(message);
    } catch (e) {
      if (mounted) setState(() => _error = groupErrorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final hasPeople = _picked.isNotEmpty || _typed.text.trim().isNotEmpty;
    final ready = !_busy &&
        _target != null &&
        (_creating ? _name.text.trim().isNotEmpty : hasPeople);

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.85,
        maxChildSize: 0.95,
        builder: (context, scroll) => ListView(
          controller: scroll,
          padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.lg, NeoSpace.xl, NeoSpace.xl),
          children: [
            Text(widget.startNew ? 'Create a group' : 'Add to a group', style: text.titleLarge),
            const SizedBox(height: NeoSpace.md),
            if (!widget.startNew) _GroupChoice(value: _target, onChanged: (v) => setState(() => _target = v)),
            if (_creating)
              TextField(
                controller: _name,
                maxLength: 80,
                decoration: const InputDecoration(labelText: 'Group name'),
                onChanged: (_) => setState(() {}),
              ),
            const SizedBox(height: NeoSpace.md),
            Row(
              children: [
                Expanded(child: Text('People', style: text.titleSmall)),
                if (widget.people.isNotEmpty)
                  TextButton(
                    onPressed: () => setState(() {
                      if (_picked.length == widget.people.length) {
                        _picked.clear();
                      } else {
                        _picked.addAll(List.generate(widget.people.length, (i) => i));
                      }
                    }),
                    child: Text(_picked.length == widget.people.length ? 'Select none' : 'Select all'),
                  ),
              ],
            ),
            for (var i = 0; i < widget.people.length; i++)
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                value: _picked.contains(i),
                onChanged: (on) => setState(() => on == true ? _picked.add(i) : _picked.remove(i)),
                title: Text(widget.people[i].name, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: widget.people[i].detail.isEmpty
                    ? null
                    : Text(widget.people[i].detail, style: TextStyle(color: p.textMuted, fontSize: 12)),
              ),
            const SizedBox(height: NeoSpace.sm),
            TextField(
              controller: _typed,
              minLines: 1,
              maxLines: 3,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: 'Add by KingsChat handle or email',
                hintText: '@handle, name@example.com',
                helperText: 'Anyone without an account joins when they sign up.',
              ),
              onChanged: (_) => setState(() {}),
            ),
            if (_error != null) ...[
              const SizedBox(height: NeoSpace.md),
              Text(_error!, style: TextStyle(color: p.danger)),
            ],
            const SizedBox(height: NeoSpace.lg),
            FilledButton(
              onPressed: ready ? _submit : null,
              child: _busy
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(_creating ? 'Create group' : 'Add to group'),
            ),
          ],
        ),
      ),
    );
  }
}

/// The groups this person can add people to (Moderator and up), and a new one.
class _GroupChoice extends ConsumerWidget {
  const _GroupChoice({required this.value, required this.onChanged});

  final String? value;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final groups = ref.watch(groupsProvider);
    final mine = [
      for (final g in groups.valueOrNull ?? const <GroupSummary>[])
        if (g.role.rank >= GroupRole.moderator.rank) g,
    ];
    return RadioGroup<String>(
      groupValue: value,
      onChanged: onChanged,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (groups.isLoading) const LinearProgressIndicator(),
          if (groups.hasError)
            Text(groupLoadText(groups.error!), style: TextStyle(color: p.danger)),
          for (final g in mine)
            RadioListTile<String>(
              contentPadding: EdgeInsets.zero,
              value: g.group.id,
              title: Text(g.group.name, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text('${g.memberCount} members · you are ${g.role.label}',
                  style: TextStyle(color: p.textMuted, fontSize: 12)),
            ),
          const RadioListTile<String>(
            contentPadding: EdgeInsets.zero,
            value: _newGroup,
            title: Text('A new group'),
          ),
        ],
      ),
    );
  }
}
