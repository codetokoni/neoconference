import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';

import '../design/brand.dart';
import '../design/neo_theme.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../events/languages.dart';
import '../meetings/room_view.dart';
import '../screens/meeting_stage.dart';
import 'audio_routes.dart';
import 'audio_sheets.dart';
import 'meeting_sheets.dart';
import 'meeting_presence.dart';
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
    // A meeting is always dark, whatever the app's theme. A white screen in
    // a dark room is unkind and video reads better against black — but a
    // dark theme someone chose on purpose is honoured, so Ocean, Amethyst
    // and Carbon follow you into the room and only the light ones do not.
    final chosen = NeoTheme.of(context);
    final p = chosen.isDark ? chosen : NeoPalette.dark;

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

    return Theme(
      data: neoThemeData(p),
      child: NeoTheme(
        palette: p,
        // The Builder is what makes the leave confirmation dark.
        //
        // A route captures the themes between the context it is given and
        // the Navigator. This State's own context sits above the two
        // wrappers, so passing it would hand showDialog the app's palette
        // and put a white dialog over the video — which is exactly what it
        // did on the phone before this Builder existed.
        child: Builder(
          builder: (context) => PopScope(
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
              backgroundColor: p.bg,
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
                        onRetry: controller.retry,
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Future<bool> _confirmLeave(BuildContext context) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Leave the meeting?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Stay'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: NeoTheme.of(context).danger,
            ),
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
    final p = NeoTheme.of(context);
    // Getting back in by itself: the tries in between are failures by
    // phase, but to the person it is one wait, not a string of errors.
    final rejoining = state.rejoining;
    final waiting = rejoining ||
        state.phase == JoinPhase.connecting ||
        state.phase == JoinPhase.knocking ||
        state.phase == JoinPhase.waitingForHost;

    // A meeting that ended under this person is not a join that failed.
    final drop = state.phase == JoinPhase.failed ? state.drop : null;
    final message = rejoining
        ? "The connection to the meeting was lost. You'll be back in as "
            'soon as it returns, with your microphone off.'
        : drop?.message ?? state.message;

    final (icon, headline) = rejoining
        ? (Icons.link_off_rounded, 'Rejoining…')
        : drop != null
        ? (Icons.link_off_rounded, drop.headline)
        : switch (state.phase) {
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
                  Icon(icon, size: 48, color: p.textMuted),
                const SizedBox(height: 24),
                Text(
                  headline,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w600,
                    color: p.text,
                  ),
                ),
                if (message != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    message,
                    textAlign: TextAlign.center,
                    style: TextStyle(color: p.textMuted),
                  ),
                ],
                if (!waiting) ...[
                  const SizedBox(height: 28),
                  if (drop == null)
                    FilledButton(
                      onPressed: onRetry,
                      child: const Text('Try again'),
                    )
                  else if (drop.canRejoin)
                    FilledButton(
                      onPressed: onRetry,
                      child: const Text('Rejoin'),
                    )
                  else
                    FilledButton(
                      onPressed: () => Navigator.of(context).maybePop(),
                      child: const Text('Back'),
                    ),
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
  /// How long this device has been in the meeting.
  ///
  /// Counted here rather than taken from the event's start time: the
  /// header is telling you how long *you* have been in the call, and on
  /// this account meetings are routinely still marked live months later.
  final _joinedAt = DateTime.now();
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.state;
    final controller = widget.controller;
    final room = controller.room;

    return ValueListenableBuilder<bool>(
      valueListenable: MeetingPresence.instance.inPip,
      builder: (context, inPip, _) {
        final view = _view(state, room);
        // In a window a few centimetres wide the control bar is unusable
        // and the filmstrip is a row of smudges. Show the one thing worth
        // seeing: whoever is talking.
        if (inPip) return PipView(room: view);
        return _stage(context, state, controller, room, view);
      },
    );
  }

  Widget _stage(
    BuildContext context,
    RoomState state,
    RoomController controller,
    Room room,
    RoomView view,
  ) {
    return Stack(
      children: [
        MeetingStage(
          room: view,
          captions: (state.translatedCaption ?? state.caption) == null
              ? null
              : CaptionStrip(state: state),
          actions: RoomActions(
            toggleMic: controller.toggleMic,
            dismissCallEnded: controller.dismissCallEnded,
            toggleCamera: controller.toggleCamera,
            toggleHand: controller.toggleHand,
            switchCamera: state.cameraOn ? controller.switchCamera : null,
            toggleScreenShare: controller.toggleScreenShare,
            react: controller.react,
            enterPip: MeetingPresence.instance.pipAvailable
                ? MeetingPresence.instance.enterPip
                : null,
            openAudioOutput: AudioRoutes.instance.canRoute
                ? () => neoSheet(
                      context,
                      builder: (_) => const AudioOutputSheet(),
                    )
                : null,
            audioOutputLabel: switch (AudioRoutes.instance.selectedOutput) {
              final device? => AudioRoutes.label(device),
              null => null,
            },
            openTranslation: () => neoSheet(
              context,
              fullHeight: true,
              builder: (_) => TranslationSheet(slug: widget.slug),
            ),
            translationLabel: switch (state.translateTo) {
              final code? => meetingLanguages
                  .firstWhere(
                    (l) => l.code == code,
                    orElse: () => MeetingLanguage(code, code, code),
                  )
                  .label,
              null => 'Off',
            },
            openDetails: () => neoSheet(
              context,
              builder: (_) => MeetingDetailsSheet(
                slug: widget.slug,
                title: widget.title,
              ),
            ),
            openChat: () => _openChat(context, controller, state),
            openParticipants: () => _openParticipants(context, controller),
            openHostControls: state.canManage
                ? () => _openHostControls(context, controller, state, room)
                : null,
            openWaitingRoom: state.canManage
                ? () => _openWaitingRoom(context, controller, state)
                : null,
            leave: () async => Navigator.of(context).maybePop(),
          ),
        ),
        // Reactions float over the whole stage, including the chrome, so
        // they are not clipped by whichever layout is showing.
        Positioned.fill(
          child: IgnorePointer(
            child: ReactionOverlay(reactions: state.reactions),
          ),
        ),
      ],
    );
  }

  /// LiveKit's objects, in the shape the screen reads.
  ///
  /// Built fresh on every frame rather than cached: LiveKit mutates its
  /// participants in place, so a remembered list goes stale without ever
  /// looking like it has.
  RoomView _view(RoomState state, Room room) {
    final people = <PersonView>[];

    final me = room.localParticipant;
    if (me != null) {
      people.add(_person(me, state, label: 'You', isMe: true));
    }
    for (final other in room.remoteParticipants.values) {
      // The captions worker joins the room as a participant and was
      // getting a tile and a place in the header count, so a meeting of
      // two read as three with a green "A" sitting in the filmstrip. The
      // web client does not show it either.
      if (other.kind == ParticipantKind.AGENT) continue;
      people.add(_person(other, state));
    }

    return RoomView(
      title: widget.title,
      people: people,
      link: switch (state.link) {
        // Weak only while otherwise live: reconnecting and lost say more.
        RoomLink.live =>
          state.weakLink ? RoomLinkState.weak : RoomLinkState.live,
        RoomLink.reconnecting => RoomLinkState.reconnecting,
        RoomLink.lost => RoomLinkState.lost,
      },
      elapsed: DateTime.now().difference(_joinedAt),
      micOn: state.micOn,
      cameraOn: state.cameraOn,
      screenSharing: state.screenSharing,
      handRaised: state.handRaised,
      recording: state.isRecording,
      canManage: state.canManage,
      unreadChat: state.unreadChat,
      waitingCount: state.canManage ? state.waitingRoom.length : 0,
      onPhoneCall: state.onPhoneCall,
      callEndedMuted: state.callEndedMuted,
    );
  }

  PersonView _person(
    Participant participant,
    RoomState state, {
    String? label,
    bool isMe = false,
  }) {
    // A screen share is what the meeting is looking at, so it wins over a
    // face — and the tile says so, rather than silently showing a slide
    // where a person was a moment ago.
    final published = participant.videoTrackPublications.where(
      (p) => p.subscribed && !p.muted && p.track != null,
    );
    final screen = published
        .where((p) => p.source == TrackSource.screenShareVideo)
        .firstOrNull;
    final publication = screen ?? published.firstOrNull;
    final track = publication?.track;

    final name = label ??
        (participant.name.isNotEmpty ? participant.name : participant.identity);

    return PersonView(
      id: participant.identity,
      name: name,
      video: track is VideoTrack
          ? VideoTrackRenderer(track, fit: VideoViewFit.contain)
          : null,
      muted: participant.isMuted,
      speaking: participant.isSpeaking,
      handRaised: state.raisedHands.containsKey(participant.identity),
      sharing: screen != null,
      isMe: isMe,
    );
  }

  void _openParticipants(BuildContext context, RoomController controller) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => ParticipantsSheet(slug: widget.slug),
    );
  }


  void _openChat(BuildContext context, RoomController controller, RoomState state) {
    controller.markChatRead();
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
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
      isScrollControlled: true,
      builder: (_) => HostControlsSheet(slug: widget.slug),
    );
  }
}

