import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';
import '../core/load_error.dart';
import '../events/event.dart';
import 'group_models.dart';

/// The website's groups routes, over the app's signed-in client.
class GroupsApi {
  const GroupsApi(this.api);
  final ApiClient api;

  static String _id(String id) => Uri.encodeComponent(id);

  Future<List<GroupSummary>> list() async {
    final body = await api.get('/api/groups');
    final list = (body is Map ? body['groups'] : null) as List? ?? const [];
    return [for (final g in list.whereType<Map<String, dynamic>>()) GroupSummary.fromJson(g)];
  }

  /// Creates a group. With [fromEventId], [memberUserIds] are people who
  /// attended that meeting (the server checks), added as Members at once.
  Future<Group> create({
    required String name,
    String description = '',
    String? fromEventId,
    List<String> memberUserIds = const [],
  }) async {
    final body = await api.post('/api/groups', {
      'name': name,
      if (description.trim().isNotEmpty) 'description': description,
      'fromEventId': ?fromEventId,
      if (fromEventId != null && memberUserIds.isNotEmpty) 'memberUserIds': memberUserIds,
    });
    return Group.fromJson((body as Map)['group'] as Map<String, dynamic>);
  }

  /// Adds people by account, email or KingsChat handle. Anyone with no
  /// account yet is kept in the group, pending, and joins when they first
  /// sign in with that email or handle.
  Future<AddMembersResult> addPeople(
    String id, {
    List<String> userIds = const [],
    List<String> emails = const [],
    List<String> kcHandles = const [],
  }) async {
    final body = await api.post('/api/groups/${_id(id)}/members', {
      if (userIds.isNotEmpty) 'userIds': userIds,
      if (emails.isNotEmpty) 'emails': emails,
      if (kcHandles.isNotEmpty) 'kcHandles': kcHandles,
      'pending': true,
    }) as Map;
    return AddMembersResult.fromJson(body);
  }

  Future<GroupDetail> detail(String id) async {
    final body = await api.get('/api/groups/${_id(id)}');
    return GroupDetail.fromJson(body as Map<String, dynamic>);
  }

  /// Only what is passed changes. Owner only.
  Future<Group> update(
    String id, {
    String? name,
    String? description,
    String? iconUrl,
    int? retryIntervalMin,
    int? maxAttempts,
  }) async {
    final body = await api.patch('/api/groups/${_id(id)}', {
      'name': ?name,
      'description': ?description,
      'iconUrl': ?iconUrl,
      if (retryIntervalMin != null || maxAttempts != null)
        'settings': {
          'retryIntervalMin': ?retryIntervalMin,
          'maxAttempts': ?maxAttempts,
        },
    });
    return Group.fromJson((body as Map)['group'] as Map<String, dynamic>);
  }

  /// Deletes the group. The server wants its name typed back.
  Future<void> delete(String id, String confirmName) async {
    await api.delete('/api/groups/${_id(id)}', {'confirmName': confirmName});
  }

  Future<AddMembersResult> addByEmail(String id, List<String> emails) async {
    final body = await api.post('/api/groups/${_id(id)}/members', {'emails': emails}) as Map;
    return AddMembersResult.fromJson(body);
  }

  /// Adds people by their account (someone met in a meeting, whose email
  /// this person may not know).
  Future<AddMembersResult> addByUserId(String id, List<String> userIds) async {
    final body = await api.post('/api/groups/${_id(id)}/members', {'userIds': userIds}) as Map;
    return AddMembersResult.fromJson(body);
  }

  /// Gives someone a role; [GroupRole.owner] hands the group over.
  Future<void> setRole(String id, String userId, GroupRole role) async {
    await api.patch('/api/groups/${_id(id)}/members', {'userId': userId, 'role': role.wire});
  }

  Future<void> remove(String id, String userId) async {
    await api.delete('/api/groups/${_id(id)}/members?userId=${Uri.encodeQueryComponent(userId)}');
  }

  Future<void> leave(String id) async {
    await api.delete('/api/groups/${_id(id)}/members');
  }

  /// A link anyone can open to join, for 72 hours.
  Future<GroupInvite> createInvite(String id) async {
    final body = await api.post('/api/groups/${_id(id)}/invite') as Map;
    return GroupInvite(
      url: body['url'] as String? ?? '',
      token: body['token'] as String? ?? '',
      expiresAt: body['expiresAt'] is String ? DateTime.tryParse(body['expiresAt'] as String)?.toLocal() : null,
    );
  }

