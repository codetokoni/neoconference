import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/meeting_share.dart' show shareSheet;
import 'group_models.dart';
import 'groups_api.dart';
import 'groups_screen.dart' show RolePill;

/// Who is in the group. Moderators and up add people by email or share an
/// invite link; roles change and people are removed as the server's
/// capabilities allow; anyone but the owner may leave.
class GroupMembersTab extends ConsumerStatefulWidget {
  const GroupMembersTab({super.key, required this.detail});

  final GroupDetail detail;

  @override
  ConsumerState<GroupMembersTab> createState() => _GroupMembersTabState();
}

class _GroupMembersTabState extends ConsumerState<GroupMembersTab> {
  final _emails = TextEditingController();
  bool _adding = false;
  bool _inviting = false;

  /// What the last "Add" did, said under the field.
  String? _addResult;
  bool _addFailed = false;

  GroupDetail get d => widget.detail;
  GroupsApi get _api => ref.read(groupsApiProvider);

  @override
  void dispose() {
    _emails.dispose();
    super.dispose();
  }

  void _refresh() => ref.invalidate(groupDetailProvider(d.group.id));

  void _say(String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  /// Splits on commas, semicolons, spaces and new lines, so a pasted list
  /// works as well as one address.
  static List<String> splitEmails(String text) => [
        for (final part in text.split(RegExp(r'[\s,;]+')))
          if (part.trim().isNotEmpty) part.trim(),
      ];

  Future<void> _add() async {
    final emails = splitEmails(_emails.text);
    if (emails.isEmpty) return;
    setState(() {
      _adding = true;
      _addResult = null;
    });
    try {
      final r = await _api.addByEmail(d.group.id, emails);
      final parts = <String>[
        if (r.added.isNotEmpty) 'Added ${r.added.map((m) => m.displayName).join(', ')}.',
        if (r.alreadyMembers.isNotEmpty)
          '${r.alreadyMembers.length} already ${r.alreadyMembers.length == 1 ? 'is a member' : 'are members'}.',
        if (r.notFound.isNotEmpty)
          'No account for ${r.notFound.join(', ')} — send them the invite link instead.',
      ];
      setState(() {
        _addResult = parts.join(' ');
        _addFailed = r.added.isEmpty;
      });
      if (r.added.isNotEmpty) _emails.clear();
      _refresh();
    } catch (e) {
      setState(() {
        _addResult = groupErrorText(e);
        _addFailed = true;
      });
    } finally {
      if (mounted) setState(() => _adding = false);
    }
  }

  Future<void> _shareInvite() async {
    setState(() => _inviting = true);
    try {
      final invite = await _api.createInvite(d.group.id);
      await shareSheet(ShareParams(
        text: 'Join "${d.group.name}" on NeoConference:\n${invite.url}',
        subject: d.group.name,
      ));
    } catch (e) {
      if (mounted) _say(groupErrorText(e));
    } finally {
      if (mounted) setState(() => _inviting = false);
    }
  }

  Future<void> _copyInvite() async {
    setState(() => _inviting = true);
    try {
      final invite = await _api.createInvite(d.group.id);
      await Clipboard.setData(ClipboardData(text: invite.url));
      if (mounted) _say('Invite link copied. It works for 72 hours.');
    } catch (e) {
      if (mounted) _say(groupErrorText(e));
    } finally {
      if (mounted) setState(() => _inviting = false);
    }
  }

  Future<void> _setRole(GroupMember m, GroupRole role) async {
    try {
      await _api.setRole(d.group.id, m.userId, role);
      _say('${m.displayName} is now ${role == GroupRole.participant ? 'a Member' : 'a ${role.label}'}.');
      _refresh();
    } catch (e) {
      _say(groupErrorText(e));
    }
  }

  Future<void> _remove(GroupMember m) async {
    final ok = await _confirm(
      title: 'Remove ${m.displayName}?',
      body: 'They leave the group and its chat. Their attendance in past meetings stays in the reports.',
      action: 'Remove',
    );
    if (!ok) return;
    try {
      await _api.remove(d.group.id, m.userId);
      _say('${m.displayName} was removed.');
      _refresh();
    } catch (e) {
      _say(groupErrorText(e));
    }
  }

  Future<void> _removePending(PendingMember p) async {
    final ok = await _confirm(
      title: 'Remove ${p.label}?',
      body: "They won't join the group when they sign up. You can add them again.",
      action: 'Remove',
    );
    if (!ok) return;
    try {
      await _api.removePending(d.group.id, p.key);
      _say('${p.label} was removed.');
      _refresh();
    } catch (e) {
      _say(groupErrorText(e));
    }
  }

  Future<void> _leave() async {
    final ok = await _confirm(
      title: 'Leave ${d.group.name}?',
      body: "You won't be rung for its meetings or see its chat. Someone can add you back.",
      action: 'Leave',
    );
    if (!ok || !mounted) return;
    final navigator = Navigator.of(context);
    try {
      await _api.leave(d.group.id);
      ref.invalidate(groupsProvider);
      navigator.pop();
    } catch (e) {
      _say(groupErrorText(e));
    }
  }

  Future<bool> _confirm({required String title, required String body, required String action}) async {
    final p = NeoTheme.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(action, style: TextStyle(color: p.danger)),
          ),
        ],
      ),
    );
    return ok == true;
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final caps = d.capabilities;
    return ListView(
      padding: const EdgeInsets.all(NeoSpace.xl),
      children: [
        if (caps.manageMembers) ...[
          NeoSection(
            title: 'Add people',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _emails,
                        keyboardType: TextInputType.emailAddress,
                        autocorrect: false,
                        decoration: const InputDecoration(
                          labelText: 'Email addresses',
                          hintText: 'name@example.com, …',
                        ),
                        onSubmitted: (_) => _add(),
                      ),
                    ),
                    const SizedBox(width: NeoSpace.sm),
                    Padding(
                      padding: const EdgeInsets.only(top: NeoSpace.sm),
                      child: FilledButton(onPressed: _adding ? null : _add, child: Text(_adding ? 'Adding…' : 'Add')),
                    ),
                  ],
                ),
                if (_addResult != null)
                  Padding(
                    padding: const EdgeInsets.only(top: NeoSpace.sm),
                    child: Text(_addResult!, style: TextStyle(color: _addFailed ? p.warning : p.success)),
                  ),
                const SizedBox(height: NeoSpace.md),
                Wrap(
                  spacing: NeoSpace.sm,
                  runSpacing: NeoSpace.sm,
                  children: [
                    OutlinedButton.icon(
                      onPressed: _inviting ? null : _shareInvite,
                      icon: const Icon(Icons.share_rounded, size: 18),
                      label: const Text('Share invite link'),
                    ),
                    TextButton.icon(
                      onPressed: _inviting ? null : _copyInvite,
                      icon: const Icon(Icons.link_rounded, size: 18),
                      label: const Text('Copy link'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
        NeoSection(
          title: '${d.members.length} ${d.members.length == 1 ? 'member' : 'members'}',
          child: Column(
            children: [
              for (final m in d.members)
                MemberRow(
                  member: m,
                  isMe: m.userId == d.myUserId,
                  roles: m.userId == d.myUserId || !caps.assignableRoles.contains(m.role)
                      ? const []
                      : [for (final r in caps.assignableRoles) if (r != m.role) r],
                  canRemove: m.userId != d.myUserId && caps.removableRoles.contains(m.role),
                  onRole: (r) => _setRole(m, r),
                  onRemove: () => _remove(m),
                ),
            ],
          ),
        ),
        if (caps.manageMembers && d.pending.isNotEmpty)
          NeoSection(
            title: 'Waiting to sign up (${d.pending.length})',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Added by email or KingsChat handle before they had an account. They join the first '
                  "time they sign in with it, and count toward the group's member limit until then.",
                  style: TextStyle(color: p.textMuted, fontSize: 12),
                ),
                for (final x in d.pending)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(x.isKingsChat ? Icons.alternate_email_rounded : Icons.mail_outline_rounded,
                        color: p.textMuted),
                    title: Text(x.label, maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text(
                      x.isKingsChat ? 'KingsChat handle · pending' : 'Email · pending',
                      style: TextStyle(color: p.textMuted, fontSize: 12),
                    ),
                    trailing: IconButton(
                      tooltip: 'Remove ${x.label}',
                      icon: Icon(Icons.person_remove_rounded, color: p.danger),
                      onPressed: () => _removePending(x),
                    ),
                  ),
              ],
            ),
          ),
        if (caps.leave)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: _leave,
              icon: Icon(Icons.logout_rounded, color: p.danger),
              label: Text('Leave group', style: TextStyle(color: p.danger)),
            ),
          ),
      ],
    );
  }
}

