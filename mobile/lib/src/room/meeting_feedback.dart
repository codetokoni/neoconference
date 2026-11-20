import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/client_info.dart';
import '../design/brand.dart';
import '../design/tokens.dart';
import '../events/event.dart';

/// Feedback on a meeting, as the website takes it (`/api/events/<id>/feedback`,
/// src/lib/meetingFeedback.ts): words go to the meeting's organiser and to
/// support, a rating alone is counted.
///
/// Two places in the app: "Send feedback" in the meeting's More menu, and
/// "How was the meeting?" when you leave — a tap of the stars, then words if
/// something did not work. The feedback link itself (`/feedback/<slug>`)
/// opens in the browser: the app does not claim it.

@immutable
class FeedbackKind {
  const FeedbackKind(this.key, this.label);
  final String key;
  final String label;
}

/// What the form needs (GET).
@immutable
class FeedbackFormInfo {
  const FeedbackFormInfo({required this.meetingName, required this.kinds, this.token});
  final String meetingName;
  final List<FeedbackKind> kinds;

  /// The bot check's token, given only to someone signed out.
  final String? token;

  factory FeedbackFormInfo.fromJson(Map<String, dynamic> j) => FeedbackFormInfo(
        meetingName: ((j['meeting'] as Map?)?['name'] as String?) ?? 'the meeting',
        kinds: [
          for (final k in (j['kinds'] as List? ?? const []))
            if (k is Map && k['key'] is String) FeedbackKind(k['key'] as String, (k['label'] as String?) ?? k['key'] as String),
        ],
        token: j['token'] as String?,
      );
}

/// One piece of feedback, as the owner reads it.
@immutable
class FeedbackEntry {
  const FeedbackEntry({
    required this.id,
    required this.at,
    required this.where,
    required this.message,
    required this.name,
    this.kind,
    this.rating,
    this.email,
    this.device,
  });

  final String id;
  final DateTime at;
  final String where;
  final String message;
  final String name;
  final String? kind;
  final int? rating;
  final String? email;
  final String? device;

  String get whereLabel => switch (where) {
        'room' => 'In the meeting',
        'after' => 'After leaving',
        _ => 'Feedback link',
      };

  factory FeedbackEntry.fromJson(Map<String, dynamic> j) => FeedbackEntry(
        id: j['id'] as String? ?? '',
        at: DateTime.fromMillisecondsSinceEpoch((j['ts'] as num?)?.toInt() ?? 0).toLocal(),
        where: j['where'] as String? ?? 'link',
        message: j['message'] as String? ?? '',
        name: j['name'] as String? ?? '',
        kind: j['kind'] as String?,
        rating: (j['rating'] as num?)?.toInt(),
        email: j['email'] as String?,
        device: j['device'] as String?,
      );
}

/// Where feedback goes besides the owner's notifications and support.
@immutable
class FeedbackContact {
  const FeedbackContact({this.kcHandle, this.email});
  final String? kcHandle;
  final String? email;

  bool get isEmpty => (kcHandle ?? '').isEmpty && (email ?? '').isEmpty;

  static FeedbackContact? fromJson(dynamic j) =>
      j is Map ? FeedbackContact(kcHandle: j['kcHandle'] as String?, email: j['email'] as String?) : null;
}

/// Whether a KingsChat message can reach the contact: null when no handle.
@immutable
class FeedbackReach {
  const FeedbackReach({this.kcHandleKnown, this.ownerKcLinked});
  final bool? kcHandleKnown;
  final bool? ownerKcLinked;

  static FeedbackReach fromJson(dynamic j) => j is Map
      ? FeedbackReach(kcHandleKnown: j['kcHandleKnown'] as bool?, ownerKcLinked: j['ownerKcLinked'] as bool?)
      : const FeedbackReach();
}

/// A meeting's feedback, for its owner.
@immutable
class FeedbackOverview {
  const FeedbackOverview({
    required this.entries,
    required this.kinds,
    required this.rated,
    required this.written,
    required this.kindCounts,
    required this.contactAllowed,
    required this.reach,
    this.average,
    this.contact,
  });

  final List<FeedbackEntry> entries;
  final List<FeedbackKind> kinds;
  final int rated;
  final int written;
  final double? average;
  final Map<String, int> kindCounts;
  final FeedbackContact? contact;
  final bool contactAllowed;
  final FeedbackReach reach;

  String kindLabel(String? key) => kinds.where((k) => k.key == key).map((k) => k.label).firstOrNull ?? (key ?? '');

