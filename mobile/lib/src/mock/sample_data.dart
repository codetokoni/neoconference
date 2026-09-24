// lib/src/mock/sample_data.dart
//
// SAMPLE DATA — NOT PRODUCTION.
//
// Everything in this file is fabricated so the UI can be built, reviewed
// and screenshotted without a live backend. It is deliberately quarantined
// in lib/src/mock/ and nothing outside a screen's preview path imports it.
// The real screens read the providers in lib/src/events, lib/src/room and
// lib/src/billing, which talk to neoconference.app.
//
// The names and meeting titles are plausible rather than placeholder, so
// layout problems — long names, wrapped titles, crowded grids — show up
// during design instead of after launch.



enum SampleStatus { live, startingSoon, scheduled, ended }

class SampleMeeting {
  const SampleMeeting({
    required this.title,
    required this.code,
    required this.host,
    required this.startsAt,
    required this.durationMinutes,
    required this.participants,
    required this.status,
    this.recurring = false,
    this.hasRecording = false,
    this.languages = const [],
  });

  final String title;
  final String code;
  final String host;
  final DateTime startsAt;
  final int durationMinutes;
  final List<String> participants;
  final SampleStatus status;
  final bool recurring;
  final bool hasRecording;
  final List<String> languages;
}

/// A fixed "now" so screenshots and golden tests do not drift day to day.
final sampleNow = DateTime(2026, 9, 24, 9, 12);

final sampleUpcoming = <SampleMeeting>[
  SampleMeeting(
    title: 'Product sync — Q4 roadmap',
    code: 'product-sync',
    host: 'Adaeze Okonkwo',
    startsAt: sampleNow.add(const Duration(minutes: 18)),
    durationMinutes: 45,
    participants: [
      'Adaeze Okonkwo',
      'Marcus Feldman',
      'Priya Raghunathan',
      'Tolu Adeyemi',
      'Sam Whitfield',
    ],
    status: SampleStatus.startingSoon,
    recurring: true,
  ),
  SampleMeeting(
    title: 'Design critique — mobile release',
    code: 'design-crit',
    host: 'Priya Raghunathan',
    startsAt: sampleNow.add(const Duration(hours: 2, minutes: 48)),
    durationMinutes: 60,
    participants: ['Priya Raghunathan', 'Jonas Lindqvist', 'Amara Nwosu'],
    status: SampleStatus.scheduled,
  ),
  SampleMeeting(
    title: 'Partner briefing — Lagos region',
    code: 'partner-lagos',
    host: 'Tolu Adeyemi',
    startsAt: sampleNow.add(const Duration(days: 1, hours: 1)),
    durationMinutes: 30,
    participants: ['Tolu Adeyemi', 'Chinwe Balogun', 'Marcus Feldman'],
    status: SampleStatus.scheduled,
    languages: ['fr', 'pt'],
  ),
];

final sampleRecent = <SampleMeeting>[
  SampleMeeting(
    title: 'All hands — September',
    code: 'all-hands-sep',
    host: 'Adaeze Okonkwo',
    startsAt: sampleNow.subtract(const Duration(days: 1, hours: 3)),
    durationMinutes: 52,
    participants: List.filled(38, 'Team'),
    status: SampleStatus.ended,
    hasRecording: true,
    languages: ['es', 'fr'],
  ),
  SampleMeeting(
    title: 'Engineering standup',
    code: 'eng-standup',
    host: 'Jonas Lindqvist',
    startsAt: sampleNow.subtract(const Duration(days: 1, hours: 21)),
    durationMinutes: 14,
    participants: ['Jonas Lindqvist', 'Sam Whitfield', 'Amara Nwosu'],
    status: SampleStatus.ended,
    recurring: true,
  ),
  SampleMeeting(
    title: 'Customer call — Meridian Health',
    code: 'meridian',
    host: 'Marcus Feldman',
    startsAt: sampleNow.subtract(const Duration(days: 3)),
    durationMinutes: 41,
    participants: ['Marcus Feldman', 'Dr Ruth Kimani', 'Priya Raghunathan'],
    status: SampleStatus.ended,
    hasRecording: true,
  ),
];

/// Roles as the product defines them (src/types/event.ts), plus owner,
/// which is the event's creator rather than a role assignment.
enum SampleRole { owner, host, cohost, moderator, speaker, attendee }

class SampleParticipant {
  const SampleParticipant({
    required this.name,
    required this.role,
    this.muted = true,
    this.cameraOn = false,
    this.speaking = false,
    this.handRaised = false,
    this.sharing = false,
    this.connection = SampleConnection.good,
  });

  final String name;
  final SampleRole role;
  final bool muted;
  final bool cameraOn;
  final bool speaking;
  final bool handRaised;
  final bool sharing;
  final SampleConnection connection;

  String get roleLabel => switch (role) {
        SampleRole.owner => 'Owner',
        SampleRole.host => 'Host',
        SampleRole.cohost => 'Co-host',
        SampleRole.moderator => 'Moderator',
        SampleRole.speaker => 'Speaker',
        SampleRole.attendee => 'Attendee',
      };
}

