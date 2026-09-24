import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../mock/sample_data.dart';
import 'meeting_sheets.dart';

/// How connected the meeting currently is.
///
/// Separate from whether we joined. A call can be fully joined and silently
/// dead, and the header must never claim otherwise — a stale participant
/// count is worse than none, because people act on it.
enum MeetingLink { live, weak, reconnecting, ended }

enum MeetingLayout { speaker, grid }

/// The live meeting.
///
/// Designed to be operated with one hand while doing something else: the
/// controls sit within thumb reach at the bottom, the row never reflows,
/// and Leave is the only red thing on the screen. Tapping the video area
/// hides the chrome for a clean view and brings it back on the next tap.
class MeetingScreen extends StatefulWidget {
  const MeetingScreen({
    super.key,
    required this.meeting,
    this.myRole = SampleRole.attendee,
    this.startMuted = true,
    this.startCameraOff = true,
    this.link = MeetingLink.live,
  });

  final SampleMeeting meeting;
  final SampleRole myRole;
  final bool startMuted;
  final bool startCameraOff;
  final MeetingLink link;

  @override
  State<MeetingScreen> createState() => _MeetingScreenState();
}

class _MeetingScreenState extends State<MeetingScreen> {
  late bool _muted = widget.startMuted;
  late bool _cameraOff = widget.startCameraOff;
  late MeetingLink _link = widget.link;

  MeetingLayout _layout = MeetingLayout.speaker;
  bool _handRaised = false;
  bool _chromeVisible = true;
  int _unreadChat = 2;
  Timer? _elapsed;
  Duration _duration = const Duration(minutes: 12, seconds: 40);

