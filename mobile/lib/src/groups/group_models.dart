import 'package:flutter/foundation.dart';

/// Groups as the website's API returns them (src/lib/groupStore.ts and
/// src/app/api/groups/**). The phone reads the same routes, so a group
/// looks and behaves the same on both.

DateTime? _iso(dynamic v) => v is String && v.isNotEmpty ? DateTime.tryParse(v)?.toLocal() : null;

DateTime? _ms(dynamic v) =>
    v is num && v > 0 ? DateTime.fromMillisecondsSinceEpoch(v.toInt()) : null;

String _str(dynamic v) => v is String ? v : '';

/// The role ladder, highest first: owner > host > moderator > participant.
enum GroupRole {
  owner('owner', 'Owner', 40),
  host('host', 'Host', 30),
  moderator('moderator', 'Moderator', 20),
  participant('participant', 'Member', 10);

  const GroupRole(this.wire, this.label, this.rank);

  /// The value the API sends and takes.
  final String wire;

  /// What a person sees. A participant is a "Member", as on the web.
  final String label;
  final int rank;

  static GroupRole parse(dynamic v) =>
      GroupRole.values.firstWhere((r) => r.wire == v, orElse: () => GroupRole.participant);
}

@immutable
class GroupSettings {
  const GroupSettings({this.retryIntervalMin = 3, this.maxAttempts = 5});

  /// Minutes between rounds of ringing for people who have not answered.
  final int retryIntervalMin;

  /// How many times each person is rung for one meeting.
  final int maxAttempts;

  factory GroupSettings.fromJson(dynamic j) => j is Map
      ? GroupSettings(
          retryIntervalMin: (j['retryIntervalMin'] as num?)?.toInt() ?? 3,
          maxAttempts: (j['maxAttempts'] as num?)?.toInt() ?? 5,
        )
      : const GroupSettings();
}

@immutable
class Group {
  const Group({
    required this.id,
    required this.name,
    this.description = '',
    this.iconUrl = '',
    this.settings = const GroupSettings(),
    this.createdAt,
  });

  final String id;
  final String name;
  final String description;

  /// An https image, or empty for the initial instead.
  final String iconUrl;
  final GroupSettings settings;
  final DateTime? createdAt;

  factory Group.fromJson(Map<String, dynamic> j) => Group(
        id: _str(j['id']),
        name: _str(j['name']),
        description: _str(j['description']),
        iconUrl: _str(j['iconUrl']),
        settings: GroupSettings.fromJson(j['settings']),
        createdAt: _iso(j['createdAt']),
      );
}

/// A row of the groups list: the group, your role in it and its size.
@immutable
class GroupSummary {
  const GroupSummary({required this.group, required this.role, required this.memberCount});

  final Group group;
  final GroupRole role;
  final int memberCount;

  factory GroupSummary.fromJson(Map<String, dynamic> j) => GroupSummary(
        group: Group.fromJson(j),
        role: GroupRole.parse(j['role']),
        memberCount: (j['memberCount'] as num?)?.toInt() ?? 0,
      );
}

@immutable
class GroupMember {
  const GroupMember({
    required this.userId,
    required this.role,
    required this.name,
    this.email,
    this.joinedAt,
    this.addedBy,
  });

  final String userId;
  final GroupRole role;
  final String name;
  final String? email;
  final DateTime? joinedAt;

  /// Null when they joined through an invite link.
  final String? addedBy;

  String get displayName => name.trim().isNotEmpty ? name : (email ?? 'Member');

  factory GroupMember.fromJson(Map<String, dynamic> j) => GroupMember(
        userId: _str(j['userId']),
        role: GroupRole.parse(j['role']),
        name: _str(j['name']),
        email: j['email'] is String && (j['email'] as String).isNotEmpty ? j['email'] as String : null,
        joinedAt: _ms(j['joinedAt']),
        addedBy: j['addedBy'] as String?,
      );
}

@immutable
class GroupActivity {
  const GroupActivity({required this.at, required this.type, required this.detail});

  final DateTime? at;
  final String type;

  /// A ready-made sentence from the server.
  final String detail;

  factory GroupActivity.fromJson(Map<String, dynamic> j) =>
      GroupActivity(at: _ms(j['ts']), type: _str(j['type']), detail: _str(j['detail']));
}

/// What the signed-in person may do in a group, decided by the server
/// (groupCapabilities in src/lib/groupStore.ts). Screens show a control
/// only when this says so; the server checks again either way.
@immutable
class GroupCapabilities {
  const GroupCapabilities({
    required this.role,
    this.manageMembers = false,
    this.assignableRoles = const [],
    this.removableRoles = const [],
    this.editSettings = false,
    this.deleteGroup = false,
    this.transferOwnership = false,
    this.leave = false,
    this.schedule = false,
    this.start = false,
    this.call = false,
    this.addParticipants = false,
    this.viewReports = false,
    this.exportReports = false,
  });

  final GroupRole role;
  final bool manageMembers;

  /// Roles this person may give someone, highest first.
  final List<GroupRole> assignableRoles;

