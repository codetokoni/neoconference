import 'dart:async';

import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../meetings/room_view.dart';
import 'room_controller.dart';

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
    final p = NeoTheme.of(context);
    final state = ref.watch(roomControllerProvider(widget.slug));
    final chat = state.chat;

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
            if (state.chatError != null)
              Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: p.danger.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: p.danger.withValues(alpha: 0.33)),
                ),
                child: Text(
                  state.chatError!,
                  style: TextStyle(color: p.text, fontSize: 12),
                ),
              ),
            Expanded(
              child: chat.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              'No messages yet.',
                              style: TextStyle(color: p.textMuted),
                            ),
                            // The packet counters are a debugging instrument
                            // for data-channel trouble on bad networks (see
                            // RoomController._publish), not
                            // something to put in front of someone waiting
                            // for a colleague to say hello.
                            if (kDebugMode) ...[
                              const SizedBox(height: 6),
                              Text(
                                '${state.dataPacketsSeen} data packets, '
                                '${state.chatPacketsSeen} chat.'
                                '${state.lastDataTopic == null ? '' : '\nLast topic: ${state.lastDataTopic}'}'
                                '${state.lastDataError == null ? '' : '\n${state.lastDataError}'}',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  color: p.textMuted,
                                  fontSize: 11,
                                ),
                              ),
                            ],
                          ],
                        ),
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
                      backgroundColor: p.primary,
                      foregroundColor: p.onPrimary,
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
    final p = NeoTheme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                line.name,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: p.primary,
                ),
              ),
              if (line.isDirect) ...[
                const SizedBox(width: 6),
                Text(
                  'direct',
                  style: TextStyle(fontSize: 10, color: p.accent),
                ),
              ],
              const SizedBox(width: 6),
              Text(
                '${line.at.hour.toString().padLeft(2, '0')}:'
                '${line.at.minute.toString().padLeft(2, '0')}',
                style: TextStyle(fontSize: 10, color: p.textMuted),
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(line.text, style: TextStyle(color: p.text)),
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
    // `palette`, not `p`: the sheets in this file use `p` for a participant.
    final palette = NeoTheme.of(context);
    final provider = roomControllerProvider(slug);
    final entries = ref.watch(provider.select((s) => s.waitingRoom));
    final controller = ref.read(provider.notifier);

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const _SheetHandle('Waiting room'),
          if (entries.isEmpty)
            Padding(
              padding: const EdgeInsets.all(32),
              child: Text(
                'Nobody is waiting.',
                style: TextStyle(color: palette.textMuted),
              ),
            )
          else
            ...entries.map(
              (e) => ListTile(
                title: Text(
                  e['name'] as String? ?? 'Someone',
                  style: TextStyle(color: palette.text),
                ),
                subtitle: e['email'] != null
                    ? Text(
                        e['email'] as String,
                        style: TextStyle(color: palette.textMuted),
                      )
                    : null,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextButton(
                      onPressed: () => controller.decideWaitingRoom(
                          e['id'] as String, false),
                      child: Text('Deny',
                          style: TextStyle(color: palette.danger)),
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
    // `palette`, not `p`: the list below uses `p` for a participant.
    final palette = NeoTheme.of(context);
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
                    // A recording started on another device cannot be stopped
                    // from here (the stop route needs its egress id), and
                    // offering Record would start a second one. Shown, not
                    // offered.
                    child: OutlinedButton.icon(
                      onPressed: state.isRecording && !state.recordingHere
                          ? null
                          : controller.toggleRecording,
                      icon: Icon(
                        state.isRecording
                            ? Icons.stop_circle_outlined
                            : Icons.fiber_manual_record,
                        size: 18,
                        color: state.isRecording ? palette.danger : null,
                      ),
                      label: Text(
                        !state.isRecording
                            ? 'Record'
                            : state.recordingHere
                                ? 'Stop'
                                : 'Recording',
                      ),
                    ),
                  ),
                ),
              ],
            ),
            // Not offered until the server has said which way it is set.
            if (state.waitingRoomEnabled != null)
              SwitchListTile(
                value: state.waitingRoomEnabled!,
                onChanged: controller.setWaitingRoom,
                title: Text('Waiting room',
                    style: TextStyle(color: palette.text)),
                subtitle: Text(
                  state.waitingRoomEnabled!
                      ? 'New arrivals wait for you to let them in.'
                      : 'Anyone with the link comes straight in.',
                  style: TextStyle(color: palette.textMuted),
                ),
              ),
            const Divider(height: 24),
            Expanded(
              child: people.isEmpty
                  ? Center(
                      child: Text(
                        'Nobody else is in the meeting.',
                        style: TextStyle(color: palette.textMuted),
                      ),
                    )
                  : ListView.builder(
                      itemCount: people.length,
                      itemBuilder: (context, i) {
                        final p = people[i];
                        final name = p.name.isNotEmpty ? p.name : p.identity;
                        return ListTile(
                          title: Text(name,
                              style: TextStyle(color: palette.text)),
                          subtitle: Text(
                            p.isMuted ? 'Muted' : 'Unmuted',
                            style: TextStyle(color: palette.textMuted),
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
                                icon: Icon(Icons.person_remove,
                                    color: palette.danger),
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
}

class _SheetHandle extends StatelessWidget {
  const _SheetHandle(this.title);
  final String title;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Row(
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              color: p.text,
            ),
          ),
          const Spacer(),
          IconButton(
            onPressed: () => Navigator.pop(context),
            icon: Icon(Icons.close, color: p.textMuted),
          ),
        ],
      ),
    );
  }
}

