import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:mbs_mobile_flutter/core/api/mobile_api_client.dart';
import 'package:mbs_mobile_flutter/core/auth/auth_controller.dart';

class FakeMobileApiClient extends MobileApiClient {
  Map<String, dynamic> loginResponse = const {};
  Map<String, dynamic> meResponse = const {};

  @override
  Future<Map<String, dynamic>> loginWithPin({
    required String orgSlug,
    required String identifier,
    required String pin,
    required String deviceId,
    String? deviceName,
    String? baseUrlOverride,
  }) async {
    return loginResponse;
  }

  @override
  Future<Map<String, dynamic>> fetchMe() async {
    return meResponse;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
  });

  test('loginWithPin stores session and loadFromStorage restores it', () async {
    final api = FakeMobileApiClient()
      ..loginResponse = {
        'accessToken': 'access-token',
        'refreshToken': 'refresh-token',
        'user': {
          'id': 'user-1',
          'email': 'tech@example.com',
          'name': 'Tech User',
          'mobilePinResetRequired': false,
        },
        'roles': ['tech'],
        'permissions': ['mobile:sync', 'time:write'],
      }
      ..meResponse = {
        'roles': ['tech'],
        'permissions': ['mobile:sync', 'time:write'],
        'user': {
          'name': 'Tech User',
          'email': 'tech@example.com',
          'mobilePinResetRequired': false,
        },
      };

    final controller = AuthController(api);

    await controller.loginWithPin(
      apiBaseUrl: 'http://localhost:3001',
      orgSlug: 'russell-comfort',
      identifier: 'tech@example.com',
      pin: '1234',
      deviceName: 'iPhone',
    );

    expect(controller.session.value, isNotNull);
    expect(controller.session.value?.actorUserId, 'user-1');
    expect(controller.session.value?.accessToken, 'access-token');

    final restored = AuthController(api);
    await restored.loadFromStorage();

    expect(restored.session.value, isNotNull);
    expect(restored.session.value?.actorUserId, 'user-1');
    expect(restored.session.value?.orgSlug, 'russell-comfort');
  });
}
