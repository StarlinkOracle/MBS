const VISITOR_ID_KEY = "rcs_vid";
const ATTRIBUTION_KEY = "rcs_attribution";
const VISITOR_ID_EXPIRY_DAYS = 90;

interface AttributionSnapshot {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  fbclid: string | null;
  landingUrl: string;
  referrerUrl: string;
  visitorId: string;
}

function generateVisitorId(): string {
  return "rcs_" + Date.now().toString(36) + "_" + Math.random().toString(36).substring(2, 10);
}

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};path=/;SameSite=Lax`;
}

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[2]) : null;
}

function getOrCreateVisitorId(): string {
  let vid = localStorage.getItem(VISITOR_ID_KEY) || getCookie(VISITOR_ID_KEY);
  if (!vid) {
    vid = generateVisitorId();
  }
  localStorage.setItem(VISITOR_ID_KEY, vid);
  setCookie(VISITOR_ID_KEY, vid, VISITOR_ID_EXPIRY_DAYS);
  return vid;
}

function getParam(params: URLSearchParams, key: string): string | null {
  return params.get(key) || null;
}

export function captureAttributionOnLoad(): void {
  const params = new URLSearchParams(window.location.search);
  const visitorId = getOrCreateVisitorId();

  const snapshot: AttributionSnapshot = {
    utmSource: getParam(params, "utm_source"),
    utmMedium: getParam(params, "utm_medium"),
    utmCampaign: getParam(params, "utm_campaign"),
    utmContent: getParam(params, "utm_content"),
    utmTerm: getParam(params, "utm_term"),
    gclid: getParam(params, "gclid"),
    gbraid: getParam(params, "gbraid"),
    wbraid: getParam(params, "wbraid"),
    fbclid: getParam(params, "fbclid"),
    landingUrl: window.location.href,
    referrerUrl: document.referrer || "",
    visitorId,
  };

  const hasParams = snapshot.utmSource || snapshot.gclid || snapshot.gbraid || snapshot.wbraid || snapshot.fbclid;

  if (hasParams) {
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(snapshot));
  } else if (!sessionStorage.getItem(ATTRIBUTION_KEY)) {
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(snapshot));
  }

  if (hasParams) {
    fetch("/api/attribution/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...snapshot,
        eventType: "page_view",
      }),
    }).catch(() => {});
  }
}

export function getAttributionSnapshot(): AttributionSnapshot {
  const stored = sessionStorage.getItem(ATTRIBUTION_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      // fall through
    }
  }
  return {
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    gclid: null,
    gbraid: null,
    wbraid: null,
    fbclid: null,
    landingUrl: window.location.href,
    referrerUrl: document.referrer || "",
    visitorId: getOrCreateVisitorId(),
  };
}

export function fireConversionEvent(contactRequestId: number): void {
  const snapshot = getAttributionSnapshot();
  fetch("/api/attribution/convert", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...snapshot,
      eventType: "conversion",
      contactRequestId,
    }),
  }).catch(() => {});
}
