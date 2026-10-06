import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import 'group_models.dart';
import 'groups_api.dart';

/// The owner's controls: name, description, icon, how calls ring, handing
/// the group to someone else, and deleting it.
class GroupSettingsTab extends ConsumerStatefulWidget {
  const GroupSettingsTab({super.key, required this.detail});

  final GroupDetail detail;

  @override
  ConsumerState<GroupSettingsTab> createState() => _GroupSettingsTabState();
}

class _GroupSettingsTabState extends ConsumerState<GroupSettingsTab> {
  late final _name = TextEditingController(text: widget.detail.group.name);
  late final _description = TextEditingController(text: widget.detail.group.description);
  late final _icon = TextEditingController(text: widget.detail.group.iconUrl);
  late int _retry = widget.detail.group.settings.retryIntervalMin;
  late int _attempts = widget.detail.group.settings.maxAttempts;
  String? _newOwner;
  bool _saving = false;

  GroupDetail get d => widget.detail;
  GroupsApi get _api => ref.read(groupsApiProvider);

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    _icon.dispose();
    super.dispose();
  }

  void _say(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    try {
      await _api.update(
        d.group.id,
        name: _name.text.trim(),
        description: _description.text.trim(),
        iconUrl: _icon.text.trim(),
        retryIntervalMin: _retry,
        maxAttempts: _attempts,
      );
      _say('Saved.');
      ref.invalidate(groupDetailProvider(d.group.id));
      ref.invalidate(groupsProvider);
    } catch (e) {
      _say(groupErrorText(e));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _transfer() async {
    final to = d.members.where((m) => m.userId == _newOwner).firstOrNull;
    if (to == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Make ${to.displayName} the owner?'),
        content: const Text(
          "They take over the group, and its meetings count against their plan. You become a Host. "
          "You can't undo this yourself.",
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Make owner')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _api.setRole(d.group.id, to.userId, GroupRole.owner);
      _say('${to.displayName} now owns the group.');
      ref.invalidate(groupDetailProvider(d.group.id));
      ref.invalidate(groupsProvider);
    } catch (e) {
      _say(groupErrorText(e));
    }
  }

  Future<void> _delete() async {
    final name = await showDialog<String>(
      context: context,
      builder: (_) => _DeleteGroupDialog(groupName: d.group.name),
    );
    if (name == null || !mounted) return;
    final navigator = Navigator.of(context);
    try {
      await _api.delete(d.group.id, name);
      ref.invalidate(groupsProvider);
      navigator.pop();
    } catch (e) {
      _say(groupErrorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final caps = d.capabilities;
    final others = [for (final m in d.members) if (m.userId != d.myUserId) m];
    return ListView(
      padding: const EdgeInsets.all(NeoSpace.xl),
      children: [
        if (caps.editSettings) ...[
          NeoSection(
            title: 'About',
            child: Column(
              children: [
                TextField(controller: _name, maxLength: 80, decoration: const InputDecoration(labelText: 'Name')),
                TextField(
                  controller: _description,
                  maxLength: 500,
                  minLines: 1,
                  maxLines: 4,
                  decoration: const InputDecoration(labelText: 'Description'),
                ),
                TextField(
                  controller: _icon,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(labelText: 'Icon image link (https://…)'),
                ),
              ],
            ),
          ),
          NeoSection(
            title: 'Calling',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text("When someone doesn't answer a meeting's call:", style: TextStyle(color: p.textMuted)),
                const SizedBox(height: NeoSpace.sm),
                _Stepper(
                  label: 'Ring again every',
                  value: _retry,
                  min: 1,
                  max: 60,
                  unit: (v) => v == 1 ? 'minute' : 'minutes',
                  onChanged: (v) => setState(() => _retry = v),
                ),
                _Stepper(
                  label: 'Ring at most',
                  value: _attempts,
                  min: 1,
                  max: 10,
                  unit: (v) => v == 1 ? 'time' : 'times',
                  onChanged: (v) => setState(() => _attempts = v),
                ),
              ],
            ),
          ),
          FilledButton(onPressed: _saving ? null : _save, child: Text(_saving ? 'Saving…' : 'Save')),
          const SizedBox(height: NeoSpace.xxl),
        ],
        if (caps.transferOwnership && others.isNotEmpty)
          NeoSection(
            title: 'Hand over the group',
            child: Row(
              children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    initialValue: _newOwner,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'New owner'),
                    items: [
                      for (final m in others)
                        DropdownMenuItem(value: m.userId, child: Text(m.displayName, overflow: TextOverflow.ellipsis)),
                    ],
                    onChanged: (v) => setState(() => _newOwner = v),
                  ),
                ),
                const SizedBox(width: NeoSpace.sm),
                OutlinedButton(onPressed: _newOwner == null ? null : _transfer, child: const Text('Make owner')),
              ],
            ),
          ),
        if (caps.deleteGroup)
          NeoSection(
            title: 'Delete',
            child: Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                onPressed: _delete,
                style: OutlinedButton.styleFrom(foregroundColor: p.danger, side: BorderSide(color: p.danger)),
                icon: const Icon(Icons.delete_outline_rounded),
                label: const Text('Delete group'),
              ),
            ),
          ),
      ],
    );
  }
}

/// Asks for the group's name typed back; returns it, or null on Cancel.
///
/// Its own widget so the text field's controller lives exactly as long as
/// the dialog: disposed by the caller instead, it went while the dialog was
/// still animating out, and the closing frame used it.
class _DeleteGroupDialog extends StatefulWidget {
  const _DeleteGroupDialog({required this.groupName});

  final String groupName;

  @override
  State<_DeleteGroupDialog> createState() => _DeleteGroupDialogState();
}

class _DeleteGroupDialogState extends State<_DeleteGroupDialog> {
  final _typed = TextEditingController();

  @override
  void dispose() {
    _typed.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final matches = _typed.text.trim() == widget.groupName;
    return AlertDialog(
      title: const Text('Delete this group?'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Its members, chat and activity are deleted for everyone. Past meetings stay in their history.'),
          const SizedBox(height: NeoSpace.md),
          Text('Type "${widget.groupName}" to confirm.', style: TextStyle(color: p.textMuted)),
          TextField(controller: _typed, autofocus: true, onChanged: (_) => setState(() {})),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        TextButton(
          onPressed: matches ? () => Navigator.pop(context, _typed.text.trim()) : null,
          child: Text('Delete', style: TextStyle(color: matches ? p.danger : p.textFaint)),
        ),
      ],
    );
  }
}

/// A number picked with − and +, between [min] and [max].
class _Stepper extends StatelessWidget {
  const _Stepper({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.unit,
    required this.onChanged,
  });

  final String label;
  final int value;
  final int min;
  final int max;
  final String Function(int) unit;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Row(
      children: [
        Expanded(child: Text(label, style: TextStyle(color: p.text))),
        IconButton(
          tooltip: 'Fewer',
          onPressed: value > min ? () => onChanged(value - 1) : null,
          icon: const Icon(Icons.remove_rounded),
        ),
        SizedBox(
          width: 96,
          child: Text('$value ${unit(value)}', textAlign: TextAlign.center, style: TextStyle(color: p.text)),
        ),
        IconButton(
          tooltip: 'More',
          onPressed: value < max ? () => onChanged(value + 1) : null,
          icon: const Icon(Icons.add_rounded),
        ),
      ],
    );
  }
}
