import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import 'package:mbs_mobile_flutter/core/api/mobile_api_client.dart';

class AuthSession {
  AuthSession({
    required this.apiBaseUrl,
    required this.orgSlug,
    required this.actorUserId,
    required this.deviceId,
    required this.roles,
    required this.permissions,
    this.accessToken,
    this.refreshToken,
    this.userName,
    this.userEmail,
    this.mobilePinResetRequired = false,
  });

  final String apiBaseUrl;
  final String orgSlug;
  final String actorUserId;
  final String deviceId;
  final String? accessToken;
  final String? refreshToken;
  final List<String> roles;
  final List<String> permissions;
  final String? userName;
  final String? userEmail;
  final bool mobilePinResetRequired;

  bool hasPermission(String permission) => permissions.any(
        (granted) =>
            granted == '*' ||
            granted == permission ||
            (granted.endsWith('*') &&
                permission.startsWith(granted.substring(0, granted.length - 1))),
      );
}

class AuthController {
  AuthController(this._apiClient);

  static const _storage = FlutterSecureStorage();
  static const _uuid = Uuid();

  static const _keyBaseUrl = 'mbs_api_base_url';
  static const _keyOrgSlug = 'mbs_org_slug';
  static const _keyActorUserId = 'mbs_actor_user_id';
  static const _keyAccessToken = 'mbs_access_token';
  static const _keyRefreshToken = 'mbs_refresh_token';
  static const _keyDeviceId = 'mbs_device_id';

  final MobileApiClient _apiClient;
  final ValueNotifier<AuthSession?> session = ValueNotifier<AuthSession?>(null);

  Future<String> getOrCreateDeviceId() async {
    final existing = await _storage.read(key: _keyDeviceId);
    if (existing != null && existing.trim().isNotEmpty) {
      return existing;
    }
    final generated = 'ios-${_uuid.v4()}';
    await _storage.write(key: _keyDeviceId, value: generated);
    return generated;
  }

  Future<void> loadFromStorage() async {
    final baseUrl = await _storage.read(key: _keyBaseUrl);
    final orgSlug = await _storage.read(key: _keyOrgSlug);
    final actorUserId = await _storage.read(key: _keyActorUserId);
    final accessToken = await _storage.read(key: _keyAccessToken);
    final refreshToken = await _storage.read(key: _keyRefreshToken);
    final deviceId = await getOrCreateDeviceId();

    if (baseUrl == null || orgSlug == null || actorUserId == null) {
      return;
    }

    try {
      _apiClient.configure(
        baseUrl: baseUrl,
        orgSlug: orgSlug,
        actorUserId: actorUserId,
        bearerToken: accessToken,
      );

      final me = await _apiClient.fetchMe();
      final roles =
          (me['roles'] as List?)?.map((e) => e.toString()).toList() ??
              const <String>[];
      final permissions =
          (me['permissions'] as List?)?.map((e) => e.toString()).toList() ??
              const <String>[];
      final user =
          (me['user'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};

      session.value = AuthSession(
        apiBaseUrl: baseUrl,
        orgSlug: orgSlug,
        actorUserId: actorUserId,
        deviceId: deviceId,
        accessToken: accessToken,
        refreshToken: refreshToken,
        roles: roles,
        permissions: permissions,
        userName: user['name']?.toString(),
        userEmail: user['email']?.toString(),
        mobilePinResetRequired: user['mobilePinResetRequired'] == true,
      );
    } catch (_) {
      await signOut();
    }
  }

  Future<void> loginWithPin({
    required String apiBaseUrl,
    required String orgSlug,
    required String identifier,
    required String pin,
    String? deviceName,
  }) async {
    final deviceId = await getOrCreateDeviceId();

    final response = await _apiClient.loginWithPin(
      baseUrlOverride: apiBaseUrl,
      orgSlug: orgSlug,
      identifier: identifier,
      pin: pin,
      deviceId: deviceId,
      deviceName: deviceName,
    );

    final accessToken = (response['accessToken'] ?? '').toString();
    if (accessToken.isEmpty) {
      throw Exception(
        (response['message'] ?? response['error'] ?? 'PIN login failed').toString(),
      );
    }

    final user =
        (response['user'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
    final actorUserId = (user['id'] ?? '').toString();
    if (actorUserId.isEmpty) {
      throw Exception('PIN login response missing user id');
    }

    final roles =
        (response['roles'] as List?)?.map((e) => e.toString()).toList() ??
            const <String>[];
    final permissions =
        (response['permissions'] as List?)?.map((e) => e.toString()).toList() ??
            const <String>[];
    final refreshToken = response['refreshToken']?.toString();

    _apiClient.configure(
      baseUrl: apiBaseUrl,
      orgSlug: orgSlug,
      actorUserId: actorUserId,
      bearerToken: accessToken,
    );

    session.value = AuthSession(
      apiBaseUrl: apiBaseUrl,
      orgSlug: orgSlug,
      actorUserId: actorUserId,
      deviceId: deviceId,
      accessToken: accessToken,
      refreshToken: refreshToken,
      roles: roles,
      permissions: permissions,
      userName: user['name']?.toString(),
      userEmail: user['email']?.toString(),
      mobilePinResetRequired: user['mobilePinResetRequired'] == true,
    );

    await Future.wait([
      _storage.write(key: _keyBaseUrl, value: apiBaseUrl),
      _storage.write(key: _keyOrgSlug, value: orgSlug),
      _storage.write(key: _keyActorUserId, value: actorUserId),
      _storage.write(key: _keyAccessToken, value: accessToken),
      _storage.write(key: _keyRefreshToken, value: refreshToken),
      _storage.write(key: _keyDeviceId, value: deviceId),
    ]);
  }

  Future<void> signOut() async {
    session.value = null;
    await Future.wait([
      _storage.delete(key: _keyBaseUrl),
      _storage.delete(key: _keyOrgSlug),
      _storage.delete(key: _keyActorUserId),
      _storage.delete(key: _keyAccessToken),
      _storage.delete(key: _keyRefreshToken),
    ]);
  }

  String debugSessionJson() {
    final current = session.value;
    if (current == null) {
      return '{}';
    }
    return const JsonEncoder.withIndent('  ').convert({
      'apiBaseUrl': current.apiBaseUrl,
      'orgSlug': current.orgSlug,
      'actorUserId': current.actorUserId,
      'deviceId': current.deviceId,
      'roles': current.roles,
      'permissions': current.permissions,
      'mobilePinResetRequired': current.mobilePinResetRequired,
    });
  }

  Future<Map<String, dynamic>> adminResetUserPin({
    required String userId,
    String? temporaryPin,
    String? reason,
  }) {
    return _apiClient.adminResetUserPin(
      userId: userId,
      temporaryPin: temporaryPin,
      reason: reason,
    );
  }

  Future<Map<String, dynamic>> adminSetUserPin({
    required String userId,
    required String newPin,
    String? reason,
  }) {
    return _apiClient.adminSetUserPin(
      userId: userId,
      newPin: newPin,
      reason: reason,
    );
  }
}
