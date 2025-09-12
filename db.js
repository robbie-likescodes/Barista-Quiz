/* =========================================================
   Barista Flashcards & Quizzes — db.js
   - Centralizes all calls to Google Apps Script backend
   - Uses CLOUD.BASE (Web App URL) and CLOUD.API_KEY
   - GET always appends ?key=...; POST uses urlencoded body
========================================================= */

// Configure once here
const CLOUD = {
  BASE: "https://script.google.com/macros/s/AKfycbzpU5ua2lfpyujRiRs4ouQdJsb8nbhZPYtThueEs_pVUuFHmhaLTswN-T0xbRU0c4-urw/exec",
  API_KEY: "longrandomstringwhatwhat" // must match Script Properties > API_KEY
};

/**
 * Generic GET to Apps Script
 * @param {object} params key/value pairs to append as query string
 * @returns {Promise<any>}
 */
async function cloudGET(params = {}) {
  if (!CLOUD.BASE) throw new Error("CLOUD.BASE missing");
  const url = new URL(CLOUD.BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  url.searchParams.set("key", CLOUD.API_KEY || "");

  const resp = await fetch(url.toString(), { method: "GET" });
  if (!resp.ok) throw new Error(`GET ${url} → ${resp.status}`);
  const json = await resp.json();
  // Support either { ok, data } or raw data
  if (json && typeof json === "object" && "ok" in json) {
    if (json.ok) return json.data;
    throw new Error(json.error || "Server error");
  }
  return json;
}

/**
 * Generic POST to Apps Script (urlencoded to avoid preflight)
 * @param {string} action action string (e.g., "submitresult", "bulkupsert")
 * @param {object} body   payload (objects/arrays auto-JSONed)
 * @returns {Promise<any>}
 */
async function cloudPOST(action, body = {}) {
  if (!CLOUD.BASE) throw new Error("CLOUD.BASE missing");
  const params = new URLSearchParams();
  params.set("action", action);
  if (CLOUD.API_KEY) params.set("key", CLOUD.API_KEY);

  for (const [k, v] of Object.entries(body)) {
    params.set(k, (v && typeof v === "object") ? JSON.stringify(v) : String(v));
  }

  const resp = await fetch(CLOUD.BASE, { method: "POST", body: params });
  if (!resp.ok) throw new Error(`POST ${action} → ${resp.status}`);
  const json = await resp.json();
  if (json && typeof json === "object" && "ok" in json) {
    if (json.ok) return json.data;
    throw new Error(json.error || "Server error");
  }
  return json;
}

/* ====== Convenience wrappers app.js can call ====== */
/* Names map to your backend actions used in app.js   */

function dbGetAll() {
  // Apps Script action: list → returns { decks, cards, tests }
  return cloudGET({ action: "list" });
}

function dbGetResults(limit = 100) {
  // Apps Script action: results → returns rows
  return cloudGET({ action: "results", limit });
}

function dbSubmitResult(row) {
  // Apps Script action: submitresult
  return cloudPOST("submitresult", row);
}

function dbBackup(payload, mode = "merge") {
  // Apps Script action: bulkupsert (mode: merge|replace)
  return cloudPOST("bulkupsert", { ...payload, mode });
}

/* Optional helpers to match archive/delete operations in app.js */

function dbArchiveMove(id, to /* 'archived' | 'active' */) {
  return cloudPOST("archivemove", { id, to });
}

function dbDeleteForever(id, from /* 'active' | 'archived' */ = "active") {
  return cloudPOST("deleteforever", { id, from });
}
