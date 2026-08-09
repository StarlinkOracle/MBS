import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'package:mbs_mobile_flutter/core/api/mobile_api_client.dart';
import 'package:mbs_mobile_flutter/core/auth/auth_controller.dart';
import 'package:mbs_mobile_flutter/core/db/local_database.dart';
import 'package:mbs_mobile_flutter/core/sync/sync_engine.dart';
import 'package:mbs_mobile_flutter/features/auth/login_screen.dart';
import 'package:mbs_mobile_flutter/features/home/home_shell.dart';
import 'package:mbs_mobile_flutter/features/jobs/job_detail_screen.dart';
import 'package:mbs_mobile_flutter/features/media/photo_upload_service.dart';
import 'package:mbs_mobile_flutter/features/timeclock/time_clock_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MbsMobileApp());
}

class MbsMobileApp extends StatefulWidget {
  const MbsMobileApp({super.key});

  @override
  State<MbsMobileApp> createState() => _MbsMobileAppState();
}

class _MbsMobileAppState extends State<MbsMobileApp> {
  late final LocalDatabase _database;
  late final MobileApiClient _apiClient;
  late final AuthController _authController;
  late final SyncEngine _syncEngine;
  late final PhotoUploadService _photoUploadService;
  bool _bootstrapped = false;

  @override
  void initState() {
    super.initState();
    _database = LocalDatabase();
    _apiClient = MobileApiClient();
    _authController = AuthController(_apiClient);
    _syncEngine = SyncEngine(
      database: _database,
      apiClient: _apiClient,
      authController: _authController,
    );
    _photoUploadService = PhotoUploadService(_syncEngine);
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await _authController.loadFromStorage();
    _syncEngine.start();
    if (_authController.session.value != null) {
      await _syncEngine.syncNow();
    }
    if (mounted) {
      setState(() {
        _bootstrapped = true;
      });
    }
  }

  @override
  void dispose() {
    _syncEngine.stop();
    _database.close();
    _authController.session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_bootstrapped) {
      return MaterialApp(
        home: Scaffold(
          body: Center(
            child: const CircularProgressIndicator(),
          ),
        ),
      );
    }

    return ValueListenableBuilder<AuthSession?>(
      valueListenable: _authController.session,
      builder: (context, session, _) {
        final router = GoRouter(
          initialLocation: session == null ? '/login' : '/',
          routes: [
            GoRoute(
              path: '/login',
              builder: (context, state) => LoginScreen(
                authController: _authController,
              ),
            ),
            GoRoute(
              path: '/',
              builder: (context, state) {
                final current = _authController.session.value;
                if (current == null) {
                  return LoginScreen(authController: _authController);
                }
                return HomeShell(
                  session: current,
                  database: _database,
                  syncEngine: _syncEngine,
                  authController: _authController,
                );
              },
            ),
            GoRoute(
              path: '/timeclock',
              builder: (context, state) => TimeClockScreen(
                database: _database,
                syncEngine: _syncEngine,
              ),
            ),
            GoRoute(
              path: '/job/:jobId',
              builder: (context, state) {
                final jobId = state.pathParameters['jobId'] ?? '';
                return JobDetailScreen(
                  jobId: jobId,
                  database: _database,
                  syncEngine: _syncEngine,
                  photoService: _photoUploadService,
                );
              },
            ),
          ],
          redirect: (context, state) {
            final isLoggedIn = _authController.session.value != null;
            final onLogin = state.matchedLocation == '/login';
            if (!isLoggedIn && !onLogin) {
              return '/login';
            }
            if (isLoggedIn && onLogin) {
              return '/';
            }
            return null;
          },
        );

        return MaterialApp.router(
          title: 'MBS Mobile',
          routerConfig: router,
          theme: ThemeData(
            useMaterial3: true,
            colorSchemeSeed: Colors.orange,
          ),
        );
      },
    );
  }
}
