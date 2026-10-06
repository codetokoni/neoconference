import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/when.dart';
import '../room/room_widgets.dart' show ChatAttachmentView;
import 'group_chat_api.dart';
import 'group_join.dart';
import 'group_models.dart';
import 'groups_api.dart';
import 'incoming_call.dart' show groupIdFromPath, meetingSlugFromPath;

/// The group's chat, as the web's ChatTab: day by day, replies, @mentions,
/// files, "Live now · Join", and deleting your own messages (or anyone's,
/// for a moderator). New messages are looked for every [every] while the
/// chat is on screen and the app is in front.
class GroupChatTab extends ConsumerStatefulWidget {
  const GroupChatTab({super.key, required this.detail, this.onOpenReport});

  final GroupDetail detail;

  /// Opens a meeting's report from an "ended" line, for those who may.
  final void Function(String eventId)? onOpenReport;

  static Duration every = const Duration(seconds: 3);

  @override
  ConsumerState<GroupChatTab> createState() => _GroupChatTabState();
}

class _GroupChatTabState extends ConsumerState<GroupChatTab> with WidgetsBindingObserver {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _messages = <String, GroupChatMessage>{};
  List<GroupChatMessage> _ordered = const [];
  List<({String slug, String title})> _live = const [];
  int? _ver;
  bool _hasOlder = false;
  bool _loadingOlder = false;
  bool _loaded = false;
  String? _error;
  Timer? _timer;
  bool _polling = false;

  GroupChatMessage? _replyTo;
  final _files = <GroupChatFile>[];
  int _uploading = 0;
  bool _sending = false;

  /// The newest message marked read, so "read" is sent once per new one.
  String? _readUpTo;

