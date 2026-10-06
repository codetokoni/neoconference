import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design/brand.dart';
import '../design/components.dart';
import '../design/tokens.dart';
import '../meetings/when.dart';
import 'group_chat_tab.dart';
import 'group_join.dart';
import 'group_meetings_api.dart';
import 'group_meetings_tab.dart';
import 'group_members_tab.dart';
import 'group_models.dart';
import 'group_reports_tab.dart';
import 'group_settings_tab.dart';
import 'groups_api.dart';
import 'groups_screen.dart' show GroupIcon, RolePill;
import 'meeting_report_screen.dart';

/// The tabs a group page can have. Which ones show depends on what the
/// person may do there, as on the web.
enum GroupTab {
  chat('Chat'),
  meetings('Meetings'),
  members('Members'),
  reports('Reports'),
  activity('Activity'),
  settings('Settings');

  const GroupTab(this.label);
  final String label;
}

/// Tells pages when they are on top again. Registered on the app's
/// navigator (main.dart).
final appRouteObserver = RouteObserver<ModalRoute<void>>();

/// One group: who is in it, what it is doing next, and — for those who may
/// — its settings. Mirrors the web's `/dashboard/groups/<id>`.
class GroupScreen extends ConsumerStatefulWidget {
  const GroupScreen({super.key, required this.groupId, required this.title});

  final String groupId;

  /// Shown while the group loads.
  final String title;

  @override
  ConsumerState<GroupScreen> createState() => _GroupScreenState();
}

class _GroupScreenState extends ConsumerState<GroupScreen> with RouteAware {
  String get groupId => widget.groupId;

