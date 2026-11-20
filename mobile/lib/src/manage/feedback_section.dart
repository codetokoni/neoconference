import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import '../design/components.dart';
import '../design/brand.dart';
import '../design/tokens.dart';
import '../events/event.dart';
import '../room/meeting_feedback.dart';

/// The meeting's feedback, on its Manage screen, as on the web's meeting
/// page: the link to share, where feedback is sent (a KingsChat handle and an
/// email, on a paid plan), the ratings, and what people wrote.
class FeedbackSection extends ConsumerStatefulWidget {
  const FeedbackSection({super.key, required this.eventId, required this.slug});
  final String eventId;
  final String slug;

  @override
  ConsumerState<FeedbackSection> createState() => _FeedbackSectionState();
}

class _FeedbackSectionState extends ConsumerState<FeedbackSection> {
  late final FeedbackApi _api = FeedbackApi(ref.read(apiProvider));
  final _handle = TextEditingController();
  final _email = TextEditingController();
  FeedbackOverview? _data;
  String? _error;
  String? _saveNote;
  bool _saveOk = false;
  bool _saving = false;
  bool _showAll = false;

  String get _link => '${Config.site}/feedback/${widget.slug}';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _handle.dispose();
    _email.dispose();
    super.dispose();
  }

  void _fill(FeedbackContact? c) {
    _handle.text = (c?.kcHandle ?? '').isEmpty ? '' : '@${c!.kcHandle}';
    _email.text = c?.email ?? '';
  }

  Future<void> _load() async {
    try {
      final d = await _api.overview(widget.slug);
      if (!mounted) return;
      if (d == null) {
        setState(() => _error = 'Only the meeting\'s owner sees its feedback.');
        return;
      }
      setState(() {
        _data = d;
        _error = null;
      });
      _fill(d.contact);
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.message : 'Feedback did not load. Pull down to try again.');
    }
  }

  Future<void> _save({bool remove = false}) async {
    final d = _data;
    if (d == null) return;
    setState(() {
      _saving = true;
      _saveNote = null;
    });
    final contact = remove ? const FeedbackContact() : FeedbackContact(kcHandle: _handle.text.trim(), email: _email.text.trim());
    try {
      final r = await _api.saveContact(widget.eventId, contact);
      if (!mounted) return;
      _fill(r.contact);
      setState(() {
        _data = d.withContact(r.contact, r.reach);
        _saveOk = true;
        _saveNote = r.contact == null ? 'Removed. Feedback goes to your notifications and our support team.' : 'Saved. New feedback will be sent there too.';
      });
    } catch (e) {
      if (!mounted) return;
      final code = e is ApiException ? e.code : '';
      setState(() {
        _saveOk = false;
        _saveNote = switch (code) {
          'invalid_feedback_contact' => 'Check the KingsChat handle (like @name) and the email address.',
          'plan_required' => 'Sending feedback to a KingsChat handle or email needs a paid plan.',
          _ => 'Not saved. Check your connection and try again.',
        };
      });
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  List<String> _reachNotes(FeedbackOverview d) {
    final handle = d.contact?.kcHandle;
    if (handle == null || handle.isEmpty) return const [];
    return [
      if (d.reach.ownerKcLinked == false)
        'KingsChat messages are sent from your own KingsChat account. Sign in with KingsChat once so they can be sent.',
      if (d.reach.kcHandleKnown == false)
        'Nobody has signed in here with @$handle yet, so a KingsChat message cannot find them. They need to sign in with KingsChat once.',
    ];
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final d = _data;
    return NeoSection(
      title: 'Feedback',
      child: d == null
          ? NeoCard(
              child: _error == null
                  ? const Center(child: Padding(padding: EdgeInsets.all(NeoSpace.md), child: CircularProgressIndicator()))
                  : Text(_error!, style: TextStyle(color: p.textMuted)),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                NeoCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Share this link so people can tell you what went wrong, even if they could not get in. '
                        'People can also send feedback from inside the meeting, and are asked how it went when they leave.',
                        style: TextStyle(color: p.textMuted),
                      ),
                      const SizedBox(height: NeoSpace.md),
                      SelectableText(_link, style: TextStyle(color: p.primary)),
                      const SizedBox(height: NeoSpace.sm),
                      OutlinedButton.icon(
                        icon: const Icon(Icons.copy_rounded, size: 18),
                        label: const Text('Copy feedback link'),
                        onPressed: () async {
                          await Clipboard.setData(ClipboardData(text: _link));
                          if (!context.mounted) return;
                          ScaffoldMessenger.of(context)
                            ..hideCurrentSnackBar()
                            ..showSnackBar(const SnackBar(content: Text('Feedback link copied.')));
                        },
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: NeoSpace.md),
                NeoCard(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text('Where feedback goes', style: TextStyle(color: p.text, fontWeight: FontWeight.w600)),
                      const SizedBox(height: NeoSpace.xs),
                      Text('Always to your notifications and to our support team.', style: TextStyle(color: p.textMuted, fontSize: 13)),
                      const SizedBox(height: NeoSpace.md),
                      if (!d.contactAllowed)
                        Text(
                          'On a paid plan, feedback can also go straight to a KingsChat handle or an email.',
                          style: TextStyle(color: p.text),
                        )
                      else ...[
                        TextField(
                          controller: _handle,
                          decoration: const InputDecoration(labelText: 'KingsChat handle', hintText: '@yourhandle', border: OutlineInputBorder()),
                        ),
                        const SizedBox(height: NeoSpace.md),
                        TextField(
                          controller: _email,
                          keyboardType: TextInputType.emailAddress,
                          decoration: const InputDecoration(labelText: 'Email', hintText: 'team@example.org', border: OutlineInputBorder()),
                        ),
                        for (final note in _reachNotes(d))
                          Padding(
                            padding: const EdgeInsets.only(top: NeoSpace.sm),
                            child: Text(note, style: TextStyle(color: p.warning, fontSize: 13)),
                          ),
                        if ((d.contact?.kcHandle ?? '').isNotEmpty && _reachNotes(d).isEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: NeoSpace.sm),
                            child: Text('KingsChat messages will reach @${d.contact!.kcHandle}.', style: TextStyle(color: p.success, fontSize: 13)),
                          ),
                        const SizedBox(height: NeoSpace.md),
                        Wrap(
                          spacing: NeoSpace.sm,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            FilledButton(onPressed: _saving ? null : _save, child: Text(_saving ? 'Saving…' : 'Save')),
                            if (d.contact != null && !d.contact!.isEmpty)
                              TextButton(onPressed: _saving ? null : () => _save(remove: true), child: const Text('Remove')),
                          ],
                        ),
                        if (_saveNote != null)
                          Padding(
                            padding: const EdgeInsets.only(top: NeoSpace.sm),
                            child: Text(_saveNote!, style: TextStyle(color: _saveOk ? p.success : p.danger)),
                          ),
                        const SizedBox(height: NeoSpace.sm),
                        Text('At most one message every 10 minutes, saying how many came in since.', style: TextStyle(color: p.textFaint, fontSize: 12)),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: NeoSpace.md),
                Wrap(
                  spacing: NeoSpace.lg,
                  runSpacing: NeoSpace.xs,
                  children: [
                    // Stars are icons, not the ★ character: a phone's font
                    // may not have it.
                    if (d.average == null)
                      Text('No ratings yet', style: TextStyle(color: p.text))
                    else
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.star_rounded, size: 18, color: Colors.amber),
                          const SizedBox(width: NeoSpace.xs),
                          Text(
                            '${d.average!.toStringAsFixed(1)} from ${d.rated} rating${d.rated == 1 ? '' : 's'}',
                            style: TextStyle(color: p.text),
                          ),
                        ],
                      ),
                    Text('${d.written} written message${d.written == 1 ? '' : 's'}', style: TextStyle(color: p.textMuted)),
                    for (final e in d.kindCounts.entries) Text('${d.kindLabel(e.key)}: ${e.value}', style: TextStyle(color: p.textMuted)),
                  ],
                ),
                const SizedBox(height: NeoSpace.sm),
                if (d.entries.isEmpty)
                  Text('No feedback yet.', style: TextStyle(color: p.textMuted))
                else ...[
                  for (final e in (_showAll ? d.entries : d.entries.take(10))) _EntryTile(entry: e, kindLabel: d.kindLabel(e.kind)),
                  if (!_showAll && d.entries.length > 10)
                    TextButton(onPressed: () => setState(() => _showAll = true), child: Text('Show all ${d.entries.length}')),
                ],
              ],
            ),
    );
  }
}

