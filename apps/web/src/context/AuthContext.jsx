import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiClient } from "../lib/apiClient";
import { clearQueryCache } from "../hooks/useQuery";

const AuthContext = createContext(null);
const IMPERSONATE_EMAIL_KEY = "rcs.impersonateEmail";
const ACTOR_USER_STORAGE_KEY = "rcs.actorUserId";
const ACTOR_LABEL_STORAGE_KEY = "rcs.actorLabel";
const ORG_SLUG_STORAGE_KEY = "rcs.orgSlug";

const normalizePermissionSet = (permissions) => new Set(Array.isArray(permissions) ? permissions : []);

const permissionImplies = (granted, requested) => {
  if (!requested) {
    return true;
  }

  if (granted.has("*") || granted.has(requested)) {
    return true;
  }

  const [domain] = requested.split(":");
  if (domain && granted.has(`${domain}:*`)) {
    return true;
  }

  return false;
};

export const AuthProvider = ({ children }) => {
  const [session, setSession] = useState(null);
  const [isReady, setIsReady] = useState(false);

  const logout = useCallback(() => {
    localStorage.removeItem("token");
    localStorage.removeItem(IMPERSONATE_EMAIL_KEY);
    localStorage.removeItem(ACTOR_USER_STORAGE_KEY);
    localStorage.removeItem(ACTOR_LABEL_STORAGE_KEY);
    setSession(null);
    clearQueryCache();
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const email = localStorage.getItem(IMPERSONATE_EMAIL_KEY) || "";
      const orgSlug = localStorage.getItem(ORG_SLUG_STORAGE_KEY) || "";
      const params = new URLSearchParams();

      if (email) {
        params.set("email", email);
      }

      if (orgSlug) {
        params.set("orgSlug", orgSlug);
      }

      const query = params.toString();
      const meResponse = await apiClient.get(`/me${query ? `?${query}` : ""}`);
      const nextSession = {
        org: meResponse?.org ?? null,
        user: meResponse?.user ?? null,
        roles: Array.isArray(meResponse?.roles) ? meResponse.roles : [],
        permissions: Array.isArray(meResponse?.permissions) ? meResponse.permissions : [],
      };

      if (nextSession.user?.id) {
        localStorage.setItem(ACTOR_USER_STORAGE_KEY, nextSession.user.id);
      } else {
        localStorage.removeItem(ACTOR_USER_STORAGE_KEY);
      }

      if (nextSession.user?.name) {
        localStorage.setItem(ACTOR_LABEL_STORAGE_KEY, `web:${nextSession.user.name}`);
      } else {
        localStorage.removeItem(ACTOR_LABEL_STORAGE_KEY);
      }

      setSession(nextSession);
      return nextSession;
    } catch {
      logout();
      return null;
    }
  }, [logout]);

  const login = useCallback(async (email, password) => {
    if (!email) {
      throw new Error("Email is required.");
    }
    localStorage.setItem(IMPERSONATE_EMAIL_KEY, email.trim().toLowerCase());
    return loadMe();
  }, [loadMe]);

  const switchUserByEmail = useCallback(async (email) => {
    if (email) {
      localStorage.setItem(IMPERSONATE_EMAIL_KEY, email.trim().toLowerCase());
    } else {
      localStorage.removeItem(IMPERSONATE_EMAIL_KEY);
    }
    return loadMe();
  }, [loadMe]);

  useEffect(() => {
    loadMe().finally(() => setIsReady(true));
  }, [loadMe]);

  const value = useMemo(() => {
    const user = session?.user ?? null;
    const roles = session?.roles ?? [];
    const permissions = session?.permissions ?? [];
    const granted = normalizePermissionSet(permissions);
    const hasPermission = (permission) => permissionImplies(granted, permission);
    const hasAnyPermission = (permissionList = []) =>
      permissionList.length === 0 || permissionList.some((permission) => hasPermission(permission));
    const hasAllPermissions = (permissionList = []) =>
      permissionList.every((permission) => hasPermission(permission));

    return {
      org: session?.org ?? null,
      user,
      roles,
      permissions,
      isReady,
      login,
      logout,
      loadMe,
      switchUserByEmail,
      hasPermission,
      hasAnyPermission,
      hasAllPermissions,
    };
  }, [isReady, loadMe, login, logout, session, switchUserByEmail]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const value = useContext(AuthContext);

  if (!value) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return value;
};
