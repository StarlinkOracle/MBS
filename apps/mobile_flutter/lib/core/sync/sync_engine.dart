import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

import 'package:mbs_mobile_flutter/core/api/mobile_api_client.dart';
import 'package:mbs_mobile_flutter/core/auth/auth_controller.dart';
import 'package:mbs_mobile_flutter/core/db/local_database.dart';
import 'package:mbs_mobile_flutter/core/models/mobile_sync_models.dart';
import 'package:mbs_mobile_flutter/core/sync/sync_logic.dart';

class SyncEngine {
  SyncEngine({
    required LocalDatabase database,
    required MobileApiClient apiClient,
    required AuthController authController,
  })  : _database = database,
        _apiClient = apiClient,
        _authController = authController;

  final LocalDatabase _database;
  final MobileApiClient _apiClient;
  final AuthController _authController;
  final Uuid _uuid = const Uuid();
  final ValueNotifier<SyncStatusSnapshot> status =
      ValueNotifier(const SyncStatusSnapshot.offline());

  Timer? _timer;
  bool _running = false;

  String get deviceId {
    return _authController.session.value?.deviceId ?? 'ios-anonymous';
  }

  void start() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 90), (_) {
      unawaited(syncNow());
    });
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> enqueueToolAction({
    required String toolName,
    required Map<String, dynamic> payload,
    String? reason,
  }) async {
    await _database.enqueueAction(
      clientActionId: _uuid.v4(),
      toolName: toolName,
      payload: payload,
      reason: reason,
    );
  }

  Future<void> enqueuePhotoUpload({
    required String localPath,
    required String ownerType,
    required String ownerId,
    required String tag,
    String? caption,
  }) async {
    await _database.enqueueAction(
      clientActionId: _uuid.v4(),
      toolName: 'mobile.media.uploadPhoto',
      payload: {
        'localPath': localPath,
        'ownerType': ownerType,
        'ownerId': ownerId,
        'tag': tag,
        if (caption != null) 'caption': caption,
      },
      reason: 'Mobile queued photo upload',
      localFilePath: localPath,
    );
  }

  Future<void> syncNow() async {
    if (_running) {
      return;
    }
    final session = _authController.session.value;
    if (session == null) {
      status.value = const SyncStatusSnapshot.offline();
      return;
    }

    _running = true;
    status.value = const SyncStatusSnapshot.syncing();
    try {
      await _pushPendingActions();
      await _pullDeltas();
      await _database.clearConfirmedActions();
      status.value = SyncStatusSnapshot.ok(lastSyncAt: DateTime.now());
    } catch (error) {
      final message = error.toString();
      final lower = message.toLowerCase();
      final looksOffline = lower.contains('socketexception') ||
          lower.contains('connection error') ||
          lower.contains('failed host lookup') ||
          lower.contains('timed out');
      status.value = looksOffline
          ? const SyncStatusSnapshot.offline()
          : SyncStatusSnapshot.error(error: message);
    } finally {
      _running = false;
    }
  }

  Future<void> _pushPendingActions() async {
    final allQueued = await _database.listPendingActions();
    final now = DateTime.now();
    final queued = allQueued
        .where((row) => shouldAttemptQueuedAction(row, now: now))
        .toList();
    if (queued.isEmpty) {
      return;
    }

    final photoActions = queued.where((row) => row.toolName == 'mobile.media.uploadPhoto').toList();
    final normalActions = queued.where((row) => row.toolName != 'mobile.media.uploadPhoto').toList();

    for (final action in photoActions) {
      try {
        final existingSession = await _apiClient.getUploadSessionStatus(
          sessionKey: action.clientActionId,
        );
        final session = existingSession?['session'];
        final remoteStatus = session is Map
            ? (session['status'] ?? '').toString().toUpperCase()
            : '';
        if (remoteStatus == 'COMPLETED') {
          await _database.markActionStatus(
            clientActionId: action.clientActionId,
            status: 'CONFIRMED',
          );
          continue;
        }

        final payload = jsonDecode(action.payloadJson) as Map<String, dynamic>;
        final localPath = (payload['localPath'] ?? action.localFilePath ?? '').toString();
        if (localPath.isEmpty || !File(localPath).existsSync()) {
          await _database.markActionStatus(
            clientActionId: action.clientActionId,
            status: 'FAILED',
            error: 'NON_RECOVERABLE: Photo file missing: $localPath',
            incrementRetry: true,
          );
          continue;
        }

        await _apiClient.uploadPhoto(
          file: File(localPath),
          ownerType: (payload['ownerType'] ?? 'JOB').toString(),
          ownerId: (payload['ownerId'] ?? '').toString(),
          tag: (payload['tag'] ?? 'OTHER').toString(),
          sessionKey: action.clientActionId,
          caption: payload['caption']?.toString(),
        );
        await _database.markActionStatus(
          clientActionId: action.clientActionId,
          status: 'CONFIRMED',
        );
      } catch (error) {
        await _database.markActionStatus(
          clientActionId: action.clientActionId,
          status: 'FAILED',
          error: error.toString(),
          incrementRetry: true,
        );
      }
    }

    const chunkSize = 50;
    for (var index = 0; index < normalActions.length; index += chunkSize) {
      final chunk = normalActions.skip(index).take(chunkSize).toList();
      if (chunk.isEmpty) {
        continue;
      }

      final pushActions = chunk.map((row) {
        final payload = jsonDecode(row.payloadJson) as Map<String, dynamic>;
        return MobileSyncPushAction(
          clientActionId: row.clientActionId,
          toolName: row.toolName,
          payload: payload,
          reason: row.reason,
        );
      }).toList();

      try {
        final results = await _apiClient.syncPush(
          deviceId: deviceId,
          actions: pushActions,
        );

        for (final resolution in resolveQueueResults(results)) {
          if (resolution.nextStatus == 'CONFIRMED') {
            await _database.markActionStatus(
              clientActionId: resolution.clientActionId,
              status: 'CONFIRMED',
            );
          } else {
            await _database.markActionStatus(
              clientActionId: resolution.clientActionId,
              status: 'FAILED',
              error: resolution.error,
              incrementRetry: true,
            );
          }
        }
      } catch (error) {
        status.value = SyncStatusSnapshot.error(error: error.toString());
        for (final row in chunk) {
          await _database.markActionStatus(
            clientActionId: row.clientActionId,
            status: 'FAILED',
            error: error.toString(),
            incrementRetry: true,
          );
        }
      }
    }
  }

  Future<void> _pullDeltas() async {
    final state = await _database.getSyncState();
    final response = await _apiClient.syncPull(
      deviceId: deviceId,
      auditCursor: state?.auditCursor,
      outboxCursor: state?.outboxCursor,
    );

    await _database.applyReadModels(response.readModels);
    await _database.upsertSyncState(
      deviceId: deviceId,
      auditCursor: resolveNextCursor(
        previousCursor: state?.auditCursor,
        incomingCursor: response.auditCursor,
      ),
      outboxCursor: resolveNextCursor(
        previousCursor: state?.outboxCursor,
        incomingCursor: response.outboxCursor,
      ),
      lastSyncAt: DateTime.now(),
    );
  }

  Future<List<QueuedAction>> listFailedActions() {
    return _database.listFailedActions();
  }

  Future<void> retryFailedActions() async {
    await _database.retryAllFailedActions();
  }
}

