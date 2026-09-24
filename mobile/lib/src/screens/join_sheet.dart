import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../mock/sample_data.dart';
import 'prejoin_screen.dart';

/// Join by link, meeting ID, or an invitation already waiting.
///
/// One field rather than three: people arrive holding a pasted URL, a code
/// someone read out, or nothing at all, and making them first classify
/// what they have is a step that serves the form rather than the person.
/// Whatever is pasted, the meeting code is extracted from it.
class JoinSheet extends StatefulWidget {
  const JoinSheet({super.key});

  @override
  State<JoinSheet> createState() => _JoinSheetState();
}

class _JoinSheetState extends State<JoinSheet> {
  final _controller = TextEditingController();
  String? _error;

  @override
  void initState() {
    super.initState();
    _controller.addListener(() {
      if (_error != null) setState(() => _error = null);
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// Accepts a full URL, a /room/ path, or a bare code.
  static String? codeFrom(String raw) {
    final cleaned = raw.trim().replaceAll(RegExp(r'[?#].*$'), '');
    if (cleaned.isEmpty) return null;
    final segment = cleaned
        .split('/')
        .where((s) => s.isNotEmpty && s != 'room' && !s.contains('.'))
        .lastOrNull;
    if (segment == null || segment.isEmpty) return null;
    return RegExp(r'^[A-Za-z0-9_-]{2,64}$').hasMatch(segment) ? segment : null;
  }

  Future<void> _paste() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    if (data?.text != null) _controller.text = data!.text!;
  }

  void _join() {
    final code = codeFrom(_controller.text);
    if (code == null) {
      setState(() => _error = 'That does not look like a meeting link or ID.');
      return;
    }
    Navigator.pop(context);
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => PreJoinScreen(
          meeting: SampleMeeting(
            title: code,
            code: code,
            host: 'Unknown host',
            startsAt: sampleNow,
            durationMinutes: 0,
            participants: const [],
            status: SampleStatus.live,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Padding(
      padding: EdgeInsets.only(
        left: NeoSpace.xl,
        right: NeoSpace.xl,
        bottom: MediaQuery.of(context).viewInsets.bottom + NeoSpace.xl,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Join a meeting', style: text.titleLarge),
          const SizedBox(height: NeoSpace.xs),
          Text(
            'Paste a link, or type the meeting ID.',
            style: text.bodySmall?.copyWith(color: p.textMuted),
          ),
          const SizedBox(height: NeoSpace.xl),
          TextField(
            controller: _controller,
            autofocus: true,
            textInputAction: TextInputAction.go,
            onSubmitted: (_) => _join(),
            decoration: InputDecoration(
              hintText: 'neoconference.app/product-sync',
              errorText: _error,
              prefixIcon: const Icon(Icons.link_rounded),
              suffixIcon: IconButton(
                tooltip: 'Paste',
                icon: const Icon(Icons.content_paste_rounded),
                onPressed: _paste,
              ),
            ),
          ),
          const SizedBox(height: NeoSpace.lg),
          FilledButton(onPressed: _join, child: const Text('Continue')),
          const SizedBox(height: NeoSpace.xxl),
          Text(
            'INVITATIONS',
            style: text.labelSmall?.copyWith(color: p.textMuted),
          ),
          const SizedBox(height: NeoSpace.md),
          for (final m in sampleUpcoming.take(2))
            Padding(
              padding: const EdgeInsets.only(bottom: NeoSpace.sm),
              child: NeoCard(
                padding: const EdgeInsets.all(NeoSpace.md),
                onTap: () {
                  Navigator.pop(context);
                  Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => PreJoinScreen(meeting: m),
                    ),
                  );
                },
                child: Row(
                  children: [
                    NeoAvatar(name: m.host, size: 34),
                    const SizedBox(width: NeoSpace.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            m.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: text.titleSmall,
                          ),
                          Text(
                            '${m.host} · ${sampleWhen(m.startsAt)}',
                            style: text.bodySmall?.copyWith(color: p.textMuted),
                          ),
                        ],
                      ),
                    ),
                    Icon(Icons.chevron_right_rounded, color: p.textFaint),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}
