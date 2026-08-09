import 'dart:convert';

import 'package:flutter/material.dart';

import 'package:mbs_mobile_flutter/core/db/local_database.dart';
import 'package:mbs_mobile_flutter/core/sync/sync_engine.dart';

class DispatchDayScreen extends StatelessWidget {
  const DispatchDayScreen({
    super.key,
    required this.database,
    required this.syncEngine,
  });

  final LocalDatabase database;
  final SyncEngine syncEngine;

  @override
  Widget build(BuildContext context) {
    final query = (database.select(database.dispatchBlocksCache)
      ..orderBy([(tbl) => OrderingTerm.asc(tbl.blockCode)]));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Dispatch Day'),
        actions: [
          IconButton(
            onPressed: () => syncEngine.syncNow(),
            icon: const Icon(Icons.sync),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: syncEngine.syncNow,
        child: StreamBuilder<List<DispatchBlocksCacheData>>(
          stream: query.watch(),
          builder: (context, snapshot) {
            final blocks = snapshot.data ?? const <DispatchBlocksCacheData>[];
            if (blocks.isEmpty) {
              return ListView(
                children: const [
                  SizedBox(height: 180),
                  Center(child: Text('No dispatch blocks cached yet. Pull to sync.')),
                ],
              );
            }

            return ListView.builder(
              itemCount: blocks.length,
              itemBuilder: (context, index) {
                final row = blocks[index];
                final payload = (jsonDecode(row.payloadJson) as Map).cast<String, dynamic>();
                return Card(
                  margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${payload['code']} (${payload['startTime']} - ${payload['endTime']})',
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                        const SizedBox(height: 10),
                        _CapacityRow(payload: payload),
                        const SizedBox(height: 10),
                        _AppointmentsSection(
                          title: 'INSTALL',
                          rows: (payload['install'] is Map)
                              ? ((((payload['install'] as Map)['appointments'] as List?) ?? [])
                                  .whereType<Map>()
                                  .map((e) => e.cast<String, dynamic>())
                                  .toList())
                              : const <Map<String, dynamic>>[],
                          onAssign: (appointmentId, techId) async {
                            await syncEngine.enqueueToolAction(
                              toolName: 'scheduling.appointment.assignTech',
                              payload: {
                                'appointmentId': appointmentId,
                                'techUserId': techId,
                              },
                              reason: 'Dispatch assign tech from mobile day view',
                            );
                            await syncEngine.syncNow();
                          },
                          onReschedule: (appointmentId, date, blockCode) async {
                            await syncEngine.enqueueToolAction(
                              toolName: 'scheduling.appointment.reschedule',
                              payload: {
                                'appointmentId': appointmentId,
                                'date': date,
                                'timeBlockCode': blockCode,
                              },
                              reason: 'Dispatch reschedule from mobile day view',
                            );
                            await syncEngine.syncNow();
                          },
                          onCancel: (appointmentId, reason) async {
                            await syncEngine.enqueueToolAction(
                              toolName: 'scheduling.appointment.cancel',
                              payload: {
                                'appointmentId': appointmentId,
                                'reason': reason,
                              },
                              reason: 'Dispatch cancel from mobile day view',
                            );
                            await syncEngine.syncNow();
                          },
                        ),
                        const SizedBox(height: 10),
                        _AppointmentsSection(
                          title: 'SERVICE/ESTIMATE',
                          rows: (payload['serviceEstimate'] is Map)
                              ? ((((payload['serviceEstimate'] as Map)['appointments'] as List?) ?? [])
                                  .whereType<Map>()
                                  .map((e) => e.cast<String, dynamic>())
                                  .toList())
                              : const <Map<String, dynamic>>[],
                          onAssign: (appointmentId, techId) async {
                            await syncEngine.enqueueToolAction(
                              toolName: 'scheduling.appointment.assignTech',
                              payload: {
                                'appointmentId': appointmentId,
                                'techUserId': techId,
                              },
                              reason: 'Dispatch assign tech from mobile day view',
                            );
                            await syncEngine.syncNow();
                          },
                          onReschedule: (appointmentId, date, blockCode) async {
                            await syncEngine.enqueueToolAction(
                              toolName: 'scheduling.appointment.reschedule',
                              payload: {
                                'appointmentId': appointmentId,
                                'date': date,
                                'timeBlockCode': blockCode,
                              },
                              reason: 'Dispatch reschedule from mobile day view',
                            );
                            await syncEngine.syncNow();
                          },
                          onCancel: (appointmentId, reason) async {
                            await syncEngine.enqueueToolAction(
                              toolName: 'scheduling.appointment.cancel',
                              payload: {
                                'appointmentId': appointmentId,
                                'reason': reason,
                              },
                              reason: 'Dispatch cancel from mobile day view',
                            );
                            await syncEngine.syncNow();
                          },
                        ),
                      ],
                    ),
                  ),
                );
              },
            );
          },
        ),
      ),
    );
  }
}