enum SyncPhase {
  offline,
  syncing,
  ok,
  error,
}

class SyncStatusSnapshot {
  const SyncStatusSnapshot({
    required this.phase,
    this.lastSyncAt,
    this.error,
  });

  const SyncStatusSnapshot.offline() : this(phase: SyncPhase.offline);
  const SyncStatusSnapshot.syncing() : this(phase: SyncPhase.syncing);
  const SyncStatusSnapshot.ok({DateTime? lastSyncAt})
      : this(phase: SyncPhase.ok, lastSyncAt: lastSyncAt);
  const SyncStatusSnapshot.error({String? error})
      : this(phase: SyncPhase.error, error: error);

  final SyncPhase phase;
  final DateTime? lastSyncAt;
  final String? error;
}

bool isNonRecoverableQueueError(String? error) {
  final value = error?.trim() ?? '';
  return value.startsWith('NON_RECOVERABLE:');
}

int computeRetryBackoffSeconds(int retryCount) {
  final clampedRetry = retryCount < 0 ? 0 : retryCount;
  final exponent = math.min(clampedRetry, 7);
  final backoff = 5 * (1 << exponent);
  return math.min(backoff, 600);
}

bool shouldAttemptQueuedAction(QueuedAction action, {DateTime? now}) {
  if (action.status == 'PENDING') {
    return true;
  }
  if (action.status != 'FAILED') {
    return false;
  }
  if (isNonRecoverableQueueError(action.error)) {
    return false;
  }

  final referenceNow = now ?? DateTime.now();
  final elapsed = referenceNow.difference(action.updatedAt).inSeconds;
  final requiredDelay = computeRetryBackoffSeconds(action.retryCount);
  return elapsed >= requiredDelay;
}
