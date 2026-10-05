import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import 'room_controller.dart';

/// The meeting's countdown timer, as the server keeps it (src/lib/timer.ts):
/// one per meeting, set and run by an owner, host or moderator, seen by
/// everyone — or only by them, when it is set to "admins".
///
/// The app had none: a host could not set one from a phone, and nobody on
/// a phone saw the one a host set on the website.
@immutable
class MeetingTimerState {
  const MeetingTimerState({
    required this.status,
    required this.durationMs,
    required this.remainingAtStartMs,
    this.startedAtMs,
    this.remainingAtPauseMs,
    this.adminsOnly = false,
    this.updatedAt = 0,
  });

  /// idle | running | paused | expired
  final String status;
  final int durationMs;
  final int remainingAtStartMs;
  final int? startedAtMs;
  final int? remainingAtPauseMs;

  /// Shown only to owner, hosts and moderators.
  final bool adminsOnly;

  /// When the server last changed it; a newer state replaces an older one.
  final int updatedAt;

  static const idle = MeetingTimerState(status: 'idle', durationMs: 0, remainingAtStartMs: 0);

  static MeetingTimerState? fromJson(Object? json) {
    if (json is! Map) return null;
    int? n(Object? v) => v is num ? v.toInt() : null;
    final status = json['status'];
    if (status is! String) return null;
    return MeetingTimerState(
      status: status,
      durationMs: n(json['durationMs']) ?? 0,
      remainingAtStartMs: n(json['remainingAtStartMs']) ?? 0,
      startedAtMs: n(json['startedAtMs']),
      remainingAtPauseMs: n(json['remainingAtPauseMs']),
      adminsOnly: json['visibility'] == 'admins',
      updatedAt: n(json['updatedAt']) ?? 0,
    );
  }

  bool get running => status == 'running';
  bool get paused => status == 'paused';
  bool get expired => status == 'expired';
  bool get isSet => status != 'idle' || durationMs > 0;

  /// What is left, the server's computeRemaining. [now] is epoch ms.
  int remainingMs(int now) {
    switch (status) {
      case 'expired':
        return 0;
      case 'paused':
        return (remainingAtPauseMs ?? durationMs).clamp(0, 1 << 62);
      case 'running':
        final started = startedAtMs ?? now;
        final elapsed = (now - started).clamp(0, 1 << 62);
        return (remainingAtStartMs - elapsed).clamp(0, 1 << 62);
      default:
        return durationMs;
    }
  }

  /// The last stretch: 30 s, or a tenth of the time when that is longer —
  /// the web's warning.
  bool urgent(int now) {
    if (durationMs <= 0) return false;
    final left = remainingMs(now);
    final threshold = durationMs ~/ 10 > 30000 ? durationMs ~/ 10 : 30000;
    return left > 0 && left <= threshold;
  }

  /// Whether this person sees it at all.
  bool visibleTo({required bool manager}) => isSet && (!adminsOnly || manager);
}

/// "04:59", or "1:04:59" past an hour.
String timerClock(int ms) {
  final total = (ms / 1000).ceil().clamp(0, 1 << 31);
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = total % 60;
  String two(int v) => v.toString().padLeft(2, '0');
  return h > 0 ? '$h:${two(m)}:${two(s)}' : '${two(m)}:${two(s)}';
}

/// What the meeting header says about the timer, or null for nothing.
String? timerLabel(MeetingTimerState? timer, {required bool manager, required int now}) {
  if (timer == null || !timer.visibleTo(manager: manager)) return null;
  if (timer.expired) return "Time's up";
  final left = timerClock(timer.remainingMs(now));
  if (timer.paused) return '$left paused';
  if (timer.running) return '$left left';
  return null; // set but not started: nothing to count yet
}

/// The host's timer: set, start, pause, adjust, who sees it.
class MeetingTimerSheet extends ConsumerStatefulWidget {
  const MeetingTimerSheet({super.key, required this.slug});
  final String slug;

  @override
  ConsumerState<MeetingTimerSheet> createState() => _MeetingTimerSheetState();
}

