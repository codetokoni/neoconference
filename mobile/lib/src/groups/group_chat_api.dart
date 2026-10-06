import 'package:flutter/foundation.dart';

import '../core/api_client.dart';
import '../room/room_controller.dart' show ChatAttachment, chatMimeType, chatFileLimit;

/// A file in a group chat message (`attachments` in ChatMessageView,
/// src/lib/groupChatView.ts). Its link is signed for 24 hours and signed
/// again every time the chat is read; null when signing failed.
@immutable
class GroupChatFile {
  const GroupChatFile({required this.name, required this.size, required this.mime, required this.isImage, this.url, this.key});

  final String name;
  final int size;
  final String mime;
  final bool isImage;
  final String? url;

  /// Only on a file just uploaded: what a new message is sent with.
  final String? key;

  factory GroupChatFile.fromJson(Map<String, dynamic> j) => GroupChatFile(
        name: j['name'] as String? ?? 'file',
        size: (j['size'] as num?)?.toInt() ?? 0,
        mime: j['mime'] as String? ?? 'application/octet-stream',
        isImage: j['kind'] == 'image',
        url: j['url'] as String?,
        key: j['key'] as String?,
      );

  /// What a message is sent with (the upload's result, less its link).
  Map<String, dynamic> toSend() => {
        'key': key,
        'name': name,
        'size': size,
        'mime': mime,
        'kind': isImage ? 'image' : 'file',
      };

  /// The meeting chat's own view of a file, which draws it.
  ChatAttachment? get asAttachment =>
      url == null ? null : ChatAttachment(url: url!, name: name, mimeType: mime, size: size, isImage: isImage);
}

@immutable
class GroupChatMessage {
  const GroupChatMessage({
    required this.id,
    required this.name,
    required this.text,
    required this.at,
    this.userId,
    this.replyTo,
    this.mentions = const [],
    this.system = false,
    this.linkHref,
    this.linkLabel,
    this.files = const [],
    this.deleted = false,
  });

  final String id;

  /// Null for a line the system wrote ("… has started").
  final String? userId;
  final String name;
  final String text;
  final DateTime at;

  /// Who and what it answers, as it was when it was sent.
  final ({String id, String name, String snippet})? replyTo;
  final List<String> mentions;
  final bool system;
  final String? linkHref;
  final String? linkLabel;
  final List<GroupChatFile> files;
  final bool deleted;

  factory GroupChatMessage.fromJson(Map<String, dynamic> j) {
    final reply = j['replyTo'];
    final link = j['link'];
    return GroupChatMessage(
      id: j['id'] as String? ?? '',
      userId: j['userId'] as String?,
      name: j['name'] as String? ?? '',
      text: j['text'] as String? ?? '',
      at: DateTime.tryParse(j['ts'] as String? ?? '')?.toLocal() ?? DateTime.now(),
      replyTo: reply is Map
          ? (id: reply['id'] as String? ?? '', name: reply['name'] as String? ?? '', snippet: reply['snippet'] as String? ?? '')
          : null,
      mentions: [for (final m in (j['mentions'] as List? ?? const [])) '$m'],
      system: j['system'] == true,
      linkHref: link is Map ? link['href'] as String? : null,
      linkLabel: link is Map ? link['label'] as String? : null,
      files: [for (final f in (j['attachments'] as List? ?? const []).whereType<Map<String, dynamic>>()) GroupChatFile.fromJson(f)],
      deleted: j['deleted'] == true,
    );
  }
}

/// One read of the chat: what changed since [ver], or nothing ([unchanged]).
@immutable
class ChatRead {
  const ChatRead({required this.ver, this.unchanged = false, this.messages = const [], this.hasOlder = false, this.live = const []});

  final int ver;
  final bool unchanged;

  /// Oldest first, at most 50.
  final List<GroupChatMessage> messages;
  final bool hasOlder;

  /// The group's meetings live now, for "Live now · Join".
  final List<({String slug, String title})> live;
}

/// The group chat's routes (`/api/groups/<id>/messages` and friends).
class GroupChatApi {
  const GroupChatApi(this.api);
  final ApiClient api;

  static String _id(String id) => Uri.encodeComponent(id);

  /// The latest messages; with [sinceVer], nothing at all if nothing changed;
  /// with [before], the 50 before that message.
  Future<ChatRead> read(String groupId, {int? sinceVer, String? before}) async {
    final body = await api.get('/api/groups/${_id(groupId)}/messages', {
      if (sinceVer != null) 'sinceVer': '$sinceVer',
      'before': ?before,
    }) as Map;
    final ver = (body['ver'] as num?)?.toInt() ?? 0;
    if (body['unchanged'] == true) return ChatRead(ver: ver, unchanged: true);
    return ChatRead(
      ver: ver,
      messages: [
        for (final m in (body['messages'] as List? ?? const []).whereType<Map<String, dynamic>>()) GroupChatMessage.fromJson(m),
      ],
      hasOlder: body['hasOlder'] == true,
      live: [
        for (final l in (body['live'] as List? ?? const []).whereType<Map>())
          (slug: l['slug'] as String? ?? '', title: l['title'] as String? ?? ''),
      ],
    );
  }

  Future<GroupChatMessage> send(String groupId, {required String text, String? replyToId, List<GroupChatFile> files = const []}) async {
    final body = await api.post('/api/groups/${_id(groupId)}/messages', {
      'text': text,
      'replyToId': ?replyToId,
      if (files.isNotEmpty) 'attachments': [for (final f in files) f.toSend()],
    }) as Map;
    return GroupChatMessage.fromJson(body['message'] as Map<String, dynamic>);
  }

  Future<void> delete(String groupId, String messageId) async {
    await api.delete('/api/groups/${_id(groupId)}/messages/${_id(messageId)}');
  }

  /// "Read up to now", which clears the unread count.
  Future<void> markRead(String groupId) async {
    await api.post('/api/groups/${_id(groupId)}/messages/read');
  }

  /// Uploads one file for a message. Refuses, before sending anything, a
  /// kind the route will not take or anything over 10 MB.
  Future<GroupChatFile> upload(String groupId, String filename, List<int> bytes) async {
    final mime = chatMimeType(filename);
    if (mime == null) throw const ChatFileRefused('That kind of file can\'t be sent. Pictures, PDFs, Word, Excel, PowerPoint, text and zip files can.');
    if (bytes.length > chatFileLimit) throw const ChatFileRefused('That file is too big to send. The limit is 10 MB.');
    final body = await api.postFile('/api/groups/${_id(groupId)}/upload', bytes: bytes, filename: filename, mimeType: mime) as Map;
    return GroupChatFile.fromJson(body['attachment'] as Map<String, dynamic>);
  }
}

class ChatFileRefused implements Exception {
  const ChatFileRefused(this.message);
  final String message;

  @override
  String toString() => message;
}

/// The members whose names start with what follows the last "@" being
/// typed, for "@mention" suggestions; at most six. Null when the text does
/// not end in an "@…" being typed.
List<T>? mentionMatches<T>(String text, List<T> members, String Function(T) name) {
  final m = RegExp(r'(?:^|\s)@([^\s@]{0,40})$').firstMatch(text);
  if (m == null) return null;
  final q = m.group(1)!.toLowerCase();
  return [
    for (final x in members)
      if (name(x).trim().isNotEmpty && name(x).toLowerCase().startsWith(q)) x,
  ].take(6).toList();
}

/// [text] with the "@…" being typed replaced by "@Name ".
String completeMention(String text, String name) =>
    text.replaceFirst(RegExp(r'@([^\s@]{0,40})$'), '@$name ');
