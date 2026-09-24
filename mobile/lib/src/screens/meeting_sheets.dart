import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../mock/sample_data.dart';

/// What each role is allowed to do.
///
/// One table, consulted by every sheet, so a permission cannot be enforced
/// in one place and forgotten in another. Note that this governs what is
/// *offered*: the server checks every one of these again, and a client that
/// hid a button would not have enforced anything.
///
/// Moderator is deliberately not Co-host. It can keep order — mute, remove,
/// admit, lower hands — and cannot record, rename the meeting, or end it
/// for everyone. Recording creates a durable artefact of other people's
/// faces and voices, which is an owner-and-host decision.
class MeetingPermissions {
  const MeetingPermissions(this.role);

  final SampleRole role;

  bool get isOwner => role == SampleRole.owner;
  bool get isHost => role == SampleRole.host || isOwner;
  bool get isCohost => role == SampleRole.cohost;
  bool get isModerator => role == SampleRole.moderator;

  bool get canModerate => isHost || isCohost || isModerator;

  /// Owner, Host and Co-host only. Never Moderator.
  bool get canRecord => isHost || isCohost;

  bool get canEndForEveryone => isHost;
  bool get canManageWaitingRoom => canModerate;
  bool get canMuteOthers => canModerate;
  bool get canRemoveOthers => canModerate;
  bool get canChangeRoles => isHost;
  bool get canLockMeeting => isHost || isCohost;

  String get label => switch (role) {
        SampleRole.owner => 'Owner',
        SampleRole.host => 'Host',
        SampleRole.cohost => 'Co-host',
        SampleRole.moderator => 'Moderator',
        SampleRole.speaker => 'Speaker',
        SampleRole.attendee => 'Attendee',
      };
}

class _SheetHeader extends StatelessWidget {
  const _SheetHeader({required this.title, this.trailing});

  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        NeoSpace.xl,
        NeoSpace.sm,
        NeoSpace.md,
        NeoSpace.md,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(title, style: Theme.of(context).textTheme.titleLarge),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// Everyone in the meeting, with the actions this role may take on them.
class ParticipantsSheet extends StatelessWidget {
  const ParticipantsSheet({super.key, required this.myRole});

