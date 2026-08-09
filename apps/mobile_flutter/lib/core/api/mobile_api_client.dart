import 'dart:io';

import 'package:dio/dio.dart';

import 'package:mbs_mobile_flutter/core/models/mobile_sync_models.dart';

class MobileApiClient {
  final Dio _dio = Dio(
    BaseOptions(
      connectTimeout: const Duration(seconds: 20),
      receiveTimeout: const Duration(seconds: 30),
      sendTimeout: const Duration(seconds: 30),
    ),
  );

  String _baseUrl = 'http://localhost:3001';
  String _orgSlug = 'russell-comfort';
  String _actorUserId = '';
  String? _bearerToken;

  void configure({
    required String baseUrl,
    required String orgSlug,
    required String actorUserId,
    String? bearerToken,
  }) {
    _baseUrl = baseUrl.trim();
    _orgSlug = orgSlug.trim();
    _actorUserId = actorUserId.trim();
    _bearerToken = bearerToken?.trim().isEmpty == true ? null : bearerToken?.trim();
  }

  Map<String, String> _headers() {
    final headers = <String, String>{
      'x-org-slug': _orgSlug,
      'x-actor-user-id': _actorUserId,
      'content-type': 'application/json',
    };
    if (_bearerToken != null) {
      headers['authorization'] = 'Bearer $_bearerToken';
    }
    return headers;
  }

  Future<Map<String, dynamic>> fetchMe() async {
    final response = await _dio.get<Map<String, dynamic>>(
      '$_baseUrl/api/me',
      options: Options(headers: _headers()),
    );
    return response.data ?? <String, dynamic>{};
  }

  Future<Map<String, dynamic>> loginWithPin({
    required String orgSlug,
    required String identifier,
    required String pin,
    required String deviceId,
    String? deviceName,
    String? baseUrlOverride,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '${(baseUrlOverride ?? _baseUrl).trim()}/api/auth/mobile/pin/login',
      data: {
        'orgSlug': orgSlug,
        'identifier': identifier,
        'pin': pin,
        'deviceId': deviceId,
        if (deviceName != null && deviceName.trim().isNotEmpty)
          'deviceName': deviceName.trim(),
      },
      options: const Options(
        headers: {
          'content-type': 'application/json',
        },
      ),
    );
    return response.data ?? <String, dynamic>{};
  }

  Future<List<MobileSyncPushResult>> syncPush({
    required String deviceId,
    required List<MobileSyncPushAction> actions,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '$_baseUrl/api/mobile/sync/push',
      data: {
        'deviceId': deviceId,
        'actions': actions.map((action) => action.toJson()).toList(),
      },
      options: Options(headers: _headers()),
    );
    final rows = (response.data?['results'] as List?)
            ?.whereType<Map>()
            .map((row) => MobileSyncPushResult.fromJson(row.cast<String, dynamic>()))
            .toList() ??
        const <MobileSyncPushResult>[];
    return rows;
  }

  Future<MobileSyncPullResponse> syncPull({
    required String deviceId,
    String? auditCursor,
    String? outboxCursor,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '$_baseUrl/api/mobile/sync/pull',
      data: {
        'deviceId': deviceId,
        'cursors': {
          if (auditCursor != null) 'auditCursor': auditCursor,
          if (outboxCursor != null) 'outboxCursor': outboxCursor,
        },
      },
      options: Options(headers: _headers()),
    );
    return MobileSyncPullResponse.fromJson(response.data ?? const {});
  }

  Future<Map<String, dynamic>> uploadPhoto({
    required File file,
    required String ownerType,
    required String ownerId,
    required String tag,
    required String sessionKey,
    String? caption,
  }) async {
    final formData = FormData.fromMap({
      'ownerType': ownerType,
      'ownerId': ownerId,
      'tag': tag,
      'sessionKey': sessionKey,
      if (caption != null) 'caption': caption,
      'file': await MultipartFile.fromFile(
        file.path,
        filename: file.uri.pathSegments.isNotEmpty
            ? file.uri.pathSegments.last
            : 'upload.jpg',
      ),
    });

    final response = await _dio.post<Map<String, dynamic>>(
      '$_baseUrl/api/media/photos',
      data: formData,
      options: Options(
        headers: {
          ..._headers(),
          'x-upload-session-key': sessionKey,
          'content-type': 'multipart/form-data',
        },
      ),
    );
    return response.data ?? const {};
  }

  Future<Map<String, dynamic>?> getUploadSessionStatus({
    required String sessionKey,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '$_baseUrl/api/media/upload/session/${Uri.encodeComponent(sessionKey)}',
        options: Options(headers: _headers()),
      );
      return response.data ?? const {};
    } on DioException catch (error) {
      if (error.response?.statusCode == 404) {
        return null;
      }
      rethrow;
    }
  }

  Future<Map<String, dynamic>> adminSetUserPin({
    required String userId,
    required String newPin,
    String? reason,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '$_baseUrl/api/admin/users/$userId/pin/set',
      data: {
        'newPin': newPin,
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
      },
      options: Options(headers: _headers()),
    );
    return response.data ?? const {};
  }

  Future<Map<String, dynamic>> adminResetUserPin({
    required String userId,
    String? temporaryPin,
    String? reason,
  }) async {
    final response = await _dio.post<Map<String, dynamic>>(
      '$_baseUrl/api/admin/users/$userId/pin/reset',
      data: {
        if (temporaryPin != null && temporaryPin.trim().isNotEmpty)
          'temporaryPin': temporaryPin.trim(),
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
      },
      options: Options(headers: _headers()),
    );
    return response.data ?? const {};
  }
}
