/* =========================================================
   Barista Flashcards & Quizzes — db.js
   - Centralizes all calls to Google Apps Script backend
   - Uses CLOUD.BASE (Web App URL) and CLOUD.API_KEY
   - Wraps fetch() with GET and POST helpers
========================================================= */

// Configure once here
const CLOUD = {
  BASE: "https://script.google.com/macros/s/PUT-YOUR-WEB-APP-ID/exec", // <-- replace with your current /exec URL
  API_KEY: "PUT-YOUR-SECRET-KEY" // <-- must match Script Properties > API_KEY
};

/**
 * Generic GET to Apps Script
 * @param {object} params  key/value pairs to append as query string
 * @returns {Promise<any>}
 */
async function cloudGET(params = {}) {
  const url = new URL(CLOUD.BASE);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
  // Always send API key for safety
  url.searchParams.set("key", CLOUD.API_KEY);

  const resp = await fetch(url.toString(), { method:"GET" });
  if (!resp.ok) throw new Error(`GET ${url} → ${resp.status}`);
  return resp.json().then(j => j.data ?? j);
}

/**
 * Generic POST to Apps Script
 * @param {string} action   action string (e.g. "submitResult", "backup")
 * @param {object} body     JSON body
 * @returns {Promise<any>}
 */
async function cloudPOST(action, body = {}) {
  const url = new URL(CLOUD.BASE);
  url.searchParams.set("action", action);
  url.searchParams.set("key", CLOUD.API_KEY);

  const resp = await fetch(url.toString(), {
    method:"POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`POST ${action} → ${resp.status}`);
  return resp.json();
}

/* ====== Convenience wrappers your app.js can call ====== */

function dbGetAll() {
  return cloudGET({ action: "getAll" });
}

function dbGetResults(limit = 100) {
  return cloudGET({ action: "getResults", limit });
}

function dbSubmitResult(row) {
  return cloudPOST("submitResult", { row });
}

function dbBackup(payload, mode="merge") {
  return cloudPOST("backup", { ...payload, mode });
}
