import 'package:mbs_mobile_flutter/core/models/mobile_sync_models.dart';

const Set<String> _nonRecoverableErrorCodes = {
  'TOOL_NOT_FOUND',
  'TOOL_BLOCKED',
  'MOBILE_SYNC_INVALID_PAYLOAD',
  'MOBILE_SYNC_DUPLICATE_ACTION_IDS',
  'AUTH_PIN_LOCKED',
  'AUTH_PIN_NOT_SET',
};

class QueueResolution {
  QueueResolution({
    required this.clientActionId,
    required this.nextStatus,
    this.error,
  });

  final String clientActionId;
  final String nextStatus;
  final String? error;
}

List<QueueResolution> resolveQueueResults(List<MobileSyncPushResult> results) {
  return results.map((result) {
    if (result.status == 'APPLIED') {
      return QueueResolution(
        clientActionId: result.clientActionId,
        nextStatus: 'CONFIRMED',
      );
    }
    final errorCode = result.errorCode?.trim();
    final markedNonRecoverable = result.recoverable == false ||
        (errorCode != null && _nonRecoverableErrorCodes.contains(errorCode));
    final errorText = [
      if (errorCode != null && errorCode.isNotEmpty) errorCode,
      result.error ?? 'Unknown sync failure',
    ].whereType<String>().join(': ');
    return QueueResolution(
      clientActionId: result.clientActionId,
      nextStatus: 'FAILED',
      error: markedNonRecoverable ? 'NON_RECOVERABLE:$errorText' : errorText,
    );
  }).toList();
}

String? resolveNextCursor({
  required String? previousCursor,
  required String? incomingCursor,
}) {
  if (incomingCursor == null || incomingCursor.trim().isEmpty) {
    return previousCursor;
  }
  if (previousCursor == null || previousCursor.trim().isEmpty) {
    return incomingCursor;
  }
  final previous = DateTime.tryParse(previousCursor);
  final incoming = DateTime.tryParse(incomingCursor);
  if (previous == null || incoming == null) {
    return incomingCursor;
  }
  return incoming.isAfter(previous) ? incomingCursor : previousCursor;
}
