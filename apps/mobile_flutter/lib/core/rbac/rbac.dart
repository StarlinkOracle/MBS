import 'package:mbs_mobile_flutter/core/auth/auth_controller.dart';

bool hasAnyRole(AuthSession session, List<String> roleFragments) {
  final normalized = session.roles.map((role) => role.toLowerCase()).toList();
  return normalized.any(
    (role) => roleFragments.any((fragment) => role.contains(fragment.toLowerCase())),
  );
}

bool canAccessDispatch(AuthSession session) {
  return hasAnyRole(session, ['dispatch', 'admin', 'owner', 'manager']) ||
      session.hasPermission('scheduling:read') ||
      session.hasPermission('scheduling:write');
}

bool canReviewTimeEdits(AuthSession session) {
  return hasAnyRole(session, ['dispatch', 'admin', 'owner', 'manager']) ||
      session.hasPermission('time:edit:review');
}

bool canUseTimeClock(AuthSession session) {
  return session.hasPermission('time:write') ||
      session.hasPermission('*') ||
      hasAnyRole(session, ['tech', 'dispatch', 'admin', 'owner']);
}
