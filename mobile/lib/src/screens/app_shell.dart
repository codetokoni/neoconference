import 'package:flutter/material.dart';

import '../design/brand.dart';
import '../mock/sample_data.dart';
import 'home_screen.dart';
import 'history_screen.dart';
import 'notifications_screen.dart';
import 'settings_screen.dart';

/// The signed-in shell.
///
/// A bottom bar rather than a drawer: four destinations, all reachable with
/// a thumb, and visible rather than hidden behind a hamburger. Labels are
/// always shown — an icon-only bar is a memory test.
class AppShell extends StatefulWidget {
  const AppShell({super.key});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _index = 0;

  static const _destinations = [
    (Icons.home_rounded, Icons.home_outlined, 'Home'),
    (Icons.history_rounded, Icons.history_outlined, 'History'),
    (Icons.notifications_rounded, Icons.notifications_none_rounded, 'Alerts'),
    (Icons.person_rounded, Icons.person_outline_rounded, 'Profile'),
  ];

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final unread = sampleNotifications.where((n) => n.unread).length;

    return Scaffold(
      backgroundColor: p.bg,
      body: IndexedStack(
        index: _index,
        children: const [
          HomeScreen(),
          HistoryScreen(),
          NotificationsScreen(),
          SettingsScreen(),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        backgroundColor: p.surface,
        indicatorColor: p.primary.withValues(alpha: 0.18),
        surfaceTintColor: Colors.transparent,
        height: 68,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        destinations: [
          for (var i = 0; i < _destinations.length; i++)
            NavigationDestination(
              icon: i == 2 && unread > 0
                  ? Badge(
                      label: Text('$unread'),
                      child: Icon(_destinations[i].$2),
                    )
                  : Icon(_destinations[i].$2),
              selectedIcon: Icon(_destinations[i].$1, color: p.primary),
              label: _destinations[i].$3,
            ),
        ],
      ),
    );
  }
}
