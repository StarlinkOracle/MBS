class MobileSyncPushAction {
  MobileSyncPushAction({
    required this.clientActionId,
    required this.toolName,
    required this.payload,
    this.reason,
  });

  final String clientActionId;
  final String toolName;
  final Map<String, dynamic> payload;
  final String? reason;

  Map<String, dynamic> toJson() => {
        'clientActionId': clientActionId,
        'toolName': toolName,
        'payload': payload,
        if (reason != null && reason!.trim().isNotEmpty) 'reason': reason,
      };
}

class MobileSyncPushResult {
  MobileSyncPushResult({
    required this.clientActionId,
    required this.status,
    this.output,
    this.error,
    this.errorCode,
    this.recoverable,
  });

  final String clientActionId;
  final String status;
  final dynamic output;
  final String? error;
  final String? errorCode;
  final bool? recoverable;

  factory MobileSyncPushResult.fromJson(Map<String, dynamic> json) =>
      MobileSyncPushResult(
        clientActionId: (json['clientActionId'] ?? '').toString(),
        status: (json['status'] ?? '').toString(),
        output: json['output'],
        error: json['error']?.toString(),
        errorCode: json['errorCode']?.toString(),
        recoverable: json['recoverable'] is bool ? json['recoverable'] as bool : null,
      );
}

class MobileSyncPullResponse {
  MobileSyncPullResponse({
    required this.auditCursor,
    required this.outboxCursor,
    required this.events,
    required this.readModels,
  });

  final String auditCursor;
  final String outboxCursor;
  final Map<String, dynamic> events;
  final Map<String, dynamic> readModels;

  factory MobileSyncPullResponse.fromJson(Map<String, dynamic> json) {
    final newCursors = (json['newCursors'] as Map?)?.cast<String, dynamic>() ?? {};
    return MobileSyncPullResponse(
      auditCursor: (newCursors['auditCursor'] ?? '').toString(),
      outboxCursor: (newCursors['outboxCursor'] ?? '').toString(),
      events: (json['events'] as Map?)?.cast<String, dynamic>() ?? const {},
      readModels: (json['readModels'] as Map?)?.cast<String, dynamic>() ?? const {},
    );
  }
}
