import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:mbs_mobile_flutter/core/api/mobile_api_client.dart';
import 'package:mbs_mobile_flutter/core/auth/auth_controller.dart';
import 'package:mbs_mobile_flutter/core/db/local_database.dart';
import 'package:mbs_mobile_flutter/core/models/mobile_sync_models.dart';
import 'package:mbs_mobile_flutter/core/sync/sync_engine.dart';

class FakeMobileApiClient extends MobileApiClient {
  int syncPushCalls = 0;
  int uploadPhotoCalls = 0;
  final Set<String> completedUploadSessionKeys = <String>{};

  @override
  Future<List<MobileSyncPushResult>> syncPush({
    required String deviceId,
    required List<MobileSyncPushAction> actions,
  }) async {
    syncPushCalls += 1;
    return actions
        .map(
          (action) => MobileSyncPushResult(
            clientActionId: action.clientActionId,
            status: 'APPLIED',
            output: const {'status': 'EXECUTED'},
          ),
        )
        .toList();
  }

  @override
  Future<MobileSyncPullResponse> syncPull({
    required String deviceId,
    String? auditCursor,
    String? outboxCursor,
  }) async {
    return MobileSyncPullResponse.fromJson({
      'newCursors': {
        'auditCursor': DateTime.now().toUtc().toIso8601String(),
        'outboxCursor': DateTime.now().toUtc().toIso8601String(),
      },
      'events': {
        'audit': [],
        'outbox': [],
      },
      'readModels': {
        'todaySchedule': {
          'date': '2026-02-22',
          'appointments': [],
          'timeEntries': [],
        },
      },
    });
  }

  @override
  Future<Map<String, dynamic>> uploadPhoto({
    required File file,
    required String ownerType,
    required String ownerId,
    required String tag,
    required String sessionKey,
    String? caption,
  }) async {
    uploadPhotoCalls += 1;
    return {
      'status': 'EXECUTED',
      'sessionKey': sessionKey,
    };
  }

  @override
  Future<Map<String, dynamic>?> getUploadSessionStatus({
    required String sessionKey,
  }) async {
    if (completedUploadSessionKeys.contains(sessionKey)) {
      return {
        'session': {
          'sessionKey': sessionKey,
          'status': 'COMPLETED',
        },
      };
    }
    return null;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('sync engine confirms queued actions and advances status', () async {
    final db = LocalDatabase();
    final api = FakeMobileApiClient();
    final auth = AuthController(api);

    auth.session.value = AuthSession(
      apiBaseUrl: 'http://localhost:3001',
      orgSlug: 'russell-comfort',
      actorUserId: 'user-1',
      deviceId: 'ios-user-1',
      accessToken: 'token',
      roles: const ['tech'],
      permissions: const ['mobile:sync'],
    );

    final engine = SyncEngine(
      database: db,
      apiClient: api,
      authController: auth,
    );

    await db.enqueueAction(
      toolName: 'time.clockIn',
      payload: jsonDecode('{}') as Map<String, dynamic>,
      reason: 'test queue',
    );

    await engine.syncNow();

    final pending = await db.listPendingActions();
    expect(pending, isEmpty);
    expect(engine.status.value.phase, SyncPhase.ok);

    await db.close();
  });

  test('retry backoff defers failed actions until delay window', () async {
    final db = LocalDatabase();
    final api = FakeMobileApiClient();
    final auth = AuthController(api);

    auth.session.value = AuthSession(
      apiBaseUrl: 'http://localhost:3001',
      orgSlug: 'russell-comfort',
      actorUserId: 'user-1',
      deviceId: 'ios-user-1',
      accessToken: 'token',
      roles: const ['tech'],
      permissions: const ['mobile:sync'],
    );

    final engine = SyncEngine(
      database: db,
      apiClient: api,
      authController: auth,
    );

    final queued = await db.enqueueAction(
      toolName: 'time.clockIn',
      payload: jsonDecode('{}') as Map<String, dynamic>,
      reason: 'retry-backoff-test',
    );

    await db.markActionStatus(
      clientActionId: queued.clientActionId,
      status: 'FAILED',
      error: 'Network timeout',
      incrementRetry: true,
    );

    await engine.syncNow();
    expect(api.syncPushCalls, 0);

    final failedRows = await db.listFailedActions();
    expect(failedRows, hasLength(1));
    expect(shouldAttemptQueuedAction(failedRows.first, now: DateTime.now()), isFalse);

    await db.close();
  });

  test('non-recoverable failures are not retried automatically', () {
    expect(isNonRecoverableQueueError('NON_RECOVERABLE: file missing'), isTrue);
    expect(isNonRecoverableQueueError('network timeout'), isFalse);
  });

  test('photo upload action is confirmed without re-upload when session already completed', () async {
    final db = LocalDatabase();
    final api = FakeMobileApiClient();
    final auth = AuthController(api);

    auth.session.value = AuthSession(
      apiBaseUrl: 'http://localhost:3001',
      orgSlug: 'russell-comfort',
      actorUserId: 'user-1',
      deviceId: 'ios-user-1',
      accessToken: 'token',
      roles: const ['tech'],
      permissions: const ['mobile:sync'],
    );

    const actionId = 'photo-session-completed-001';
    api.completedUploadSessionKeys.add(actionId);

    await db.enqueueAction(
      clientActionId: actionId,
      toolName: 'mobile.media.uploadPhoto',
      payload: const {
        'localPath': '/tmp/does-not-exist.jpg',
        'ownerType': 'JOB',
        'ownerId': 'job-1',
        'tag': 'PROBLEM',
      },
      localFilePath: '/tmp/does-not-exist.jpg',
      reason: 'photo-replay-test',
    );

    final engine = SyncEngine(
      database: db,
      apiClient: api,
      authController: auth,
    );

    await engine.syncNow();

    expect(api.uploadPhotoCalls, 0);
    final pending = await db.listPendingActions();
    expect(pending, isEmpty);

    await db.close();
  });

  test('retry backoff grows exponentially and caps', () {
    expect(computeRetryBackoffSeconds(0), 5);
    expect(computeRetryBackoffSeconds(1), 10);
    expect(computeRetryBackoffSeconds(4), 80);
    expect(computeRetryBackoffSeconds(9), 600);
  });
}