  @override
  void initState() {
    super.initState();
    SystemChrome.setEnabledSystemUIMode(
      SystemUiMode.edgeToEdge,
    );
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

  String get _clock {
    final m = _duration.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = _duration.inSeconds.remainder(60).toString().padLeft(2, '0');
    final h = _duration.inHours;
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    if (_link == MeetingLink.ended) {
      return _MeetingEnded(meeting: widget.meeting, duration: _clock);
    }

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        await _leave();
      },
      child: Scaffold(
        // The meeting is always dark, in both themes. A white screen in a
        // dark room is unkind, and video reads better against black.
        backgroundColor: NeoPalette.dark.bg,
        body: NeoTheme(
          palette: NeoPalette.dark,
          child: SafeArea(
            child: Stack(
              children: [
                GestureDetector(
                  onTap: () =>
                      setState(() => _chromeVisible = !_chromeVisible),
                  behavior: HitTestBehavior.opaque,
                  child: Padding(
                    padding: EdgeInsets.only(
                      top: _chromeVisible ? 64 : 0,
                      bottom: _chromeVisible ? 132 : 0,
                    ),
                    child: _layout == MeetingLayout.speaker
                        ? const _SpeakerView()
                        : const _GridView(),
                  ),
                ),
                AnimatedPositioned(
                  duration: NeoMotion.base,
                  curve: NeoMotion.curve,
                  top: _chromeVisible ? 0 : -80,
                  left: 0,
                  right: 0,
                  child: _Header(
                    title: widget.meeting.title,
                    clock: _clock,
                    link: _link,
                    participants: sampleParticipants.length,
                    layout: _layout,
                    onToggleLayout: () => setState(() {
                      _layout = _layout == MeetingLayout.speaker
                          ? MeetingLayout.grid
                          : MeetingLayout.speaker;
                    }),
                    onParticipants: _openParticipants,
                  ),
                ),
                AnimatedPositioned(
                  duration: NeoMotion.base,
                  curve: NeoMotion.curve,
                  bottom: _chromeVisible ? 0 : -160,
                  left: 0,
                  right: 0,
                  child: _Controls(
                    muted: _muted,
                    cameraOff: _cameraOff,
                    handRaised: _handRaised,
                    unreadChat: _unreadChat,
                    canManage: _canManage,
                    onMic: () => setState(() => _muted = !_muted),
                    onCamera: () => setState(() => _cameraOff = !_cameraOff),
                    onHand: () => setState(() => _handRaised = !_handRaised),
                    onChat: () {
                      setState(() => _unreadChat = 0);
                      neoSheet(
                        context,
                        fullHeight: true,
                        builder: (_) => const ChatSheet(),
                      );
                    },
                    onReact: () => neoSheet(
                      context,
                      builder: (_) => const ReactionsSheet(),
                    ),
                    onMore: () => neoSheet(
                      context,
                      builder: (_) => MoreSheet(
                        role: widget.myRole,
                        handRaised: _handRaised,
                        onToggleHand: () =>
                            setState(() => _handRaised = !_handRaised),
                        onReact: () => neoSheet(
                          context,
                          builder: (_) => const ReactionsSheet(),
                        ),
                        onHostControls: _openHostControls,
                        onDetails: () => neoSheet(
                          context,
                          builder: (_) => MeetingDetailsSheet(
                            meeting: widget.meeting,
                          ),
                        ),
                      ),
                    ),
                    onLeave: _leave,
                  ),
                ),
                if (_link == MeetingLink.reconnecting)
                  const Positioned.fill(child: _ReconnectingOverlay()),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _openParticipants() => neoSheet(
        context,
        fullHeight: true,
        builder: (_) => ParticipantsSheet(myRole: widget.myRole),
      );

  void _openHostControls() => neoSheet(
        context,
        fullHeight: true,
        builder: (_) => HostControlsSheet(role: widget.myRole),
      );

  Future<void> _leave() async {
    final isHost = _canManage;
    final leave = await neoConfirm(
      context,
      title: isHost ? 'Leave or end?' : 'Leave the meeting?',
      message: isHost
          ? 'Leaving keeps the meeting running for everyone else.'
          : 'You can rejoin with the same link.',
      confirmLabel: 'Leave',
    );
    if (leave && mounted) setState(() => _link = MeetingLink.ended);
  }
}
class _Header extends StatelessWidget {
  const _Header({
    required this.title,
    required this.clock,
    required this.link,
    required this.participants,
    required this.layout,
    required this.onToggleLayout,
    required this.onParticipants,
  });

  final String title;
  final String clock;
  final MeetingLink link;
  final int participants;
  final MeetingLayout layout;
  final VoidCallback onToggleLayout;
  final VoidCallback onParticipants;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    final (statusLabel, statusColor) = switch (link) {
      MeetingLink.live => (clock, p.textMuted),
      MeetingLink.weak => ('Weak connection', p.warning),
      MeetingLink.reconnecting => ('Reconnecting…', p.danger),
      MeetingLink.ended => ('Ended', p.textMuted),
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
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: text.titleSmall?.copyWith(color: p.text),
                ),
                Row(
                  children: [
                    if (link == MeetingLink.live)
                      Container(
                        margin: const EdgeInsets.only(right: 6),
                        height: 6,
                        width: 6,
                        decoration: BoxDecoration(
                          color: p.danger,
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
          IconButton(
            tooltip: layout == MeetingLayout.speaker
                ? 'Grid view'
                : 'Speaker view',
            onPressed: onToggleLayout,
            icon: Icon(
              layout == MeetingLayout.speaker
                  ? Icons.grid_view_rounded
                  : Icons.person_rounded,
              color: p.text,
            ),
          ),
          TextButton.icon(
            onPressed: onParticipants,
            icon: Icon(Icons.people_alt_rounded, size: 18, color: p.text),
            label: Text(
              '$participants',
              style: text.labelMedium?.copyWith(color: p.text),
            ),
          ),
        ],
      ),
    );
  }
}

class _SpeakerView extends StatelessWidget {
  const _SpeakerView();

  @override
  Widget build(BuildContext context) {
    final speaker = sampleParticipants.firstWhere((s) => s.sharing,
        orElse: () => sampleParticipants.first);
    final others = sampleParticipants.where((s) => s != speaker).toList();

    return Column(
      children: [
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(NeoSpace.md),
            child: ParticipantTile(participant: speaker, large: true),
          ),
        ),
        SizedBox(
          height: 96,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: NeoSpace.md),
            itemCount: others.length,
            separatorBuilder: (_, _) => const SizedBox(width: NeoSpace.sm),
            itemBuilder: (context, i) => SizedBox(
              width: 128,
              child: ParticipantTile(participant: others[i]),
            ),
          ),
        ),
        const SizedBox(height: NeoSpace.md),
      ],
    );
  }
}

class _GridView extends StatelessWidget {
  const _GridView();

  @override
  Widget build(BuildContext context) {
    return GridView.builder(
      padding: const EdgeInsets.all(NeoSpace.md),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        childAspectRatio: 0.82,
        mainAxisSpacing: NeoSpace.sm,
        crossAxisSpacing: NeoSpace.sm,
      ),
      itemCount: sampleParticipants.length,
      itemBuilder: (context, i) =>
          ParticipantTile(participant: sampleParticipants[i]),
    );
  }
}

/// One person's tile: video or avatar, with their name, mic state, and
/// whatever else is true of them right now.
class ParticipantTile extends StatelessWidget {
  const ParticipantTile({
    super.key,
    required this.participant,
    this.large = false,
  });

