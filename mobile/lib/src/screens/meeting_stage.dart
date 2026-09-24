import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/room_view.dart';

/// The live meeting.
///
/// Designed to be operated with one hand while doing something else: the
/// controls sit within thumb reach at the bottom, the row never reflows,
/// and Leave is the only red thing on the screen. Tapping the video area
/// hides the chrome for a clean view and brings it back on the next tap.
///
/// Takes a [RoomView] and a [RoomActions] rather than talking to LiveKit
/// or to sample data, so the same screen serves the real meeting and the
/// design review. Everything it knows about the meeting is in those two.
class MeetingStage extends StatefulWidget {
  const MeetingStage({
    super.key,
    required this.room,
    required this.actions,
  });

  final RoomView room;
  final RoomActions actions;

  @override
  State<MeetingStage> createState() => _MeetingStageState();
}

class _MeetingStageState extends State<MeetingStage> {
  RoomLayout _layout = RoomLayout.speaker;
  bool _chromeVisible = true;

  @override
  Widget build(BuildContext context) {
    // The palette is whatever the caller handed down. The meeting is kept
    // dark in both themes — a white screen in a dark room is unkind, and
    // video reads better against black — and that decision belongs to
    // whoever wraps this, not here.
    final room = widget.room;

    return Stack(
      children: [
        GestureDetector(
          onTap: () => setState(() => _chromeVisible = !_chromeVisible),
          behavior: HitTestBehavior.opaque,
          child: AnimatedPadding(
            duration: NeoMotion.base,
            curve: NeoMotion.curve,
            padding: EdgeInsets.only(
              top: _chromeVisible ? 64 : 0,
              bottom: _chromeVisible ? 132 : 0,
            ),
            child: room.people.isEmpty
                ? const _Alone()
                : _layout == RoomLayout.speaker
                    ? _SpeakerView(room: room)
                    : _GridView(room: room),
          ),
        ),
        AnimatedPositioned(
          duration: NeoMotion.base,
          curve: NeoMotion.curve,
          top: _chromeVisible ? 0 : -80,
          left: 0,
          right: 0,
          child: _Header(
            room: room,
            layout: _layout,
            onToggleLayout: () => setState(() {
              _layout = _layout == RoomLayout.speaker
                  ? RoomLayout.grid
                  : RoomLayout.speaker;
            }),
            onParticipants: widget.actions.openParticipants,
            onWaitingRoom: widget.actions.openWaitingRoom,
          ),
        ),
        AnimatedPositioned(
          duration: NeoMotion.base,
          curve: NeoMotion.curve,
          bottom: _chromeVisible ? 0 : -160,
          left: 0,
          right: 0,
          child: _Controls(
            room: room,
            onMic: widget.actions.toggleMic,
            onCamera: widget.actions.toggleCamera,
            onChat: widget.actions.openChat,
            onMore: _openMore,
            onLeave: widget.actions.leave,
          ),
        ),
        if (room.link == RoomLinkState.reconnecting)
          const Positioned.fill(child: _ReconnectingOverlay()),
      ],
    );
  }

