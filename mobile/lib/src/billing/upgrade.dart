import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import '../design/brand.dart';
import '../events/event.dart';

/// Paying for a plan, from the phone.
///
/// The payment itself happens on eSPees' own hosted page, opened in the
/// phone's browser — the app never sees a card number, a wallet, or any
/// payment detail. That is deliberate and not merely convenient: handling
/// them here would put this app in scope for obligations it has no business
/// carrying.
///
/// The app tells the server where to send the buyer afterwards, and the
/// server accepts only its own App Link, so the round trip lands back in the
/// app rather than on a web dashboard the person cannot get out of.
///
/// Note for distribution: this is fine for an APK handed out directly. If
/// this app is ever published on Google Play, selling plan upgrades through
/// a web checkout breaks Play's payments policy and would need Play Billing
/// instead.
class UpgradeSheet extends ConsumerStatefulWidget {
  const UpgradeSheet({super.key, required this.reason, this.currentPlan});

  /// What the person was trying to do when they ran into the plan.
  final String reason;
  final String? currentPlan;

  @override
  ConsumerState<UpgradeSheet> createState() => _UpgradeSheetState();
}

class _UpgradeSheetState extends ConsumerState<UpgradeSheet> {
  String _plan = 'pro';
  String _cycle = 'monthly';
  bool _busy = false;
  String? _error;

  /// Prices as the server charges them, from lib/espees.ts. Shown rather
  /// than hidden behind "Continue" — nobody should have to open a payment
  /// page to find out what it costs.
  static const _espees = {
    'starter': {'monthly': 10, 'annual': 100},
    'pro': {'monthly': 20, 'annual': 200},
    'business': {'monthly': 30, 'annual': 300},
  };

  Future<void> _start() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final body = await ref.read(apiProvider).post(
        '/api/billing/espees/checkout',
        {
          'plan': _plan,
          'billingCycle': _cycle,
          'returnTo': Config.deepLinkCallback,
        },
      );
      final url = (body is Map ? body['url'] : null) as String?;
      if (url == null || url.isEmpty) {
        setState(() {
          _busy = false;
          _error = 'The server did not return a payment page.';
        });
        return;
      }
      final opened = await launchUrl(
        Uri.parse(url),
        mode: LaunchMode.externalApplication,
      );
      if (!opened) {
        setState(() {
          _busy = false;
          _error = 'Could not open the payment page.';
        });
        return;
      }
      if (mounted) Navigator.pop(context);
    } on ApiException catch (e) {
      setState(() {
        _busy = false;
        _error = e.message;
      });
    } catch (e) {
      setState(() {
        _busy = false;
        _error = 'Could not start the payment: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final amount = _espees[_plan]?[_cycle];

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              'Upgrade your plan',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w700,
                color: p.text,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              widget.reason,
              style: TextStyle(color: p.textMuted, fontSize: 13),
            ),
            const SizedBox(height: 20),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'starter', label: Text('Starter')),
                ButtonSegment(value: 'pro', label: Text('Pro')),
                ButtonSegment(value: 'business', label: Text('Business')),
              ],
              selected: {_plan},
              onSelectionChanged: (s) => setState(() => _plan = s.first),
            ),
            const SizedBox(height: 12),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'monthly', label: Text('Monthly')),
                ButtonSegment(value: 'annual', label: Text('Annual')),
              ],
              selected: {_cycle},
              onSelectionChanged: (s) => setState(() => _cycle = s.first),
            ),
            const SizedBox(height: 16),
            if (amount != null)
              Text(
                '$amount ESP ${_cycle == 'monthly' ? 'per month' : 'per year'}',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: p.primary,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
            if (_plan == 'starter') ...[
              const SizedBox(height: 8),
              Text(
                'Starter does not include live translation.',
                textAlign: TextAlign.center,
                style: TextStyle(color: p.danger, fontSize: 12),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                style: TextStyle(color: p.danger, fontSize: 13),
              ),
            ],
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _busy ? null : _start,
              child: _busy
                  ? const SizedBox(
                      height: 20,
                      width: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('Continue to payment'),
            ),
            const SizedBox(height: 10),
            Text(
              'Payment happens on eSPees. You will come back here when it '
              'is done.',
              textAlign: TextAlign.center,
              style: TextStyle(color: p.textMuted, fontSize: 11),
            ),
          ],
        ),
      ),
    );
  }
}
