import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:livekit_client/livekit_client.dart';

import '../design/brand.dart';
import '../meetings/room_view.dart';
import 'room_controller.dart';

/// What can be done to one person, opened by holding their tile.
///
/// Pin, for everyone. Then, for a host, the web's tile menu, item for item
/// and with its rules: every action is
/// host rank on the server (the sheet is only offered to a host), Make Host
/// is the owner's alone (FRS §1.1), and Demote only appears for someone who
/// is a host or moderator. The owner is never offered to be demoted or
/// removed. The server checks the role again on each of them.
class PersonActionsSheet extends ConsumerWidget {
  const PersonActionsSheet({super.key, required this.slug, required this.person});

  final String slug;
  final PersonView person;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = NeoTheme.of(context);
    final provider = roomControllerProvider(slug);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);

    Future<void> run(Future<void> Function() action) async {
      Navigator.pop(context);
      await action();
    }

    Widget item(IconData icon, String label, VoidCallback onTap, {Color? color}) => ListTile(
          leading: Icon(icon, color: color ?? palette.text),
          title: Text(label, style: TextStyle(color: color ?? palette.text)),
          onTap: onTap,
        );

    final label = person.roleLabel;

    return SafeArea(
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
              child: Text(
                person.name,
                style: Theme.of(context).textTheme.titleLarge,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                label ?? 'Participant',
                style: TextStyle(color: palette.textMuted),
              ),
            ),
            // For everyone: keep this person on the big tile (only on this
            // screen), or let them go.
            if (state.pinnedId == person.id)
              item(Icons.push_pin_outlined, 'Unpin', () {
                Navigator.pop(context);
                controller.togglePin(null);
              })
            else
              item(Icons.push_pin_rounded, 'Pin to the big screen', () {
                Navigator.pop(context);
                controller.togglePin(person.id);
              }),
            if (state.canModerateOthers && !person.isMe) ..._hostActions(context, state, controller, run, item),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  /// What only a host can do to someone else.
  List<Widget> _hostActions(
    BuildContext context,
    RoomState state,
    RoomController controller,
    Future<void> Function(Future<void> Function()) run,
    Widget Function(IconData, String, VoidCallback, {Color? color}) item,
  ) {
    final palette = NeoTheme.of(context);
    return [
            const Divider(height: 16),
            item(Icons.mic_off_rounded, 'Mute microphone',
                () => run(() => controller.moderate(person.id, 'muteAudio'))),
            item(Icons.videocam_off_rounded, 'Turn off camera',
                () => run(() => controller.moderate(person.id, 'muteVideo'))),
            item(Icons.record_voice_over_rounded, 'Ask to unmute mic',
                () => run(() => controller.moderate(person.id, 'requestUnmuteAudio'))),
            item(Icons.videocam_rounded, 'Ask to turn on camera',
                () => run(() => controller.moderate(person.id, 'requestCameraOn'))),
            item(Icons.volume_off_rounded, 'Mute everyone else',
                () => run(() => controller.muteEveryone(except: person.id))),
            if (!person.owner) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
                child: Text(
                  'ROLE',
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(color: palette.textMuted),
                ),
              ),
              if (state.isOwner && person.role != 'host')
                item(Icons.star_rounded, 'Make Host',
                    () => run(() => controller.assignRole(person.id, 'host'))),
              if (person.role != 'cohost')
                item(Icons.shield_rounded, 'Make Moderator',
                    () => run(() => controller.assignRole(person.id, 'moderator'))),
              if (person.elevated)
                item(Icons.person_rounded, 'Demote to Participant',
                    () => run(() => controller.assignRole(person.id, 'participant'))),
              const Divider(height: 16),
              item(
                Icons.person_remove_rounded,
                'Remove from room',
                () async {
                  final yes = await confirmRemove(context, person.name);
                  if (!yes || !context.mounted) return;
                  await run(() => controller.moderate(person.id, 'kick'));
                },
                color: palette.danger,
              ),
            ],
    ];
  }
}

/// Asks before removing someone. True to go ahead.
Future<bool> confirmRemove(BuildContext context, String name) async {
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
          style: FilledButton.styleFrom(backgroundColor: NeoTheme.of(context).danger),
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Remove'),
        ),
      ],
    ),
  );
  return yes == true;
}

/// Which camera to use: the ▾ beside Camera on the web.
///
/// Lists every camera LiveKit can see — front, back, and anything plugged
/// in — rather than only flipping between two. Choosing one while the
/// camera is off makes it the one the next "Video" opens.
class CameraSheet extends ConsumerWidget {
  const CameraSheet({super.key, required this.slug});

  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final palette = NeoTheme.of(context);
    final provider = roomControllerProvider(slug);
    ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final cameras = controller.cameras;
    final current = controller.cameraDeviceId;

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
            child: Text('Camera', style: Theme.of(context).textTheme.titleLarge),
          ),
          if (cameras.isEmpty)
            Padding(
              padding: const EdgeInsets.all(20),
              child: Text(
                'No camera found on this device.',
                style: TextStyle(color: palette.textMuted),
              ),
            )
          else
            for (final (i, camera) in cameras.indexed)
              ListTile(
                leading: Icon(
                  cameraLabel(camera, i).startsWith('Back')
                      ? Icons.photo_camera_back_rounded
                      : Icons.photo_camera_front_rounded,
                  color: palette.text,
                ),
                title: Text(cameraLabel(camera, i), style: TextStyle(color: palette.text)),
                trailing: camera.deviceId == current
                    ? Icon(Icons.check_rounded, color: palette.primary)
                    : null,
                onTap: () async {
                  Navigator.pop(context);
                  await controller.selectCamera(camera);
                },
              ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

/// A name a person recognises. Android labels cameras "Camera 1, Facing
/// front, Orientation 270"; the facing is the part that matters.
String cameraLabel(MediaDevice camera, int index) {
  final text = camera.label.toLowerCase();
  if (text.contains('front')) return 'Front camera';
  if (text.contains('back') || text.contains('rear')) return 'Back camera';
  if (text.contains('external') || text.contains('usb')) return 'External camera';
  return camera.label.isNotEmpty ? camera.label : 'Camera ${index + 1}';
}
