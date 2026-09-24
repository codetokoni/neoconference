import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_controller.dart';
import '../core/theme.dart';
import '../room/room_screen.dart';
import 'event.dart';

class EventsScreen extends ConsumerWidget {
  const EventsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final events = ref.watch(eventsProvider);
    final name = ref.watch(authProvider.select((s) => s.displayName));

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Meetings', style: TextStyle(fontWeight: FontWeight.w700)),
            if (name != null)
              Text(
                'Signed in as $name',
                style: const TextStyle(fontSize: 12, color: NeoColors.textDim),
              ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Sign out',
            icon: const Icon(Icons.logout),
            onPressed: () => ref.read(authProvider.notifier).signOut(),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: NeoColors.cyan,
        foregroundColor: const Color(0xFF03181C),
        onPressed: () => _joinByCode(context),
        icon: const Icon(Icons.login),
        label: const Text('Join with a link'),
      ),
      body: RefreshIndicator(
        onRefresh: () async => ref.refresh(eventsProvider.future),
        child: events.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => _Message(
            icon: Icons.cloud_off,
            title: 'Could not load your meetings',
            detail: '$e',
            action: FilledButton(
              onPressed: () => ref.invalidate(eventsProvider),
              child: const Text('Try again'),
            ),
          ),
          data: (list) => list.isEmpty
              ? const _Message(
                  icon: Icons.event_available,
                  title: 'No meetings yet',
                  detail:
                      'Meetings you create on neoconference.app show up here. '
                      'You can still join any meeting with its link.',
                )
              : ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
                  itemCount: list.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 10),
                  itemBuilder: (context, i) => _EventCard(list[i]),
                ),
        ),
      ),
    );
  }

  Future<void> _joinByCode(BuildContext context) async {
    final controller = TextEditingController();
    final slug = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: NeoColors.bg2,
        title: const Text('Join a meeting'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: 'Meeting link or code',
          ),
          onSubmitted: (v) => Navigator.pop(context, v),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text),
            child: const Text('Join'),
          ),
        ],
      ),
    );
    if (slug == null || !context.mounted) return;

    // People paste the whole link. Take the last path segment, which is the
    // slug on both neoconference.app/<slug> and /room/<slug>.
    final cleaned = slug
        .trim()
        .replaceAll(RegExp(r'[?#].*$'), '')
        .split('/')
        .where((s) => s.isNotEmpty && s != 'room')
        .lastOrNull;
    if (cleaned == null || cleaned.isEmpty) return;

    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => RoomScreen(slug: cleaned, title: cleaned)),
    );
  }
}

class _EventCard extends StatelessWidget {
  const _EventCard(this.event);
  final NeoEvent event;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: event.canJoin
            ? () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) =>
                        RoomScreen(slug: event.slug, title: event.name),
                  ),
                )
            : null,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      event.name,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: NeoColors.text,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        _StateChip(event),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            _subtitle(event),
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: NeoColors.textDim,
                              fontSize: 12,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              if (event.canJoin)
                const Icon(Icons.chevron_right, color: NeoColors.cyanSoft),
            ],
          ),
        ),
      ),
    );
  }

  static String _subtitle(NeoEvent e) {
    if (e.isPermanent) return 'Your personal room';
    final when = e.startedAt ?? e.scheduledAt;
    if (when == null) return e.slug;
    final d = '${when.day}/${when.month}';
    final t = '${when.hour.toString().padLeft(2, '0')}:'
        '${when.minute.toString().padLeft(2, '0')}';
    return '$d at $t';
  }
}

class _StateChip extends StatelessWidget {
  const _StateChip(this.event);
  final NeoEvent event;

  @override
  Widget build(BuildContext context) {
    final (label, color) = switch (event.state) {
      'live' => ('Live', NeoColors.cyan),
      'waiting' => ('Waiting', NeoColors.blue),
      'ended' => ('Ended', NeoColors.textDim),
      'replay' => ('Replay', NeoColors.purple),
      'archived' => ('Archived', NeoColors.textDim),
      _ => ('Scheduled', NeoColors.purple),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withValues(alpha: 0.45)),
      ),
      child: Text(
        label,
        style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({
    required this.icon,
    required this.title,
    required this.detail,
    this.action,
  });

  final IconData icon;
  final String title;
  final String detail;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    // A ListView so pull-to-refresh still works on an empty or failed list.
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 80),
      children: [
        Icon(icon, size: 48, color: NeoColors.textDim),
        const SizedBox(height: 16),
        Text(
          title,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: NeoColors.text,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          detail,
          textAlign: TextAlign.center,
          style: const TextStyle(color: NeoColors.textDim),
        ),
        if (action != null) ...[const SizedBox(height: 24), action!],
      ],
    );
  }
}
