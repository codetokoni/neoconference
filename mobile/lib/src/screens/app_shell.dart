import 'package:flutter/material.dart';

import '../design/brand.dart';

/// One destination in the bottom bar.
class NeoTab {
  const NeoTab({
    required this.icon,
    required this.selectedIcon,
    required this.label,
    required this.screen,
    this.badge = 0,
  });

  final IconData icon;
  final IconData selectedIcon;
  final String label;
  final Widget screen;

  /// Zero means no badge. Production leaves it at zero rather than
  /// inventing a count for a feed that does not exist.
  final int badge;
}

/// The signed-in shell.
///
/// A bottom bar rather than a drawer: the destinations are all reachable
/// with a thumb, and visible rather than hidden behind a hamburger. Labels
/// are always shown — an icon-only bar is a memory test.
///
/// The tabs are passed in rather than fixed here, because production and
/// the showcase do not have the same ones. Alerts needs a notifications
/// backend that does not exist yet, so the real app leaves that tab out
/// instead of shipping a tab with nothing truthful to put in it.
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.tabs});

  final List<NeoTab> tabs;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    // A tab list that shrank between builds must not leave the bar
    // pointing past the end of it.
    final index = _index.clamp(0, widget.tabs.length - 1);

    return Scaffold(
      backgroundColor: p.bg,
      body: IndexedStack(
        index: index,
        children: [for (final tab in widget.tabs) tab.screen],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (i) => setState(() => _index = i),
        backgroundColor: p.surface,
        indicatorColor: p.primary.withValues(alpha: 0.18),
        surfaceTintColor: Colors.transparent,
        height: 68,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        destinations: [
          for (final tab in widget.tabs)
            NavigationDestination(
              icon: tab.badge > 0
                  ? Badge(
                      label: Text('${tab.badge}'),
                      child: Icon(tab.icon, color: p.textMuted),
                    )
                  : Icon(tab.icon, color: p.textMuted),
              selectedIcon: Icon(tab.selectedIcon, color: p.primary),
              label: tab.label,
            ),
        ],
      ),
    );
  }
}
