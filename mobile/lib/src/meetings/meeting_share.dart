import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';

import 'meeting_links.dart';
import 'when.dart';

/// What a shared meeting link says: the meeting, when (for a scheduled
/// one), and the link. One wording wherever the link is shared from — the
/// Manage page, the meeting, the "Meeting scheduled" dialog, the QR sheet.
String meetingInviteText(String title, String slug, {DateTime? when}) {
  final name = title.trim().isEmpty ? 'a meeting' : '"${title.trim()}"';
  final at = when == null ? '' : ' on ${_day(when)} at ${neoClock(when)}';
  return 'Join $name on NeoConference$at:\n${meetingShareLink(slug)}';
}

String _day(DateTime d) {
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return '${days[d.weekday - 1]} ${d.day} ${months[d.month - 1]}';
}

/// Opens the phone's share menu (WhatsApp, KingsChat, SMS…). Replaced in
/// tests, which have no share menu.
Future<void> Function(ShareParams params) shareSheet =
    (params) => SharePlus.instance.share(params).then((_) {});

/// Shares a meeting's invite through the phone's share menu.
Future<void> shareMeeting(String title, String slug, {DateTime? when}) => shareSheet(
      ShareParams(
        text: meetingInviteText(title, slug, when: when),
        subject: title.trim().isEmpty ? 'NeoConference meeting' : title.trim(),
      ),
    );

/// The Share button, the same everywhere a meeting link is shown.
class ShareMeetingButton extends StatelessWidget {
  const ShareMeetingButton({
    super.key,
    required this.title,
    required this.slug,
    this.when,
    this.filled = false,
  });

  final String title;
  final String slug;
  final DateTime? when;

  /// The main action where sharing is the point (a meeting just scheduled).
  final bool filled;

  @override
  Widget build(BuildContext context) {
    void share() => shareMeeting(title, slug, when: when);
    const icon = Icon(Icons.share_rounded, size: 18);
    const label = Text('Share');
    return filled
        ? FilledButton.icon(onPressed: share, icon: icon, label: label)
        : OutlinedButton.icon(onPressed: share, icon: icon, label: label);
  }
}
