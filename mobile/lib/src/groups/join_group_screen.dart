import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import 'group_models.dart';
import 'group_screen.dart';
import 'groups_api.dart';
import 'groups_screen.dart' show GroupIcon;

/// The invite token in a group invite link, or null when it is not one.
///
/// The website's invite links are `https://www.neoconference.app/groups/join/<token>`
/// (`POST /api/groups/<id>/invite`); the token is 22 URL-safe characters.
String? groupInviteTokenFromLink(Uri uri) {
  if (uri.scheme != 'https') return null;
  if (uri.host != 'www.neoconference.app' && uri.host != 'neoconference.app') return null;
  final parts = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  if (parts.length != 3 || parts[0] != 'groups' || parts[1] != 'join') return null;
  final token = parts[2];
  return RegExp(r'^[A-Za-z0-9_-]{8,64}$').hasMatch(token) ? token : null;
}

/// What an invite link leads to, and Join.
class JoinGroupScreen extends ConsumerStatefulWidget {
  const JoinGroupScreen({super.key, required this.token});

  final String token;

  @override
  ConsumerState<JoinGroupScreen> createState() => _JoinGroupScreenState();
}

class _JoinGroupScreenState extends ConsumerState<JoinGroupScreen> {
  late Future<InvitePreview> _preview = ref.read(groupsApiProvider).invitePreview(widget.token);
  bool _joining = false;
  String? _error;

  Future<void> _join(InvitePreview preview) async {
    setState(() {
      _joining = true;
      _error = null;
    });
    try {
      final id = await ref.read(groupsApiProvider).redeemInvite(widget.token);
      ref.invalidate(groupsProvider);
      if (!mounted) return;
      _open(id, preview.groupName);
    } catch (e) {
      if (mounted) {
        setState(() {
          _joining = false;
          _error = groupErrorText(e);
        });
      }
    }
  }

  void _open(String id, String name) {
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => GroupScreen(groupId: id, title: name)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(title: const Text('Group invite')),
      body: FutureBuilder<InvitePreview>(
        future: _preview,
        builder: (context, snap) {
          if (snap.hasError) {
            return Padding(
              padding: const EdgeInsets.all(NeoSpace.xl),
              child: NeoBanner(
                icon: Icons.link_off_rounded,
                tone: NeoBannerTone.warning,
                message: groupLoadText(snap.error!),
                action: () => setState(() => _preview = ref.read(groupsApiProvider).invitePreview(widget.token)),
                actionLabel: 'Retry',
              ),
            );
          }
          final preview = snap.data;
          if (preview == null) return const Center(child: CircularProgressIndicator());
          final count = preview.memberCount;
          return ListView(
            padding: const EdgeInsets.all(NeoSpace.xl),
            children: [
              Center(child: GroupIcon(name: preview.groupName, url: preview.iconUrl, size: 72)),
              const SizedBox(height: NeoSpace.lg),
              Text(
                preview.groupName,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineSmall,
              ),
              const SizedBox(height: NeoSpace.xs),
              Text(
                '$count ${count == 1 ? 'member' : 'members'}',
                textAlign: TextAlign.center,
                style: TextStyle(color: p.textMuted),
              ),
              if (preview.description.isNotEmpty) ...[
                const SizedBox(height: NeoSpace.md),
                Text(preview.description, textAlign: TextAlign.center, style: TextStyle(color: p.text)),
              ],
              const SizedBox(height: NeoSpace.xxl),
              if (preview.alreadyMember && preview.groupId != null)
                FilledButton(
                  onPressed: () => _open(preview.groupId!, preview.groupName),
                  child: const Text("You're in this group · Open it"),
                )
              else
                FilledButton(
                  onPressed: _joining ? null : () => _join(preview),
                  child: Text(_joining ? 'Joining…' : 'Join group'),
                ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: NeoSpace.md),
                  child: Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: p.danger)),
                ),
            ],
          );
        },
      ),
    );
  }
}