  final SampleRole myRole;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final perms = MeetingPermissions(myRole);
    final raised = sampleParticipants.where((s) => s.handRaised).toList();

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _SheetHeader(
          title: 'Participants (${sampleParticipants.length})',
          trailing: perms.canMuteOthers
              ? TextButton(onPressed: () {}, child: const Text('Mute all'))
              : null,
        ),
        if (raised.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(
              NeoSpace.xl,
              0,
              NeoSpace.xl,
              NeoSpace.md,
            ),
            child: NeoBanner(
              icon: Icons.back_hand_rounded,
              tone: NeoBannerTone.info,
              message: raised.length == 1
                  ? '${raised.first.name} has a hand raised'
                  : '${raised.length} hands raised',
              actionLabel: perms.canModerate ? 'Lower all' : null,
              action: perms.canModerate ? () {} : null,
            ),
          ),
        Flexible(
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: NeoSpace.xl),
            itemCount: sampleParticipants.length,
            itemBuilder: (context, i) {
              final person = sampleParticipants[i];
              return ListTile(
                leading: NeoAvatar(name: person.name, size: 40),
                title: Text(person.name),
                subtitle: Text(person.roleLabel),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (person.handRaised)
                      const Padding(
                        padding: EdgeInsets.only(right: NeoSpace.sm),
                        child: Text('✋'),
                      ),
                    Icon(
                      person.muted
                          ? Icons.mic_off_rounded
                          : Icons.mic_rounded,
                      size: 18,
                      color: person.muted ? p.textFaint : p.success,
                    ),
                    if (perms.canModerate && person.role != SampleRole.owner)
                      IconButton(
                        tooltip: 'Manage ${person.name}',
                        icon: const Icon(Icons.more_vert_rounded),
                        onPressed: () => _manage(context, person, perms),
                      ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  void _manage(
    BuildContext context,
    SampleParticipant person,
    MeetingPermissions perms,
  ) {
    final p = NeoTheme.of(context);
    neoSheet(
      context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            _SheetHeader(title: person.name),
            if (perms.canMuteOthers)
              ListTile(
                leading: const Icon(Icons.mic_off_rounded),
                title: Text(person.muted ? 'Ask to unmute' : 'Mute'),
                onTap: () => Navigator.pop(sheetContext),
              ),
            if (perms.canChangeRoles)
              ListTile(
                leading: const Icon(Icons.shield_moon_rounded),
                title: const Text('Make co-host'),
                onTap: () => Navigator.pop(sheetContext),
              ),
            if (perms.canRemoveOthers)
              ListTile(
                leading: Icon(Icons.person_remove_rounded, color: p.danger),
                title: Text(
                  'Remove from meeting',
                  style: TextStyle(color: p.danger),
                ),
                onTap: () async {
                  Navigator.pop(sheetContext);
                  await neoConfirm(
                    context,
                    title: 'Remove ${person.name}?',
                    message: 'They will be disconnected immediately.',
                    confirmLabel: 'Remove',
                  );
                },
              ),
            const SizedBox(height: NeoSpace.md),
          ],
        ),
      ),
    );
  }
}

class ChatSheet extends StatelessWidget {
  const ChatSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const _SheetHeader(title: 'Chat'),
          Flexible(
            child: ListView.builder(
              padding: const EdgeInsets.symmetric(horizontal: NeoSpace.xl),
              itemCount: sampleChat.length,
              itemBuilder: (context, i) {
                final m = sampleChat[i];
                return Padding(
                  padding: const EdgeInsets.only(bottom: NeoSpace.lg),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      NeoAvatar(name: m.author, size: 32),
                      const SizedBox(width: NeoSpace.md),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    m.author,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: text.titleSmall,
                                  ),
                                ),
                                const SizedBox(width: NeoSpace.sm),
                                Text(
                                  sampleClock(m.at),
                                  style: text.labelSmall
                                      ?.copyWith(color: p.textFaint),
                                ),
                                if (m.isDirect) ...[
                                  const SizedBox(width: NeoSpace.sm),
                                  NeoPill('Direct', color: p.accent),
                                ],
                              ],
                            ),
                            const SizedBox(height: 2),
                            Text(m.text, style: text.bodyMedium),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              NeoSpace.xl,
              NeoSpace.sm,
              NeoSpace.xl,
              NeoSpace.xl,
            ),
            child: Row(
              children: [
                const Expanded(
                  child: TextField(
                    decoration: InputDecoration(hintText: 'Message everyone'),
                  ),
                ),
                const SizedBox(width: NeoSpace.md),
                IconButton.filled(
                  onPressed: () {},
                  icon: const Icon(Icons.send_rounded),
                  style: IconButton.styleFrom(
                    backgroundColor: p.primary,
                    foregroundColor: p.onPrimary,
                    minimumSize: const Size(52, 52),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class ReactionsSheet extends StatelessWidget {
  const ReactionsSheet({super.key});

  static const _reactions = [
    ('❤️', 'Heart'),
    ('👍', 'Thumbs up'),
    ('👏', 'Clap'),
    ('😂', 'Laugh'),
    ('😮', 'Wow'),
    ('🔥', 'Fire'),
  ];

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          NeoSpace.xl,
          0,
          NeoSpace.xl,
          NeoSpace.xl,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const _SheetHeader(title: 'Send a reaction'),
            Wrap(
              spacing: NeoSpace.md,
              runSpacing: NeoSpace.md,
              alignment: WrapAlignment.center,
              children: [
                for (final (emoji, label) in _reactions)
                  Semantics(
                    button: true,
                    label: label,
                    child: InkWell(
                      onTap: () => Navigator.pop(context),
                      borderRadius: BorderRadius.circular(NeoRadius.pill),
                      child: Container(
                        height: 56,
                        width: 56,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: NeoTheme.of(context).surfaceHigh,
                          shape: BoxShape.circle,
                        ),
                        child: Text(
                          emoji,
                          style: const TextStyle(fontSize: 26),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Everything that does not earn a place on the control bar.
class MoreSheet extends StatelessWidget {
  const MoreSheet({
    super.key,
    required this.role,
    required this.onHostControls,
    required this.onDetails,
    required this.onToggleHand,
    required this.onReact,
    this.handRaised = false,
  });

  final SampleRole role;
  final VoidCallback onHostControls;
  final VoidCallback onDetails;
  final VoidCallback onToggleHand;
  final VoidCallback onReact;
  final bool handRaised;

  @override
  Widget build(BuildContext context) {
    final perms = MeetingPermissions(role);
    final p = NeoTheme.of(context);

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          _SheetHeader(
            title: 'More',
            trailing: NeoPill(perms.label, color: p.primary),
          ),
          ListTile(
            leading: Icon(
              Icons.back_hand_rounded,
              color: handRaised ? p.primary : null,
            ),
            title: Text(handRaised ? 'Lower hand' : 'Raise hand'),
            onTap: () {
              Navigator.pop(context);
              onToggleHand();
            },
          ),
          ListTile(
            leading: const Icon(Icons.add_reaction_rounded),
            title: const Text('Send a reaction'),
            onTap: () {
              Navigator.pop(context);
              onReact();
            },
          ),
          ListTile(
            leading: const Icon(Icons.screen_share_rounded),
            title: const Text('Share screen'),
            subtitle: const Text('Android asks for consent first'),
            onTap: () => Navigator.pop(context),
          ),
          ListTile(
            leading: const Icon(Icons.volume_up_rounded),
            title: const Text('Audio output'),
            subtitle: const Text('Speaker'),
            onTap: () => Navigator.pop(context),
          ),
          ListTile(
            leading: const Icon(Icons.translate_rounded),
            title: const Text('Live translation'),
            subtitle: const Text('Off'),
            onTap: () => Navigator.pop(context),
          ),
          ListTile(
            leading: const Icon(Icons.info_outline_rounded),
            title: const Text('Meeting details'),
            onTap: () {
              Navigator.pop(context);
              onDetails();
            },
          ),
          if (perms.canModerate)
            ListTile(
              leading: Icon(Icons.shield_moon_rounded, color: p.primary),
              title: const Text('Host controls'),
              subtitle: Text('Available to ${perms.label.toLowerCase()}s'),
              onTap: () {
                Navigator.pop(context);
                onHostControls();
              },
            ),
          const SizedBox(height: NeoSpace.md),
        ],
      ),
    );
  }
}

/// The controls only an owner, host, co-host or moderator sees.
///
/// Recording is absent for a Moderator — not greyed out, absent. Showing a
/// disabled control that someone will never be able to use is an invitation
/// to keep trying.
class HostControlsSheet extends StatelessWidget {
  const HostControlsSheet({super.key, required this.role});

  final SampleRole role;

  @override
  Widget build(BuildContext context) {
    final perms = MeetingPermissions(role);
    final p = NeoTheme.of(context);
    final waiting = ['Chinwe Balogun', 'Dr Ruth Kimani'];

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _SheetHeader(
          title: 'Host controls',
          trailing: NeoPill(perms.label, color: p.primary),
        ),
        Flexible(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(
              NeoSpace.xl,
              0,
              NeoSpace.xl,
              NeoSpace.xl,
            ),
            children: [
              if (perms.canManageWaitingRoom && waiting.isNotEmpty) ...[
                NeoSection(
                  title: 'Waiting room (${waiting.length})',
                  padding: const EdgeInsets.only(bottom: NeoSpace.xl),
                  child: Column(
                    children: [
                      for (final name in waiting)
                        Padding(
                          padding: const EdgeInsets.only(bottom: NeoSpace.sm),
                          child: NeoCard(
                            padding: const EdgeInsets.all(NeoSpace.md),
                            child: Row(
                              children: [
                                NeoAvatar(name: name, size: 34),
                                const SizedBox(width: NeoSpace.md),
                                Expanded(child: Text(name)),
                                TextButton(
                                  onPressed: () {},
                                  style: TextButton.styleFrom(
                                    foregroundColor: p.danger,
                                  ),
                                  child: const Text('Deny'),
                                ),
                                const SizedBox(width: NeoSpace.xs),
                                FilledButton(
                                  onPressed: () {},
                                  style: FilledButton.styleFrom(
                                    minimumSize: const Size(72, 40),
                                  ),
                                  child: const Text('Admit'),
                                ),
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ],

              NeoSection(
                title: 'Moderation',
                padding: const EdgeInsets.only(bottom: NeoSpace.xl),
                child: Column(
                  children: [
                    _Toggle(
                      icon: Icons.mic_off_rounded,
                      title: 'Mute everyone',
                      subtitle: 'Hosts and co-hosts are not muted',
                      onTap: () {},
                    ),
                    _Toggle(
                      icon: Icons.back_hand_rounded,
                      title: 'Lower all hands',
                      onTap: () {},
                    ),
                    if (perms.canLockMeeting)
                      _Toggle(
                        icon: Icons.lock_rounded,
                        title: 'Lock meeting',
                        subtitle: 'No new participants can join',
                        toggle: true,
                        onTap: () {},
                      ),
                  ],
                ),
              ),

              // The gate this whole class exists to demonstrate.
              if (perms.canRecord)
                NeoSection(
                  title: 'Recording',
                  padding: const EdgeInsets.only(bottom: NeoSpace.xl),
                  child: Column(
                    children: [
                      _Toggle(
                        icon: Icons.fiber_manual_record_rounded,
                        iconColor: p.danger,
                        title: 'Start recording',
                        subtitle: 'Everyone is told when recording begins',
                        onTap: () {},
                      ),
                    ],
                  ),
                )
              else
                NeoBanner(
                  icon: Icons.info_outline_rounded,
                  tone: NeoBannerTone.info,
                  message:
                      'Recording is available to the owner, host and '
                      'co-hosts.',
                ),

              if (perms.canEndForEveryone) ...[
                const SizedBox(height: NeoSpace.lg),
                OutlinedButton.icon(
                  onPressed: () async {
                    final end = await neoConfirm(
                      context,
                      title: 'End for everyone?',
                      message:
                          'The meeting closes for all participants and any '
                          'recording stops.',
                      confirmLabel: 'End meeting',
                    );
                    if (end && context.mounted) Navigator.pop(context);
                  },
                  icon: Icon(Icons.call_end_rounded, color: p.danger),
                  label: Text(
                    'End meeting for everyone',
                    style: TextStyle(color: p.danger),
                  ),
                  style: OutlinedButton.styleFrom(
                    side: BorderSide(color: p.danger.withValues(alpha: 0.6)),
                  ),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

class _Toggle extends StatelessWidget {
  const _Toggle({
    required this.icon,
    required this.title,
    this.subtitle,
    this.onTap,
    this.toggle = false,
    this.iconColor,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final bool toggle;
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: NeoSpace.sm),
      child: NeoCard(
        padding: const EdgeInsets.symmetric(
          horizontal: NeoSpace.md,
          vertical: NeoSpace.md,
        ),
        onTap: onTap,
        child: Row(
          children: [
            Icon(icon, size: 20, color: iconColor),
            const SizedBox(width: NeoSpace.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: Theme.of(context).textTheme.titleSmall),
                  if (subtitle != null)
                    Text(
                      subtitle!,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                ],
              ),
            ),
            if (toggle) Switch(value: false, onChanged: (_) {}),
          ],
        ),
      ),
    );
  }
}

class MeetingDetailsSheet extends StatelessWidget {
  const MeetingDetailsSheet({super.key, required this.meeting});

  final SampleMeeting meeting;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final text = Theme.of(context).textTheme;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          NeoSpace.xl,
          0,
          NeoSpace.xl,
          NeoSpace.xl,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SheetHeader(title: 'Meeting details'),
            Text(meeting.title, style: text.titleMedium),
            const SizedBox(height: NeoSpace.xs),
            Text(
              'Hosted by ${meeting.host}',
              style: text.bodySmall?.copyWith(color: p.textMuted),
            ),
            const SizedBox(height: NeoSpace.xl),
            NeoCard(
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Meeting link', style: text.labelSmall),
                        const SizedBox(height: 2),
                        Text(
                          'neoconference.app/${meeting.code}',
                          style: text.bodyMedium,
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: 'Copy link',
                    icon: const Icon(Icons.copy_rounded),
                    onPressed: () {},
                  ),
                ],
              ),
            ),
            const SizedBox(height: NeoSpace.md),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () {},
                    icon: const Icon(Icons.ios_share_rounded, size: 18),
                    label: const Text('Share'),
                  ),
                ),
                const SizedBox(width: NeoSpace.md),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () {},
                    icon: const Icon(Icons.qr_code_rounded, size: 18),
                    label: const Text('QR code'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