  FeedbackOverview withContact(FeedbackContact? c, FeedbackReach r) => FeedbackOverview(
        entries: entries,
        kinds: kinds,
        rated: rated,
        written: written,
        average: average,
        kindCounts: kindCounts,
        contact: c,
        contactAllowed: contactAllowed,
        reach: r,
      );

  static FeedbackOverview? fromJson(Map<String, dynamic> j) {
    final m = j['manage'];
    if (m is! Map) return null;
    final tally = (m['tally'] as Map?) ?? const {};
    return FeedbackOverview(
      entries: [
        for (final e in (m['feedback'] as List? ?? const []))
          if (e is Map) FeedbackEntry.fromJson(e.cast<String, dynamic>()),
      ],
      kinds: FeedbackFormInfo.fromJson(j).kinds,
      rated: (tally['rated'] as num?)?.toInt() ?? 0,
      written: (tally['written'] as num?)?.toInt() ?? 0,
      average: (tally['average'] as num?)?.toDouble(),
      kindCounts: {
        for (final e in ((tally['kinds'] as Map?) ?? const {}).entries) '${e.key}': (e.value as num).toInt(),
      },
      contact: FeedbackContact.fromJson(m['contact']),
      contactAllowed: m['contactAllowed'] == true,
      reach: FeedbackReach.fromJson(m['reach']),
    );
  }
}

class FeedbackApi {
  FeedbackApi(this._api);
  final ApiClient _api;

  String _path(String slug) => '/api/events/${Uri.encodeComponent(slug)}/feedback';

  Future<FeedbackFormInfo> form(String slug) async =>
      FeedbackFormInfo.fromJson(((await _api.get(_path(slug))) as Map).cast<String, dynamic>());

  /// Words, a rating, or both. [where] is 'room' or 'after'. [client] is
  /// the app and phone (clientDescription), if it was ready: never waited
  /// for here, because asking the phone can hang and the person is waiting.
  Future<void> send(
    String slug, {
    required String where,
    String? token,
    int? rating,
    String? kind,
    String? message,
    String? client,
  }) async {
    await _api.post(_path(slug), {
      'where': where,
      'rating': ?rating,
      'kind': ?kind,
      if (message != null && message.trim().isNotEmpty) 'message': message.trim(),
      'token': ?token,
      'website': '',
      'client': ?client,
    });
  }

  /// The owner's view; null for anyone else.
  Future<FeedbackOverview?> overview(String slug) async =>
      FeedbackOverview.fromJson(((await _api.get(_path(slug))) as Map).cast<String, dynamic>());

  /// Saves (or, with an empty contact, removes) where feedback is sent.
  Future<({FeedbackContact? contact, FeedbackReach reach})> saveContact(String eventId, FeedbackContact c) async {
    final body = (await _api.patch('/api/events/${Uri.encodeComponent(eventId)}', {
      'feedbackContact': c.isEmpty ? null : {'kcHandle': c.kcHandle ?? '', 'email': c.email ?? ''},
    })) as Map;
    return (
      contact: FeedbackContact.fromJson((body['event'] as Map?)?['feedbackContact']),
      reach: FeedbackReach.fromJson(body['feedbackReach']),
    );
  }
}

/// Opens "Send feedback" (in the meeting) or "How was the meeting?" (after
/// leaving). Says thank you when something was sent.
Future<void> openMeetingFeedback(BuildContext context, {required String slug, required String where}) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final sent = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => MeetingFeedbackSheet(slug: slug, where: where),
  );
  if (sent == true) {
    messenger
      ?..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Thank you. The organiser and our support team will see it.')));
  }
}

/// The form. After leaving, stars come first: a tap sends the rating at
/// once, and the words below are optional.
class MeetingFeedbackSheet extends ConsumerStatefulWidget {
  const MeetingFeedbackSheet({super.key, required this.slug, required this.where});
  final String slug;

  /// 'room' or 'after'.
  final String where;

  @override
  ConsumerState<MeetingFeedbackSheet> createState() => _MeetingFeedbackSheetState();
}

class _MeetingFeedbackSheetState extends ConsumerState<MeetingFeedbackSheet> {
  late final FeedbackApi _api = FeedbackApi(ref.read(apiProvider));
  final _message = TextEditingController();
  FeedbackFormInfo? _info;
  String? _loadError;
  String? _error;
  String? _kind;
  int? _rating;
  bool _ratingSent = false;
  bool _busy = false;

  /// Which app and phone, once the phone has said (usually at once). Sent
  /// if ready; a send never waits for it.
  String? _client;

  bool get _after => widget.where == 'after';

  @override
  void initState() {
    super.initState();
    _load();
    clientDescription().then((c) => _client = c, onError: (_) {});
  }

