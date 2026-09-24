import 'package:flutter/material.dart';
import 'package:livekit_client/livekit_client.dart' show MediaDevice;

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import 'audio_routes.dart';

/// The two routes Android actually lets an app choose between.
///
/// `setSpeakerOutputPreferred(false)` sends the sound to whatever is
/// attached — Bluetooth earbuds, wired headphones — and to the earpiece
/// when nothing is. Turning it on overrides that and uses the
/// loudspeaker. There is no third option to offer, and no list: WebRTC's
/// enumeration returns no outputs on Android, even mid-call.
List<Widget> _speakerChoice(BuildContext context, AudioRoutes routes) {
  final p = NeoTheme.of(context);
  final speaker = routes.speakerPreferred;

  Widget row({
    required bool selected,
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
  }) =>
      ListTile(
        leading: Icon(icon, color: selected ? p.primary : p.textMuted),
        title: Text(title),
        subtitle: Text(subtitle),
        trailing: selected ? Icon(Icons.check_rounded, color: p.primary) : null,
        onTap: onTap,
      );

  return [
    row(
      selected: speaker,
      icon: Icons.volume_up_rounded,
      title: 'Speaker',
      subtitle: 'The phone\'s loudspeaker',
      onTap: () async {
        await routes.setSpeaker(true);
        if (context.mounted) Navigator.pop(context);
      },
    ),
    row(
      selected: !speaker,
      icon: Icons.headphones_rounded,
      title: 'Headset or earpiece',
      subtitle: 'Bluetooth or wired when connected, otherwise the earpiece',
      onTap: () async {
        await routes.setSpeaker(false);
        if (context.mounted) Navigator.pop(context);
      },
    ),
    Padding(
      padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.sm, NeoSpace.xl, 0),
      child: Text(
        'Android picks the attached device itself; it does not give apps a '
        'list to choose from.',
        style: Theme.of(context)
            .textTheme
            .bodySmall
            ?.copyWith(color: p.textFaint),
      ),
    ),
  ];
}

IconData audioRouteIcon(AudioRouteKind kind) => switch (kind) {
      AudioRouteKind.bluetooth => Icons.bluetooth_audio_rounded,
      AudioRouteKind.wired => Icons.headphones_rounded,
      AudioRouteKind.speaker => Icons.volume_up_rounded,
      AudioRouteKind.earpiece => Icons.hearing_rounded,
      AudioRouteKind.other => Icons.speaker_rounded,
    };

/// Where the sound goes.
///
/// The list is whatever the device actually reports, not a fixed set of
/// three: a phone with two pairs of earbuds paired shows both, and one
/// with nothing attached shows what it has rather than inventing options.
class AudioOutputSheet extends StatefulWidget {
  const AudioOutputSheet({super.key});

  @override
  State<AudioOutputSheet> createState() => _AudioOutputSheetState();
}

class _AudioOutputSheetState extends State<AudioOutputSheet> {
  @override
  void initState() {
    super.initState();
    // Re-read on open: earbuds connect while a meeting is running more
    // often than at any other time.
    AudioRoutes.instance.refresh();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);

    return AnimatedBuilder(
      animation: AudioRoutes.instance,
      builder: (context, _) {
        final routes = AudioRoutes.instance;
        final outputs = routes.outputs;
        final selected = routes.selectedOutput;

        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NeoSpace.xl,
                  NeoSpace.sm,
                  NeoSpace.xl,
                  NeoSpace.md,
                ),
                child: Text(
                  'Audio output',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),

              if (routes.error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: NeoSpace.xl,
                    vertical: NeoSpace.sm,
                  ),
                  child: NeoBanner(
                    icon: Icons.error_outline_rounded,
                    tone: NeoBannerTone.warning,
                    message: 'Could not read this device\'s audio outputs.',
                  ),
                )
              else if (outputs.isEmpty)
                // Android does not hand WebRTC a list of outputs — its
                // AudioSwitch reports none even mid-call — so the choice
                // it actually offers is the one shown here: loudspeaker,
                // or whatever is attached. A spinner would sit there
                // forever waiting for a list that never arrives.
                ..._speakerChoice(context, routes)
              else
                for (final device in outputs)
                  ListTile(
                    leading: Icon(
                      audioRouteIcon(AudioRoutes.routeKind(device)),
                      color: device == selected ? p.primary : p.textMuted,
                    ),
                    title: Text(AudioRoutes.label(device)),
                    trailing: device == selected
                        ? Icon(Icons.check_rounded, color: p.primary)
                        : null,
                    onTap: () async {
                      final moved = await routes.select(device);
                      if (!context.mounted) return;
                      Navigator.pop(context);
                      if (!moved) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text(
                              'This device would not take the audio. It may '
                              'have disconnected.',
                            ),
                          ),
                        );
                      }
                    },
                  ),

              if (!routes.canRoute)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    NeoSpace.xl,
                    NeoSpace.sm,
                    NeoSpace.xl,
                    0,
                  ),
                  child: Text(
                    'This platform does not let an app move the audio; the '
                    'system decides.',
                    style: Theme.of(context)
                        .textTheme
                        .bodySmall
                        ?.copyWith(color: p.textFaint),
                  ),
                ),
              const SizedBox(height: NeoSpace.md),
            ],
          ),
        );
      },
    );
  }
}

