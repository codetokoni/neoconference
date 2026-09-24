import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';

import '../core/theme.dart';
import 'room_controller.dart';

/// Everyone's video, laid out so nobody is a sliver.
///
/// One person fills the screen; two stack; more go into a two-column grid
/// that scrolls. Deliberately not fit-to-viewport — a meeting with thirty
/// people on a phone would give each of them a stamp nobody can read.
class ParticipantGrid extends StatelessWidget {
  const ParticipantGrid({
    super.key,
    required this.room,
    required this.raisedHands,
  });

  final Room room;
  final Map<String, String> raisedHands;

  @override
  Widget build(BuildContext context) {
    final tiles = <Widget>[];

    final me = room.localParticipant;
    if (me != null) {
      tiles.add(_Tile(
        participant: me,
        label: 'You',
        handRaised: raisedHands.containsKey(me.identity),
      ));
    }
    for (final p in room.remoteParticipants.values) {
      tiles.add(_Tile(
        participant: p,
        label: p.name.isNotEmpty ? p.name : p.identity,
        handRaised: raisedHands.containsKey(p.identity),
      ));
    }

    if (tiles.isEmpty) {
      return const Center(
        child: Text(
          'Nobody else is here yet.',
          style: TextStyle(color: NeoColors.textDim),
        ),
      );
    }
    if (tiles.length == 1) {
      return Padding(padding: const EdgeInsets.all(8), child: tiles.first);
    }

    return GridView.count(
      padding: const EdgeInsets.all(8),
      crossAxisCount: tiles.length == 2 ? 1 : 2,
      childAspectRatio: tiles.length == 2 ? 1.2 : 0.85,
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
      children: tiles,
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    required this.participant,
    required this.label,
    required this.handRaised,
  });

  final Participant participant;
  final String label;
  final bool handRaised;

  @override
  Widget build(BuildContext context) {
    // Prefer a screen share over a face: if someone is presenting, the
    // presentation is what the meeting is looking at.
    final publications = participant.videoTrackPublications.where(
      (p) => p.subscribed && !p.muted && p.track != null,
    );
    final screen = publications
        .where((p) => p.source == TrackSource.screenShareVideo)
        .firstOrNull;
    final video = screen ?? publications.firstOrNull;
    final track = video?.track;

    final speaking = participant.isSpeaking;

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: NeoColors.bg2,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: speaking ? NeoColors.cyan : const Color(0x2267E8F9),
          width: speaking ? 2 : 1,
        ),
      ),
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (track is VideoTrack)
            VideoTrackRenderer(track, fit: VideoViewFit.contain)
          else
            _Avatar(label: label),
          Positioned(
            left: 6,
            right: 6,
            bottom: 6,
            child: Row(
              children: [
                if (handRaised) const _Pill(child: Text('✋')),
                if (handRaised) const SizedBox(width: 4),
                Flexible(
                  child: _Pill(
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          participant.isMuted
                              ? Icons.mic_off
                              : Icons.mic,
                          size: 12,
                          color: participant.isMuted
                              ? NeoColors.danger
                              : NeoColors.cyanSoft,
                        ),
                        const SizedBox(width: 4),
                        Flexible(
                          child: Text(
                            label,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 11,
                              color: NeoColors.text,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: const Color(0xAA03050A),
        borderRadius: BorderRadius.circular(8),
      ),
      child: child,
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final initial = label.trim().isEmpty ? '?' : label.trim()[0].toUpperCase();
    return Center(
      child: Container(
        height: 64,
        width: 64,
        decoration: const BoxDecoration(
          shape: BoxShape.circle,
          gradient: LinearGradient(colors: [NeoColors.blue, NeoColors.purple]),
        ),
        child: Center(
          child: Text(
            initial,
            style: const TextStyle(
              fontSize: 26,
              fontWeight: FontWeight.w700,
              color: Color(0xFF03181C),
            ),
          ),
        ),
      ),
    );
  }
}

/// Reactions drifting up the screen, then gone.
class ReactionOverlay extends StatelessWidget {
  const ReactionOverlay({super.key, required this.reactions});

  final List<Reaction> reactions;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    // Only the last few seconds' worth. The list itself is never trimmed,
    // so this is what stops old reactions reappearing on a rebuild.
    final live = reactions
        .where((r) => now.difference(r.at) < const Duration(seconds: 3))
        .toList();
    if (live.isEmpty) return const SizedBox.shrink();

    return IgnorePointer(
      child: Stack(
        children: [
          for (var i = 0; i < live.length; i++)
            _FloatingEmoji(
              key: ValueKey('${live[i].at.microsecondsSinceEpoch}-$i'),
              emoji: live[i].emoji,
              offset: (i * 37) % 120,
            ),
        ],
      ),
    );
  }
}

class _FloatingEmoji extends StatefulWidget {
  const _FloatingEmoji({super.key, required this.emoji, required this.offset});

  final String emoji;
  final int offset;

  @override
  State<_FloatingEmoji> createState() => _FloatingEmojiState();
}

class _FloatingEmojiState extends State<_FloatingEmoji>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 3),
  )..forward();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final t = _controller.value;
        return Positioned(
          right: 24.0 + widget.offset,
          bottom: 20 + t * 260,
          child: Opacity(
            opacity: (1 - t).clamp(0.0, 1.0),
            child: Text(widget.emoji, style: const TextStyle(fontSize: 34)),
          ),
        );
      },
    );
  }
}