  final SampleParticipant participant;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: p.surfaceAlt,
        borderRadius: BorderRadius.circular(large ? NeoRadius.lg : NeoRadius.md),
        border: Border.all(
          color: participant.speaking ? p.primary : p.border,
          width: participant.speaking ? 2 : 1,
        ),
      ),
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (participant.cameraOn)
            DecoratedBox(
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
            )
          else
            Center(
              child: NeoAvatar(
                name: participant.name,
                size: large ? 96 : 44,
              ),
            ),

          if (participant.sharing)
            Positioned(
              top: NeoSpace.sm,
              left: NeoSpace.sm,
              child: NeoPill('Sharing', color: p.info),
            ),
          if (participant.handRaised)
            Positioned(
              top: NeoSpace.sm,
              right: NeoSpace.sm,
              child: _Chip(child: const Text('✋')),
            ),
          if (participant.connection == SampleConnection.poor)
            Positioned(
              bottom: NeoSpace.sm,
              right: NeoSpace.sm,
              child: _Chip(
                child: Icon(
                  Icons.signal_wifi_statusbar_connected_no_internet_4_rounded,
                  size: 12,
                  color: p.warning,
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
                    participant.muted ? Icons.mic_off_rounded : Icons.mic_rounded,
                    size: 12,
                    color: participant.muted ? p.danger : p.success,
                  ),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      participant.name,
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
/// control that moves is a control people miss. Everything beyond the six
/// essentials lives behind More.
class _Controls extends StatelessWidget {
  const _Controls({
    required this.muted,
    required this.cameraOff,
    required this.handRaised,
    required this.unreadChat,
    required this.canManage,
    required this.onMic,
    required this.onCamera,
    required this.onHand,
    required this.onChat,
    required this.onReact,
    required this.onMore,
    required this.onLeave,
  });

  final bool muted;
  final bool cameraOff;
  final bool handRaised;
  final int unreadChat;
  final bool canManage;
  final VoidCallback onMic;
  final VoidCallback onCamera;
  final VoidCallback onHand;
  final VoidCallback onChat;
  final VoidCallback onReact;
  final VoidCallback onMore;
  final VoidCallback onLeave;

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
      // phone. Raise hand, reactions, screen share and audio routing live
      // in More: the bar holds what people reach for without thinking, and
      // Leave must never be the control that falls off the edge.
      child: Row(
        children: [
          Expanded(
            child: NeoControlButton(
              icon: muted ? Icons.mic_off_rounded : Icons.mic_rounded,
              label: muted ? 'Unmute' : 'Mute',
              active: !muted,
              onPressed: onMic,
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: cameraOff
                  ? Icons.videocam_off_rounded
                  : Icons.videocam_rounded,
              label: cameraOff ? 'Video' : 'Stop',
              active: !cameraOff,
              onPressed: onCamera,
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: Icons.chat_bubble_rounded,
              label: 'Chat',
              badge: unreadChat,
              onPressed: onChat,
            ),
          ),
          Expanded(
            child: NeoControlButton(
              icon: Icons.more_horiz_rounded,
              label: 'More',
              active: handRaised,
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
              child: CircularProgressIndicator(strokeWidth: 2.5, color: p.primary),
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
                onPressed: () => Navigator.of(context)
                    .popUntil((route) => route.isFirst),
                child: const Text('Back to home'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