  /// The page's own scroll: the header, then the pinned tabs.
  final _outer = ScrollController();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route != null) appRouteObserver.subscribe(this, route);
  }

  @override
  void dispose() {
    appRouteObserver.unsubscribe(this);
    _outer.dispose();
    super.dispose();
  }

  /// Back from a meeting (or anything else pushed over this page): what
  /// was live may have ended, and a past meeting been added. Reported from
  /// a phone that ended a meeting and came back to it still "Live now".
  @override
  void didPopNext() => refreshGroup(ref, groupId);

  void _openReport(GroupDetail d, String eventId) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => MeetingReportScreen(groupId: d.group.id, eventId: eventId, canExport: d.capabilities.exportReports),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final title = widget.title;
    final detail = ref.watch(groupDetailProvider(groupId));
    final d = detail.valueOrNull;

    if (d == null) {
      return Scaffold(
        backgroundColor: p.bg,
        appBar: AppBar(title: Text(title)),
        body: detail.hasError
            ? Padding(
                padding: const EdgeInsets.all(NeoSpace.xl),
                child: NeoBanner(
                  icon: Icons.cloud_off_rounded,
                  tone: NeoBannerTone.warning,
                  message: groupLoadText(detail.error!),
                  action: () => ref.invalidate(groupDetailProvider(groupId)),
                  actionLabel: 'Retry',
                ),
              )
            : const Center(child: CircularProgressIndicator()),
      );
    }

    final tabs = [
      GroupTab.chat,
      GroupTab.meetings,
      GroupTab.members,
      if (d.capabilities.viewReports) GroupTab.reports,
      GroupTab.activity,
      if (d.capabilities.anySettings) GroupTab.settings,
    ];
    // Members land in the chat, as on the web; whoever runs the group
    // lands on its meetings.
    final first = d.myRole == GroupRole.participant ? GroupTab.chat : GroupTab.meetings;
    final unread = ref
            .watch(groupsProvider)
            .valueOrNull
            ?.where((g) => g.group.id == groupId)
            .firstOrNull
            ?.unread ??
        0;

    return DefaultTabController(
      // A new set of tabs (a role changed) starts a new controller.
      key: ValueKey(tabs.map((t) => t.name).join(',')),
      length: tabs.length,
      initialIndex: tabs.indexOf(first),
      child: _HeaderFolder(
        outer: _outer,
        tabs: tabs,
        child: Scaffold(
        backgroundColor: p.bg,
        appBar: AppBar(
          title: Text(d.group.name, maxLines: 1, overflow: TextOverflow.ellipsis),
        ),
        body: RefreshIndicator(
          onRefresh: () async {
            refreshGroup(ref, groupId);
            await ref.read(groupDetailProvider(groupId).future).then((_) {}, onError: (_) {});
          },
          // Pulled down from the top of whichever tab is showing. That tab's
          // list is two scrollables down — the page's own scroll (0), the
          // tab pager (1), the list (2) — and it is the list's pull that
          // counts. With depth 1 (the pager, which only scrolls sideways)
          // the pull never fired; listening at 0 as well let the page's
          // own start and end of scrolling cut each pull short.
          notificationPredicate: (n) => n.depth == 2 && n.metrics.axis == Axis.vertical,
          // The group's header first, then its tabs, which stay pinned
          // under the app bar once the header has scrolled away.
          child: NestedScrollView(
            controller: _outer,
            headerSliverBuilder: (context, _) => [
              SliverToBoxAdapter(child: GroupHeader(detail: d)),
              SliverPersistentHeader(
                pinned: true,
                delegate: _PinnedTabs(
                  color: p.bg,
                  divider: p.border,
                  bar: TabBar(
                    isScrollable: tabs.length > 3,
                    tabAlignment: tabs.length > 3 ? TabAlignment.start : null,
                    tabs: [
                      for (final t in tabs)
                        t == GroupTab.chat && unread > 0
                            ? Tab(
                                child: Badge(
                                  label: Text(unread > 99 ? '99+' : '$unread'),
                                  offset: const Offset(14, -6),
                                  child: Text(t.label),
                                ),
                              )
                            : Tab(text: t.label),
                    ],
                  ),
                ),
              ),
            ],
            body: TabBarView(
              children: [
                for (final t in tabs)
                  switch (t) {
                    GroupTab.chat => GroupChatTab(detail: d, onOpenReport: d.capabilities.viewReports ? (eid) => _openReport(d, eid) : null),
                    GroupTab.meetings => GroupMeetingsTab(detail: d, onOpenReport: (m) => _openReport(d, m.id)),
                    GroupTab.members => GroupMembersTab(detail: d),
                    GroupTab.reports => GroupReportsTab(detail: d),
                    GroupTab.activity => GroupActivityTab(activity: d.activity),
                    GroupTab.settings => GroupSettingsTab(detail: d),
                  },
              ],
            ),
          ),
        ),
      ),
      ),
    );
  }
}

/// Folds the group's header away whenever the Chat tab is showing, so the
/// conversation and the keyboard get the screen; the other tabs leave it
/// where it is (scrolling them brings it back).
class _HeaderFolder extends StatefulWidget {
  const _HeaderFolder({required this.outer, required this.tabs, required this.child});

  final ScrollController outer;
  final List<GroupTab> tabs;
  final Widget child;

  @override
  State<_HeaderFolder> createState() => _HeaderFolderState();
}

class _HeaderFolderState extends State<_HeaderFolder> {
  TabController? _tabs;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final tabs = DefaultTabController.of(context);
    if (tabs == _tabs) return;
    _tabs?.removeListener(_follow);
    _tabs = tabs..addListener(_follow);
    WidgetsBinding.instance.addPostFrameCallback((_) => _follow());
  }

  @override
  void dispose() {
    _tabs?.removeListener(_follow);
    super.dispose();
  }

  void _follow() {
    final tabs = _tabs;
    if (tabs == null || !mounted || widget.tabs[tabs.index] != GroupTab.chat) return;
    final outer = widget.outer;
    if (!outer.hasClients) return;
    unawaited(outer.animateTo(outer.position.maxScrollExtent, duration: NeoMotion.base, curve: NeoMotion.curve));
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// Loads everything on a group's page again: the group, its live and
/// coming meetings, and (through [groupRevisionProvider]) its past ones.
void refreshGroup(WidgetRef ref, String groupId) {
  ref.invalidate(groupDetailProvider(groupId));
  ref.invalidate(upcomingMeetingsProvider(groupId));
  ref.read(groupRevisionProvider(groupId).notifier).state++;
}

class _PinnedTabs extends SliverPersistentHeaderDelegate {
  _PinnedTabs({required this.bar, required this.color, required this.divider});

  final TabBar bar;
  final Color color;
  final Color divider;

  @override
  double get minExtent => bar.preferredSize.height + 1;

  @override
  double get maxExtent => bar.preferredSize.height + 1;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) => Container(
        decoration: BoxDecoration(color: color, border: Border(bottom: BorderSide(color: divider))),
        child: bar,
      );

  @override
  bool shouldRebuild(_PinnedTabs old) => old.bar != bar || old.color != color || old.divider != divider;
}