  Future<InvitePreview> invitePreview(String token) async {
    final body = await api.get('/api/groups/invite/${_id(token)}');
    return InvitePreview.fromJson(body as Map<String, dynamic>);
  }

  /// Joins through an invite link; returns the group's id.
  Future<String> redeemInvite(String token) async {
    final body = await api.post('/api/groups/invite/${_id(token)}') as Map;
    return body['groupId'] as String? ?? '';
  }
}

final groupsApiProvider = Provider<GroupsApi>((ref) => GroupsApi(ref.watch(apiProvider)));

/// The groups the signed-in person is in, newest first.
final groupsProvider = FutureProvider.autoDispose<List<GroupSummary>>((ref) async {
  if (ref.watch(sessionIdProvider) == null) return const [];
  return ref.watch(groupsApiProvider).list();
});

final groupDetailProvider = FutureProvider.autoDispose.family<GroupDetail, String>((ref, id) async {
  return ref.watch(groupsApiProvider).detail(id);
});

/// The server's refusals in the words the website uses
/// (src/lib/groupMessages.ts), so a phone and a browser say the same thing.
const _groupMessages = <String, String>{
  'unauthorized': 'Please sign in again.',
  'forbidden': "Your role in this group doesn't allow that.",
  'insufficient_rank': "Your role in this group doesn't allow that.",
  'not_found': 'This group no longer exists, or you are not in it.',
  'invalid_name': 'Give the group a name (up to 80 characters).',
  'invalid_description': 'The description is too long (500 characters at most).',
  'invalid_icon': 'The icon must be an https:// image link.',
  'invalid_settings': 'Retry interval must be 1–60 minutes and attempts 1–10.',
  'invalid_members': "One of those entries isn't a valid email address or KingsChat handle.",
  'no_members': 'Enter an email address to add.',
  'too_many_at_once': 'Add at most 50 people at a time.',
  'too_many_members': 'A group can have at most 500 members.',
  'user_not_found': 'No NeoConference account uses that email. Send them the invite link instead.',
  'not_member': 'That person is no longer in the group.',
  'cannot_target_owner': "The owner can't be changed or removed.",
  'cannot_manage_self': "You can't change your own role.",
  'owner_must_transfer': 'Make someone else the owner before you leave.',
  'confirmation_mismatch': "The name you typed doesn't match.",
  'not_attendee': "Some of the people chosen weren't in this meeting.",
  'not_started': "This meeting hasn't started yet, so there is no one to add.",
  'invite_expired': 'This invite link has expired. Ask for a new one.',
  'event_not_found': 'That meeting no longer exists.',
  'invalid_title': 'Give the meeting a title (up to 120 characters).',
  'invalid_time': 'Choose a time in the future.',
  'invalid_duration': 'The meeting must last between 5 and 480 minutes.',
  'invalid_timezone': 'Choose a timezone from the list.',
  'invalid_recurrence': 'Check the repeat: every 1–12, and 1–52 meetings or a last date after the first.',
  'invalid_password': 'The password can be up to 80 characters.',
  'invalid_scope': 'Choose this meeting, or this and the following ones.',
  'lifetime_meetings_exhausted': "The group owner's Free plan has no meetings left. Ask the owner to upgrade.",
  'plan_member_limit': "This group has as many members as its owner's plan allows.",
  'meeting_not_editable': "This meeting has already started, ended or been cancelled, so it can't be changed.",
  'meeting_not_open': 'This meeting is over, so no one more can be added.',
  'not_group_meeting': "This isn't a group meeting.",
  'group_has_no_owner': "This group has no owner, so it can't hold meetings.",
};

/// Refusals an upgrade of the owner's plan would lift.
bool isPlanLimitError(Object error) =>
    error is ApiException &&
    (error.code == 'lifetime_meetings_exhausted' || error.code == 'plan_member_limit');

/// What to say when a groups request failed: the website's sentence for a
/// refusal it knows, otherwise what the app says for any failed action.
String groupErrorText(Object error) => _knownGroupError(error) ?? describeActionError(error);

/// The same for something that failed to load: a refusal in the website's
/// words ("not found" means the group went away or they were removed),
/// anything else as the app describes a failed load.
String groupLoadText(Object error) => _knownGroupError(error) ?? describeLoadError(error);

String? _knownGroupError(Object error) {
  if (error is! ApiException) return null;
  return _groupMessages[error.code] ?? (error.status == 404 ? _groupMessages['not_found'] : null);
}
