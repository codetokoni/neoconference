import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../mock/sample_data.dart';

class NotificationsScreen extends StatelessWidget {
  const NotificationsScreen({super.key, this.empty = false});

  final bool empty;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Scaffold(
      backgroundColor: p.bg,
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          if (!empty)
            TextButton(onPressed: () {}, child: const Text('Mark all read')),
        ],
      ),
      body: empty
          ? const NeoEmptyState(
              icon: Icons.notifications_none_rounded,
              title: 'Nothing new',
              message:
                  'Invitations, reminders and finished recordings appear '
                  'here.',
            )
          : ListView.separated(
              padding: const EdgeInsets.all(NeoSpace.xl),
              itemCount: sampleNotifications.length,
              separatorBuilder: (_, _) => const SizedBox(height: NeoSpace.md),
              itemBuilder: (context, i) {
                final n = sampleNotifications[i];
                final (icon, color) = switch (n.icon) {
                  NeoNotificationIcon.invite => (
                      Icons.mail_outline_rounded,
                      p.info
                    ),
                  NeoNotificationIcon.recording => (
                      Icons.play_circle_outline_rounded,
                      p.accent
                    ),
                  NeoNotificationIcon.reminder => (
                      Icons.schedule_rounded,
                      p.primary
                    ),
                  NeoNotificationIcon.host => (
                      Icons.shield_moon_rounded,
                      p.success
                    ),
                };

                return NeoCard(
                  onTap: () {},
                  highlighted: n.unread,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        height: 38,
                        width: 38,
                        decoration: BoxDecoration(
                          color: color.withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(NeoRadius.md),
                        ),
                        child: Icon(icon, size: 18, color: color),
                      ),
                      const SizedBox(width: NeoSpace.md),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(n.title, style: text.titleSmall),
                            const SizedBox(height: 2),
                            Text(
                              n.body,
                              style:
                                  text.bodySmall?.copyWith(color: p.textMuted),
                            ),
                            const SizedBox(height: NeoSpace.xs),
                            Text(
                              sampleWhen(n.at),
                              style:
                                  text.labelSmall?.copyWith(color: p.textFaint),
                            ),
                          ],
                        ),
                      ),
                      if (n.unread)
                        Container(
                          margin: const EdgeInsets.only(top: NeoSpace.xs),
                          height: 8,
                          width: 8,
                          decoration: BoxDecoration(
                            color: p.primary,
                            shape: BoxShape.circle,
                          ),
                        ),
                    ],
                  ),
                );
              },
            ),
    );
  }
}