enum SampleConnection { good, fair, poor }

final sampleParticipants = <SampleParticipant>[
  const SampleParticipant(
    name: 'Adaeze Okonkwo',
    role: SampleRole.owner,
    muted: false,
    cameraOn: true,
    speaking: true,
  ),
  const SampleParticipant(
    name: 'Marcus Feldman',
    role: SampleRole.cohost,
    cameraOn: true,
  ),
  const SampleParticipant(
    name: 'Priya Raghunathan',
    role: SampleRole.speaker,
    muted: false,
    cameraOn: true,
    sharing: true,
  ),
  const SampleParticipant(
    name: 'Tolu Adeyemi',
    role: SampleRole.attendee,
    handRaised: true,
  ),
  const SampleParticipant(
    name: 'Jonas Lindqvist',
    role: SampleRole.attendee,
    connection: SampleConnection.poor,
  ),
  const SampleParticipant(name: 'Amara Nwosu', role: SampleRole.attendee),
  const SampleParticipant(
    name: 'Sam Whitfield',
    role: SampleRole.attendee,
    cameraOn: true,
  ),
  const SampleParticipant(name: 'Chinwe Balogun', role: SampleRole.attendee),
];

class SampleMessage {
  const SampleMessage({
    required this.author,
    required this.text,
    required this.at,
    this.isDirect = false,
  });

  final String author;
  final String text;
  final DateTime at;
  final bool isDirect;
}

final sampleChat = <SampleMessage>[
  SampleMessage(
    author: 'Marcus Feldman',
    text: 'Joining two minutes late — on a call with the vendor.',
    at: sampleNow.subtract(const Duration(minutes: 11)),
  ),
  SampleMessage(
    author: 'Priya Raghunathan',
    text: 'Sharing the roadmap deck now. Shout if the text is too small.',
    at: sampleNow.subtract(const Duration(minutes: 8)),
  ),
  SampleMessage(
    author: 'Tolu Adeyemi',
    text: 'Can we come back to the Lagos launch date before we finish?',
    at: sampleNow.subtract(const Duration(minutes: 5)),
  ),
  SampleMessage(
    author: 'Adaeze Okonkwo',
    text: 'Yes — putting it after the budget item.',
    at: sampleNow.subtract(const Duration(minutes: 4)),
  ),
  SampleMessage(
    author: 'Amara Nwosu',
    text: 'The captions are lagging slightly for me.',
    at: sampleNow.subtract(const Duration(minutes: 2)),
    isDirect: true,
  ),
];

class SampleNotification {
  const SampleNotification({
    required this.title,
    required this.body,
    required this.at,
    required this.icon,
    this.unread = false,
  });

  final String title;
  final String body;
  final DateTime at;
  final NeoNotificationIcon icon;
  final bool unread;
}

enum NeoNotificationIcon { invite, recording, reminder, host }

final sampleNotifications = <SampleNotification>[
  SampleNotification(
    title: 'Product sync starts in 20 minutes',
    body: 'Adaeze Okonkwo · product-sync',
    at: sampleNow.subtract(const Duration(minutes: 2)),
    icon: NeoNotificationIcon.reminder,
    unread: true,
  ),
  SampleNotification(
    title: 'Recording ready',
    body: 'All hands — September · 52 minutes',
    at: sampleNow.subtract(const Duration(hours: 20)),
    icon: NeoNotificationIcon.recording,
    unread: true,
  ),
  SampleNotification(
    title: 'You were made a co-host',
    body: 'Design critique — mobile release',
    at: sampleNow.subtract(const Duration(days: 1)),
    icon: NeoNotificationIcon.host,
  ),
  SampleNotification(
    title: 'Chinwe Balogun invited you',
    body: 'Partner briefing — Lagos region',
    at: sampleNow.subtract(const Duration(days: 2)),
    icon: NeoNotificationIcon.invite,
  ),
];

/// Human wording for a time near [sampleNow], e.g. "in 18 min", "Yesterday".
String sampleWhen(DateTime when) {
  final diff = when.difference(sampleNow);
  final minutes = diff.inMinutes;
  if (minutes.abs() < 1) return 'Now';
  if (minutes > 0 && minutes < 60) return 'in $minutes min';
  if (minutes > 0 && diff.inHours < 24) return 'in ${diff.inHours} h';
  if (minutes < 0 && diff.inHours > -24) {
    return '${-diff.inHours} h ago';
  }
  if (diff.inDays == 1) return 'Tomorrow';
  if (diff.inDays == -1) return 'Yesterday';
  if (diff.inDays < -1) return '${-diff.inDays} days ago';
  return 'In ${diff.inDays} days';
}

String sampleClock(DateTime when) =>
    '${when.hour.toString().padLeft(2, '0')}:'
    '${when.minute.toString().padLeft(2, '0')}';