class _MeetingTimerSheetState extends ConsumerState<MeetingTimerSheet> {
  final _minutes = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _minutes.dispose();
    super.dispose();
  }

  Future<void> _do(Map<String, Object?> action) async {
    setState(() => _busy = true);
    await ref.read(roomControllerProvider(widget.slug).notifier).timerAction(action);
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _setAndStart(int minutes) async {
    if (minutes <= 0) return;
    final adminsOnly = ref.read(roomControllerProvider(widget.slug)).timer?.adminsOnly ?? false;
    await _do({
      'action': 'set',
      'durationMs': minutes * 60000,
      'visibility': adminsOnly ? 'admins' : 'everyone',
    });
    await _do({'action': 'start'});
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final state = ref.watch(roomControllerProvider(widget.slug));
    final timer = state.timer ?? MeetingTimerState.idle;
    final now = DateTime.now().millisecondsSinceEpoch;
    final left = timer.remainingMs(now);

    Widget preset(int m) => OutlinedButton(
          onPressed: _busy ? null : () => _setAndStart(m),
          child: Text('$m min'),
        );

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 16, 20, 16 + MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Meeting timer', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(
              'A countdown everyone in the meeting sees — on phones and the website.',
              style: TextStyle(color: p.textMuted, fontSize: 13),
            ),
            if (timer.isSet) ...[
              const SizedBox(height: 16),
              Center(
                child: Text(
                  timer.expired ? "Time's up" : timerClock(left),
                  style: TextStyle(
                    fontSize: 44,
                    fontWeight: FontWeight.w700,
                    color: timer.expired || timer.urgent(now) ? p.danger : p.text,
                  ),
                ),
              ),
              Center(
                child: Text(
                  switch (timer.status) {
                    'running' => 'Running',
                    'paused' => 'Paused',
                    'expired' => 'Finished',
                    _ => 'Ready to start',
                  },
                  style: TextStyle(color: p.textMuted),
                ),
              ),
              const SizedBox(height: 12),
              Wrap(
                alignment: WrapAlignment.center,
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (timer.running)
                    FilledButton.icon(
                      onPressed: _busy ? null : () => _do({'action': 'pause'}),
                      icon: const Icon(Icons.pause_rounded),
                      label: const Text('Pause'),
                    )
                  else if (timer.paused)
                    FilledButton.icon(
                      onPressed: _busy ? null : () => _do({'action': 'resume'}),
                      icon: const Icon(Icons.play_arrow_rounded),
                      label: const Text('Resume'),
                    )
                  else if (!timer.expired)
                    FilledButton.icon(
                      onPressed: _busy ? null : () => _do({'action': 'start'}),
                      icon: const Icon(Icons.play_arrow_rounded),
                      label: const Text('Start'),
                    ),
                  if (timer.running || timer.paused) ...[
                    OutlinedButton(
                      onPressed: _busy ? null : () => _do({'action': 'adjust', 'deltaMs': -60000}),
                      child: const Text('− 1 min'),
                    ),
                    OutlinedButton(
                      onPressed: _busy ? null : () => _do({'action': 'adjust', 'deltaMs': 60000}),
                      child: const Text('+ 1 min'),
                    ),
                  ],
                  TextButton.icon(
                    onPressed: _busy ? null : () => _do({'action': 'reset'}),
                    icon: const Icon(Icons.restart_alt_rounded),
                    label: const Text('Reset'),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 16),
            Text('START A NEW COUNTDOWN', style: TextStyle(color: p.primary, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.8)),
            const SizedBox(height: 8),
            Wrap(spacing: 8, runSpacing: 8, children: [for (final m in const [5, 10, 15, 30, 45, 60]) preset(m)]),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _minutes,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(hintText: 'Other: minutes', isDense: true),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _busy
                      ? null
                      : () {
                          final m = int.tryParse(_minutes.text.trim()) ?? 0;
                          if (m > 0) {
                            FocusScope.of(context).unfocus();
                            _setAndStart(m);
                          }
                        },
                  child: const Text('Start'),
                ),
              ],
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: timer.adminsOnly,
              onChanged: _busy
                  ? null
                  : (on) => _do({'action': 'visibility', 'visibility': on ? 'admins' : 'everyone'}),
              title: const Text('Only hosts see it'),
              subtitle: const Text('Off: everyone in the meeting sees the countdown.'),
            ),
            if (state.timerError != null)
              Text(state.timerError!, style: TextStyle(color: p.danger, fontSize: 12)),
          ],
        ),
      ),
    );
  }
}
