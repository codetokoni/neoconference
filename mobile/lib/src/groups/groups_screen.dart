import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/load_error.dart';
import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import 'full_screen_calls.dart';
import 'group_models.dart';
import 'group_screen.dart';
import 'groups_api.dart';
import 'my_meetings_screen.dart';

/// The groups someone is in, as the web's /dashboard/groups lists them:
/// icon, name, size and description, and their role. "New group" makes one
/// with them as its owner.
class GroupsScreen extends ConsumerWidget {
  const GroupsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final groups = ref.watch(groupsProvider);
    final list = groups.valueOrNull;

    return Scaffold(
      backgroundColor: p.bg,
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _create(context, ref),
        icon: const Icon(Icons.group_add_rounded),
        label: const Text('New group'),
      ),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(groupsProvider);
            await ref.read(groupsProvider.future).then((_) {}, onError: (_) {});
          },
          child: ListView(
            padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.xl, NeoSpace.xl, 96),
            children: [
              Row(
                children: [
                  Expanded(child: Text('Groups', style: Theme.of(context).textTheme.headlineSmall)),
                  TextButton.icon(
                    onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const MyMeetingsScreen())),
                    icon: const Icon(Icons.assignment_turned_in_outlined, size: 18),
                    label: const Text('My reports'),
                  ),
                ],
              ),
              const SizedBox(height: NeoSpace.xs),
              Text(
                'Meet, call and chat with the same people again and again.',
                style: TextStyle(color: p.textMuted),
              ),
              const SizedBox(height: NeoSpace.lg),
              const FullScreenCallsBanner(),
              if (groups.hasError && list == null)
                NeoBanner(
                  icon: Icons.cloud_off_rounded,
                  tone: NeoBannerTone.warning,
                  message: describeLoadError(groups.error!),
                  action: () => ref.invalidate(groupsProvider),
                  actionLabel: 'Retry',
                )
              else if (list == null)
                const Column(children: [
                  NeoSkeleton(height: 72),
                  SizedBox(height: NeoSpace.sm),
                  NeoSkeleton(height: 72),
                ])
              else if (list.isEmpty)
                const NeoEmptyState(
                  icon: Icons.groups_rounded,
                  title: 'No groups yet',
                  message: 'Make a group for a team, a cell or a class, then schedule its meetings, '
                      'call its members and chat in one place.',
                )
              else
                for (final g in list)
                  Padding(
                    padding: const EdgeInsets.only(bottom: NeoSpace.sm),
                    child: GroupTile(summary: g, onTap: () => openGroup(context, g.group.id, g.group.name)),
                  ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final created = await showDialog<Group>(context: context, builder: (_) => const NewGroupDialog());
    if (created == null || !context.mounted) return;
    ref.invalidate(groupsProvider);
    await openGroup(context, created.id, created.name);
  }
}

/// Opens a group's page, and refreshes the list on the way back: a group
/// left, deleted or renamed there must not stay as it was here.
Future<void> openGroup(BuildContext context, String id, String name) async {
  final container = ProviderScope.containerOf(context, listen: false);
  await Navigator.of(context).push(MaterialPageRoute(builder: (_) => GroupScreen(groupId: id, title: name)));
  container.invalidate(groupsProvider);
}

class GroupTile extends StatelessWidget {
  const GroupTile({super.key, required this.summary, this.onTap});

  final GroupSummary summary;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final g = summary.group;
    final members = '${summary.memberCount} ${summary.memberCount == 1 ? 'member' : 'members'}';
    return NeoCard(
      onTap: onTap,
      child: Row(
        children: [
          GroupIcon(name: g.name, url: g.iconUrl),
          const SizedBox(width: NeoSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(g.name, style: Theme.of(context).textTheme.titleSmall, maxLines: 1, overflow: TextOverflow.ellipsis),
                const SizedBox(height: 2),
                Text(
                  g.description.isEmpty ? members : '$members · ${g.description}',
                  style: TextStyle(color: p.textMuted, fontSize: 13),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: NeoSpace.sm),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              RolePill(role: summary.role),
              if (summary.unread > 0) ...[
                const SizedBox(height: NeoSpace.xs),
                Badge(
                  label: Text(summary.unread > 99 ? '99+' : '${summary.unread}'),
                  backgroundColor: p.primary,
                  textColor: p.onPrimary,
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

/// A group's picture, or its initial when it has none or the image fails.
class GroupIcon extends StatelessWidget {
  const GroupIcon({super.key, required this.name, required this.url, this.size = 44});

  final String name;
  final String url;
  final double size;

  @override
  Widget build(BuildContext context) {
    final fallback = NeoAvatar(name: name, size: size);
    if (!url.startsWith('https://')) return fallback;
    return ClipRRect(
      borderRadius: BorderRadius.circular(size / 2),
      child: Image.network(
        url,
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => fallback,
      ),
    );
  }
}

class RolePill extends StatelessWidget {
  const RolePill({super.key, required this.role});

  final GroupRole role;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final color = switch (role) {
      GroupRole.owner => p.warning,
      GroupRole.host => p.accent,
      GroupRole.moderator => p.info,
      GroupRole.participant => p.textMuted,
    };
    return NeoPill(role.label, color: color);
  }
}

/// Name and description; creates the group and returns it.
class NewGroupDialog extends ConsumerStatefulWidget {
  const NewGroupDialog({super.key});

  @override
  ConsumerState<NewGroupDialog> createState() => _NewGroupDialogState();
}

class _NewGroupDialogState extends ConsumerState<NewGroupDialog> {
  final _name = TextEditingController();
  final _description = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Give the group a name.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final group = await ref.read(groupsApiProvider).create(name: name, description: _description.text.trim());
      if (mounted) Navigator.pop(context, group);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = groupErrorText(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return AlertDialog(
      title: const Text('New group'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _name,
            autofocus: true,
            maxLength: 80,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Name'),
            onSubmitted: (_) => _submit(),
          ),
          TextField(
            controller: _description,
            maxLength: 500,
            minLines: 1,
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'Description (optional)'),
          ),
          if (_error != null) Text(_error!, style: TextStyle(color: p.danger)),
        ],
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(onPressed: _busy ? null : _submit, child: Text(_busy ? 'Creating…' : 'Create')),
      ],
    );
  }
}
