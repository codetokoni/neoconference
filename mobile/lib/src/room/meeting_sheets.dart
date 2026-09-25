import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../events/languages.dart';
import 'room_controller.dart';

/// What this meeting is, and the link to hand someone.
///
/// Everything shown is read from the meeting itself. There is no host
/// name or invitee list because /api/events/mine does not return them —
/// the row is absent rather than blank.
class MeetingDetailsSheet extends ConsumerWidget {
  const MeetingDetailsSheet({
    super.key,
    required this.slug,
    required this.title,
  });

  final String slug;
  final String title;

  static const _origin = 'https://www.neoconference.app';

  String get _link => '$_origin/$slug';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final provider = roomControllerProvider(slug);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);
    final people = controller.room.remoteParticipants.length + 1;

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
              Text('Meeting details', style: text.titleLarge),
              const SizedBox(height: NeoSpace.lg),

              _Row(label: 'Name', value: title),
              _Row(label: 'Meeting ID', value: slug),
              _Row(
                label: 'In the meeting',
                value: state.link == RoomLink.live
                    ? '$people'
                    // A count from before the link dropped is a leftover,
                    // and people act on it.
                    : 'Not known while reconnecting',
              ),
              _Row(
                label: 'Your role',
                value: state.role[0].toUpperCase() + state.role.substring(1),
              ),
              if (state.waitingRoom.isNotEmpty && state.canManage)
                _Row(label: 'Waiting', value: '${state.waitingRoom.length}'),
              if (state.isRecording)
                _Row(label: 'Recording', value: 'In progress'),

              const SizedBox(height: NeoSpace.lg),
              Text(
                'LINK',
                style: text.labelSmall?.copyWith(color: p.textMuted),
              ),
              const SizedBox(height: NeoSpace.xs),
              SelectableText(_link, style: text.bodyMedium),
              const SizedBox(height: NeoSpace.md),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () async {
                        await Clipboard.setData(ClipboardData(text: _link));
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Link copied.')),
                        );
                      },
                      icon: const Icon(Icons.copy_rounded, size: 18),
                      label: const Text('Copy link'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: NeoSpace.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: text.bodySmall?.copyWith(color: p.textMuted),
            ),
          ),
          Expanded(child: Text(value, style: text.bodyMedium)),
        ],
      ),
    );
  }
}

/// Choose a language for live captions.
///
/// The meeting's own transcription produces the captions; this only
/// decides what they are translated into. Both halves can fail
/// independently and the sheet says which: no captions arriving is a
/// different problem from translation being switched off on the server.
class TranslationSheet extends ConsumerWidget {
  const TranslationSheet({super.key, required this.slug});

  final String slug;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;
    final provider = roomControllerProvider(slug);
    final state = ref.watch(provider);
    final controller = ref.read(provider.notifier);

    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(
                NeoSpace.xl,
                NeoSpace.sm,
                NeoSpace.xl,
                NeoSpace.sm,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Live translation', style: text.titleLarge),
                  const SizedBox(height: NeoSpace.xs),
                  Text(
                    'Captions come from the meeting. This chooses the '
                    'language they are shown in.',
                    style: text.bodySmall?.copyWith(color: p.textMuted),
                  ),
                ],
              ),
            ),

            if (state.translationError != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NeoSpace.xl,
                  0,
                  NeoSpace.xl,
                  NeoSpace.sm,
                ),
                child: NeoBanner(
                  icon: Icons.error_outline_rounded,
                  tone: NeoBannerTone.warning,
                  message: state.translationError!,
                ),
              )
            else if (state.translateTo != null && state.transcriptionsSeen == 0)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  NeoSpace.xl,
                  0,
                  NeoSpace.xl,
                  NeoSpace.sm,
                ),
                child: NeoBanner(
                  icon: Icons.hourglass_empty_rounded,
                  tone: NeoBannerTone.info,
                  // Said rather than left to a blank screen: with no
                  // captions there is nothing to translate, and that is
                  // the meeting's doing, not this phone's.
                  message: 'No captions have arrived yet. The meeting has to '
                      'be transcribing for anything to appear.',
                ),
              ),

            Expanded(
              child: ListView(
                children: [
                  RadioListTile<String?>(
                    value: null,
                    groupValue: state.translateTo,
                    onChanged: (_) {
                      controller.setTranslation(null);
                      Navigator.pop(context);
                    },
                    title: const Text('Off'),
                    subtitle: const Text('Show captions as spoken'),
                  ),
                  for (final language in meetingLanguages)
                    RadioListTile<String?>(
                      value: language.code,
                      groupValue: state.translateTo,
                      onChanged: (value) {
                        controller.setTranslation(value);
                        Navigator.pop(context);
                      },
                      title: Text(language.label),
                      subtitle: Text(language.native),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The caption strip, under the video and above the controls.
///
/// Shows the translation when there is one and the spoken text until
/// then, so a caption never disappears while a request is in flight.
class CaptionStrip extends StatelessWidget {
  const CaptionStrip({super.key, required this.state});

  final RoomState state;

  @override
  Widget build(BuildContext context) {
    final caption = state.translatedCaption ?? state.caption;
    if (caption == null || caption.isEmpty) return const SizedBox.shrink();

    final p = NeoTheme.of(context);
    final translating =
        state.translateTo != null && state.translatedCaption == null;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: NeoSpace.lg),
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: NeoSpace.md,
          vertical: NeoSpace.sm,
        ),
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.62),
          borderRadius: BorderRadius.circular(NeoRadius.md),
        ),
        child: Text(
          caption,
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                // Dimmed while the translated version is on its way, so
                // the change is expected rather than a flicker.
                color: translating ? p.textMuted : p.text,
              ),
        ),
      ),
    );
  }
}
