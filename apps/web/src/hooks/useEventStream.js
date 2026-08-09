import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "../lib/apiClient";

const IMPERSONATE_EMAIL_KEY = "rcs.impersonateEmail";

export const useEventStream = ({ enabled = true, types = [], since, onEvent }) => {
  const [status, setStatus] = useState(enabled ? "connecting" : "disabled");
  const [error, setError] = useState("");
  const sourceRef = useRef(null);

  const streamUrl = useMemo(() => {
    if (!enabled) {
      return null;
    }
    const query = new URLSearchParams();
    const email = localStorage.getItem(IMPERSONATE_EMAIL_KEY) || "";
    if (email) {
      query.set("email", email);
    }
    if (since) {
      query.set("since", since);
    }
    if (Array.isArray(types) && types.length > 0) {
      query.set("types", types.join(","));
    }
    return `${API_BASE_URL}/stream${query.toString() ? `?${query.toString()}` : ""}`;
  }, [enabled, since, types]);

  useEffect(() => {
    if (!streamUrl) {
      setStatus("disabled");
      setError("");
      sourceRef.current?.close();
      sourceRef.current = null;
      return undefined;
    }

    let cancelled = false;
    const source = new EventSource(streamUrl);
    sourceRef.current = source;
    setStatus("connecting");
    setError("");

    const parsePayload = (event) => {
      if (!event?.data) {
        return null;
      }
      try {
        return JSON.parse(event.data);
      } catch {
        return null;
      }
    };

    const forwardEvent = (type, event) => {
      const payload = parsePayload(event);
      if (!payload) {
        return;
      }
      onEvent?.({ type, payload });
    };

    const eventTypes = [
      "tool.execution.created",
      "tool.execution.updated",
      "approval.request.created",
      "approval.request.updated",
      "agent.run.updated",
      "system.killswitch.updated",
      "system.policy.updated",
      "finance.exposure.updated",
      "stream.error",
    ];

    const listeners = eventTypes.map((type) => {
      const listener = (event) => forwardEvent(type, event);
      source.addEventListener(type, listener);
      return { type, listener };
    });

    source.onopen = () => {
      if (!cancelled) {
        setStatus("open");
        setError("");
      }
    };

    source.onerror = () => {
      if (!cancelled) {
        setStatus("error");
        setError("Live feed unavailable. Falling back to polling.");
      }
    };

    return () => {
      cancelled = true;
      listeners.forEach(({ type, listener }) => {
        source.removeEventListener(type, listener);
      });
      source.close();
      if (sourceRef.current === source) {
        sourceRef.current = null;
      }
    };
  }, [streamUrl, onEvent]);

  return {
    status,
    error,
    isConnected: status === "open",
    isUsingFallback: enabled && status === "error",
  };
};