/// One person: name, email, role, and a menu of what may be done to them.
class MemberRow extends StatelessWidget {
  const MemberRow({
    super.key,
    required this.member,
    required this.isMe,
    required this.roles,
    required this.canRemove,
    required this.onRole,
    required this.onRemove,
  });

  final GroupMember member;
  final bool isMe;

  /// Roles they may be given, besides the one they have.
  final List<GroupRole> roles;
  final bool canRemove;
  final ValueChanged<GroupRole> onRole;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final hasMenu = roles.isNotEmpty || canRemove;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: NeoSpace.xs),
      child: Row(
        children: [
          NeoAvatar(name: member.displayName, size: 36),
          const SizedBox(width: NeoSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isMe ? '${member.displayName} (you)' : member.displayName,
                  style: TextStyle(color: p.text, fontWeight: FontWeight.w600),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                if (member.email != null)
                  Text(member.email!, style: TextStyle(color: p.textMuted, fontSize: 12), maxLines: 1, overflow: TextOverflow.ellipsis),
              ],
            ),
          ),
          RolePill(role: member.role),
          if (hasMenu)
            PopupMenuButton<String>(
              tooltip: 'Manage ${member.displayName}',
              icon: Icon(Icons.more_vert_rounded, color: p.textMuted),
              onSelected: (v) => v == 'remove' ? onRemove() : onRole(GroupRole.parse(v)),
              itemBuilder: (_) => [
                for (final r in roles)
                  PopupMenuItem(value: r.wire, child: Text(r == GroupRole.participant ? 'Make Member' : 'Make ${r.label}')),
                if (canRemove)
                  PopupMenuItem(value: 'remove', child: Text('Remove from group', style: TextStyle(color: p.danger))),
              ],
            )
          else
            const SizedBox(width: NeoSpace.sm),
        ],
      ),
    );
  }
}
