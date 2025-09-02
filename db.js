/* db.js — tiny client for Google Apps Script Sheets API
   Works with the Code.gs you deployed as a Web App.
   Exposes global `GSYNC` with:
     setConfig, setAuth, ping, listAll, readResults,
     submitResult, bulkUpsert, archiveMove, deleteForever, testWrite
*/

(function attachGSYNC() {
  const DEFAULT_TIMEOUT_MS = 15000; // each request timeout
  const MAX_RETRIES = 2;            // total tries = 1 + MAX_RETRIES
  const LS_KEY = 'bq_gsync_cfg_v1';

  // ---- Config (persisted) ----
  const _cfg = loadCfg() || {
    SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzrw0Asmr7iAxq3qq64IB9uatgASDdGkAOZU4J7JcFPMzLRf9yJpPO1jA-NbPo0LVugRA/exec', // e.g. https://script.google.com/macros/s/AKfycb.../exec
    API_KEY: 'longrandomstringwhatwhat'     // same as Apps Script Script Property API_KEY
  };

  function saveCfg() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(_cfg)); } catch {}
  }
  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || ''); } catch { return null; }
  }

  // ---- Helpers ----
  function qs(params) {
    const sp = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === '') return;
      sp.set(k, String(v));
    });
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  async function fetchJSON(url, { method='GET', body=null, timeout=DEFAULT_TIMEOUT_MS, retries=MAX_RETRIES } = {}) {
    if (!_cfg.SCRIPT_URL) throw new Error('GSYNC: SCRIPT_URL is not set. Call GSYNC.setConfig({ scriptUrl }) first.');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);

    const opts = {
      method,
      headers: { 'Accept': 'application/json' },
      mode: 'cors',
      signal: ctl.signal
    };
    if (body && method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    try {
      const res = await fetch(url, opts);
      clearTimeout(t);
      if (!res.ok) {
        const text = await res.text().catch(()=>'');
        throw new Error(`HTTP ${res.status} ${res.statusText} — ${text}`.trim());
      }
      const data = await res.json();
      if (!data || data.ok !== true) {
        const msg = data && data.error ? data.error : 'Unknown server error';
        throw new Error(msg);
      }
      return data.data;
    } catch (err) {
      clearTimeout(t);
      // retry strategy for network-ish failures
      if (retries > 0 && (err.name === 'AbortError' || /NetworkError|Failed to fetch/i.test(String(err)))) {
        await delay(backoffDelay(MAX_RETRIES - retries));
        return fetchJSON(url, { method, body, timeout, retries: retries - 1 });
      }
      throw err;
    }
  }

  const delay = ms => new Promise(res => setTimeout(res, ms));
  const backoffDelay = (i) => 400 * Math.pow(1.8, i); // 400ms, 720ms, ~1296ms …

  function nowISO() {
    // yyyy-mm-dd (local) + human time handy for the Results tab
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return { date: `${y}-${m}-${day}`, timeStr: `${hh}:${mm}` };
  }

  function urlFor(action, params) {
    if (!_cfg.SCRIPT_URL) throw new Error('GSYNC: SCRIPT_URL is not set.');
    return _cfg.SCRIPT_URL + qs({ action, ...(params || {}) });
  }

  // ---- Public API ----
  const GSYNC = {
    // Configure at startup (or store via UI)
    setConfig({ scriptUrl, apiKey } = {}) {
      if (scriptUrl) _cfg.SCRIPT_URL = String(scriptUrl);
      if (apiKey !== undefined) _cfg.API_KEY = String(apiKey);
      saveCfg();
      return { ..._cfg };
    },
    // Alias if you want to only change API key later
    setAuth(apiKey) {
      _cfg.API_KEY = String(apiKey || '');
      saveCfg();
      return { ..._cfg };
    },
    getConfig() { return { ..._cfg }; },

    // Health check
    async ping() {
      const url = urlFor('ping');
      return fetchJSON(url, { method:'GET' });
    },

    // Student hydration: decks + cards + tests (cached server-side)
    async listAll() {
      const url = urlFor('list');
      return fetchJSON(url, { method:'GET' });
    },

    // Read Results (optionally pass { limit, since })
    async readResults({ limit, since } = {}) {
      const url = urlFor('results', { limit, since });
      return fetchJSON(url, { method:'GET' });
    },

    // ---- Writes (require API_KEY) ----

    /** Save a single student submission row into Results. 
     *  Shape accepted (anything missing is normalized server-side):
     *  {
     *    resId?, name?, location?, date?, time?, testId?, testName?,
     *    score?, correct?, of?, answers? (array)
     *  }
     */
    async submitResult(row) {
      if (!_cfg.API_KEY) throw new Error('GSYNC: Missing API_KEY. Call GSYNC.setAuth(apiKey).');
      const url = _cfg.SCRIPT_URL;
      const body = { action:'submitResult', apiKey:_cfg.API_KEY, row };
      return fetchJSON(url, { method:'POST', body });
    },

    /** Bulk upsert content: decks/cards/tests/results/archived using your backup schema OR raw rows.
     *  Example (backup schema):
     *  {
     *    schema: 'bq_backup_v1',
     *    decks: { [deckId]: { id, className, deckName, tags[], cards: [{ id, q, a, distractors[], sub, createdAt }] } },
     *    tests: { [testId]: { id, name, title, n, selections: [...] } },
     *    results: [ {...} ],
     *    archived: [ {...} ]
     *  }
     *  mode: 'merge' (default) or 'replace'
     */
    async bulkUpsert(payload, mode='merge') {
      if (!_cfg.API_KEY) throw new Error('GSYNC: Missing API_KEY. Call GSYNC.setAuth(apiKey).');
      const url = _cfg.SCRIPT_URL;
      const body = { action:'bulkupsert', apiKey:_cfg.API_KEY, mode, ...payload };
      return fetchJSON(url, { method:'POST', body });
    },

    /** Move a result between Results <-> Archived. 
     *  to === 'archived' moves Results → Archived; otherwise Archived → Results
     */
    async archiveMove(id, to='archived') {
      if (!_cfg.API_KEY) throw new Error('GSYNC: Missing API_KEY.');
      const url = _cfg.SCRIPT_URL;
      const body = { action:'archivemove', apiKey:_cfg.API_KEY, id, to };
      return fetchJSON(url, { method:'POST', body });
    },

    /** Delete a result forever from Results or Archived */
    async deleteForever(id, from='results') {
      if (!_cfg.API_KEY) throw new Error('GSYNC: Missing API_KEY.');
      const url = _cfg.SCRIPT_URL;
      const body = { action:'deleteforever', apiKey:_cfg.API_KEY, id, from };
      return fetchJSON(url, { method:'POST', body });
    },

    /** Convenience: write a demo submission row to validate your pipeline */
    async testWrite() {
      const { date, timeStr } = nowISO();
      const demo = {
        name: 'Smoke Test',
        location: 'Browser',
        date,                // yyyy-mm-dd (for readability in the Sheet)
        time: Date.now(),    // timeEpoch (server normalizes)
        testId: 'demo_1',
        testName: 'Connectivity Check',
        score: 4,
        correct: 4,
        of: 4,
        answers: [
          { q:'Q1', a:'A', correct:true },
          { q:'Q2', a:'B', correct:true },
          { q:'Q3', a:'C', correct:true },
          { q:'Q4', a:'D', correct:true },
        ]
      };
      return GSYNC.submitResult(demo);
    }
  };

  // expose globally
  window.GSYNC = GSYNC;

  // OPTIONAL: initialize from data-* attributes if present
  try {
    const tag = document.currentScript || document.querySelector('script[src*="db.js"]');
    if (tag) {
      const su = tag.getAttribute('data-script-url');
      const ak = tag.getAttribute('data-api-key');
      if (su || ak) GSYNC.setConfig({ scriptUrl: su || _cfg.SCRIPT_URL, apiKey: ak || _cfg.API_KEY });
    }
  } catch {}
})();