/// Icon, name, role and description, then the meeting that is live or next.
class GroupHeader extends StatelessWidget {
  const GroupHeader({super.key, required this.detail});

  final GroupDetail detail;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final g = detail.group;
    final count = detail.members.length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(NeoSpace.xl, NeoSpace.lg, NeoSpace.xl, NeoSpace.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              GroupIcon(name: g.name, url: g.iconUrl, size: 52),
              const SizedBox(width: NeoSpace.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('$count ${count == 1 ? 'member' : 'members'}', style: TextStyle(color: p.textMuted)),
                    const SizedBox(height: NeoSpace.xs),
                    RolePill(role: detail.myRole),
                  ],
                ),
              ),
            ],
          ),
          if (g.description.isNotEmpty) ...[
            const SizedBox(height: NeoSpace.md),
            Text(g.description, style: TextStyle(color: p.text)),
          ],
          if (detail.nextMeeting != null) ...[
            const SizedBox(height: NeoSpace.md),
            NextMeetingCard(meeting: detail.nextMeeting!),
          ],
        ],
      ),
    );
  }
}

/// "Live now" or "Up next", with Join from 15 minutes before.
class NextMeetingCard extends StatelessWidget {
  const NextMeetingCard({super.key, required this.meeting});

  final NextMeeting meeting;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    final now = DateTime.now();
    final live = meeting.isLive;
    final when = meeting.start == null ? '' : neoWhen(meeting.start!, now: now);
    return NeoCard(
      highlighted: live,
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                live
                    ? NeoPill('Live now', color: p.success, dot: true)
                    : Text('Up next · $when', style: TextStyle(color: p.textMuted, fontSize: 13)),
                const SizedBox(height: NeoSpace.xs),
                Text(meeting.title, style: Theme.of(context).textTheme.titleSmall, maxLines: 2, overflow: TextOverflow.ellipsis),
              ],
            ),
          ),
          if (meeting.joinableAt(now))
            FilledButton(
              onPressed: () => joinGroupMeeting(context, slug: meeting.slug, title: meeting.title),
              child: const Text('Join'),
            ),
        ],
      ),
    );
  }
}

/// The group's recent activity, newest first, in the server's own words.
class GroupActivityTab extends StatelessWidget {
  const GroupActivityTab({super.key, required this.activity});

  final List<GroupActivity> activity;

  @override
  Widget build(BuildContext context) {
    final p = NeoTheme.of(context);
    if (activity.isEmpty) {
      return ListView(children: const [
        NeoEmptyState(icon: Icons.history_rounded, title: 'Nothing yet', message: 'What happens in the group shows here.'),
      ]);
    }
    final now = DateTime.now();
    return ListView.separated(
      padding: const EdgeInsets.all(NeoSpace.xl),
      itemCount: activity.length,
      separatorBuilder: (_, _) => Divider(color: p.border, height: NeoSpace.lg),
      itemBuilder: (context, i) {
        final a = activity[i];
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: Text(a.detail, style: TextStyle(color: p.text))),
            const SizedBox(width: NeoSpace.sm),
            if (a.at != null) Text(neoWhen(a.at!, now: now), style: TextStyle(color: p.textFaint, fontSize: 12)),
          ],
        );
      },
    );
  }
}
