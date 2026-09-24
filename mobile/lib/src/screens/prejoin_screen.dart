import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../mock/sample_data.dart';
import 'meeting_screen.dart';

/// The room before the room.
///
/// Everything here exists so that nobody discovers a muted microphone or a
/// covered lens in front of eleven colleagues. Mic and camera start off —
/// arriving already broadcasting is a rude surprise on a device that is
/// usually somewhere personal — and the state chosen here is what the
/// meeting is entered with.
class PreJoinScreen extends StatefulWidget {
  const PreJoinScreen({
    super.key,
    required this.meeting,
    this.instant = false,
    this.permissionDenied = false,
  });

  final SampleMeeting meeting;
  final bool instant;

  /// Shown when the OS has refused the camera or microphone. Surfaced as a
  /// state rather than a dead preview, because the fix is in Settings and
  /// the person needs telling.
  final bool permissionDenied;

  @override
  State<PreJoinScreen> createState() => _PreJoinScreenState();
}

class _PreJoinScreenState extends State<PreJoinScreen> {
  bool _mic = false;
  bool _camera = false;
  _AudioRoute _route = _AudioRoute.speaker;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.close_rounded),
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Text(widget.instant ? 'Start a meeting' : 'Ready to join?'),
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: NeoSpace.xl),
                child: Column(
                  children: [
                    Expanded(child: _Preview(cameraOn: _camera)),
                    const SizedBox(height: NeoSpace.lg),
                    if (widget.permissionDenied)
                      NeoBanner(
                        icon: Icons.videocam_off_rounded,
                        tone: NeoBannerTone.warning,
                        message:
                            'Camera and microphone are blocked for '
                            'NeoConference.',
                        actionLabel: 'Settings',
                        action: () {},
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: NeoSpace.lg),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: NeoSpace.xl),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [
                      NeoControlButton(
                        icon: _mic ? Icons.mic_rounded : Icons.mic_off_rounded,
                        label: _mic ? 'Mic on' : 'Mic off',
                        active: _mic,
                        enabled: !widget.permissionDenied,
                        onPressed: () => setState(() => _mic = !_mic),
                      ),
                      NeoControlButton(
                        icon: _camera
                            ? Icons.videocam_rounded
                            : Icons.videocam_off_rounded,
                        label: _camera ? 'Camera on' : 'Camera off',
                        active: _camera,
                        enabled: !widget.permissionDenied,
                        onPressed: () => setState(() => _camera = !_camera),
                      ),
                      NeoControlButton(
                        icon: _route.icon,
                        label: _route.label,
                        onPressed: _pickRoute,
                      ),
                      NeoControlButton(
                        icon: Icons.tune_rounded,
                        label: 'Checks',
                        onPressed: _deviceChecks,
                      ),
                    ],
                  ),
                  const SizedBox(height: NeoSpace.xl),
                  Text(
                    widget.meeting.title,
                    textAlign: TextAlign.center,
                    style: text.titleMedium,
                  ),
                  const SizedBox(height: NeoSpace.xs),
                  Text(
                    widget.instant
                        ? 'You are the host'
                        : '${widget.meeting.host} · '
                            '${widget.meeting.participants.length} invited',
                    textAlign: TextAlign.center,
                    style: text.bodySmall?.copyWith(color: p.textMuted),
                  ),
                  const SizedBox(height: NeoSpace.xl),
                  FilledButton(
                    onPressed: () => Navigator.of(context).pushReplacement(
                      MaterialPageRoute(
                        builder: (_) => MeetingScreen(
                          meeting: widget.meeting,
                          startMuted: !_mic,
                          startCameraOff: !_camera,
                          myRole: widget.instant
                              ? SampleRole.owner
                              : SampleRole.attendee,
                        ),
                      ),
                    ),
                    child: Text(
                      widget.instant ? 'Start meeting' : 'Join now',
                    ),
                  ),
                  const SizedBox(height: NeoSpace.md),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _pickRoute() {
    neoSheet(
      context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final route in _AudioRoute.values)
              ListTile(
                leading: Icon(route.icon),
                title: Text(route.label),
                subtitle: route == _AudioRoute.bluetooth
                    ? const Text('Aria Buds Pro')
                    : null,
                trailing: _route == route
                    ? Icon(
                        Icons.check_rounded,
                        color: NeoTheme.of(context).primary,
                      )
                    : null,
                onTap: () {
                  setState(() => _route = route);
                  Navigator.pop(sheetContext);
                },
              ),
            const SizedBox(height: NeoSpace.md),
          ],
        ),
      ),
    );
  }

  void _deviceChecks() {
    neoSheet(
      context,
      builder: (_) => const _DeviceChecksSheet(),
    );
  }
}

