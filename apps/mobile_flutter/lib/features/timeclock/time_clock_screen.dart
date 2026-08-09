import 'dart:convert';

import 'package:flutter/material.dart';

import 'package:mbs_mobile_flutter/core/db/local_database.dart';
import 'package:mbs_mobile_flutter/core/sync/sync_engine.dart';

class TimeClockScreen extends StatelessWidget {
  const TimeClockScreen({
    super.key,
    required this.database,
    required this.syncEngine,
  });

  final LocalDatabase database;
  final SyncEngine syncEngine;

  Future<void> _requestEdit(
    BuildContext context,
    TimeEntriesCacheData entry,
  ) async {
    final startedController = TextEditingController(text: entry.startedAt ?? '');
    final endedController = TextEditingController(text: entry.endedAt ?? '');
    final notesController = TextEditingController();
    final reasonController = TextEditingController();

    final submitted = await showDialog<bool>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('Request Time Edit'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: startedController,
                  decoration: const InputDecoration(
                    labelText: 'Started At (ISO)',
                  ),
                ),
                TextField(
                  controller: endedController,
                  decoration: const InputDecoration(
                    labelText: 'Ended At (ISO)',
                  ),
                ),
                TextField(
                  controller: notesController,
                  decoration: const InputDecoration(labelText: 'Notes (optional)'),
                ),
                TextField(
                  controller: reasonController,
                  decoration: const InputDecoration(labelText: 'Reason (required)'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Submit'),
            ),
          ],
        );
      },
    );

    if (submitted != true) {
      return;
    }
    final reason = reasonController.text.trim();
    if (reason.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Reason is required for time edit request')),
      );
      return;
    }

    await syncEngine.enqueueToolAction(
      toolName: 'time.edit.request',
      payload: {
        'timeEntryId': entry.id,
        'requestedChanges': {
          'startedAt': startedController.text.trim(),
          'endedAt': endedController.text.trim().isEmpty
              ? null
              : endedController.text.trim(),
          if (notesController.text.trim().isNotEmpty)
            'notes': notesController.text.trim(),
        },
        'reason': reason,
      },
      reason: 'Mobile time edit request',
    );
    await syncEngine.syncNow();
  }

  @override
  Widget build(BuildContext context) {
    final entriesQuery = (database.select(database.timeEntriesCache)
      ..orderBy([(tbl) => OrderingTerm.desc(tbl.startedAt)]));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Time Clock'),
        actions: [
          IconButton(
            onPressed: () => syncEngine.syncNow(),
            icon: const Icon(Icons.sync),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton(
                  onPressed: () async {
                    await syncEngine.enqueueToolAction(
                      toolName: 'time.clockIn',
                      payload: {},
                      reason: 'Mobile clock in',
                    );
                    await syncEngine.syncNow();
                  },
                  child: const Text('Clock In'),
                ),
                FilledButton.tonal(
                  onPressed: () async {
                    await syncEngine.enqueueToolAction(
                      toolName: 'time.clockOut',
                      payload: {},
                      reason: 'Mobile clock out',
                    );
                    await syncEngine.syncNow();
                  },
                  child: const Text('Clock Out'),
                ),
                OutlinedButton(
                  onPressed: () async {
                    await syncEngine.enqueueToolAction(
                      toolName: 'time.breakStart',
                      payload: {},
                      reason: 'Mobile break start',
                    );
                    await syncEngine.syncNow();
                  },
                  child: const Text('Break Start'),
                ),
                OutlinedButton(
                  onPressed: () async {
                    await syncEngine.enqueueToolAction(
                      toolName: 'time.breakEnd',
                      payload: {},
                      reason: 'Mobile break end',
                    );
                    await syncEngine.syncNow();
                  },
                  child: const Text('Break End'),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: StreamBuilder<List<TimeEntriesCacheData>>(
              stream: entriesQuery.watch(),
              builder: (context, snapshot) {
                final rows = snapshot.data ?? const <TimeEntriesCacheData>[];
                if (rows.isEmpty) {
                  return const Center(child: Text('No entries synced yet.'));
                }
                return ListView.separated(
                  itemCount: rows.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, index) {
                    final row = rows[index];
                    final payload = (jsonDecode(row.payloadJson) as Map)
                        .cast<String, dynamic>();
                    return ListTile(
                      title: Text('${row.type ?? 'ENTRY'} • ${row.status ?? ''}'),
                      subtitle: Text(
                        '${row.startedAt ?? '-'}\n${row.endedAt ?? 'OPEN'}',
                      ),
                      isThreeLine: true,
                      trailing: IconButton(
                        icon: const Icon(Icons.edit_note),
                        onPressed: () => _requestEdit(context, row),
                      ),
                      onTap: () {
                        showModalBottomSheet<void>(
                          context: context,
                          builder: (context) {
                            return Padding(
                              padding: const EdgeInsets.all(12),
                              child: SingleChildScrollView(
                                child: Text(
                                  const JsonEncoder.withIndent('  ')
                                      .convert(payload),
                                ),
                              ),
                            );
                          },
                        );
                      },
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
