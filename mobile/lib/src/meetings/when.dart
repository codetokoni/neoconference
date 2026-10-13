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
  // Under an hour ago has to be counted in minutes: rounding it to hours
  // printed "0 h ago" against every meeting from earlier in the evening.
  if (minutes < 0 && minutes > -60) return '${-minutes} min ago';
  if (minutes < 0 && diff.inHours > -24) return '${-diff.inHours} h ago';
  if (diff.inDays == 1) return 'Tomorrow';
  if (diff.inDays == -1) return 'Yesterday';
  if (diff.inDays < -1) return '${-diff.inDays} days ago';
  return 'In ${diff.inDays} days';
}

String neoClock(DateTime when) =>
    '${when.hour.toString().padLeft(2, '0')}:'
    '${when.minute.toString().padLeft(2, '0')}';

/// A join or leave time on a report: the clock alone on the day the meeting
/// started (`day`), with its date otherwise ("13 Oct, 11:51"). A permanent
/// room's report spans weeks, and bare clocks read as someone leaving at
/// 11:51 after joining at 13:59.
String neoClockOn(DateTime when, DateTime? day) {
  final at = when.toLocal();
  final ref = day?.toLocal();
  if (ref != null && ref.year == at.year && ref.month == at.month && ref.day == at.day) return neoClock(at);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${at.day} ${months[at.month - 1]}, ${neoClock(at)}';
}

/// "Good morning" and the rest, from the hour on the device.
String neoGreeting(DateTime now) {
  final hour = now.hour;
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