  /// Everything beyond the five essentials.
  ///
  /// Raise hand, reactions, screen share and host controls live here: the
  /// bar holds what people reach for without thinking, and Leave must
  /// never be the control that falls off the edge of a narrow phone.
  void _openMore() {
    final room = widget.room;
    final actions = widget.actions;

    neoSheet(
      context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.back_hand_outlined),
              title: Text(room.handRaised ? 'Lower hand' : 'Raise hand'),
              trailing: room.handRaised
                  ? Icon(
                      Icons.check_rounded,
                      color: NeoTheme.of(sheetContext).primary,
                    )
                  : null,
              onTap: () {
                Navigator.pop(sheetContext);
                actions.toggleHand();
              },
            ),
            if (actions.react != null)
              ListTile(
                leading: const Icon(Icons.add_reaction_outlined),
                title: const Text('Send a reaction'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  _openReactions();
                },
              ),
            if (actions.toggleScreenShare != null)
              ListTile(
                leading: const Icon(Icons.screen_share_outlined),
                title: Text(
                  room.screenSharing ? 'Stop sharing' : 'Share screen',
                ),
                subtitle: room.screenSharing
                    ? null
                    : const Text('Android asks for consent first'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  actions.toggleScreenShare!();
                },
              ),
            if (actions.switchCamera != null && room.cameraOn)
              ListTile(
                leading: const Icon(Icons.cameraswitch_outlined),
                title: const Text('Flip camera'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  actions.switchCamera!();
                },
              ),
            if (actions.enterPip != null)
              ListTile(
                leading: const Icon(Icons.picture_in_picture_alt_rounded),
                title: const Text('Float the meeting'),
                subtitle: const Text('Keep it in a corner while you work'),
                onTap: () async {
                  Navigator.pop(sheetContext);
                  final floated = await actions.enterPip!();
                  // Picture in Picture can be switched off per app in
                  // Android settings, and a tap that silently does nothing
                  // reads as a broken button rather than a refused one.
                  if (!floated && context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text(
                          'Picture in Picture is turned off for this app in '
                          'Android settings.',
                        ),
                      ),
                    );
                  }
                },
              ),
            if (actions.openHostControls != null) ...[
              const Divider(),
              ListTile(
                leading: const Icon(Icons.shield_outlined),
                title: const Text('Host controls'),
                subtitle: const Text('Mute, remove, record'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  actions.openHostControls!();
                },
              ),
            ],
            const SizedBox(height: NeoSpace.md),
          ],
        ),
      ),
    );
  }

  void _openReactions() {
    final react = widget.actions.react;
    if (react == null) return;

    neoSheet(
      context,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: NeoSpace.xxl,
            horizontal: NeoSpace.md,
          ),
          child: Wrap(
            alignment: WrapAlignment.center,
            spacing: NeoSpace.sm,
            children: [
              for (final entry in const {
                'heart': '❤️',
                'thumbs': '👍',
                'clap': '👏',
                'laugh': '😂',
                'wow': '😮',
                'fire': '🔥',
              }.entries)
                IconButton(
                  iconSize: 40,
                  onPressed: () {
                    react(entry.key);
                    Navigator.pop(sheetContext);
                  },
                  icon: Text(
                    entry.value,
                    style: const TextStyle(fontSize: 34),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.room,
    required this.layout,
    required this.onToggleLayout,
    this.onParticipants,
    this.onWaitingRoom,
  });

  final RoomView room;
  final RoomLayout layout;
  final VoidCallback onToggleLayout;
  final VoidCallback? onParticipants;
  final VoidCallback? onWaitingRoom;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    // While the link is down the participant count is a leftover from when
    // it was up, so it is not shown — saying nothing beats saying
    // something false.
    final live = room.link == RoomLinkState.live;
    final (statusLabel, statusColor) = switch (room.link) {
      RoomLinkState.live =>
        (room.recording ? '${room.clock} · Recording' : room.clock,
            room.recording ? p.danger : p.textMuted),
      RoomLinkState.weak => ('Weak connection', p.warning),
      RoomLinkState.reconnecting => ('Reconnecting…', p.warning),
      RoomLinkState.lost => ('Connection lost', p.danger),
    };

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: NeoSpace.lg,
        vertical: NeoSpace.md,
      ),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [p.bg.withValues(alpha: 0.95), p.bg.withValues(alpha: 0)],
        ),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  room.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: text.titleSmall?.copyWith(color: p.text),
                ),
                Row(
                  children: [
                    if (live)
                      Container(
                        margin: const EdgeInsets.only(right: 6),
                        height: 6,
                        width: 6,
                        decoration: BoxDecoration(
                          color: room.recording ? p.danger : p.success,
                          shape: BoxShape.circle,
                        ),
                      ),
                    Text(
                      statusLabel,
                      style: text.labelSmall?.copyWith(color: statusColor),
                    ),
                  ],
                ),
              ],
            ),
          ),
          if (room.waitingCount > 0 && onWaitingRoom != null)
            Badge(
              label: Text('${room.waitingCount}'),
              child: IconButton(
                tooltip: 'Waiting room',
                onPressed: onWaitingRoom,
                icon: Icon(Icons.door_front_door_outlined, color: p.text),
              ),
            ),
          if (room.people.length > 1)
            IconButton(
              tooltip: layout == RoomLayout.speaker
                  ? 'Grid view'
                  : 'Speaker view',
              onPressed: onToggleLayout,
              icon: Icon(
                layout == RoomLayout.speaker
                    ? Icons.grid_view_rounded
                    : Icons.person_rounded,
                color: p.text,
              ),
            ),
          if (onParticipants != null && live)
            TextButton.icon(
              onPressed: onParticipants,
              icon: Icon(Icons.people_alt_rounded, size: 18, color: p.text),
              label: Text(
                '${room.people.length}',
                style: text.labelMedium?.copyWith(color: p.text),
              ),
            ),
        ],
      ),
    );
  }
}