  GroupDetail get d => widget.detail;
  GroupChatApi get _api => GroupChatApi(ref.read(groupsApiProvider).api);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _input.addListener(() => setState(() {}));
    _poll();
    _timer = Timer.periodic(GroupChatTab.every, (_) => _poll());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _timer?.cancel();
      _timer = Timer.periodic(GroupChatTab.every, (_) => _poll());
      _poll();
    } else if (state == AppLifecycleState.paused) {
      _timer?.cancel();
    }
  }

  void _merge(Iterable<GroupChatMessage> fresh) {
    for (final m in fresh) {
      _messages[m.id] = m;
    }
    _ordered = _messages.values.toList()..sort((a, b) => a.at.compareTo(b.at));
  }

  Future<void> _poll() async {
    if (_polling || !mounted) return;
    _polling = true;
    try {
      final read = await _api.read(d.group.id, sinceVer: _ver);
      if (!mounted) return;
      final atBottom = !_scroll.hasClients || _scroll.position.extentAfter < 80;
      setState(() {
        _error = null;
        _loaded = true;
        _ver = read.ver;
        if (!read.unchanged) {
          _merge(read.messages);
          _live = read.live;
          // Only the first read says whether there is anything older.
          if (_ordered.length <= read.messages.length) _hasOlder = read.hasOlder;
        }
      });
      if (!read.unchanged && atBottom) _toBottom();
      _markRead();
    } catch (e) {
      if (mounted) setState(() => _error = groupLoadText(e));
    } finally {
      _polling = false;
    }
  }

  void _markRead() {
    final newest = _ordered.isEmpty ? null : _ordered.last;
    if (newest == null || newest.id == _readUpTo) return;
    _readUpTo = newest.id;
    unawaited(_api.markRead(d.group.id).then((_) {
      if (mounted) ref.invalidate(groupsProvider);
    }, onError: (Object e) => debugPrint('[chat] read: $e')));
  }

  void _toBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });
  }

  Future<void> _loadOlder() async {
    if (_ordered.isEmpty || _loadingOlder) return;
    setState(() => _loadingOlder = true);
    try {
      final read = await _api.read(d.group.id, before: _ordered.first.id);
      if (!mounted) return;
      setState(() {
        _merge(read.messages);
        _hasOlder = read.hasOlder;
      });
    } catch (e) {
      _say(groupErrorText(e));
    } finally {
      if (mounted) setState(() => _loadingOlder = false);
    }
  }

  void _say(String text) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _attach() async {
    final room = 5 - _files.length;
    if (room <= 0) return _say('At most 5 files a message.');
    final picked = await FilePicker.pickFiles(
      dialogTitle: 'Send a file',
      type: FileType.custom,
      allowedExtensions: const [
        'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'txt', 'csv', 'json', 'zip',
      ],
    );
    if (picked.isEmpty || !mounted) return;
    for (final file in picked.take(room)) {
      setState(() => _uploading++);
      try {
        final bytes = await file.xFile.readAsBytes();
        final up = await _api.upload(d.group.id, file.name, bytes);
        if (mounted) setState(() => _files.add(up));
      } catch (e) {
        _say(e is ChatFileRefused ? e.message : groupErrorText(e));
      } finally {
        if (mounted) setState(() => _uploading--);
      }
    }
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if ((text.isEmpty && _files.isEmpty) || _sending || _uploading > 0) return;
    setState(() => _sending = true);
    try {
      final sent = await _api.send(d.group.id, text: text, replyToId: _replyTo?.id, files: List.of(_files));
      if (!mounted) return;
      setState(() {
        _input.clear();
        _files.clear();
        _replyTo = null;
        _merge([sent]);
      });
      _toBottom();
    } catch (e) {
      _say(groupErrorText(e));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  bool _canDelete(GroupChatMessage m) =>
      !m.deleted && (m.userId == d.myUserId ? m.userId != null : d.capabilities.manageMembers);

  Future<void> _options(GroupChatMessage m) async {
    final p = NeoTheme.of(context);
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (!m.system && !m.deleted)
              ListTile(leading: const Icon(Icons.reply_rounded), title: const Text('Reply'), onTap: () => Navigator.pop(context, 'reply')),
            if (_canDelete(m))
              ListTile(
                leading: Icon(Icons.delete_outline_rounded, color: p.danger),
                title: Text('Delete', style: TextStyle(color: p.danger)),
                onTap: () => Navigator.pop(context, 'delete'),
              ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    if (choice == 'reply') setState(() => _replyTo = m);
    if (choice == 'delete') await _delete(m);
  }

  Future<void> _delete(GroupChatMessage m) async {
    final p = NeoTheme.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this message?'),
        content: Text(m.userId == d.myUserId ? 'It is removed for everyone.' : 'It is removed for everyone, as a moderator.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(context, true), child: Text('Delete', style: TextStyle(color: p.danger))),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await _api.delete(d.group.id, m.id);
      await _poll();
    } catch (e) {
      _say(groupErrorText(e));
    }
  }

  void _follow(String href) {
    final reportMatch = RegExp(r'^/dashboard/groups/[^/]+/reports/([^/?#]+)').firstMatch(href);
    if (reportMatch != null) {
      widget.onOpenReport?.call(reportMatch.group(1)!);
      return;
    }
    if (groupIdFromPath(href) != null) return; // this group, already open
    final slug = meetingSlugFromPath(href);
    if (slug != null) unawaited(joinGroupMeeting(context, slug: slug, title: slug));
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final others = [for (final m in d.members) if (m.userId != d.myUserId) m];
    final suggestions = mentionMatches(_input.text, others, (m) => m.displayName);

    return Column(
      children: [
        for (final l in _live)
          Material(
            color: p.success.withValues(alpha: 0.12),
            child: ListTile(
              dense: true,
              leading: Icon(Icons.sensors_rounded, color: p.success),
              title: Text('Live now · ${l.title}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: p.text)),
              trailing: TextButton(onPressed: () => joinGroupMeeting(context, slug: l.slug, title: l.title), child: const Text('Join')),
            ),
          ),
        Expanded(child: _list(p)),
        if (suggestions != null && suggestions.isNotEmpty)
          SizedBox(
            height: 44,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: NeoSpace.md),
              children: [
                for (final m in suggestions)
                  Padding(
                    padding: const EdgeInsets.only(right: NeoSpace.xs),
                    child: ActionChip(
                      avatar: NeoAvatar(name: m.displayName, size: 22),
                      label: Text(m.displayName),
                      onPressed: () {
                        final text = completeMention(_input.text, m.displayName);
                        _input.value = TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
                      },
                    ),
                  ),
              ],
            ),
          ),
        _composer(p),
      ],
    );
  }

  Widget _list(NeoPalette p) {
    if (!_loaded) {
      return _error != null
          ? Padding(
              padding: const EdgeInsets.all(NeoSpace.xl),
              child: NeoBanner(icon: Icons.cloud_off_rounded, tone: NeoBannerTone.warning, message: _error!, action: _poll, actionLabel: 'Retry'),
            )
          : const Center(child: CircularProgressIndicator());
    }
    if (_ordered.isEmpty) {
      return ListView(children: const [
        NeoEmptyState(icon: Icons.forum_outlined, title: 'No messages yet', message: 'Say hello to the group.'),
      ]);
    }
    final rows = <Widget>[
      if (_hasOlder)
        Center(
          child: TextButton(
            onPressed: _loadingOlder ? null : _loadOlder,
            child: Text(_loadingOlder ? 'Loading…' : 'Load earlier messages'),
          ),
        ),
    ];
    DateTime? day;
    for (final m in _ordered) {
      final d0 = DateTime(m.at.year, m.at.month, m.at.day);
      if (day == null || d0 != day) {
        day = d0;
        rows.add(_DaySeparator(day: d0));
      }
      rows.add(m.system
          ? _SystemLine(message: m, onFollow: m.linkHref == null ? null : () => _follow(m.linkHref!), canFollow: _canFollow(m))
          : _Bubble(message: m, mine: m.userId == d.myUserId, myUserId: d.myUserId, onLongPress: () => _options(m)));
    }
    return ListView(
      controller: _scroll,
      padding: const EdgeInsets.fromLTRB(NeoSpace.md, NeoSpace.sm, NeoSpace.md, NeoSpace.sm),
      children: rows,
    );
  }

  /// A report link only for someone who may see reports, and only once
  /// the app can open them.
  bool _canFollow(GroupChatMessage m) {
    final href = m.linkHref;
    if (href == null) return false;
    if (href.contains('/reports/')) return widget.onOpenReport != null && d.capabilities.viewReports;
    return meetingSlugFromPath(href) != null;
  }

  Widget _composer(NeoPalette p) {
    final busy = _sending || _uploading > 0;
    final canSend = (_input.text.trim().isNotEmpty || _files.isNotEmpty) && !busy;
    return Material(
      color: p.surface,
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(NeoSpace.sm, NeoSpace.xs, NeoSpace.sm, NeoSpace.sm),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_replyTo != null)
                Row(
                  children: [
                    Icon(Icons.reply_rounded, size: 16, color: p.textMuted),
                    const SizedBox(width: NeoSpace.xs),
                    Expanded(
                      child: Text(
                        'Replying to ${_replyTo!.name}: ${_replyTo!.text}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: p.textMuted, fontSize: 12),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Cancel reply',
                      visualDensity: VisualDensity.compact,
                      onPressed: () => setState(() => _replyTo = null),
                      icon: const Icon(Icons.close_rounded, size: 18),
                    ),
                  ],
                ),
              if (_files.isNotEmpty || _uploading > 0)
                Wrap(
                  spacing: NeoSpace.xs,
                  children: [
                    for (final f in _files)
                      InputChip(
                        avatar: Icon(f.isImage ? Icons.image_outlined : Icons.attach_file_rounded, size: 16),
                        label: Text(f.name, overflow: TextOverflow.ellipsis),
                        onDeleted: () => setState(() => _files.remove(f)),
                      ),
                    if (_uploading > 0) const Chip(label: Text('Uploading…')),
                  ],
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  IconButton(
                    tooltip: 'Attach a file',
                    onPressed: _files.length >= 5 ? null : _attach,
                    icon: const Icon(Icons.attach_file_rounded),
                  ),
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 5,
                      maxLength: 8000,
                      textCapitalization: TextCapitalization.sentences,
                      decoration: const InputDecoration(hintText: 'Message the group', counterText: ''),
                    ),
                  ),
                  IconButton(
                    tooltip: 'Send',
                    onPressed: canSend ? _send : null,
                    icon: Icon(Icons.send_rounded, color: canSend ? p.primary : p.textFaint),
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

class _DaySeparator extends StatelessWidget {
  const _DaySeparator({required this.day});
  final DateTime day;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final today = DateTime.now();
    final t0 = DateTime(today.year, today.month, today.day);
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    final label = day == t0
        ? 'Today'
        : day == t0.subtract(const Duration(days: 1))
            ? 'Yesterday'
            : '${days[day.weekday - 1]} ${day.day} ${months[day.month - 1]}';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: NeoSpace.sm),
      child: Center(child: Text(label, style: TextStyle(color: p.textFaint, fontSize: 12, fontWeight: FontWeight.w600))),
    );
  }
}

class _SystemLine extends StatelessWidget {
  const _SystemLine({required this.message, required this.onFollow, required this.canFollow});
  final GroupChatMessage message;
  final VoidCallback? onFollow;
  final bool canFollow;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: NeoSpace.xs, horizontal: NeoSpace.lg),
      child: Column(
        children: [
          Text(
            message.deleted ? 'Message removed' : message.text,
            textAlign: TextAlign.center,
            style: TextStyle(color: p.textMuted, fontSize: 13, fontStyle: message.deleted ? FontStyle.italic : null),
          ),
          if (canFollow && onFollow != null && message.linkLabel != null)
            TextButton(onPressed: onFollow, child: Text(message.linkLabel!)),
        ],
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message, required this.mine, required this.myUserId, required this.onLongPress});
  final GroupChatMessage message;
  final bool mine;
  final String myUserId;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final m = message;
    final mentionsMe = m.mentions.contains(myUserId);
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: GestureDetector(
        onLongPress: onLongPress,
        child: Container(
          constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
          margin: const EdgeInsets.symmetric(vertical: 3),
          padding: const EdgeInsets.symmetric(horizontal: NeoSpace.md, vertical: NeoSpace.sm),
          decoration: BoxDecoration(
            color: mine ? p.primary.withValues(alpha: 0.16) : p.surfaceAlt,
            borderRadius: BorderRadius.circular(NeoRadius.lg),
            border: Border.all(color: mentionsMe ? p.warning : p.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (!mine)
                Text(m.name, style: TextStyle(color: p.spectrumFor(m.userId ?? m.name) ?? p.accent, fontWeight: FontWeight.w600, fontSize: 12)),
              if (m.replyTo != null)
                Container(
                  margin: const EdgeInsets.only(top: 2, bottom: 4),
                  padding: const EdgeInsets.only(left: NeoSpace.sm),
                  decoration: BoxDecoration(border: Border(left: BorderSide(color: p.textFaint, width: 2))),
                  child: Text(
                    '${m.replyTo!.name}: ${m.replyTo!.snippet}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: p.textMuted, fontSize: 12),
                  ),
                ),
              if (m.text.isNotEmpty)
                Text(
                  m.text,
                  style: TextStyle(color: m.deleted ? p.textFaint : p.text, fontStyle: m.deleted ? FontStyle.italic : null),
                ),
              for (final f in m.files)
                Padding(
                  padding: const EdgeInsets.only(top: NeoSpace.xs),
                  child: f.asAttachment == null
                      ? Text('${f.name} (unavailable)', style: TextStyle(color: p.textMuted, fontSize: 12))
                      : ChatAttachmentView(attachment: f.asAttachment!),
                ),
              const SizedBox(height: 2),
              Align(
                alignment: Alignment.bottomRight,
                child: Text(neoClock(m.at), style: TextStyle(color: p.textFaint, fontSize: 10)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
