import 'dart:async';

import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/room_view.dart';
import '../mock/sample_data.dart';
import 'meeting_sheets.dart';
import 'meeting_stage.dart';

/// The showcase's meeting.
///
/// A thin adapter: it turns sample participants into the [RoomView] the
/// real meeting also produces and hands it to [MeetingStage]. The screen
/// people review is therefore the screen that ships, and a layout problem
/// found here is a layout problem fixed there.
class MeetingScreen extends StatefulWidget {
  const MeetingScreen({
    super.key,
    required this.meeting,
    this.myRole = SampleRole.attendee,
    this.startMuted = true,
    this.startCameraOff = true,
    this.link = RoomLinkState.live,
    this.ended = false,
  });

  final SampleMeeting meeting;
  final SampleRole myRole;
  final bool startMuted;
  final bool startCameraOff;
  final RoomLinkState link;

  /// The after-the-meeting screen, which is a state rather than a link.
  final bool ended;

  @override
  State<MeetingScreen> createState() => _MeetingScreenState();
}

class _MeetingScreenState extends State<MeetingScreen> {
  late bool _muted = widget.startMuted;
  late bool _cameraOff = widget.startCameraOff;
  late bool _ended = widget.ended;

  bool _handRaised = false;
  int _unreadChat = 2;
  Timer? _elapsed;
  Duration _duration = const Duration(minutes: 12, seconds: 40);

  @override
  void initState() {
    super.initState();
    _elapsed = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() => _duration += const Duration(seconds: 1));
    });
  }

  @override
  void dispose() {
    _elapsed?.cancel();
    super.dispose();
  }

  bool get _canManage =>
      widget.myRole == SampleRole.owner ||
      widget.myRole == SampleRole.host ||
      widget.myRole == SampleRole.cohost;

  /// Recording is offered to the owner, host and co-hosts, and never to a
  /// moderator. A moderator admits, mutes and removes; making a permanent
  /// copy of the room is a different kind of authority.
  bool get _canRecord => _canManage;

  @override
  Widget build(BuildContext context) {
    if (_ended) {
      return _MeetingEnded(meeting: widget.meeting, duration: _view.clock);
    }

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        await _leave();
      },
      child: Scaffold(
        // The meeting is always dark, in both themes.
        backgroundColor: NeoPalette.dark.bg,
        body: NeoTheme(
          palette: NeoPalette.dark,
          child: SafeArea(
            child: MeetingStage(
              room: _view,
              actions: RoomActions(
                toggleMic: () async => setState(() => _muted = !_muted),
                toggleCamera: () async =>
                    setState(() => _cameraOff = !_cameraOff),
                toggleHand: () async =>
                    setState(() => _handRaised = !_handRaised),
                switchCamera: () async {},
                toggleScreenShare: () async {},
                react: (_) {},
                openChat: () {
                  setState(() => _unreadChat = 0);
                  neoSheet(
                    context,
                    fullHeight: true,
                    builder: (_) => const ChatSheet(),
                  );
                },
                openParticipants: () => neoSheet(
                  context,
                  fullHeight: true,
                  builder: (_) => ParticipantsSheet(myRole: widget.myRole),
                ),
                openHostControls: _canManage || _canRecord
                    ? () => neoSheet(
                          context,
                          fullHeight: true,
                          builder: (_) => HostControlsSheet(
                            role: widget.myRole,
                          ),
                        )
                    : null,
                leave: _leave,
              ),
            ),
          ),
        ),
      ),
    );
  }

  RoomView get _view => RoomView(
        title: widget.meeting.title,
        people: [
          for (final person in sampleParticipants)
            PersonView(
              id: person.name,
              name: person.name,
              // A gradient rather than a fake face: the tile is showing
              // that video is on, and inventing a person to fill it would
              // make the design look better than the product.
              video: person.cameraOn ? const _SampleVideo() : null,
              muted: person.muted,
              speaking: person.speaking,
              handRaised: person.handRaised,
              sharing: person.sharing,
            ),
        ],
        link: widget.link,
        elapsed: _duration,
        micOn: !_muted,
        cameraOn: !_cameraOff,
        handRaised: _handRaised,
        canManage: _canManage,
        unreadChat: _unreadChat,
        waitingCount: _canManage ? 2 : 0,
      );

  Future<void> _leave() async {
    final leave = await neoConfirm(
      context,
      title: _canManage ? 'Leave or end?' : 'Leave the meeting?',
      message: _canManage
          ? 'Leaving keeps the meeting running for everyone else.'
          : 'You can rejoin with the same link.',
      confirmLabel: 'Leave',
    );
    if (leave && mounted) setState(() => _ended = true);
  }
}

class _SampleVideo extends StatelessWidget {
  const _SampleVideo();

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            p.primary.withValues(alpha: 0.28),
            p.accent.withValues(alpha: 0.38),
          ],
        ),
      ),
    );
  }
}

class _MeetingEnded extends StatelessWidget {
  const _MeetingEnded({required this.meeting, required this.duration});

  final SampleMeeting meeting;
  final String duration;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Scaffold(
      backgroundColor: p.bg,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(NeoSpace.xl),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Center(child: NeoLogoMark(size: 56)),
              const SizedBox(height: NeoSpace.xxl),
              Text(
                'You left the meeting',
                textAlign: TextAlign.center,
                style: text.headlineSmall,
              ),
              const SizedBox(height: NeoSpace.sm),
              Text(
                '${meeting.title} · $duration',
                textAlign: TextAlign.center,
                style: text.bodyMedium?.copyWith(color: p.textMuted),
              ),
              const SizedBox(height: NeoSpace.huge),
              FilledButton(
                onPressed: () => Navigator.of(context).maybePop(),
                child: const Text('Rejoin'),
              ),
              const SizedBox(height: NeoSpace.md),
              OutlinedButton(
                onPressed: () =>
                    Navigator.of(context).popUntil((route) => route.isFirst),
                child: const Text('Back to home'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
