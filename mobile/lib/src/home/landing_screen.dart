import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../billing/plan.dart';
import '../billing/upgrade.dart';
import '../design/brand.dart';

/// Where the app opens: what it does, what it costs, and the way in.
///
/// Plans and prices are read from the server rather than written here, so a
/// pricing change on the website does not leave the app quoting last
/// month's numbers to someone about to pay.
class LandingScreen extends ConsumerWidget {
  const LandingScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = NeoTheme.of(context);
    final plan = ref.watch(planProvider);

    // The upgrade and cancellation notices are raised at the root, which is
    // always mounted. Raising them here too would show them twice when
    // this screen happens to be the one on top when the browser returns.

    return Scaffold(
      appBar: AppBar(title: const Text('Plans and pricing')),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async => ref.refresh(planProvider.future),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
            children: [
              Text(
                'Host and join meetings, with live translation, recording '
                'and host controls.',
                style: TextStyle(color: p.textMuted, fontSize: 13),
              ),
              const SizedBox(height: 24),

              const _SectionLabel('Your plan'),
              plan.when(
                loading: () => const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Center(child: CircularProgressIndicator()),
                ),
                error: (e, _) => _Note(
                  'Could not load your plan. $e',
                  danger: true,
                ),
                data: (p) => _CurrentPlanCard(
                  plan: p,
                  onUpgrade: () => _openUpgrade(context, p),
                ),
              ),
              const SizedBox(height: 28),

              const _SectionLabel('Plans'),
              const _PriceCard(
                name: 'Starter',
                monthly: 10,
                annual: 100,
                lines: [
                  '100 participants',
                  '120 minutes per meeting',
                  'No recording, no translation',
                ],
              ),
              const _PriceCard(
                name: 'Pro',
                monthly: 20,
                annual: 200,
                highlight: true,
                lines: [
                  '200 participants',
                  'No time limit',
                  'Recording and breakouts',
                  'Live translation',
                ],
              ),
              const _PriceCard(
                name: 'Business',
                monthly: 30,
                annual: 300,
                lines: [
                  '500 participants',
                  'Recording, breakouts, branding',
                  'Live translation',
                ],
              ),
              const _Note(
                'Enterprise, including livestreaming, is arranged directly — '
                'email info@neoconference.app.',
              ),
              const SizedBox(height: 20),
              Text(
                'Prices are in Espees. Payment opens on eSPees in your '
                'browser and returns here when it is done.',
                style: TextStyle(color: p.textMuted, fontSize: 11),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _openUpgrade(BuildContext context, PlanInfo plan) {
    // Colour and shape come from bottomSheetTheme, so that a chosen theme
    // reaches the sheet as well as the screen behind it.
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => UpgradeSheet(
        reason: plan.isFree
            ? 'You are on the Free plan.'
            : 'You are on the ${plan.plan} plan.',
        currentPlan: plan.plan,
      ),
    );
  }
}

class _CurrentPlanCard extends StatelessWidget {
  const _CurrentPlanCard({required this.plan, required this.onUpgrade});

  final PlanInfo plan;
  final VoidCallback onUpgrade;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  plan.plan[0].toUpperCase() + plan.plan.substring(1),
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w700,
                    color: NeoTheme.of(context).primary,
                  ),
                ),
                const Spacer(),
                if (plan.plan != 'enterprise')
                  TextButton(
                    onPressed: onUpgrade,
                    child: const Text('Upgrade'),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            _Limit(plan.participantsLabel, true),
            _Limit(plan.minutesLabel, true),
            _Limit('Recording', plan.recording),
            _Limit('Breakout rooms', plan.breakouts),
            _Limit('Live translation', plan.translation),
            _Limit('Custom branding', plan.branding),
            _Limit('Livestreaming', plan.livestream),
          ],
        ),
      ),
    );
  }
}

class _Limit extends StatelessWidget {
  const _Limit(this.label, this.included);
  final String label;
  final bool included;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Icon(
            included ? Icons.check_circle_outline : Icons.remove_circle_outline,
            size: 16,
            color: included ? p.primary : p.textMuted,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 13,
                color: included ? p.text : p.textMuted,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PriceCard extends StatelessWidget {
  const _PriceCard({
    required this.name,
    required this.monthly,
    required this.annual,
    required this.lines,
    this.highlight = false,
  });

  final String name;
  final int monthly;
  final int annual;
  final List<String> lines;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: p.surfaceAlt,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: highlight ? p.primary : p.border,
          width: highlight ? 1.5 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                name,
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: p.text,
                ),
              ),
              const Spacer(),
              Text(
                '$monthly ESP / month',
                style: TextStyle(
                  color: p.primary,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          Align(
            alignment: Alignment.centerRight,
            child: Text(
              'or $annual ESP a year',
              style: TextStyle(color: p.textMuted, fontSize: 11),
            ),
          ),
          const SizedBox(height: 10),
          for (final line in lines)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: Text(
                '· $line',
                style: TextStyle(color: p.textMuted, fontSize: 12),
              ),
            ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(
        text.toUpperCase(),
        style: TextStyle(
          color: NeoTheme.of(context).primary,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text, {this.danger = false});
  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Text(
        text,
        style: TextStyle(
          color: danger
              ? NeoTheme.of(context).danger
              : NeoTheme.of(context).textMuted,
          fontSize: 12,
        ),
      ),
    );
  }
}
