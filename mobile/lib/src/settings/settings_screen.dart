import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../auth/auth_controller.dart';
import '../billing/plan.dart';
import '../billing/upgrade.dart';
import '../core/theme.dart';
import 'meeting_defaults.dart';

/// Settings for the production app.
///
/// Every row here does something. The two meeting switches are read by the
/// room when it connects, the plan is the live one from the server, and
/// signing out really ends the Clerk session. A settings screen full of
/// controls that change nothing is worse than no settings screen, because
/// it teaches people their preferences are ignored.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  bool _loaded = false;
  bool _joinMuted = true;
  bool _joinCameraOff = true;
  String _build = '';

  @override
  void initState() {
    super.initState();
    _restore();
  }

  Future<void> _restore() async {
    final muted = await MeetingDefaults.joinMuted();
    final cameraOff = await MeetingDefaults.joinCameraOff();
    String build = '';
    try {
      final info = await PackageInfo.fromPlatform();
      build = '${info.version} (${info.buildNumber})';
    } catch (_) {
      // Not knowing the build number is not a reason to withhold the screen.
    }
    if (!mounted) return;
    setState(() {
      _joinMuted = muted;
      _joinCameraOff = cameraOff;
      _build = build;
      _loaded = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final name = ref.watch(authProvider.select((s) => s.displayName));
    final plan = ref.watch(planProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 40),
        children: [
          _Account(name: name),
          const SizedBox(height: 28),

          const _Label('Your plan'),
          plan.when(
            loading: () => const Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (e, _) => _Tile(
              title: 'Could not load your plan',
              subtitle: '$e',
              danger: true,
            ),
            data: (p) => _Tile(
              title: p.plan[0].toUpperCase() + p.plan.substring(1),
              subtitle: '${p.participantsLabel} · ${p.minutesLabel}',
              trailing: p.plan == 'enterprise'
                  ? null
                  : TextButton(
                      onPressed: () => _openUpgrade(context, p),
                      child: const Text('Upgrade'),
                    ),
            ),
          ),
          const SizedBox(height: 28),

          const _Label('Meetings'),
          if (!_loaded)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Center(child: CircularProgressIndicator()),
            )
          else ...[
            _Tile(
              title: 'Join muted',
              subtitle: 'Your microphone starts off',
              trailing: Switch(
                value: _joinMuted,
                onChanged: (v) {
                  setState(() => _joinMuted = v);
                  MeetingDefaults.setJoinMuted(v);
                },
              ),
            ),
            _Tile(
              title: 'Join with camera off',
              subtitle: 'Arriving already on camera is a rude surprise',
              trailing: Switch(
                value: _joinCameraOff,
                onChanged: (v) {
                  setState(() => _joinCameraOff = v);
                  MeetingDefaults.setJoinCameraOff(v);
                },
              ),
            ),
          ],
          const SizedBox(height: 28),

          const _Label('About'),
          _Tile(
            title: 'NeoConference',
            subtitle: _build.isEmpty ? 'neoconference.app' : _build,
          ),
          _Tile(
            title: 'Open neoconference.app',
            subtitle: 'Pricing, help and your account on the web',
            trailing: const Icon(
              Icons.open_in_new_rounded,
              size: 18,
              color: NeoColors.textDim,
            ),
            onTap: () => launchUrl(
              Uri.parse('https://www.neoconference.app/'),
              mode: LaunchMode.externalApplication,
            ),
          ),
          const SizedBox(height: 28),

          OutlinedButton.icon(
            onPressed: _confirmSignOut,
            icon: const Icon(Icons.logout_rounded, color: NeoColors.danger),
            label: const Text(
              'Sign out',
              style: TextStyle(color: NeoColors.danger),
            ),
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(48),
              side: const BorderSide(color: Color(0x80F87171)),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmSignOut() async {
    final out = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: NeoColors.bg2,
        title: const Text('Sign out?'),
        content: const Text(
          'You will need to sign in with KingsChat again to join meetings.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: NeoColors.danger,
              minimumSize: const Size(88, 44),
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (out != true || !mounted) return;
    // Pop first: signing out swaps the root over to the sign-in screen, and
    // leaving Settings on top of that shows a signed-out person their plan.
    Navigator.of(context).pop();
    await ref.read(authProvider.notifier).signOut();
  }

  void _openUpgrade(BuildContext context, PlanInfo plan) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: NeoColors.bg1,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => UpgradeSheet(
        reason: plan.isFree
            ? 'You are on the Free plan.'
            : 'You are on the ${plan.plan} plan.',
        currentPlan: plan.plan,
      ),
    );
  }
}

class _Account extends StatelessWidget {
  const _Account({this.name});

  final String? name;

  @override
  Widget build(BuildContext context) {
    final label =
        (name != null && name!.trim().isNotEmpty) ? name!.trim() : 'Signed in';
    return Row(
      children: [
        Container(
          height: 52,
          width: 52,
          decoration: const BoxDecoration(
            shape: BoxShape.circle,
            gradient: LinearGradient(
              colors: [NeoColors.cyanSoft, NeoColors.blue],
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
          ),
          alignment: Alignment.center,
          child: Text(
            label.substring(0, 1).toUpperCase(),
            style: const TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w700,
              color: Color(0xFF03181C),
            ),
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Text(
            label,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: NeoColors.text,
            ),
          ),
        ),
      ],
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(
        text.toUpperCase(),
        style: const TextStyle(
          color: NeoColors.cyanSoft,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.danger = false,
  });

  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: NeoColors.bg2,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(16),
          child: Container(
            constraints: const BoxConstraints(minHeight: 56),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: danger ? const Color(0x55F87171) : const Color(0x3322D3EE),
              ),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: danger ? NeoColors.danger : NeoColors.text,
                        ),
                      ),
                      if (subtitle != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            subtitle!,
                            style: const TextStyle(
                              fontSize: 12,
                              color: NeoColors.textDim,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                if (trailing != null)
                  Padding(
                    padding: const EdgeInsets.only(left: 12),
                    child: trailing,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