  /// Roles of the people this person may remove.
  final List<GroupRole> removableRoles;
  final bool editSettings;
  final bool deleteGroup;
  final bool transferOwnership;
  final bool leave;
  final bool schedule;
  final bool start;
  final bool call;
  final bool addParticipants;
  final bool viewReports;
  final bool exportReports;

  bool get anySettings => editSettings || deleteGroup || transferOwnership;

  static List<GroupRole> _roles(dynamic v) =>
      v is List ? [for (final r in v) GroupRole.parse(r)] : const [];

  factory GroupCapabilities.fromJson(dynamic j) {
    if (j is! Map) return const GroupCapabilities(role: GroupRole.participant);
    bool b(String k) => j[k] == true;
    return GroupCapabilities(
      role: GroupRole.parse(j['role']),
      manageMembers: b('manageMembers'),
      assignableRoles: _roles(j['assignableRoles']),
      removableRoles: _roles(j['removableRoles']),
      editSettings: b('editSettings'),
      deleteGroup: b('deleteGroup'),
      transferOwnership: b('transferOwnership'),
      leave: b('leave'),
      schedule: b('schedule'),
      start: b('start'),
      call: b('call'),
      addParticipants: b('addParticipants'),
      viewReports: b('viewReports'),
      exportReports: b('exportReports'),
    );
  }
}

/// The meeting the group page leads with: the live one, else the soonest.
@immutable
class NextMeeting {
  const NextMeeting({required this.id, required this.slug, required this.title, this.start, required this.state});

  final String id;
  final String slug;
  final String title;
  final DateTime? start;
  final String state;

  bool get isLive => state == 'live' || state == 'waiting';

  /// Join shows while it is live, or from 15 minutes before it starts.
  bool joinableAt(DateTime now) =>
      isLive || (start != null && !now.isBefore(start!.subtract(const Duration(minutes: 15))));

  static NextMeeting? fromJson(dynamic j) => j is Map
      ? NextMeeting(
          id: _str(j['id']),
          slug: _str(j['slug']),
          title: _str(j['title']),
          start: _iso(j['start']),
          state: _str(j['state']),
        )
      : null;
}

/// Everything the group page shows (`GET /api/groups/<id>`).
@immutable
class GroupDetail {
  const GroupDetail({
    required this.group,
    required this.members,
    required this.activity,
    required this.myUserId,
    required this.capabilities,
    this.nextMeeting,
  });

  final Group group;
  final List<GroupMember> members;
  final List<GroupActivity> activity;
  final String myUserId;
  final GroupCapabilities capabilities;
  final NextMeeting? nextMeeting;

  GroupRole get myRole => capabilities.role;

  factory GroupDetail.fromJson(Map<String, dynamic> j) {
    final me = j['me'];
    return GroupDetail(
      group: Group.fromJson(j['group'] as Map<String, dynamic>),
      members: [
        for (final m in (j['members'] as List? ?? const []).whereType<Map<String, dynamic>>())
          GroupMember.fromJson(m),
      ],
      activity: [
        for (final a in (j['activity'] as List? ?? const []).whereType<Map<String, dynamic>>())
          GroupActivity.fromJson(a),
      ],
      myUserId: me is Map ? _str(me['userId']) : '',
      capabilities: GroupCapabilities.fromJson(j['capabilities']),
      nextMeeting: NextMeeting.fromJson(j['nextMeeting']),
    );
  }
}

/// The result of adding people by email.
@immutable
class AddMembersResult {
  const AddMembersResult({required this.added, required this.alreadyMembers, required this.notFound});

  final List<GroupMember> added;
  final List<String> alreadyMembers;

  /// Addresses with no NeoConference account: send them the invite link.
  final List<String> notFound;
}

/// An invite link and when it stops working (72 hours).
@immutable
class GroupInvite {
  const GroupInvite({required this.url, required this.token, this.expiresAt});

  final String url;
  final String token;
  final DateTime? expiresAt;
}

/// What an invite link leads to, before joining.
@immutable
class InvitePreview {
  const InvitePreview({
    required this.groupName,
    this.groupId,
    this.description = '',
    this.iconUrl = '',
    this.memberCount = 0,
    this.alreadyMember = false,
    this.expiresAt,
  });

  final String groupName;

  /// Only sent to someone already in the group.
  final String? groupId;
  final String description;
  final String iconUrl;
  final int memberCount;
  final bool alreadyMember;
  final DateTime? expiresAt;

  factory InvitePreview.fromJson(Map<String, dynamic> j) {
    final g = j['group'] is Map ? j['group'] as Map : const {};
    final inv = j['invite'] is Map ? j['invite'] as Map : const {};
    return InvitePreview(
      groupName: _str(g['name']),
      groupId: g['id'] as String?,
      description: _str(g['description']),
      iconUrl: _str(g['iconUrl']),
      memberCount: (g['memberCount'] as num?)?.toInt() ?? 0,
      alreadyMember: j['alreadyMember'] == true,
      expiresAt: _iso(inv['expiresAt']),
    );
  }
}