/// Asks before removing someone, from either sheet that offers it.
Future<void> _confirmRemove(
  BuildContext context,
  RoomController controller,
  Participant p,
  String name,
) async {
  final yes = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text('Remove $name?'),
      content: const Text('They will be disconnected from the meeting.'),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: NeoTheme.of(context).danger,
          ),
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Remove'),
        ),
      ],
    ),
  );
  if (yes == true) await controller.moderate(p.identity, 'kick');
}

/// Who is in the meeting.
///
/// Read from LiveKit rather than from a roster the server sent: the people
/// on this list are the people whose media this device is actually
/// connected to, which is the only list that cannot be out of date.
class ParticipantsSheet extends ConsumerWidget {
  const ParticipantsSheet({super.key, required this.slug});
  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = NeoTheme.of(context);
    final provider = roomControllerProvider(slug);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final room = controller.room;

    final me = room.localParticipant;
    final others = room.remoteParticipants.values.toList();

    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Column(
          children: [
            _SheetHandle('In the meeting (${others.length + (me == null ? 0 : 1)})'),
            Expanded(
              child: ListView(
                children: [
                  if (me != null)
                    _PersonRow(
                      name: 'You',
                      muted: me.isMuted,
                      speaking: me.isSpeaking,
                      handRaised: state.raisedHands.containsKey(me.identity),
                      role: state.role,
                    ),
                  for (final person in others)
                    _PersonRow(
                      name: person.name.isNotEmpty
                          ? person.name
                          : person.identity,
                      muted: person.isMuted,
                      speaking: person.isSpeaking,
                      handRaised:
                          state.raisedHands.containsKey(person.identity),
                      // This is the list hosts open when they want someone
                      // out. With Remove only under More -> Host controls,
                      // a host on a real phone looked here, found nothing,
                      // and the person stayed in the meeting.
                      onRemove: state.canManage
                          ? () => _confirmRemove(
                                context,
                                controller,
                                person,
                                person.name.isNotEmpty
                                    ? person.name
                                    : person.identity,
                              )
                          : null,
                    ),
                ],
              ),
            ),
            if (state.canManage)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                child: OutlinedButton.icon(
                  onPressed: () {
                    Navigator.pop(context);
                    controller.muteEveryone();
                  },
                  icon: const Icon(Icons.mic_off, size: 18),
                  label: const Text('Mute everyone'),
                  style: OutlinedButton.styleFrom(
                    minimumSize: const Size.fromHeight(48),
                    foregroundColor: palette.primary,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _PersonRow extends StatelessWidget {
  const _PersonRow({
    required this.name,
    required this.muted,
    required this.speaking,
    required this.handRaised,
    this.role,
    this.onRemove,
  });

  final String name;
  final bool muted;
  final bool speaking;
  final bool handRaised;

  /// Null unless this device may remove people, and never for its own row.
  final VoidCallback? onRemove;

  /// Only known for this device: LiveKit does not carry everyone's role.
  final String? role;

  @override
  Widget build(BuildContext context) {
    final palette = NeoTheme.of(context);
    return ListTile(
      leading: NeoAvatar(name: name, size: 38),
      title: Text(name, style: TextStyle(color: palette.text)),
      subtitle: role == null
          ? null
          : Text(
              role![0].toUpperCase() + role!.substring(1),
              style: TextStyle(color: palette.textMuted),
            ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (handRaised) const Text('✋'),
          if (handRaised) const SizedBox(width: 10),
          Icon(
            muted ? Icons.mic_off : Icons.mic,
            size: 18,
            color: muted
                ? palette.textFaint
                : speaking
                    ? palette.success
                    : palette.textMuted,
          ),
          if (onRemove != null)
            IconButton(
              tooltip: 'Remove from meeting',
              icon: Icon(Icons.person_remove, color: palette.danger),
              onPressed: onRemove,
            ),
        ],
      ),
    );
  }
}

/// The meeting, in a window a few centimetres wide.
///
/// Android renders whatever the activity draws into the PiP window, so
/// without this the full meeting screen is scaled down: a control bar
/// nobody can hit and a filmstrip of smudges. This shows the one thing
/// worth seeing at that size — whoever is talking — and the mic state,
/// because "am I still muted" is the question people float a call to keep
/// an eye on.
class PipView extends StatelessWidget {
  const PipView({super.key, required this.room});

  final RoomView room;

  @override
  Widget build(BuildContext context) {
    final palette = NeoTheme.of(context);
    final focus = room.focus;
    final video = focus?.video;

    return ColoredBox(
      color: palette.bg,
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (video != null)
            video
          else
            Center(
              child: NeoAvatar(name: focus?.name ?? room.title, size: 48),
            ),
          // Weak is still connected, and veiling the video over it would
          // read as "Connection lost" in a window too small to say more.
          if (room.link == RoomLinkState.reconnecting ||
              room.link == RoomLinkState.lost)
            Positioned.fill(
              child: ColoredBox(
                color: palette.bg.withValues(alpha: 0.72),
                child: Center(
                  child: Text(
                    room.link == RoomLinkState.reconnecting
                        ? 'Reconnecting…'
                        : 'Connection lost',
                    style: TextStyle(color: palette.text, fontSize: 12),
                  ),
                ),
              ),
            ),
          Positioned(
            left: 6,
            bottom: 6,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
              decoration: BoxDecoration(
                color: Colors.black.withValues(alpha: 0.55),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    room.micOn ? Icons.mic_rounded : Icons.mic_off_rounded,
                    size: 11,
                    color: room.micOn ? palette.success : palette.danger,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    focus?.isMe ?? true ? 'You' : focus!.name,
                    style: TextStyle(color: palette.text, fontSize: 10),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
