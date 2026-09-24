/// How a meeting's time is written.
///
/// Relative where relative is what someone wants ("in 18 min" answers
/// "should I be walking to a quiet room?"), absolute once it is far enough
/// away that the relative form stops meaning anything.
///
/// `now` is a parameter rather than a call to DateTime.now() so the
/// showcase can pin it and screenshots do not drift day to day.
String neoWhen(DateTime when, {required DateTime now}) {
  final diff = when.difference(now);
  final minutes = diff.inMinutes;
  if (minutes.abs() < 1) return 'Now';
  if (minutes > 0 && minutes < 60) return 'in $minutes min';
  if (minutes > 0 && diff.inHours < 24) return 'in ${diff.inHours} h';
  if (minutes < 0 && diff.inHours > -24) return '${-diff.inHours} h ago';
  if (diff.inDays == 1) return 'Tomorrow';
  if (diff.inDays == -1) return 'Yesterday';
  if (diff.inDays < -1) return '${-diff.inDays} days ago';
  return 'In ${diff.inDays} days';
}

String neoClock(DateTime when) =>
    '${when.hour.toString().padLeft(2, '0')}:'
    '${when.minute.toString().padLeft(2, '0')}';

/// "Good morning" and the rest, from the hour on the device.
String neoGreeting(DateTime now) {
  final hour = now.hour;
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