class _CapacityRow extends StatelessWidget {
  const _CapacityRow({required this.payload});

  final Map<String, dynamic> payload;

  @override
  Widget build(BuildContext context) {
    final install = (payload['install'] as Map?)?.cast<String, dynamic>() ?? {};
    final service =
        (payload['serviceEstimate'] as Map?)?.cast<String, dynamic>() ?? {};
    return Row(
      children: [
        Expanded(
          child: _CapacityCard(
            title: 'INSTALL',
            reserved: (install['reservedCount'] ?? 0).toString(),
            capacity: (install['capacity'] ?? 0).toString(),
            remaining: (install['remaining'] ?? 0).toString(),
          ),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: _CapacityCard(
            title: 'SERVICE',
            reserved: (service['reservedCount'] ?? 0).toString(),
            capacity: (service['capacity'] ?? 0).toString(),
            remaining: (service['remaining'] ?? 0).toString(),
          ),
        ),
      ],
    );
  }
}

class _CapacityCard extends StatelessWidget {
  const _CapacityCard({
    required this.title,
    required this.reserved,
    required this.capacity,
    required this.remaining,
  });

  final String title;
  final String reserved;
  final String capacity;
  final String remaining;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
      ),
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.labelLarge),
          const SizedBox(height: 4),
          Text('$reserved / $capacity booked'),
          Text('$remaining remaining'),
        ],
      ),
    );
  }
}

class _AppointmentsSection extends StatelessWidget {
  const _AppointmentsSection({
    required this.title,
    required this.rows,
    required this.onAssign,
    required this.onReschedule,
    required this.onCancel,
  });

  final String title;
  final List<Map<String, dynamic>> rows;
  final Future<void> Function(String appointmentId, String techUserId) onAssign;
  final Future<void> Function(String appointmentId, String date, String blockCode)
      onReschedule;
  final Future<void> Function(String appointmentId, String reason) onCancel;

  Future<String?> _prompt(BuildContext context, String label) async {
    final controller = TextEditingController();
    final value = await showDialog<String>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: Text(label),
          content: TextField(controller: controller),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(null),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(controller.text.trim()),
              child: const Text('Save'),
            ),
          ],
        );
      },
    );
    return value;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 6),
        if (rows.isEmpty)
          const Text('No bookings')
        else
          ...rows.map((row) {
            final appointmentId = (row['id'] ?? '').toString();
            final customer =
                (row['customer'] as Map?)?.cast<String, dynamic>() ?? {};
            final address = [
              customer['addressLine1'],
              customer['city'],
              customer['state'],
            ].whereType<String>().where((v) => v.trim().isNotEmpty).join(', ');
            return Card(
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(customer['fullName']?.toString() ?? 'Customer'),
                    Text(address.isEmpty ? 'No address' : address),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 4,
                      children: [
                        OutlinedButton(
                          onPressed: () async {
                            final techUserId =
                                await _prompt(context, 'Assign Tech User ID');
                            if (techUserId == null || techUserId.isEmpty) return;
                            await onAssign(appointmentId, techUserId);
                          },
                          child: const Text('Assign'),
                        ),
                        OutlinedButton(
                          onPressed: () async {
                            final date = await _prompt(context, 'Reschedule Date (YYYY-MM-DD)');
                            if (date == null || date.isEmpty) return;
                            final block = await _prompt(context, 'Time Block Code');
                            if (block == null || block.isEmpty) return;
                            await onReschedule(appointmentId, date, block);
                          },
                          child: const Text('Reschedule'),
                        ),
                        OutlinedButton(
                          onPressed: () async {
                            final reason = await _prompt(context, 'Cancel Reason');
                            if (reason == null || reason.isEmpty) return;
                            await onCancel(appointmentId, reason);
                          },
                          child: const Text('Cancel'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            );
          }),
      ],
    );
  }
}