class RaisedHandsBadge extends StatelessWidget {
  const RaisedHandsBadge({super.key, required this.names});
  final List<String> names;

  @override
  Widget build(BuildContext context) {
    return _Pill(
      child: Text(
        names.length == 1 ? '✋ ${names.first}' : '✋ ${names.length} hands up',
        style: const TextStyle(fontSize: 12, color: NeoColors.text),
      ),
    );
  }
}

/// The controls along the bottom.
class RoomToolbar extends StatelessWidget {
  const RoomToolbar({
    super.key,
    required this.state,
    required this.onMic,
    required this.onCamera,
    required this.onFlipCamera,
    required this.onScreenShare,
    required this.onHand,
    required this.onReact,
    required this.onChat,
    required this.onMore,
    required this.onLeave,
  });

  final RoomState state;
  final VoidCallback onMic;
  final VoidCallback onCamera;
  final VoidCallback onFlipCamera;
  final VoidCallback onScreenShare;
  final VoidCallback onHand;
  final VoidCallback onReact;
  final VoidCallback onChat;
  final VoidCallback? onMore;
  final VoidCallback onLeave;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
      decoration: const BoxDecoration(
        color: NeoColors.bg1,
        border: Border(top: BorderSide(color: Color(0x2267E8F9))),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            _ToolButton(
              icon: state.micOn ? Icons.mic : Icons.mic_off,
              label: state.micOn ? 'Mute' : 'Unmute',
              active: state.micOn,
              onPressed: onMic,
            ),
            _ToolButton(
              icon: state.cameraOn ? Icons.videocam : Icons.videocam_off,
              label: state.cameraOn ? 'Stop video' : 'Start video',
              active: state.cameraOn,
              onPressed: onCamera,
            ),
            if (state.cameraOn)
              _ToolButton(
                icon: Icons.cameraswitch_outlined,
                label: 'Flip',
                onPressed: onFlipCamera,
              ),
            _ToolButton(
              icon: Icons.screen_share_outlined,
              label: 'Share',
              active: state.screenSharing,
              onPressed: onScreenShare,
            ),
            _ToolButton(
              icon: Icons.back_hand_outlined,
              label: 'Hand',
              active: state.handRaised,
              onPressed: onHand,
            ),
            _ToolButton(
              icon: Icons.add_reaction_outlined,
              label: 'React',
              onPressed: onReact,
            ),
            _ToolButton(
              icon: Icons.chat_bubble_outline,
              label: 'Chat',
              badge: state.unreadChat,
              onPressed: onChat,
            ),
            if (onMore != null)
              _ToolButton(
                icon: Icons.shield_outlined,
                label: 'Host',
                badge: state.waitingRoom.length,
                onPressed: onMore!,
              ),
            _ToolButton(
              icon: Icons.call_end,
              label: 'Leave',
              danger: true,
              onPressed: onLeave,
            ),
          ],
        ),
      ),
    );
  }
}

