const envApiBase =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL
    ? String(import.meta.env.VITE_API_BASE_URL)
    : "";

export const API_BASE_URL = envApiBase || "/api";
const API_BASE = API_BASE_URL;
const ACTOR_USER_STORAGE_KEY = "rcs.actorUserId";
const ACTOR_LABEL_STORAGE_KEY = "rcs.actorLabel";

const safeParseJson = async (response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const getErrorMessage = (data, fallback) => {
  if (!data) {
    return fallback;
  }

  if (typeof data === "string") {
    return data;
  }

  return data.message || data.error || fallback;
};

export class ApiError extends Error {
  constructor({ message, status = 0, code = "UNKNOWN_ERROR", data = null, isNetworkError = false, isAbort = false }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
    this.isNetworkError = isNetworkError;
    this.isAbort = isAbort;
  }
}

export const apiClient = {
  async request(path, options = {}) {
    const token = localStorage.getItem("token") || "";
    const actorUserId = localStorage.getItem(ACTOR_USER_STORAGE_KEY) || "";
    const actorLabel = localStorage.getItem(ACTOR_LABEL_STORAGE_KEY) || "";
    const isFormDataBody =
      typeof FormData !== "undefined" && options.body instanceof FormData;
    const headers = {
      ...(isFormDataBody ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (actorUserId && !headers["x-actor-user-id"]) {
      headers["x-actor-user-id"] = actorUserId;
    }

    if (actorLabel && !headers["x-actor-label"]) {
      headers["x-actor-label"] = actorLabel;
    }

    let response;

    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
        signal: options.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new ApiError({
          message: "Request aborted",
          code: "REQUEST_ABORTED",
          isAbort: true,
        });
      }

      throw new ApiError({
        message: "Network error. Check API availability.",
        code: "NETWORK_ERROR",
        isNetworkError: true,
      });
    }

    const data = await safeParseJson(response);

    if (!response.ok) {
      throw new ApiError({
        message: getErrorMessage(data, `Request failed (${response.status})`),
        status: response.status,
        code: data?.code || "HTTP_ERROR",
        data,
      });
    }

    return data;
  },

  get(path, options = {}) {
    return this.request(path, { ...options, method: "GET" });
  },

  post(path, body, options = {}) {
    return this.request(path, {
      ...options,
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  postForm(path, formData, options = {}) {
    return this.request(path, {
      ...options,
      method: "POST",
      body: formData,
    });
  },

  put(path, body, options = {}) {
    return this.request(path, {
      ...options,
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  patch(path, body, options = {}) {
    return this.request(path, {
      ...options,
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  del(path, options = {}) {
    return this.request(path, { ...options, method: "DELETE" });
  },
};