/// What this device actually has.
///
/// Every row is read from the platform. The version of this screen in the
/// design showed four invented readings and a banner admitting they were
/// invented; this shows the real microphone, camera and output lists, and
/// says plainly where a platform will not answer.
class DeviceChecksSheet extends StatefulWidget {
  const DeviceChecksSheet({super.key});

  @override
  State<DeviceChecksSheet> createState() => _DeviceChecksSheetState();
}

class _DeviceChecksSheetState extends State<DeviceChecksSheet> {
  @override
  void initState() {
    super.initState();
    AudioRoutes.instance.refresh();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);

    return AnimatedBuilder(
      animation: AudioRoutes.instance,
      builder: (context, _) {
        final routes = AudioRoutes.instance;

        return SafeArea(
          child: SingleChildScrollView(
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

                  if (routes.error != null)
                    NeoBanner(
                      icon: Icons.error_outline_rounded,
                      tone: NeoBannerTone.warning,
                      message: 'Could not read this device\'s hardware.',
                    )
                  else ...[
                    _Group(
                      title: 'Microphone',
                      devices: routes.inputs,
                      icon: Icons.mic_rounded,
                      // selectAudioInput is Windows and macOS only; on a
                      // phone the OS picks the microphone to match the
                      // output route, so these are shown and not offered.
                      note: 'Chosen by the system to match the output',
                    ),
                    _Group(
                      title: 'Audio output',
                      devices: routes.outputs,
                      icon: Icons.volume_up_rounded,
                      selected: routes.selectedOutput,
                      // Not a fault, and not "none": WebRTC reports no
                      // outputs on Android at all. The choice that exists
                      // is speaker or attached-device, which is what the
                      // output sheet offers.
                      emptyLabel: 'Not listed by Android',
                      note: routes.outputs.isEmpty
                          ? 'Currently: ${routes.speakerPreferred ? 'Speaker' : 'Headset or earpiece'}'
                          : null,
                    ),
                    _Group(
                      title: 'Camera',
                      devices: routes.cameras,
                      icon: Icons.videocam_rounded,
                    ),
                  ],

                  const SizedBox(height: NeoSpace.sm),
                  Text(
                    'Bluetooth devices appear under their own name once '
                    'NeoConference has the Nearby devices permission; '
                    'without it Android reports them generically.',
                    style: Theme.of(context)
                        .textTheme
                        .bodySmall
                        ?.copyWith(color: p.textFaint),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Group extends StatelessWidget {
  const _Group({
    required this.title,
    required this.devices,
    required this.icon,
    this.selected,
    this.note,
    this.emptyLabel,
  });

  final String title;
  final List<MediaDevice> devices;
  final IconData icon;
  final MediaDevice? selected;
  final String? note;

  /// What to say instead of "None found" when empty is expected rather
  /// than a problem.
  final String? emptyLabel;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: NeoSpace.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                icon,
                size: 18,
                color: devices.isEmpty ? p.textFaint : p.primary,
              ),
              const SizedBox(width: NeoSpace.sm),
              Text(title, style: text.titleSmall),
              const Spacer(),
              // The count is the check: "none" is a real answer and the
              // reason a meeting would be silent.
              Text(
                devices.isEmpty
                    ? (emptyLabel ?? 'None found')
                    : '${devices.length}',
                style: text.bodySmall?.copyWith(
                  color: devices.isEmpty && emptyLabel == null
                      ? p.warning
                      : p.textMuted,
                ),
              ),
            ],
          ),
          for (final device in devices)
            Padding(
              padding: const EdgeInsets.only(left: 26, top: 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      AudioRoutes.label(device),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: text.bodySmall?.copyWith(
                        color: device == selected ? p.text : p.textMuted,
                      ),
                    ),
                  ),
                  if (device == selected)
                    Icon(Icons.check_rounded, size: 14, color: p.primary),
                ],
              ),
            ),
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(left: 26, top: 4),
              child: Text(
                note!,
                style: text.bodySmall?.copyWith(color: p.textFaint),
              ),
            ),
        ],
      ),
    );
  }
}