  @override
  void dispose() {
    _message.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final info = await _api.form(widget.slug);
      if (mounted) setState(() => _info = info);
    } catch (e) {
      if (mounted) setState(() => _loadError = e is ApiException ? e.message : 'The feedback form did not load. Check your connection.');
    }
  }

  Future<void> _rate(int n) async {
    if (_busy || _ratingSent) return;
    setState(() {
      _rating = n;
      _busy = true;
      _error = null;
    });
    try {
      await _api.send(widget.slug, where: widget.where, token: _info?.token, rating: n, client: _client);
      if (mounted) setState(() => _ratingSent = true);
    } catch (e) {
      if (mounted) {
        setState(() {
          _rating = null;
          _error = e is ApiException ? e.message : 'Not sent. Check your connection and try again.';
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _send() async {
    final text = _message.text.trim();
    if (text.isEmpty) {
      setState(() => _error = 'Write what happened first.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _api.send(widget.slug, where: widget.where, token: _info?.token, kind: _kind, message: text, client: _client);
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.message : 'Not sent. Check your connection and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final info = _info;
    final title = _after ? 'How was ${info?.meetingName ?? 'the meeting'}?' : 'Send feedback';
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.lg, NeoSpace.xl, NeoSpace.xl),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(title, style: Theme.of(context).textTheme.titleMedium?.copyWith(color: p.text, fontWeight: FontWeight.w600)),
                ),
                IconButton(
                  tooltip: _after ? 'Skip' : 'Close',
                  onPressed: () => Navigator.pop(context, _ratingSent),
                  icon: Icon(Icons.close_rounded, color: p.textMuted),
                ),
              ],
            ),
            if (info == null && _loadError == null)
              const Padding(padding: EdgeInsets.all(NeoSpace.xl), child: Center(child: CircularProgressIndicator()))
            else if (info == null)
              Text(_loadError!, style: TextStyle(color: p.danger))
            else ...[
              if (_after) ...[
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    for (var n = 1; n <= 5; n++)
                      Semantics(
                        button: true,
                        selected: _rating == n,
                        label: '$n star${n == 1 ? '' : 's'}',
                        excludeSemantics: true,
                        child: IconButton(
                          key: ValueKey('star-$n'),
                          iconSize: 40,
                          onPressed: _ratingSent || _busy ? null : () => _rate(n),
                          icon: Icon(
                            _rating != null && n <= _rating! ? Icons.star_rounded : Icons.star_outline_rounded,
                            color: Colors.amber,
                          ),
                        ),
                      ),
                  ],
                ),
                if (_ratingSent)
                  Padding(
                    padding: const EdgeInsets.only(top: NeoSpace.xs),
                    child: Text(
                      'Thanks, $_rating star${_rating == 1 ? '' : 's'} sent. Anything else to tell the organiser? Write it below.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: p.success),
                    ),
                  ),
                const SizedBox(height: NeoSpace.lg),
              ] else
                Padding(
                  padding: const EdgeInsets.only(bottom: NeoSpace.md),
                  child: Text(
                    'Sound, video, dropping out? Tell the organiser. You stay in the meeting.',
                    style: TextStyle(color: p.textMuted),
                  ),
                ),
              Text('What is it about?', style: TextStyle(color: p.textMuted, fontSize: 13)),
              const SizedBox(height: NeoSpace.sm),
              Wrap(
                spacing: NeoSpace.sm,
                runSpacing: NeoSpace.sm,
                children: [
                  for (final k in info.kinds)
                    ChoiceChip(
                      label: Text(k.label),
                      selected: _kind == k.key,
                      onSelected: (on) => setState(() => _kind = on ? k.key : null),
                    ),
                ],
              ),
              const SizedBox(height: NeoSpace.lg),
              TextField(
                controller: _message,
                minLines: 3,
                maxLines: 6,
                maxLength: 2000,
                textCapitalization: TextCapitalization.sentences,
                onChanged: (_) {
                  if (_error != null) setState(() => _error = null);
                },
                decoration: InputDecoration(
                  labelText: _after ? 'Tell the organiser more' : 'What happened?',
                  hintText: 'For example: the sound kept cutting out.',
                  border: const OutlineInputBorder(),
                ),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: NeoSpace.sm),
                  child: Text(_error!, style: TextStyle(color: p.danger)),
                ),
              FilledButton(
                onPressed: _busy ? null : _send,
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                child: Text(_busy ? 'Sending…' : 'Send feedback'),
              ),
              const SizedBox(height: NeoSpace.sm),
              Text(
                'Goes to the organiser and our support team.',
                textAlign: TextAlign.center,
                style: TextStyle(color: p.textFaint, fontSize: 12),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
