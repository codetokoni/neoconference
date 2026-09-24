import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';

import '../core/theme.dart';
import 'room_controller.dart';
import 'room_widgets.dart';

class RoomScreen extends ConsumerStatefulWidget {
  const RoomScreen({super.key, required this.slug, required this.title});

  final String slug;
  final String title;

  @override
  ConsumerState<RoomScreen> createState() => _RoomScreenState();
}

class _RoomScreenState extends ConsumerState<RoomScreen> {
  // Camera and microphone permission is not asked for here. WebRTC asks the
  // moment a capture actually starts, which is when someone taps the mic or
  // camera button — and since a meeting is joined muted with the camera off,
  // nobody is asked for a device they never turn on.

  @override
  Widget build(BuildContext context) {
    final provider = roomControllerProvider(widget.slug);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);

    ref.listen(provider.select((s) => s.message), (_, message) {
      if (message == null || !state.inRoom) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(message)));
      controller.clearMessage();
    });

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final leave = !state.inRoom || await _confirmLeave(context);
        if (leave && context.mounted) {
          await controller.leave();
          if (context.mounted) Navigator.of(context).pop();
        }
      },
      child: Scaffold(
        backgroundColor: NeoColors.bg0,
        body: SafeArea(
          child: state.inRoom
              ? _InMeeting(
                  slug: widget.slug,
                  title: widget.title,
                  state: state,
                  controller: controller,
                )
              : _Gate(
                  title: widget.title,
                  state: state,
                  onRetry: controller.join,
                ),
        ),
      ),
    );
  }

  Future<bool> _confirmLeave(BuildContext context) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: NeoColors.bg2,
        title: const Text('Leave the meeting?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Stay'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: NeoColors.danger),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Leave'),
          ),
        ],
      ),
    );
    return result ?? false;
  }
}

/// Everything before the meeting: connecting, waiting, or refused.
class _Gate extends StatelessWidget {
  const _Gate({required this.title, required this.state, required this.onRetry});

  final String title;
  final RoomState state;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final waiting = state.phase == JoinPhase.connecting ||
        state.phase == JoinPhase.knocking ||
        state.phase == JoinPhase.waitingForHost;

    final (icon, headline) = switch (state.phase) {
      JoinPhase.connecting => (Icons.wifi_tethering, 'Joining $title'),
      JoinPhase.knocking => (Icons.door_front_door_outlined, 'In the waiting room'),
      JoinPhase.waitingForHost => (Icons.hourglass_empty, 'Waiting for the host'),
      JoinPhase.denied => (Icons.block, 'Not admitted'),
      JoinPhase.locked => (Icons.lock_outline, 'Meeting locked'),
      JoinPhase.full => (Icons.groups, 'Meeting full'),
      _ => (Icons.error_outline, 'Could not join'),
    };

