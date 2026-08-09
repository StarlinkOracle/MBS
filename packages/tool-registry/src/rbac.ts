function matchesPermission(granted: string, required: string): boolean {
  if (granted === '*') {
    return true;
  }

  if (required === '*') {
    return granted === '*';
  }

  if (granted.endsWith('*')) {
    const prefix = granted.slice(0, -1);
    return required.startsWith(prefix);
  }

  if (required.endsWith('*')) {
    const prefix = required.slice(0, -1);
    return granted.startsWith(prefix);
  }

  return granted === required;
}

export function hasAllRequiredPermissions(
  grantedPermissions: string[],
  requiredPermissions: string[],
): boolean {
  if (requiredPermissions.length === 0) {
    return true;
  }

  return requiredPermissions.every((required) =>
    grantedPermissions.some((granted) => matchesPermission(granted, required)),
  );
}

export { matchesPermission };
