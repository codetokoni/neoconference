import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/tokens.dart';
import 'live_stream.dart';

/// Go Live, in Host controls: where the meeting is going, or where to send
/// it. Built from plain state and callbacks so it can be tested without a
/// live meeting; the sheet gives it the controller's.
class GoLiveControl extends StatelessWidget {
  const GoLiveControl({
    super.key,
    required this.allowed,
    required this.stream,
    required this.onStart,
    required this.onStop,
    required this.onRefresh,
  });

  /// The owner's plan includes livestreaming.
  final bool allowed;
  final LiveStreamView? stream;

  /// Both answer with what went wrong, or null.
  final Future<String?> Function(List<StreamDestinationInput>) onStart;
  final Future<String?> Function() onStop;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final live = stream;
    if (live != null) {
      return ListTile(
        leading: Icon(Icons.sensors_rounded, color: p.danger),
        title: Text(live.liveOn, style: TextStyle(color: p.text, fontWeight: FontWeight.w600)),
        subtitle: Text(
          live.destinations.map((d) => '${d.label}: ${d.statusLabel}').join(' · '),
          style: TextStyle(color: live.destinations.any((d) => d.status == 'failed') ? p.warning : p.textMuted),
        ),
        trailing: TextButton(
          onPressed: () async {
            final problem = await onStop();
            if (problem != null && context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(problem)));
            }
          },
          child: Text('Stop', style: TextStyle(color: p.danger)),
        ),
        onTap: onRefresh,
      );
    }
    if (!allowed) {
      return ListTile(
        leading: Icon(Icons.sensors_rounded, color: p.textFaint),
        title: Text('Go Live', style: TextStyle(color: p.textMuted)),
        subtitle: Text(
          "Streaming to YouTube, Facebook or Twitch is on the Enterprise plan, and this meeting's owner is not on it.",
          style: TextStyle(color: p.textMuted),
        ),
      );
    }
    return ListTile(
      leading: Icon(Icons.sensors_rounded, color: p.danger),
      title: Text('Go Live', style: TextStyle(color: p.text)),
      subtitle: Text('Stream this meeting to YouTube, Facebook, Twitch or RTMP', style: TextStyle(color: p.textMuted)),
      trailing: Icon(Icons.chevron_right_rounded, color: p.textMuted),
      onTap: () => showDialog<void>(
        context: context,
        builder: (_) => GoLiveDialog(onStart: onStart),
      ),
    );
  }
}

/// Pick a platform, paste its key, start. One destination here; the web
/// offers up to four. The key field never shows what was typed.
class GoLiveDialog extends StatefulWidget {
  const GoLiveDialog({super.key, required this.onStart});
  final Future<String?> Function(List<StreamDestinationInput>) onStart;

  @override
  State<GoLiveDialog> createState() => _GoLiveDialogState();
}

class _GoLiveDialogState extends State<GoLiveDialog> {
  String _platform = 'youtube';
  final _key = TextEditingController();
  final _label = TextEditingController();
  bool _busy = false;
  String? _problem;

  @override
  void dispose() {
    _key.dispose();
    _label.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    final input = StreamDestinationInput(platform: _platform, key: _key.text, label: _label.text);
    final problem = destinationProblem(input);
    if (problem != null) {
      setState(() => _problem = problem);
      return;
    }
    setState(() {
      _busy = true;
      _problem = null;
    });
    final failed = await widget.onStart([input]);
    if (!mounted) return;
    if (failed != null) {
      setState(() {
        _busy = false;
        _problem = failed;
      });
      return;
    }
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final platform = streamPlatforms.firstWhere((x) => x.id == _platform);
    return AlertDialog(
      title: const Text('Go Live'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              "Send this meeting's video and audio live. Paste the stream key from the platform; "
              'NeoConference does the rest.',
              style: TextStyle(color: p.textMuted, fontSize: 13),
            ),
            const SizedBox(height: NeoSpace.md),
            DropdownButtonFormField<String>(
              initialValue: _platform,
              decoration: const InputDecoration(labelText: 'Platform'),
              items: [for (final x in streamPlatforms) DropdownMenuItem(value: x.id, child: Text(x.label))],
              onChanged: _busy ? null : (v) => setState(() => _platform = v ?? 'youtube'),
            ),
            const SizedBox(height: NeoSpace.md),
            TextField(
              controller: _key,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              decoration: InputDecoration(
                labelText: _platform == 'rtmp' ? 'RTMP address' : 'Stream key',
                helperText: platform.keyHint,
                helperMaxLines: 2,
              ),
            ),
            const SizedBox(height: NeoSpace.md),
            TextField(
              controller: _label,
              maxLength: 40,
              decoration: InputDecoration(
                labelText: 'Name shown to everyone (optional)',
                hintText: '${platform.label} channel',
                counterText: '',
              ),
            ),
            if (_problem != null) ...[
              const SizedBox(height: NeoSpace.sm),
              Text(_problem!, style: TextStyle(color: p.warning)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: _busy ? null : () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          onPressed: _busy ? null : _start,
          style: FilledButton.styleFrom(backgroundColor: p.danger),
          child: Text(_busy ? 'Starting…' : 'Start streaming'),
        ),
      ],
    );
  }
}