class _SpeakerView extends StatelessWidget {
  const _SpeakerView({required this.room});
  final RoomView room;

  @override
  Widget build(BuildContext context) {
    final focus = room.focus;
    final others = room.others;
    if (focus == null) return const SizedBox.shrink();

    return Column(
      children: [
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(NeoSpace.md),
            child: ParticipantTile(person: focus, large: true),
          ),
        ),
        if (others.isNotEmpty) ...[
          SizedBox(
            height: 96,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: NeoSpace.md),
              itemCount: others.length,
              separatorBuilder: (_, _) => const SizedBox(width: NeoSpace.sm),
              itemBuilder: (context, i) => SizedBox(
                width: 128,
                child: ParticipantTile(person: others[i]),
              ),
            ),
          ),
          const SizedBox(height: NeoSpace.md),
        ],
      ],
    );
  }
}

class _GridView extends StatelessWidget {
  const _GridView({required this.room});
  final RoomView room;

  @override
  Widget build(BuildContext context) {
    final people = room.people;
    // One person gets the whole screen rather than half of it with a gap.
    if (people.length == 1) {
      return Padding(
        padding: const EdgeInsets.all(NeoSpace.md),
        child: ParticipantTile(person: people.first, large: true),
      );
    }

    return GridView.builder(
      padding: const EdgeInsets.all(NeoSpace.md),
      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: people.length == 2 ? 1 : 2,
        childAspectRatio: people.length == 2 ? 1.2 : 0.82,
        mainAxisSpacing: NeoSpace.sm,
        crossAxisSpacing: NeoSpace.sm,
      ),
      itemCount: people.length,
      itemBuilder: (context, i) => ParticipantTile(person: people[i]),
    );
  }
}

/// One person's tile: video or avatar, with their name, mic state, and
/// whatever else is true of them right now.
class ParticipantTile extends StatelessWidget {
  const ParticipantTile({
    super.key,
    required this.person,
    this.large = false,
  });

  final PersonView person;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final video = person.video;

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: p.surfaceAlt,
        borderRadius:
            BorderRadius.circular(large ? NeoRadius.lg : NeoRadius.md),
        border: Border.all(
          color: person.speaking ? p.primary : p.border,
          width: person.speaking ? 2 : 1,
        ),
      ),
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (video != null)
            video
          else
            Center(child: NeoAvatar(name: person.name, size: large ? 96 : 44)),

          if (person.sharing)
            Positioned(
              top: NeoSpace.sm,
              left: NeoSpace.sm,
              child: NeoPill('Sharing', color: p.info),
            ),
          if (person.handRaised)
            const Positioned(
              top: NeoSpace.sm,
              right: NeoSpace.sm,
              child: _Chip(child: Text('✋')),
            ),

          Positioned(
            left: NeoSpace.sm,
            bottom: NeoSpace.sm,
            right: NeoSpace.sm,
            child: _Chip(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    person.muted ? Icons.mic_off_rounded : Icons.mic_rounded,
                    size: 12,
                    color: person.muted ? p.danger : p.success,
                  ),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      person.isMe ? 'You' : person.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context)
                          .textTheme
                          .labelSmall
                          ?.copyWith(color: p.text),
                    ),
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