class _EntryTile extends StatelessWidget {
  const _EntryTile({required this.entry, required this.kindLabel});
  final FeedbackEntry entry;
  final String kindLabel;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final e = entry;
    final when = MaterialLocalizations.of(context);
    final at = '${when.formatShortDate(e.at)} ${when.formatTimeOfDay(TimeOfDay.fromDateTime(e.at))}';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: NeoSpace.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: NeoSpace.sm,
            runSpacing: NeoSpace.xs,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (e.kind != null) NeoPill(kindLabel, color: p.primary),
              if (e.rating != null)
                Semantics(
                  label: '${e.rating} of 5 stars',
                  excludeSemantics: true,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (var i = 1; i <= 5; i++)
                        Icon(i <= e.rating! ? Icons.star_rounded : Icons.star_outline_rounded, size: 16, color: Colors.amber),
                    ],
                  ),
                ),
              Text(e.whereLabel, style: TextStyle(color: p.textMuted, fontSize: 12)),
              Text(at, style: TextStyle(color: p.textMuted, fontSize: 12)),
            ],
          ),
          if (e.message.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: NeoSpace.xs),
              child: Text(e.message, style: TextStyle(color: p.text)),
            ),
          Padding(
            padding: const EdgeInsets.only(top: NeoSpace.xs),
            child: Text(
              [e.name.isEmpty ? 'Someone' : e.name, ?e.email, ?e.device].join(' · '),
              style: TextStyle(color: p.textFaint, fontSize: 12),
            ),
          ),
          Divider(color: p.border, height: NeoSpace.lg),
        ],
      ),
    );
  }
}
