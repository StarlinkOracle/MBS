import 'dart:convert';

import 'package:flutter/material.dart';

import 'package:mbs_mobile_flutter/core/db/local_database.dart';
import 'package:mbs_mobile_flutter/core/sync/sync_engine.dart';

class TechTodayScreen extends StatelessWidget {
  const TechTodayScreen({
    super.key,
    required this.database,
    required this.syncEngine,
    required this.onOpenJob,
    required this.onOpenTimeClock,
  });

  final LocalDatabase database;
  final SyncEngine syncEngine;
  final ValueChanged<String> onOpenJob;
  final VoidCallback onOpenTimeClock;

  @override
  Widget build(BuildContext context) {
    final appointmentsQuery = (database.select(database.appointmentsCache)
      ..orderBy([(tbl) => OrderingTerm.asc(tbl.timeBlockCode)]));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tech Today'),
        actions: [
          IconButton(
            onPressed: () => syncEngine.syncNow(),
            icon: const Icon(Icons.sync),
          ),
          IconButton(
            onPressed: onOpenTimeClock,
            icon: const Icon(Icons.timer_outlined),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: syncEngine.syncNow,
        child: StreamBuilder<List<AppointmentsCacheData>>(
          stream: appointmentsQuery.watch(),
          builder: (context, snapshot) {
            final rows = snapshot.data ?? const <AppointmentsCacheData>[];
            if (rows.isEmpty) {
              return ListView(
                children: const [
                  SizedBox(height: 160),
                  Center(
                    child: Text('No appointments cached yet.\nPull to sync.'),
                  ),
                ],
              );
            }

            return ListView.separated(
              itemCount: rows.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, index) {
                final row = rows[index];
                final payload =
                    (jsonDecode(row.payloadJson) as Map).cast<String, dynamic>();
                final customer =
                    (payload['customer'] as Map?)?.cast<String, dynamic>() ?? {};
                final job = (payload['job'] as Map?)?.cast<String, dynamic>() ?? {};
                final address = [
                  customer['addressLine1'],
                  customer['city'],
                  customer['state'],
                ].whereType<String>().where((v) => v.trim().isNotEmpty).join(', ');

                return ListTile(
                  title: Text(customer['fullName']?.toString() ?? 'Customer'),
                  subtitle: Text(
                    '${row.timeBlockCode ?? ''} • ${row.type ?? ''}\n${address.isEmpty ? 'No address' : address}',
                  ),
                  isThreeLine: true,
                  trailing: (job['id']?.toString().isNotEmpty ?? false)
                      ? const Icon(Icons.chevron_right)
                      : null,
                  onTap: (job['id']?.toString().isNotEmpty ?? false)
                      ? () => onOpenJob(job['id'].toString())
                      : null,
                );
              },
            );
          },
        ),
      ),
    );
  }
}
