import 'package:flutter_test/flutter_test.dart';

import 'package:mbs_mobile_flutter/core/models/mobile_sync_models.dart';
import 'package:mbs_mobile_flutter/core/sync/sync_logic.dart';

void main() {
  test('resolveQueueResults maps APPLIED to CONFIRMED and FAILED to FAILED', () {
    final results = [
      MobileSyncPushResult(
        clientActionId: 'a1',
        status: 'APPLIED',
      ),
      MobileSyncPushResult(
        clientActionId: 'a2',
        status: 'FAILED',
        error: 'blocked',
      ),
    ];

    final resolved = resolveQueueResults(results);
    expect(resolved[0].clientActionId, 'a1');
    expect(resolved[0].nextStatus, 'CONFIRMED');
    expect(resolved[1].clientActionId, 'a2');
    expect(resolved[1].nextStatus, 'FAILED');
    expect(resolved[1].error, 'blocked');
  });

  test('resolveQueueResults marks non-recoverable failures for queue suppression', () {
    final results = [
      MobileSyncPushResult(
        clientActionId: 'nr1',
        status: 'FAILED',
        errorCode: 'TOOL_NOT_FOUND',
        error: 'Tool not found: mobile.unknown.tool',
        recoverable: false,
      ),
      MobileSyncPushResult(
        clientActionId: 'nr2',
        status: 'FAILED',
        errorCode: 'AUTH_PIN_LOCKED',
        error: 'PIN is locked',
      ),
    ];

    final resolved = resolveQueueResults(results);
    expect(resolved[0].nextStatus, 'FAILED');
    expect(resolved[0].error?.startsWith('NON_RECOVERABLE:'), true);
    expect(resolved[1].nextStatus, 'FAILED');
    expect(resolved[1].error?.startsWith('NON_RECOVERABLE:'), true);
  });

  test('resolveNextCursor keeps latest ISO timestamp', () {
    final previous = '2026-02-22T08:00:00.000Z';
    final incomingEarlier = '2026-02-22T07:59:59.000Z';
    final incomingLater = '2026-02-22T08:00:01.000Z';

    expect(
      resolveNextCursor(previousCursor: previous, incomingCursor: incomingEarlier),
      previous,
    );
    expect(
      resolveNextCursor(previousCursor: previous, incomingCursor: incomingLater),
      incomingLater,
    );
    expect(
      resolveNextCursor(previousCursor: null, incomingCursor: incomingLater),
      incomingLater,
    );
  });
}
