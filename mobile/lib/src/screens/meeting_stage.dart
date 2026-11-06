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

  // A tap anywhere on the stage brings hidden controls back. It is read
  // from the raw pointer, not a tap recogniser: LiveKit wraps this phone's
  // own video in a GestureDetector of its own (tap to focus), which won the
  // gesture arena, so with the controls hidden and your own camera filling
  // the screen no tap ever reached the stage and Leave was out of reach.
  Offset? _downAt;
  DateTime? _downTime;
  bool _justRevealed = false;

  /// What is on the screen: a pin always shows the speaker view.
  RoomLayout get _shown =>
      widget.room.pinned != null ? RoomLayout.speaker : _layout;

  void _toggleLayout() {
    setState(() {
      if (widget.room.pinned != null) {
        // The grid button while someone is pinned used to flip a hidden
        // setting and change nothing (the pin kept the speaker view).
        // Asking for the grid means letting the pin go.
        widget.actions.unpin?.call();
        _layout = RoomLayout.grid;
      } else {
        _layout = _layout == RoomLayout.speaker ? RoomLayout.grid : RoomLayout.speaker;
      }
    });
  }

  void _onPointerDown(PointerDownEvent e) {
    _downAt = e.position;
    _downTime = DateTime.now();
    _justRevealed = false;
  }

  void _onPointerUp(PointerUpEvent e) {
    final at = _downAt, time = _downTime;
    _downAt = null;
    if (_chromeVisible || at == null || time == null) return;
    final tap = (e.position - at).distance < 18 &&
        DateTime.now().difference(time) < const Duration(milliseconds: 500);
    if (!tap) return;
    _justRevealed = true;
    setState(() => _chromeVisible = true);
  }

  void _onStageTap() {
    // The pointer-up above already brought the controls back for this tap.
    if (_justRevealed) {
      _justRevealed = false;
      return;
    }
    setState(() => _chromeVisible = !_chromeVisible);
  }

  @override
  Widget build(BuildContext context) {
    // The palette is whatever the caller handed down. The meeting is kept
    // dark in both themes — a white screen in a dark room is unkind, and
    // video reads better against black — and that decision belongs to
    // whoever wraps this, not here.
    final room = widget.room;
    final size = MediaQuery.sizeOf(context);
    // A phone held sideways has little height: the bars get thinner so the
    // video keeps most of it.
    final compact = size.height < 500;
    final shown = _shown;

    // The header, the banners and the control bar each take their own
    // space in a column, and the tiles get what is left. They used to be
    // drawn over the tiles with a fixed gap reserved (64 at the top, 132 at
    // the bottom): a header grown by large text, a three-line caption or a
    // banner covered the first row, its names and its menus.
    return Stack(
      children: [
        Column(
          children: [
            _Slide(
              visible: _chromeVisible,
              fromTop: true,
              child: _Header(
                room: room,
                layout: shown,
                compact: compact,
                onToggleLayout: _toggleLayout,
                onParticipants: widget.actions.openParticipants,
                onWaitingRoom: widget.actions.openWaitingRoom,
                onInvite: widget.actions.invite,
              ),
            ),
            if (room.onPhoneCall)
              Padding(
                padding: const EdgeInsets.fromLTRB(NeoSpace.lg, NeoSpace.xs, NeoSpace.lg, 0),
                child: NeoBanner(
                  icon: Icons.phone_in_talk_rounded,
                  tone: NeoBannerTone.warning,
                  message: 'On a phone call. Your microphone is off in the '
                      'meeting.',
                ),
              )
            else if (room.callEndedMuted)
              Padding(
                padding: const EdgeInsets.fromLTRB(NeoSpace.lg, NeoSpace.xs, NeoSpace.lg, 0),
                child: NeoBanner(
                  icon: Icons.mic_off_rounded,
                  tone: NeoBannerTone.info,
                  message: 'Phone call ended. Your microphone is still off.',
                  actionLabel: 'Unmute',
                  action: widget.actions.toggleMic,
                  onClose: widget.actions.dismissCallEnded,
                ),
              ),
            Expanded(
              child: Listener(
                behavior: HitTestBehavior.translucent,
                onPointerDown: _onPointerDown,
                onPointerUp: _onPointerUp,
                child: GestureDetector(
                  onTap: _onStageTap,
                  behavior: HitTestBehavior.opaque,
                  child: room.people.isEmpty
                      ? const _Alone()
                      // Pinning someone means seeing them large: the grid
                      // gives way to the speaker view while a pin lasts.
                      : shown == RoomLayout.speaker
                          ? _SpeakerView(
                              room: room,
                              onPerson: widget.actions.openPersonMenu,
                              onUnpin: widget.actions.unpin,
                            )
                          : _GridView(room: room, onPerson: widget.actions.openPersonMenu),
                ),
              ),
            ),
            // Captions ride with the control bar so they slide away with it
            // when the chrome is hidden for a clean view.
            _Slide(
              visible: _chromeVisible,
              fromTop: false,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (widget.captions != null) widget.captions!,
                  _Controls(
                    room: room,
                    compact: compact,
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
          ],
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
            // CC: easy to find, as on the web. A host switches captions on or
            // off for everyone; anyone else sees whether they are on.
            if (actions.toggleRecording != null)
              ListTile(
                leading: Icon(actions.isRecording ? Icons.stop_circle_rounded : Icons.fiber_manual_record_rounded, color: Colors.redAccent),
                title: Text(actions.isRecording ? 'Stop recording' : 'Record'),
                subtitle: const Text('You were added to this meeting, so you can record it'),
                onTap: () {
                  Navigator.pop(sheetContext);
                  actions.toggleRecording!();
                },
              ),
            if (actions.setCaptions != null)
              SwitchListTile(
                secondary: const Icon(Icons.closed_caption_rounded),
                title: const Text('Captions (CC)'),
                subtitle: const Text('Live captions for everyone in the meeting'),
                value: actions.captionsOn,
                onChanged: (on) {
                  Navigator.pop(sheetContext);
                  actions.setCaptions!(on);
                },
              )
            else
              ListTile(
                leading: Icon(actions.captionsOn ? Icons.closed_caption_rounded : Icons.closed_caption_off_rounded),
                title: const Text('Captions (CC)'),
                subtitle: Text(actions.captionsOn ? 'On — shown at the bottom of the meeting' : 'Off — ask the host to turn on captions'),
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

/// A bar that slides out of the way and gives its space back: hidden, it is
/// no height at all, so the tiles grow into it; shown, it takes its own
/// height, however tall large text or a wrapped caption makes it.
class _Slide extends StatelessWidget {
  const _Slide({required this.visible, required this.fromTop, required this.child});
  final bool visible;
  final bool fromTop;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: AnimatedAlign(
        duration: NeoMotion.base,
        curve: NeoMotion.curve,
        // The header leaves upwards, the control bar downwards.
        alignment: fromTop ? Alignment.bottomCenter : Alignment.topCenter,
        heightFactor: visible ? 1 : 0,
        child: IgnorePointer(ignoring: !visible, child: child),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.room,
    required this.layout,
    required this.onToggleLayout,
    this.compact = false,
    this.onParticipants,
    this.onWaitingRoom,
    this.onInvite,
  });

  final RoomView room;

  /// What the stage is showing now (a pin shows the speaker view).
  final RoomLayout layout;
  final bool compact;
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
      padding: EdgeInsets.symmetric(
        horizontal: NeoSpace.lg,
        vertical: compact ? NeoSpace.xs : NeoSpace.md,
      ),
      // Its own space now, not drawn over the video: plain background.
      color: p.bg,
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
    final big = Column(
      children: [
        if (pinned)
          // Says why this person stays put, and lets them go. Above the
          // tile, not on it: on the tile it shared a corner with the tile's
          // menu and its raised hand, under the phone-call banner.
          Padding(
            padding: const EdgeInsets.only(top: NeoSpace.sm),
            child: ActionChip(
              avatar: const Icon(Icons.push_pin_rounded, size: 16),
              label: const Text('Pinned · tap to unpin'),
              visualDensity: VisualDensity.compact,
              onPressed: onUnpin,
            ),
          ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(NeoSpace.md),
            child: ParticipantTile(
              key: ValueKey('focus:${focus.id}'),
              person: focus,
              large: true,
              onLongPress: onPerson,
            ),
          ),
        ),
      ],
    );
    if (others.isEmpty) return big;

    Widget strip(Axis axis) => ListView.separated(
          scrollDirection: axis,
          padding: axis == Axis.horizontal
              ? const EdgeInsets.symmetric(horizontal: NeoSpace.md)
              : const EdgeInsets.fromLTRB(0, NeoSpace.md, NeoSpace.md, NeoSpace.md),
          itemCount: others.length,
          // Each tile follows its person when the strip reorders (a new
          // speaker moves to the big tile), so a hold or a menu tap lands
          // on the person it started on, not on whoever slid into the slot.
          findItemIndexCallback: (key) {
            final id = (key as ValueKey<String>).value;
            final i = others.indexWhere((o) => o.id == id);
            return i < 0 ? null : i;
          },
          separatorBuilder: (_, _) => const SizedBox(width: NeoSpace.sm, height: NeoSpace.sm),
          itemBuilder: (context, i) => SizedBox(
            key: ValueKey(others[i].id),
            width: 128,
            height: 96,
            child: ParticipantTile(person: others[i], onLongPress: onPerson),
          ),
        );

    return LayoutBuilder(
      builder: (context, box) {
        // Sideways, the strip goes down the right-hand side: below the big
        // tile it left the big tile no height at all.
        if (box.maxWidth > box.maxHeight) {
          return Row(
            children: [
              Expanded(child: big),
              SizedBox(width: 140, child: strip(Axis.vertical)),
            ],
          );
        }
        return Column(
          children: [
            Expanded(child: big),
            SizedBox(height: 96, child: strip(Axis.horizontal)),
            const SizedBox(height: NeoSpace.md),
          ],
        );
      },
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
        child: ParticipantTile(key: ValueKey(people.first.id), person: people.first, large: true, onLongPress: onPerson),
      );
    }

    return LayoutBuilder(
      builder: (context, box) {
        final wide = box.maxWidth > box.maxHeight;
        final n = people.length;
        // Sideways: more columns of wider tiles, so a row fits the height.
        final columns = wide ? (n <= 2 ? n : (n <= 6 ? 3 : 4)) : (n == 2 ? 1 : 2);
        final aspect = wide ? 16 / 10 : (n == 2 ? 1.2 : 0.82);
        return GridView.builder(
          padding: const EdgeInsets.all(NeoSpace.md),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: columns,
            childAspectRatio: aspect,
            mainAxisSpacing: NeoSpace.sm,
            crossAxisSpacing: NeoSpace.sm,
          ),
          itemCount: n,
          // Keyed by person, as the strip is: someone joining or leaving
          // moves the others along, and their tiles (and a hold in
          // progress) move with them.
          findChildIndexCallback: (key) {
            final id = (key as ValueKey<String>).value;
            final i = people.indexWhere((o) => o.id == id);
            return i < 0 ? null : i;
          },
          itemBuilder: (context, i) =>
              ParticipantTile(key: ValueKey(people[i].id), person: people[i], onLongPress: onPerson),
        );
      },
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
    final menu = hold != null && !person.isMe;

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
              // Clear of the menu button (the raised hand goes under it).
              right: menu ? 44 : NeoSpace.xxl,
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
            Positioned(
              // Under the menu button, not beside it: beside it took the
              // width the role pill needs on a small tile.
              top: menu ? 44 : NeoSpace.sm,
              right: NeoSpace.sm,
              child: const _Chip(child: Text('✋')),
            ),
          if (menu)
            // The tile's menu, as on the web: holding the tile does the
            // same, but nobody finds a long press they were never told of.
            Positioned(
              top: 2,
              right: 2,
              child: Semantics(
                button: true,
                label: 'Options for ${person.name}',
                child: IconButton(
                  tooltip: 'Options for ${person.name}',
                  visualDensity: VisualDensity.compact,
                  constraints: const BoxConstraints.tightFor(width: 40, height: 40),
                  style: IconButton.styleFrom(
                    backgroundColor: Colors.black.withValues(alpha: 0.45),
                    foregroundColor: Colors.white,
                  ),
                  iconSize: 20,
                  icon: const Icon(Icons.more_vert_rounded),
                  onPressed: () => hold(person),
                ),
              ),
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
    this.compact = false,
    required this.onMic,
    required this.onCamera,
    required this.onMore,
    required this.onLeave,
    this.onChat,
    this.onMicMenu,
    this.onCameraMenu,
  });

  final RoomView room;

  /// Sideways: less padding, so the video keeps the height.
  final bool compact;
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
    final v = compact ? NeoSpace.xs : NeoSpace.lg;

    return Container(
      padding: EdgeInsets.fromLTRB(NeoSpace.sm, v, NeoSpace.sm, v),
      // Its own space below the tiles, not drawn over them.
      color: p.bg,
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
