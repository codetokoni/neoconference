import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_controller.dart';
import '../core/load_error.dart';
import '../design/brand.dart';
import '../room/room_screen.dart';
import 'create_meeting_screen.dart';
import 'event.dart';

class EventsScreen extends ConsumerWidget {
  const EventsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final events = ref.watch(eventsProvider);
    final name = ref.watch(authProvider.select((s) => s.displayName));

    // The upgrade confirmation is raised on the landing screen, which owns
    // it — two listeners would race to show and clear the same message.

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Meetings', style: TextStyle(fontWeight: FontWeight.w700)),
            if (name != null)
              Text(
                'Signed in as $name',
                style: TextStyle(fontSize: 12, color: p.textMuted),
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
      floatingActionButton: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          FloatingActionButton.extended(
            heroTag: 'join',
            backgroundColor: p.surfaceAlt,
            foregroundColor: p.primary,
            onPressed: () => _joinByCode(context),
            icon: const Icon(Icons.login),
            label: const Text('Join with a link'),
          ),
          const SizedBox(height: 10),
          FloatingActionButton.extended(
            heroTag: 'create',
            backgroundColor: p.primary,
            foregroundColor: p.onPrimary,
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const CreateMeetingScreen()),
            ),
            icon: const Icon(Icons.add),
            label: const Text('New meeting'),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => ref.refresh(eventsProvider.future),
        child: events.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => _Message(
            icon: Icons.cloud_off,
            title: 'Could not load your meetings',
            detail: describeLoadError(e),
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
                      'Start one with New meeting, or join any meeting with '
                      'its link.',
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
      // Colour and shape come from dialogTheme, so the dialog follows the
      // chosen theme rather than staying on the original dark surface.
      builder: (context) => AlertDialog(
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
    final p = NeoTheme.of(context);
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
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                        color: p.text,
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
                            style: TextStyle(
                              color: p.textMuted,
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
                Icon(Icons.chevron_right, color: p.primary),
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
    final p = NeoTheme.of(context);
    // Live is the palette's primary because it is the one state worth
    // acting on; the rest borrow the supporting colours so a light theme
    // does not end up with pale chips on a pale card.
    final (label, color) = switch (event.state) {
      'live' => ('Live', p.primary),
      'waiting' => ('Waiting', p.info),
      'ended' => ('Ended', p.textMuted),
      'replay' => ('Replay', p.accent),
      'archived' => ('Archived', p.textMuted),
      _ => ('Scheduled', p.accent),
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
    final p = NeoTheme.of(context);
    // A ListView so pull-to-refresh still works on an empty or failed list.
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 80),
      children: [
        Icon(icon, size: 48, color: p.textMuted),
        const SizedBox(height: 16),
        Text(
          title,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: p.text,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          detail,
          textAlign: TextAlign.center,
          style: TextStyle(color: p.textMuted),
        ),
        if (action != null) ...[const SizedBox(height: 24), action!],
      ],
    );
  }
}