class _ToolButton extends StatelessWidget {
  const _ToolButton({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.active = false,
    this.danger = false,
    this.badge = 0,
  });

  final IconData icon;
  final String label;
  final VoidCallback onPressed;
  final bool active;
  final bool danger;
  final int badge;

  @override
  Widget build(BuildContext context) {
    final color = danger
        ? NeoColors.danger
        : active
            ? NeoColors.cyan
            : NeoColors.textDim;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onPressed,
        child: Container(
          width: 66,
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              badge > 0
                  ? Badge(label: Text('$badge'), child: Icon(icon, color: color))
                  : Icon(icon, color: color),
              const SizedBox(height: 4),
              Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11, color: color),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// In-meeting chat.
class ChatSheet extends ConsumerStatefulWidget {
  const ChatSheet({super.key, required this.slug});
  final String slug;

  @override
  ConsumerState<ChatSheet> createState() => _ChatSheetState();
}

class _ChatSheetState extends ConsumerState<ChatSheet> {
  final _input = TextEditingController();
  final _scroll = ScrollController();

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send() {
    final text = _input.text;
    if (text.trim().isEmpty) return;
    _input.clear();
    unawaited(
      ref.read(roomControllerProvider(widget.slug).notifier).sendChat(text),
    );
  }

  @override
  Widget build(BuildContext context) {
    final chat = ref.watch(
      roomControllerProvider(widget.slug).select((s) => s.chat),
    );

    // Keep the newest message in view as they arrive.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Column(
          children: [
            const _SheetHandle('Chat'),
            Expanded(
              child: chat.isEmpty
                  ? const Center(
                      child: Text(
                        'No messages yet.',
                        style: TextStyle(color: NeoColors.textDim),
                      ),
                    )
                  : ListView.builder(
                      controller: _scroll,
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      itemCount: chat.length,
                      itemBuilder: (context, i) => _ChatBubble(chat[i]),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _send(),
                      decoration: const InputDecoration(
                        hintText: 'Message everyone',
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    onPressed: _send,
                    icon: const Icon(Icons.send),
                    style: IconButton.styleFrom(
                      backgroundColor: NeoColors.cyan,
                      foregroundColor: const Color(0xFF03181C),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ChatBubble extends StatelessWidget {
  const _ChatBubble(this.line);
  final ChatLine line;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                line.name,
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: NeoColors.cyanSoft,
                ),
              ),
              if (line.isDirect) ...[
                const SizedBox(width: 6),
                const Text(
                  'direct',
                  style: TextStyle(fontSize: 10, color: NeoColors.purple),
                ),
              ],
              const SizedBox(width: 6),
              Text(
                '${line.at.hour.toString().padLeft(2, '0')}:'
                '${line.at.minute.toString().padLeft(2, '0')}',
                style: const TextStyle(fontSize: 10, color: NeoColors.textDim),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(line.text, style: const TextStyle(color: NeoColors.text)),
        ],
      ),
    );
  }
}

/// The queue of people asking to be let in.
class WaitingRoomSheet extends ConsumerWidget {
  const WaitingRoomSheet({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = roomControllerProvider(slug);
    final entries = ref.watch(provider.select((s) => s.waitingRoom));
    final controller = ref.read(provider.notifier);

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const _SheetHandle('Waiting room'),
          if (entries.isEmpty)
            const Padding(
              padding: EdgeInsets.all(32),
              child: Text(
                'Nobody is waiting.',
                style: TextStyle(color: NeoColors.textDim),
              ),
            )
          else
            ...entries.map(
              (e) => ListTile(
                title: Text(
                  e['name'] as String? ?? 'Someone',
                  style: const TextStyle(color: NeoColors.text),
                ),
                subtitle: e['email'] != null
                    ? Text(
                        e['email'] as String,
                        style: const TextStyle(color: NeoColors.textDim),
                      )
                    : null,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextButton(
                      onPressed: () => controller.decideWaitingRoom(
                          e['id'] as String, false),
                      child: const Text('Deny',
                          style: TextStyle(color: NeoColors.danger)),
                    ),
                    FilledButton(
                      style: FilledButton.styleFrom(
                        minimumSize: const Size(72, 36),
                      ),
                      onPressed: () =>
                          controller.decideWaitingRoom(e['id'] as String, true),
                      child: const Text('Admit'),
                    ),
                  ],
                ),
              ),
            ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}

/// Mute, remove, record — the things only a host or co-host may do.
///
/// Every one of these is a request to the server, which checks the role
/// again. Showing the sheet is a convenience, not a grant of permission.
class HostControlsSheet extends ConsumerWidget {
  const HostControlsSheet({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = roomControllerProvider(slug);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final people = controller.room.remoteParticipants.values.toList();

    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.65,
        child: Column(
          children: [
            const _SheetHandle('Host controls'),
            Row(
              children: [
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: OutlinedButton.icon(
                      onPressed: controller.muteEveryone,
                      icon: const Icon(Icons.mic_off, size: 18),
                      label: const Text('Mute everyone'),
                    ),
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: OutlinedButton.icon(
                      onPressed: controller.toggleRecording,
                      icon: Icon(
                        state.isRecording
                            ? Icons.stop_circle_outlined
                            : Icons.fiber_manual_record,
                        size: 18,
                        color: state.isRecording ? NeoColors.danger : null,
                      ),
                      label: Text(state.isRecording ? 'Stop' : 'Record'),
                    ),
                  ),
                ),
              ],
            ),
            const Divider(height: 24),
            Expanded(
              child: people.isEmpty
                  ? const Center(
                      child: Text(
                        'Nobody else is in the meeting.',
                        style: TextStyle(color: NeoColors.textDim),
                      ),
                    )
                  : ListView.builder(
                      itemCount: people.length,
                      itemBuilder: (context, i) {
                        final p = people[i];
                        final name = p.name.isNotEmpty ? p.name : p.identity;
                        return ListTile(
                          title: Text(name,
                              style: const TextStyle(color: NeoColors.text)),
                          subtitle: Text(
                            p.isMuted ? 'Muted' : 'Unmuted',
                            style: const TextStyle(color: NeoColors.textDim),
                          ),
                          trailing: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              IconButton(
                                tooltip: p.isMuted
                                    ? 'Ask them to unmute'
                                    : 'Mute them',
                                icon: Icon(
                                    p.isMuted ? Icons.record_voice_over : Icons.mic_off),
                                onPressed: () => controller.moderate(
                                  p.identity,
                                  p.isMuted ? 'requestUnmuteAudio' : 'muteAudio',
                                ),
                              ),
                              IconButton(
                                tooltip: 'Remove from meeting',
                                icon: const Icon(Icons.person_remove,
                                    color: NeoColors.danger),
                                onPressed: () =>
                                    _confirmRemove(context, controller, p, name),
                              ),
                            ],
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _confirmRemove(
    BuildContext context,
    RoomController controller,
    Participant p,
    String name,
  ) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: NeoColors.bg2,
        title: Text('Remove $name?'),
        content: const Text('They will be disconnected from the meeting.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: NeoColors.danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (yes == true) await controller.moderate(p.identity, 'kick');
  }
}

class _SheetHandle extends StatelessWidget {
  const _SheetHandle(this.title);
  final String title;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Row(
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              color: NeoColors.text,
            ),
          ),
          const Spacer(),
          IconButton(
            onPressed: () => Navigator.pop(context),
            icon: const Icon(Icons.close, color: NeoColors.textDim),
          ),
        ],
      ),
    );
  }
}
