import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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
    this.captions,
  });

  final RoomView room;
  final RoomActions actions;

  /// The caption strip, when there is one.
  ///
  /// Taken as a slot rather than drawn over the top, because an overlay
  /// landed on the filmstrip: the text crossed the tiles and their names.
  /// Given to the layout, it gets its own space and the tiles move up.
  final Widget? captions;

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
              bottom: (_chromeVisible ? 132 : 0) +
                  (widget.captions != null ? 56 : 0),
            ),
            child: room.people.isEmpty
                ? const _Alone()
                // Pinning someone means seeing them large: the grid gives
                // way to the speaker view while a pin lasts.
                : _layout == RoomLayout.speaker || room.pinned != null
                    ? _SpeakerView(
                        room: room,
                        onPerson: widget.actions.openPersonMenu,
                        onUnpin: widget.actions.unpin,
                      )
                    : _GridView(room: room, onPerson: widget.actions.openPersonMenu),
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
            onInvite: widget.actions.invite,
          ),
        ),
        AnimatedPositioned(
          duration: NeoMotion.base,
          curve: NeoMotion.curve,
          bottom: _chromeVisible ? 0 : -160,
          left: 0,
          right: 0,
          // Captions ride with the control bar so they slide away with it
          // when the chrome is hidden for a clean view.
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (widget.captions != null) widget.captions!,
              _Controls(
                room: room,
                onMic: widget.actions.toggleMic,
                onCamera: widget.actions.toggleCamera,
                onMicMenu: widget.actions.openMicPicker,
                onCameraMenu: widget.actions.openCameraPicker,
                onChat: widget.actions.openChat,
                onMore: _openMore,
                onLeave: widget.actions.leave,
              ),
            ],
          ),
        ),
        if (room.onPhoneCall)
          Positioned(
            top: 72,
            left: NeoSpace.lg,
            right: NeoSpace.lg,
            child: NeoBanner(
              icon: Icons.phone_in_talk_rounded,
              tone: NeoBannerTone.warning,
              message: 'On a phone call. Your microphone is off in the '
                  'meeting.',
            ),
          )
        else if (room.callEndedMuted)
          Positioned(
            top: 72,
            left: NeoSpace.lg,
            right: NeoSpace.lg,
            child: NeoBanner(
              icon: Icons.mic_off_rounded,
              tone: NeoBannerTone.info,
              message: 'Phone call ended. Your microphone is still off.',
              actionLabel: 'Unmute',
              action: widget.actions.toggleMic,
              onClose: widget.actions.dismissCallEnded,
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
            if (actions.invite != null)
              ListTile(
                leading: const Icon(Icons.person_add_alt_1_rounded),
                title: const Text('Invite people'),
                subtitle: const Text('Share the meeting link: WhatsApp, KingsChat, SMS…'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  actions.invite!();
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
            if (actions.openAudioOutput != null)
              ListTile(
                leading: const Icon(Icons.volume_up_rounded),
                title: const Text('Audio output'),
                subtitle: actions.audioOutputLabel == null
                    ? null
                    : Text(actions.audioOutputLabel!),
                onTap: () {
                  Navigator.pop(sheetContext);
                  actions.openAudioOutput!();
                },
              ),
            if (actions.openTranslation != null)
              ListTile(
                leading: const Icon(Icons.translate_rounded),
                title: const Text('Live translation'),
                subtitle: Text(actions.translationLabel ?? 'Off'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  actions.openTranslation!();
                },
              ),
            if (actions.openDetails != null)
              ListTile(
                leading: const Icon(Icons.info_outline_rounded),
                title: const Text('Meeting details'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  actions.openDetails!();
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
    this.onInvite,
  });

  final RoomView room;
  final RoomLayout layout;
  final VoidCallback onToggleLayout;
  final VoidCallback? onParticipants;
  final VoidCallback? onWaitingRoom;

  /// Share the meeting's link: one tap from the meeting itself.
  final VoidCallback? onInvite;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    // While the link is down the participant count is a leftover from when
    // it was up, so it is not shown — saying nothing beats saying
    // something false. A weak link is still up, and its count is true.
    final live = room.link == RoomLinkState.live;
    final connected = live || room.link == RoomLinkState.weak;
    final (statusLabel, statusColor) = switch (room.link) {
      RoomLinkState.live => (
          [
            // The host's countdown, when there is one, says more than how
            // long this phone has been in.
            room.timerLabel ?? room.clock,
            if (room.recording) 'Recording',
            // Everyone is told the meeting is going out, as with recording.
            ?room.liveOn,
          ].join(' · '),
          room.recording || room.liveOn != null || room.timerUrgent ? p.danger : p.textMuted,
        ),
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
          if (onInvite != null)
            IconButton(
              tooltip: 'Invite people',
              onPressed: onInvite,
              icon: Icon(Icons.person_add_alt_1_rounded, color: p.text),
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
          if (onParticipants != null && connected)
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
  const _SpeakerView({required this.room, this.onPerson, this.onUnpin});
  final RoomView room;
  final void Function(PersonView person)? onPerson;
  final VoidCallback? onUnpin;

  @override
  Widget build(BuildContext context) {
    final focus = room.focus;
    final others = room.others;
    if (focus == null) return const SizedBox.shrink();

    final pinned = room.pinned != null;
    return Column(
      children: [
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(NeoSpace.md),
            child: Stack(
              children: [
                Positioned.fill(
                  child: ParticipantTile(person: focus, large: true, onLongPress: onPerson),
                ),
                if (pinned)
                  // Says why this person stays put, and lets them go.
                  Positioned(
                    top: NeoSpace.sm,
                    right: NeoSpace.sm,
                    child: ActionChip(
                      avatar: const Icon(Icons.push_pin_rounded, size: 16),
                      label: const Text('Pinned · tap to unpin'),
                      visualDensity: VisualDensity.compact,
                      onPressed: onUnpin,
                    ),
                  ),
              ],
            ),
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
                child: ParticipantTile(person: others[i], onLongPress: onPerson),
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
  const _GridView({required this.room, this.onPerson});
  final RoomView room;
  final void Function(PersonView person)? onPerson;

  @override
  Widget build(BuildContext context) {
    final people = room.people;
    // One person gets the whole screen rather than half of it with a gap.
    if (people.length == 1) {
      return Padding(
        padding: const EdgeInsets.all(NeoSpace.md),
        child: ParticipantTile(person: people.first, large: true, onLongPress: onPerson),
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
      itemBuilder: (context, i) => ParticipantTile(person: people[i], onLongPress: onPerson),
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
    this.onLongPress,
  });

  final PersonView person;
  final bool large;

  /// Hold a tile for that person's host actions — the web's tile menu.
  /// Never for this device's own tile: its controls are the bar below.
  final void Function(PersonView person)? onLongPress;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final video = person.video;
    final hold = onLongPress;
    final roleLabel = person.roleLabel;

    final tile = Container(
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

          if (person.sharing || roleLabel != null)
            Positioned(
              top: NeoSpace.sm,
              left: NeoSpace.sm,
              right: NeoSpace.xxl,
              child: Wrap(
                spacing: NeoSpace.xs,
                runSpacing: NeoSpace.xs,
                children: [
                  // Who runs the meeting, on their tile, as on the web.
                  if (roleLabel != null)
                    NeoPill(roleLabel, color: person.owner || person.role == 'host' ? p.primary : p.accent),
                  if (person.sharing) NeoPill('Sharing', color: p.info),
                ],
              ),
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

    if (hold == null || person.isMe) return tile;
    return GestureDetector(
      onLongPress: () {
        HapticFeedback.mediumImpact();
        hold(person);
      },
      child: tile,
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
    this.onMicMenu,
    this.onCameraMenu,
  });

  final RoomView room;
  final Future<void> Function() onMic;
  final Future<void> Function() onCamera;
  final VoidCallback? onMicMenu;
  final VoidCallback? onCameraMenu;
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
              tint: p.spectrumAt(3),
              active: room.micOn,
              onPressed: onMic,
              onMenu: onMicMenu,
              menuLabel: 'Choose microphone and speaker',
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: room.cameraOn
                  ? Icons.videocam_rounded
                  : Icons.videocam_off_rounded,
              label: room.cameraOn ? 'Stop' : 'Video',
              tint: p.spectrumAt(5),
              active: room.cameraOn,
              onPressed: onCamera,
              onMenu: onCameraMenu,
              menuLabel: 'Choose camera',
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: Icons.chat_bubble_rounded,
              label: 'Chat',
              tint: p.spectrumAt(6),
              badge: room.unreadChat,
              enabled: onChat != null,
              onPressed: onChat ?? () {},
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: Icons.more_horiz_rounded,
              label: 'More',
              tint: p.spectrumAt(2),
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
