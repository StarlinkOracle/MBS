import 'dart:convert';

import 'package:flutter/material.dart';

import 'package:mbs_mobile_flutter/core/db/local_database.dart';
import 'package:mbs_mobile_flutter/core/sync/sync_engine.dart';
import 'package:mbs_mobile_flutter/features/media/photo_upload_service.dart';

class JobDetailScreen extends StatelessWidget {
  const JobDetailScreen({
    super.key,
    required this.jobId,
    required this.database,
    required this.syncEngine,
    required this.photoService,
  });

  final String jobId;
  final LocalDatabase database;
  final SyncEngine syncEngine;
  final PhotoUploadService photoService;

  @override
  Widget build(BuildContext context) {
    final query = database.select(database.jobsCache)
      ..where((tbl) => tbl.id.equals(jobId));

    return Scaffold(
      appBar: AppBar(
        title: const Text('Job Detail'),
        actions: [
          IconButton(
            onPressed: () => syncEngine.syncNow(),
            icon: const Icon(Icons.sync),
          ),
        ],
      ),
      body: StreamBuilder<List<JobsCacheData>>(
        stream: query.watch(),
        builder: (context, snapshot) {
          final row = snapshot.data?.isNotEmpty == true ? snapshot.data!.first : null;
          if (row == null) {
            return const Center(child: Text('Job not cached yet.'));
          }

          final payload = (jsonDecode(row.payloadJson) as Map).cast<String, dynamic>();
          final customer = (payload['customer'] as Map?)?.cast<String, dynamic>() ?? {};
          final quote = (payload['quote'] as Map?)?.cast<String, dynamic>() ?? {};

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(row.title ?? 'Job', style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 6),
              Text('Status: ${row.status ?? 'UNKNOWN'}'),
              const SizedBox(height: 14),
              Text('Customer', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 6),
              Text(customer['fullName']?.toString() ?? 'Unassigned'),
              Text(customer['phone']?.toString() ?? ''),
              Text(
                [
                  customer['addressLine1'],
                  customer['city'],
                  customer['state'],
                  customer['postalCode'],
                ].whereType<String>().where((v) => v.trim().isNotEmpty).join(', '),
              ),
              const SizedBox(height: 14),
              Text('Quote', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 6),
              Text('ID: ${quote['id'] ?? '-'}'),
              Text('Kind: ${quote['kind'] ?? '-'}'),
              Text('Status: ${quote['status'] ?? '-'}'),
              const SizedBox(height: 20),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton.icon(
                    onPressed: () async {
                      await syncEngine.enqueueToolAction(
                        toolName: 'time.jobStart',
                        payload: {'jobId': jobId},
                        reason: 'Start job timer from mobile job detail',
                      );
                      await syncEngine.syncNow();
                    },
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Start Job Timer'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () async {
                      await syncEngine.enqueueToolAction(
                        toolName: 'time.jobStop',
                        payload: {'jobId': jobId},
                        reason: 'Stop job timer from mobile job detail',
                      );
                      await syncEngine.syncNow();
                    },
                    icon: const Icon(Icons.stop),
                    label: const Text('Stop Job Timer'),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              Text('Photos', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton.tonalIcon(
                    onPressed: () async {
                      await photoService.captureForJob(jobId: jobId, tag: 'PROBLEM');
                      await syncEngine.syncNow();
                    },
                    icon: const Icon(Icons.camera_alt),
                    label: const Text('Capture'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () async {
                      await photoService.selectFromLibraryForJob(jobId: jobId, tag: 'OTHER');
                      await syncEngine.syncNow();
                    },
                    icon: const Icon(Icons.photo_library),
                    label: const Text('From Library'),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              Text(
                'Uploads and tool actions are queued offline and replayed when online.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          );
        },
      ),
    );
  }
}