    return Stack(
      children: [
        Align(
          alignment: Alignment.topLeft,
          child: BackButton(onPressed: () => Navigator.of(context).maybePop()),
        ),
        Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (waiting)
                  const SizedBox(
                    height: 48,
                    width: 48,
                    child: CircularProgressIndicator(strokeWidth: 3),
                  )
                else
                  Icon(icon, size: 48, color: NeoColors.textDim),
                const SizedBox(height: 24),
                Text(
                  headline,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w600,
                    color: NeoColors.text,
                  ),
                ),
                if (state.message != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    state.message!,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: NeoColors.textDim),
                  ),
                ],
                if (!waiting) ...[
                  const SizedBox(height: 28),
                  FilledButton(onPressed: onRetry, child: const Text('Try again')),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _InMeeting extends StatefulWidget {
  const _InMeeting({
    required this.slug,
    required this.title,
    required this.state,
    required this.controller,
  });

  final String slug;
  final String title;
  final RoomState state;
  final RoomController controller;

  @override
  State<_InMeeting> createState() => _InMeetingState();
}

class _InMeetingState extends State<_InMeeting> {
  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final controller = widget.controller;
    final room = controller.room;

    return Column(
      children: [
        _RoomHeader(
          title: widget.title,
          participants: room.remoteParticipants.length + 1,
          link: state.link,
          recording: state.isRecording,
          waiting: state.canManage ? state.waitingRoom.length : 0,
          onWaitingRoom: () => _openWaitingRoom(context, controller, state),
          onLeave: () => Navigator.of(context).maybePop(),
        ),
        Expanded(
          child: Stack(
            children: [
              ParticipantGrid(room: room, raisedHands: state.raisedHands),
              ReactionOverlay(reactions: state.reactions),
              if (state.raisedHands.isNotEmpty)
                Positioned(
                  left: 12,
                  top: 12,
                  child: RaisedHandsBadge(names: state.raisedHands.values.toList()),
                ),
            ],
          ),
        ),
        RoomToolbar(
          state: state,
          onMic: controller.toggleMic,
          onCamera: controller.toggleCamera,
          onFlipCamera: controller.switchCamera,
          onScreenShare: controller.toggleScreenShare,
          onHand: controller.toggleHand,
          onReact: () => _openReactions(context, controller),
          onChat: () => _openChat(context, controller, state),
          onMore: state.canManage
              ? () => _openHostControls(context, controller, state, room)
              : null,
          onLeave: () => Navigator.of(context).maybePop(),
        ),
      ],
    );
  }

  void _openReactions(BuildContext context, RoomController controller) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: NeoColors.bg2,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 12),
          child: Wrap(
            alignment: WrapAlignment.center,
            spacing: 8,
            children: const {
              'heart': '❤️',
              'thumbs': '👍',
              'clap': '👏',
              'laugh': '😂',
              'wow': '😮',
              'fire': '🔥',
            }.entries.map((e) {
              return IconButton(
                iconSize: 40,
                onPressed: () {
                  controller.react(e.key);
                  Navigator.pop(context);
                },
                icon: Text(e.value, style: const TextStyle(fontSize: 34)),
              );
            }).toList(),
          ),
        ),
      ),
    );
  }

  void _openChat(BuildContext context, RoomController controller, RoomState state) {
    controller.markChatRead();
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: NeoColors.bg1,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => ChatSheet(slug: widget.slug),
    );
  }

  void _openWaitingRoom(
    BuildContext context,
    RoomController controller,
    RoomState state,
  ) {
    controller.refreshWaitingRoom();
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: NeoColors.bg1,
      builder: (_) => WaitingRoomSheet(slug: widget.slug),
    );
  }

  void _openHostControls(
    BuildContext context,
    RoomController controller,
    RoomState state,
    Room room,
  ) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: NeoColors.bg1,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => HostControlsSheet(slug: widget.slug),
    );
  }
}

class _RoomHeader extends StatelessWidget {
  const _RoomHeader({
    required this.title,
    required this.participants,
    required this.link,
    required this.recording,
    required this.waiting,
    required this.onWaitingRoom,
    required this.onLeave,
  });

  final String title;
  final int participants;
  final RoomLink link;
  final bool recording;
  final int waiting;
  final VoidCallback onWaitingRoom;
  final VoidCallback onLeave;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: NeoColors.text,
                  ),
                ),
                Row(
                  children: [
                    // While the link is down the participant count is a
                    // leftover from when it was up, so it is not shown —
                    // saying nothing beats saying something false.
                    Text(
                      switch (link) {
                        RoomLink.live => '$participants in the meeting',
                        RoomLink.reconnecting => 'Reconnecting…',
                        RoomLink.lost => 'Connection lost',
                      },
                      style: TextStyle(
                        fontSize: 12,
                        color: link == RoomLink.live
                            ? NeoColors.textDim
                            : NeoColors.danger,
                      ),
                    ),
                    if (recording && link == RoomLink.live) ...[
                      const SizedBox(width: 8),
                      const _RecordingDot(),
                    ],
                  ],
                ),
              ],
            ),
          ),
          if (waiting > 0)
            Badge(
              label: Text('$waiting'),
              child: IconButton(
                tooltip: 'Waiting room',
                onPressed: onWaitingRoom,
                icon: const Icon(Icons.door_front_door_outlined),
              ),
            ),
        ],
      ),
    );
  }
}

class _RecordingDot extends StatelessWidget {
  const _RecordingDot();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          height: 8,
          width: 8,
          decoration: const BoxDecoration(
            color: NeoColors.danger,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 4),
        const Text(
          'Recording',
          style: TextStyle(fontSize: 12, color: NeoColors.danger),
        ),
      ],
    );
  }
}
