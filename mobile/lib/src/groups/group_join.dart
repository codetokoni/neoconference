import 'package:flutter/material.dart';

import '../meetings/meeting_view.dart';
import '../room/room_screen.dart';
import '../screens/prejoin_screen.dart';

/// Goes into a group meeting.
///
/// From a list or the group page it goes through the pre-join, where the
/// person picks microphone and camera, as joining any meeting does. An
/// answered ring, or a meeting or call you just started, skips it
/// ([straightIn]), as the web's `&join=1` does — someone who just tapped
/// Answer expects to be in the call.
///
/// No event id is passed on purpose: the pre-join reopens one of *your*
/// meetings when it has one, and a group meeting belongs to the group's
/// owner, not to whoever is joining it.
///
/// A variable so tests can see where it would go without starting a call.
Future<void> Function(BuildContext context, {required String slug, required String title, bool straightIn})
    joinGroupMeeting = _join;

Future<void> _join(
  BuildContext context, {
  required String slug,
  required String title,
  bool straightIn = false,
}) {
  return Navigator.of(context).push(
    MaterialPageRoute(
      builder: (_) => straightIn
          ? RoomScreen(slug: slug, title: title)
          : PreJoinScreen(
              meeting: MeetingView(
                title: title,
                code: slug,
                status: MeetingStatus.live,
                canJoin: true,
              ),
            ),
    ),
  );
}