enum _AudioRoute { speaker, earpiece, bluetooth }

extension on _AudioRoute {
  String get label => switch (this) {
        _AudioRoute.speaker => 'Speaker',
        _AudioRoute.earpiece => 'Earpiece',
        _AudioRoute.bluetooth => 'Bluetooth',
      };

  IconData get icon => switch (this) {
        _AudioRoute.speaker => Icons.volume_up_rounded,
        _AudioRoute.earpiece => Icons.hearing_rounded,
        _AudioRoute.bluetooth => Icons.bluetooth_audio_rounded,
      };
}

class _Preview extends StatelessWidget {
  const _Preview({required this.cameraOn});
  final bool cameraOn;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return AnimatedContainer(
      duration: NeoMotion.base,
      curve: NeoMotion.curve,
      width: double.infinity,
      decoration: BoxDecoration(
        color: p.surfaceAlt,
        borderRadius: BorderRadius.circular(NeoRadius.xl),
        border: Border.all(color: p.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (cameraOn)
            // The real camera feed replaces this once the preview is wired
            // to LiveKit's local track; the placeholder is a gradient
            // rather than a fake face.
            DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    p.primary.withValues(alpha: 0.35),
                    p.accent.withValues(alpha: 0.45),
                  ],
                ),
              ),
            )
          else
            Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const NeoAvatar(name: 'Adaeze Okonkwo', size: 84),
                  const SizedBox(height: NeoSpace.lg),
                  Text(
                    'Camera is off',
                    style: Theme.of(context)
                        .textTheme
                        .bodyMedium
                        ?.copyWith(color: p.textMuted),
                  ),
                ],
              ),
            ),
          Positioned(
            left: NeoSpace.md,
            bottom: NeoSpace.md,
            child: NeoPill('Preview', color: p.info),
          ),
        ],
      ),
    );
  }
}

class _DeviceChecksSheet extends StatelessWidget {
  const _DeviceChecksSheet();

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final checks = [
      ('Microphone', 'Aria Buds Pro', true),
      ('Camera', 'Front camera', true),
      ('Speaker', 'Aria Buds Pro', true),
      ('Network', 'Wi-Fi · strong', true),
    ];

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          NeoSpace.xl,
          0,
          NeoSpace.xl,
          NeoSpace.xl,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Device checks',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: NeoSpace.lg),
            for (final (name, detail, ok) in checks)
              Padding(
                padding: const EdgeInsets.only(bottom: NeoSpace.md),
                child: Row(
                  children: [
                    Icon(
                      ok ? Icons.check_circle_rounded : Icons.error_rounded,
                      color: ok ? p.success : p.danger,
                      size: 20,
                    ),
                    const SizedBox(width: NeoSpace.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            name,
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                          Text(
                            detail,
                            style: Theme.of(context)
                                .textTheme
                                .bodySmall
                                ?.copyWith(color: p.textMuted),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: NeoSpace.sm),
            NeoBanner(
              icon: Icons.info_outline_rounded,
              tone: NeoBannerTone.info,
              message:
                  'These readings are sample values. Real device enumeration '
                  'needs the native integration listed in the README.',
            ),
          ],
        ),
      ),
    );
  }
}
