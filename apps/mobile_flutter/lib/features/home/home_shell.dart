import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'package:mbs_mobile_flutter/core/auth/auth_controller.dart';
import 'package:mbs_mobile_flutter/core/db/local_database.dart';
import 'package:mbs_mobile_flutter/core/rbac/rbac.dart';
import 'package:mbs_mobile_flutter/core/sync/sync_engine.dart';
import 'package:mbs_mobile_flutter/features/dispatch/dispatch_screen.dart';
import 'package:mbs_mobile_flutter/features/tech/today_screen.dart';
import 'package:mbs_mobile_flutter/features/timeclock/time_clock_screen.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({
    super.key,
    required this.session,
    required this.database,
    required this.syncEngine,
    required this.authController,
  });

  final AuthSession session;
  final LocalDatabase database;
  final SyncEngine syncEngine;
  final AuthController authController;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  Future<void> _showSyncDetails() async {
    final failed = await widget.syncEngine.listFailedActions();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      builder: (context) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Sync Queue Failures',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                if (failed.isEmpty)
                  const Text('No failed queued actions.')
                else
                  SizedBox(
                    height: 260,
                    child: ListView.builder(
                      itemCount: failed.length,
                      itemBuilder: (context, index) {
                        final row = failed[index];
                        return ListTile(
                          title: Text(row.toolName),
                          subtitle: Text(row.error ?? 'Unknown error'),
                        );
                      },
                    ),
                  ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    FilledButton(
                      onPressed: failed.isEmpty
                          ? null
                          : () async {
                              await widget.syncEngine.retryFailedActions();
                              await widget.syncEngine.syncNow();
                              if (mounted) Navigator.of(context).pop();
                            },
                      child: const Text('Retry Failed'),
                    ),
                    const SizedBox(width: 8),
                    TextButton(
                      onPressed: () => Navigator.of(context).pop(),
                      child: const Text('Close'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _showAdminPinReset() async {
    final userIdController = TextEditingController();
    final pinController = TextEditingController();
    final reasonController = TextEditingController(text: 'Field pilot PIN reset');

    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('Admin PIN Reset'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: userIdController,
                  decoration: const InputDecoration(labelText: 'Target User ID'),
                ),
                TextField(
                  controller: pinController,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: 'Temporary PIN (optional 4-6 digits)',
                  ),
                ),
                TextField(
                  controller: reasonController,
                  decoration: const InputDecoration(labelText: 'Reason'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () async {
                final userId = userIdController.text.trim();
                if (userId.isEmpty) return;
                final response = await widget.authController.adminResetUserPin(
                  userId: userId,
                  temporaryPin: pinController.text.trim().isEmpty
                      ? null
                      : pinController.text.trim(),
                  reason: reasonController.text.trim().isEmpty
                      ? null
                      : reasonController.text.trim(),
                );
                if (!mounted) return;
                Navigator.of(context).pop();
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(
                      'PIN reset response: ${(response['status'] ?? 'UNKNOWN').toString()}',
                    ),
                  ),
                );
              },
              child: const Text('Reset PIN'),
            ),
          ],
        );
      },
    );
  }

  String _syncLabel(SyncStatusSnapshot snapshot) {
    switch (snapshot.phase) {
      case SyncPhase.offline:
        return 'OFFLINE';
      case SyncPhase.syncing:
        return 'SYNCING';
      case SyncPhase.ok:
        final time = snapshot.lastSyncAt;
        if (time == null) return 'SYNC OK';
        final hh = time.hour.toString().padLeft(2, '0');
        final mm = time.minute.toString().padLeft(2, '0');
        return 'SYNC OK $hh:$mm';
      case SyncPhase.error:
        return 'SYNC ERROR';
    }
  }

  Color _syncColor(BuildContext context, SyncStatusSnapshot snapshot) {
    switch (snapshot.phase) {
      case SyncPhase.offline:
        return Theme.of(context).colorScheme.errorContainer;
      case SyncPhase.syncing:
        return Theme.of(context).colorScheme.secondaryContainer;
      case SyncPhase.ok:
        return Theme.of(context).colorScheme.tertiaryContainer;
      case SyncPhase.error:
        return Theme.of(context).colorScheme.errorContainer;
    }
  }

  @override
  Widget build(BuildContext context) {
    final dispatchVisible = canAccessDispatch(widget.session);
    final pages = <Widget>[
      TechTodayScreen(
        database: widget.database,
        syncEngine: widget.syncEngine,
        onOpenJob: (jobId) => context.push('/job/$jobId'),
        onOpenTimeClock: () => context.push('/timeclock'),
      ),
      TimeClockScreen(
        database: widget.database,
        syncEngine: widget.syncEngine,
      ),
      if (dispatchVisible)
        DispatchDayScreen(
          database: widget.database,
          syncEngine: widget.syncEngine,
        ),
    ];

    final destinations = <NavigationDestination>[
      const NavigationDestination(
        icon: Icon(Icons.engineering_outlined),
        selectedIcon: Icon(Icons.engineering),
        label: 'Tech',
      ),
      const NavigationDestination(
        icon: Icon(Icons.timer_outlined),
        selectedIcon: Icon(Icons.timer),
        label: 'Time',
      ),
      if (dispatchVisible)
        const NavigationDestination(
          icon: Icon(Icons.view_day_outlined),
          selectedIcon: Icon(Icons.view_day),
          label: 'Dispatch',
        ),
    ];

    if (_index >= pages.length) {
      _index = 0;
    }

    return Scaffold(
      body: Column(
        children: [
          SafeArea(
            bottom: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
              child: ValueListenableBuilder<SyncStatusSnapshot>(
                valueListenable: widget.syncEngine.status,
                builder: (context, snapshot, _) {
                  final canManagePins = widget.session.hasPermission('auth:mobile:pin:reset') ||
                      widget.session.hasPermission('*');
                  return Row(
                    children: [
                      InkWell(
                        onTap: _showSyncDetails,
                        borderRadius: BorderRadius.circular(999),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                          decoration: BoxDecoration(
                            color: _syncColor(context, snapshot),
                            borderRadius: BorderRadius.circular(999),
                          ),
                          child: Text(
                            _syncLabel(snapshot),
                            style: Theme.of(context).textTheme.labelLarge,
                          ),
                        ),
                      ),
                      const Spacer(),
                      if (canManagePins)
                        TextButton.icon(
                          onPressed: _showAdminPinReset,
                          icon: const Icon(Icons.lock_reset),
                          label: const Text('PIN Reset'),
                        ),
                    ],
                  );
                },
              ),
            ),
          ),
          Expanded(
            child: IndexedStack(
              index: _index,
              children: pages,
            ),
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        destinations: destinations,
        onDestinationSelected: (next) {
          setState(() {
            _index = next;
          });
        },
      ),
    );
  }
}