class _Chip extends StatelessWidget {
  const _Chip({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
      decoration: BoxDecoration(
        // Black rather than the palette's background: this sits over video,
        // which can be any colour, and has to stay readable on all of it.
        color: Colors.black.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(NeoRadius.sm),
      ),
      child: child,
    );
  }
}

/// The control bar.
///
/// Fixed order, never reflowed: muscle memory is the whole point, and a
/// control that moves is a control people miss.
class _Controls extends StatelessWidget {
  const _Controls({
    required this.room,
    required this.onMic,
    required this.onCamera,
    required this.onMore,
    required this.onLeave,
    this.onChat,
  });

  final RoomView room;
  final Future<void> Function() onMic;
  final Future<void> Function() onCamera;
  final VoidCallback onMore;
  final Future<void> Function() onLeave;
  final VoidCallback? onChat;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);

    return Container(
      padding: const EdgeInsets.fromLTRB(
        NeoSpace.sm,
        NeoSpace.lg,
        NeoSpace.sm,
        NeoSpace.lg,
      ),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.bottomCenter,
          end: Alignment.topCenter,
          colors: [p.bg, p.bg.withValues(alpha: 0)],
        ),
      ),
      // Five, each given an equal share of the width so they fit on any
      // phone. Six fixed-width buttons needed 468pt on a 393pt screen and
      // pushed Leave off the edge, which is the one that must never go.
      child: Row(
        children: [
          Expanded(
            child: NeoControlButton(
              icon: room.micOn ? Icons.mic_rounded : Icons.mic_off_rounded,
              label: room.micOn ? 'Mute' : 'Unmute',
              active: room.micOn,
              onPressed: onMic,
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: room.cameraOn
                  ? Icons.videocam_rounded
                  : Icons.videocam_off_rounded,
              label: room.cameraOn ? 'Stop' : 'Video',
              active: room.cameraOn,
              onPressed: onCamera,
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: Icons.chat_bubble_rounded,
              label: 'Chat',
              badge: room.unreadChat,
              enabled: onChat != null,
              onPressed: onChat ?? () {},
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: Icons.more_horiz_rounded,
              label: 'More',
              active: room.handRaised || room.screenSharing,
              onPressed: onMore,
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: Icons.call_end_rounded,
              label: 'Leave',
              danger: true,
              onPressed: onLeave,
            ),
          ),
        ],
      ),
    );
  }
}

class _Alone extends StatelessWidget {
  const _Alone();

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(NeoSpace.huge),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.groups_outlined, size: 48, color: p.textFaint),
            const SizedBox(height: NeoSpace.lg),
            Text(
              'Nobody else is here yet',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: NeoSpace.sm),
            Text(
              'Share the meeting link and they will appear here.',
              textAlign: TextAlign.center,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: p.textMuted),
            ),
          ],
        ),
      ),
    );
  }
}

class _ReconnectingOverlay extends StatelessWidget {
  const _ReconnectingOverlay();

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return ColoredBox(
      color: p.bg.withValues(alpha: 0.82),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              height: 34,
              width: 34,
              child: CircularProgressIndicator(
                strokeWidth: 2.5,
                color: p.primary,
              ),
            ),
            const SizedBox(height: NeoSpace.xl),
            Text(
              'Reconnecting…',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: NeoSpace.sm),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: NeoSpace.huge),
              child: Text(
                'Your place in the meeting is being kept. Audio resumes as '
                'soon as the connection returns.',
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: p.textMuted),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
