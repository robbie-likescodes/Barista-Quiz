/* ========================================================= 
   Barista Flashcards & Quizzes — app.js (Google Sheets sync)
   Local-first SPA + Cloud sync (pull/push/submit/results)
   NOTE: POST uses URL-ENCODED form data to avoid CORS preflight.
========================================================= */

/* ========= Cloud API Config (EDIT AFTER REDEPLOY) ========= */
const CLOUD = {
  BASE: "https://script.google.com/macros/s/AKfycbyd2qWD-0n_FXIXzRmOdb1L17Vy0CiCYKHtiyz5_BsqBRsYCmiOfuxiATErvD3c-wjvtg/exec",
  API_KEY: "longrandomstringwhatwhat" // must match Script Property 'API_KEY'
};
/* ========================================================= */

//////////////////// tiny DOM/storage helpers ////////////////////
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const on = (el, ev, fn, opt) => el && el.addEventListener(ev, fn, opt);
const bindOnce = (el, ev, fn, key) => {
  if(!el) return;
  const flag = `__bq_bound_${key || ev}`;
  if(el[flag]) return;
  el.addEventListener(ev, fn);
  el[flag] = true;
};

const store = {
  get(k, f){ try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
  set(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
};

//////////////////////////// constants ///////////////////////////
const KEYS = {
  decks   : 'bq_decks_v6',
  tests   : 'bq_tests_v6',
  results : 'bq_results_v6',
  archived: 'bq_results_archived_v1',
  outbox  : 'bq_outbox_v1',
  clientId: 'bq_client_id_v1',
  schema  : 'bq_schema_version',
  outboxLock: 'bq_outbox_lock_v1'
};
const SCHEMA_VERSION = 1;
const ADMIN_VIEWS = new Set(['create','build','quizzes','reports','settings']);

//////////////////////////// utils ///////////////////////////////
const uid      = (p='id') => p+'_'+Math.random().toString(36).slice(2,10);
const todayISO = () => new Date().toISOString().slice(0,10);
const esc      = s => (s??'').toString().replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));
const shuffle  = a => { const x=a.slice(); for(let i=x.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]] } return x; };
const sample   = (a,n) => shuffle(a).slice(0,n);
const unique   = xs => Array.from(new Set(xs));
const deepCopy = obj => JSON.parse(JSON.stringify(obj));
const deckKey  = d => `${(d.className||'').trim().toLowerCase()}||${(d.deckName||'').trim().toLowerCase()}`;
const cardKey  = c => `${(c.q||'').trim().toLowerCase()}|${(c.a||'').trim().toLowerCase()}|${(c.sub||'').trim().toLowerCase()}`;

// tolerant name matcher for ?test=
const _smartMap = { '“':'"', '”':'"', '‘':'\'', '’':'\'' };
const normalizeName = raw => (decodeURIComponent(String(raw||''))
  .replace(/[“”‘’]/g, ch => _smartMap[ch] || ch)
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase());

function getClientId(){
  let id = store.get(KEYS.clientId, '');
  if(!id){
    id = uid('client');
    store.set(KEYS.clientId, id);
  }
  return id;
}

function migrateStorage(){
  const existing = Number(store.get(KEYS.schema, 0)) || 0;
  if(existing >= SCHEMA_VERSION) return;

  const decks = store.get(KEYS.decks, {});
  const tests = store.get(KEYS.tests, {});
  const results = store.get(KEYS.results, []);
  const archived = store.get(KEYS.archived, []);
  const outbox = store.get(KEYS.outbox, []);

  if(!decks || typeof decks !== 'object' || Array.isArray(decks)) store.set(KEYS.decks, {});
  if(!tests || typeof tests !== 'object' || Array.isArray(tests)) store.set(KEYS.tests, {});
  if(!Array.isArray(results)) store.set(KEYS.results, []);
  if(!Array.isArray(archived)) store.set(KEYS.archived, []);
  if(!Array.isArray(outbox)) store.set(KEYS.outbox, []);

  store.set(KEYS.schema, SCHEMA_VERSION);
}

//////////////////////// fetch helpers /////////////////////////
// Timeout wrapper (Safari-friendly)
async function fetchWithTimeout(url, opts={}, ms=7000){
  const controller = new AbortController();
  const t = setTimeout(()=>controller.abort(), ms);
  try{
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

//////////////////////// Cloud helpers /////////////////////////
// include API key on GET + cache-buster + no-store; use timeout + single retry
async function cloudGET(params={}){
  if(!CLOUD.BASE) throw new Error('CLOUD.BASE missing');
  const makeUrl = () => {
    const url = new URL(CLOUD.BASE);
    if (CLOUD.API_KEY) url.searchParams.set('key', CLOUD.API_KEY);
    Object.entries(params).forEach(([k,v])=> url.searchParams.set(k, String(v)));
    url.searchParams.set('_', String(Date.now())); // cache-buster
    return url.toString();
  };

  const tryOnce = async () => {
    const r = await fetchWithTimeout(makeUrl(), { method:'GET', cache:'no-store' }, 7000);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    if(json && typeof json === 'object' && 'ok' in json){
      if(json.ok) return json.data;
      throw new Error(json.error || 'Server error');
    }
    return json;
  };

  try{
    return await tryOnce();
  }catch(e){
    // small jittered backoff then one retry
    await new Promise(res => setTimeout(res, 500 + Math.random()*300));
    return await tryOnce();
  }
}

async function cloudPOST(action, payload={}){
  if(!CLOUD.BASE) throw new Error('CLOUD.BASE missing');
  const makeParams = () => {
    const params = new URLSearchParams();
    params.set('action', action);
    if (CLOUD.API_KEY) params.set('key', CLOUD.API_KEY);
    for (const [k,v] of Object.entries(payload)){
      params.set(k, (v && typeof v === 'object') ? JSON.stringify(v) : String(v));
    }
    return params;
  };

  const tryOnce = async () => {
    const r = await fetchWithTimeout(CLOUD.BASE, { method: 'POST', body: makeParams() }, 8000);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    if(json && typeof json === 'object' && 'ok' in json){
      if(json.ok) return json.data;
      throw new Error(json.error || 'Server error');
    }
    return json;
  };

  try{
    return await tryOnce();
  }catch(err){
    await new Promise(res => setTimeout(res, 500 + Math.random()*500));
    return await tryOnce();
  }
}

// GET list() → {decks, cards, tests}
async function getAllFromCloud(){
  const data = await cloudGET({action:'list'});
  if(!data || !Array.isArray(data.decks) || !Array.isArray(data.cards) || !Array.isArray(data.tests)){
    throw new Error('Malformed list() response');
  }

  // Decks map
  const decks = {};
  for(const d of data.decks){
    const id = d.deckId || d.id || uid('deck');
    const tagsArr =
      Array.isArray(d.tags) ? d.tags :
      typeof d.tags==='string' && d.tags ? String(d.tags).split('|').map(s=>s.trim()).filter(Boolean) : [];
    decks[id] = {
      id,
      className: d.className || '',
      deckName : d.deckName || (d.name || 'Deck'),
      cards    : [],
      tags     : tagsArr,
      createdAt: Number(d.createdAt || Date.now())
    };
  }

  // Cards into decks
  for(const c of data.cards){
    const deckId = c.deckId;
    if(!deckId || !decks[deckId]) continue;
    (decks[deckId].cards ||= []).push({
      id: c.cardId || uid('card'),
      q: c.q || '',
      a: c.a || '',
      distractors:
        Array.isArray(c.distractors) ? c.distractors :
        (typeof c.distractors==='string' && c.distractors ? String(c.distractors).split('|').map(s=>s.trim()).filter(Boolean) : []),
      sub: c.sub || '',
      createdAt: Number(c.createdAt || Date.now())
    });
  }

  // Tests map (parse selectionsJSON)
  const tests = {};
  for(const t of data.tests){
    const id = t.testId || t.id || uid('test');
    let sel = [];
    if (Array.isArray(t.selections)) sel = t.selections;
    else if (typeof t.selectionsJSON === 'string') {
      try { sel = JSON.parse(t.selectionsJSON) || []; } catch { sel = []; }
    }
    tests[id] = {
      id,
      name : t.name || 'Test',
      title: t.title || t.name || 'Test',
      n    : Math.max(1, Number(t.n || 30)),
      selections: sel
    };
  }

  return {decks, tests};
}

function makeBackupObject(){
  return {
    schema : 'bq_backup_v1',
    exportedAt: Date.now(),
    decks   : state.decks,
    tests   : state.tests,
    results : state.results,
    archived: state.archived
  };
}

async function cloudPullHandler(){
  try{
    const localDecks = Object.keys(state.decks || {}).length;
    const localTests = Object.keys(state.tests || {}).length;
    if(localDecks || localTests){
      const ok = confirm(`Pull from Cloud?\n\nThis will replace your local decks/tests with the Cloud version.\nLocal changes not in the Cloud may be lost.\n\nLocal: ${localDecks} deck(s), ${localTests} test(s).`);
      if(!ok) return;
    }
    $('#cloudPullBtn')?.setAttribute('disabled','true');
    const {decks, tests} = await getAllFromCloud();
    state.decks = decks; state.tests = tests;
    mergeDecksByName(); normalizeTests();
    saveDecks();
    saveTests();
    renderCreate(); renderBuild(); renderReports();
    toast('Pulled from Cloud');
  }catch(err){
    const hint = (String(err||'').includes('HTTP 403')||String(err||'').toLowerCase().includes('key')) ? ' • Check API key' : '';
    alert('Cloud pull failed: '+(err.message||err)+hint);
  }finally{ $('#cloudPullBtn')?.removeAttribute('disabled'); }
}

async function cloudPushHandler(){
  const modeMerge = confirm('Push to Cloud?\n\nOK = MERGE into Sheets\nCancel = REPLACE (overwrite Sheets with local)');
  try{
    $('#cloudPushBtn')?.setAttribute('disabled','true');
    const backup = makeBackupObject();
    const resp = await cloudPOST('bulkupsert', { ...backup, mode: modeMerge ? 'merge' : 'replace' });
    if(resp && (resp.status === 'ok')){
      toast(modeMerge ? 'Merged to Cloud' : 'Replaced in Cloud');
    } else {
      throw new Error(JSON.stringify(resp||{}));
    }
  }catch(err){
    alert('Cloud push failed: '+(err.message||err));
  }finally{ $('#cloudPushBtn')?.removeAttribute('disabled'); }
}

async function resultsRefreshFromCloud(){
  try{
    const rows = await cloudGET({action:'results',limit:500});
    if(!Array.isArray(rows)) throw new Error('Bad results response');

    state.results = rows.map(r=>({
      id      : r.resId || r.id || uid('res'),
      name    : r.name || '',
      location: r.location || '',
      date    : r.date || '',
      time    : Number(r.timeEpoch || r.time || Date.now()),
      testId  : r.testId || '',
      testName: r.testName || '',
      score   : Number(r.score || 0),
      correct : Number(r.correct || 0),
      of      : Number(r.of || 0),
      answers : (()=>{ try { return JSON.parse(r.answersJSON||'[]'); } catch { return []; }})()
    }));

    saveResults();
    renderReports();
    toast('Results pulled from Cloud');
  }catch(err){
    alert('Failed to refresh results: '+(err.message||err));
  }
}

/* ---------------------- UPDATED (drop-in) ---------------------- */
// single-flight guard + loading banner control
let __hydratingPromise = null;
function setStudentLoading(on, msg='Loading latest decks & tests…'){
  const banner = $('#studentLoading');
  if(!banner) return;
  banner.textContent = msg;
  banner.classList.toggle('hidden', !on);
  // disable selects/buttons while loading
  const disable = sel => sel && (sel.disabled = on);
  disable($('#practiceTestSelect'));
  disable($('#quizTestSelect'));
  disable($('#startPracticeBtn'));
  disable($('#quizPrev'));
  disable($('#quizNext'));
  disable($('#submitQuizBtn'));
}

// Force refresh when student mode, otherwise only when empty; retry built into cloudGET
async function maybeHydrateFromCloud(force = false){
  if(__hydratingPromise) return __hydratingPromise;
  const student = isStudent();
  const needHydrate =
    force ||
    (Object.keys(state.decks||{}).length===0 && Object.keys(state.tests||{}).length===0);

  if(!needHydrate) return;

  __hydratingPromise = (async () => {
    try{
      if(student) setStudentLoading(true);
      const {decks, tests} = await getAllFromCloud();
      state.decks = decks; state.tests = tests;
      saveDecks();
      saveTests();
    }catch(err){
      console.warn('Cloud hydrate failed:', err.message||err);
      if(!student){
        toast('Cloud pull failed (working from local).', 2200);
      }else{
        // subtle banner for students
        setStudentLoading(true, 'Unable to reach Cloud. Using any saved data…');
        setTimeout(()=>setStudentLoading(false), 1500);
      }
    }finally{
      if(student) setStudentLoading(false);
      __hydratingPromise = null;
    }
  })();

  return __hydratingPromise;
}
/* --------------------------------------------------------------- */

/////////////////////////// global state /////////////////////////
migrateStorage();
const clientId = getClientId();

let state = {
  decks   : store.get(KEYS.decks, {}),
  tests   : store.get(KEYS.tests, {}),
  results : store.get(KEYS.results, []),
  archived: store.get(KEYS.archived, []),
  outbox  : store.get(KEYS.outbox, []),
  practice: { cards:[], idx:0 },
  quiz    : { items:[], idx:0, n:30, locked:false, testId:'', submitting:false },
  ui      : { currentTestId: null, subFilter: '' },
  meta    : { decksVersion: 0, testsVersion: 0, resultsVersion: 0, archivedVersion: 0 }
};

//////////////////////////// outbox //////////////////////////////
let __outboxFlushPromise = null;
const cache = {
  deckListVersion: -1,
  deckList: [],
  missedVersion: -1,
  missedHtml: '',
  locationKey: '',
  locationHtml: ''
};

function saveDecks(){ store.set(KEYS.decks, state.decks); state.meta.decksVersion++; }
function saveTests(){ store.set(KEYS.tests, state.tests); state.meta.testsVersion++; }
function saveResults(){ store.set(KEYS.results, state.results); state.meta.resultsVersion++; }
function saveArchived(){ store.set(KEYS.archived, state.archived); state.meta.archivedVersion++; }

function validateResultRow(row){
  if(!row) return 'Missing result payload';
  if(!row.id) return 'Missing result id';
  if(!row.name) return 'Missing name';
  if(!row.location) return 'Missing location';
  if(!row.date) return 'Missing date';
  if(!row.testId) return 'Missing test id';
  if(!row.testName) return 'Missing test name';
  if(!Array.isArray(row.answers)) return 'Missing answers';
  return '';
}
function persistOutbox(){ store.set(KEYS.outbox, state.outbox); updateOutboxIndicator(); }
function updateOutboxIndicator(){
  const el = document.getElementById('outboxStatus');
  if(!el) return;
  const count = state.outbox.length;
  el.textContent = count ? `Pending sync: ${count}` : 'All synced';
  el.classList.toggle('pending', count > 0);
}
function ensureOutboxIndicator(){
  if(document.getElementById('outboxStatus')) return;
  const footer = document.querySelector('.footer');
  if(!footer) return;
  const span = document.createElement('span');
  span.id = 'outboxStatus';
  span.className = 'hint';
  span.style.marginLeft = '8px';
  footer.appendChild(span);
  updateOutboxIndicator();
}
function enqueueOutbox(action, payload){
  const exists = state.outbox.some(item => item.action === action && item.id === payload.id);
  if(exists) return;
  state.outbox.push({
    id: payload.id,
    action,
    payload,
    tries: 0,
    nextAttemptAt: 0,
    lastError: ''
  });
  persistOutbox();
}
function isOutboxPending(id){
  return state.outbox.some(item => item.id === id);
}
function acquireOutboxLock(){
  const now = Date.now();
  const existing = Number(localStorage.getItem(KEYS.outboxLock) || 0);
  if(existing && now - existing < 15000) return false;
  localStorage.setItem(KEYS.outboxLock, String(now));
  return true;
}
function releaseOutboxLock(){
  const existing = Number(localStorage.getItem(KEYS.outboxLock) || 0);
  if(existing) localStorage.removeItem(KEYS.outboxLock);
}
async function flushOutbox(forceToast=false){
  if(__outboxFlushPromise) return __outboxFlushPromise;
  if(!state.outbox.length) return;
  if(!acquireOutboxLock()) return;

  __outboxFlushPromise = (async ()=>{
    const now = Date.now();
    const remaining = [];
    let sent = 0;
    for(const item of state.outbox){
      if(item.nextAttemptAt && item.nextAttemptAt > now){ remaining.push(item); continue; }
      try{
        await cloudPOST(item.action, item.payload);
        sent++;
      }catch(err){
        item.tries = (item.tries || 0) + 1;
        item.lastError = String(err?.message || err || 'Unknown error');
        const backoffMs = Math.min(60000, 1000 * Math.pow(2, Math.min(item.tries, 6)));
        item.nextAttemptAt = Date.now() + backoffMs;
        remaining.push(item);
      }
    }
    state.outbox = remaining;
    persistOutbox();
    if(forceToast && sent){ toast(`Synced ${sent} queued result${sent===1?'':'s'}.`); }
  })().finally(()=>{
    releaseOutboxLock();
    __outboxFlushPromise = null;
  });

  return __outboxFlushPromise;
}

//////////////////////////// toasts //////////////////////////////
function toast(msg, ms=1800){
  const t = $('#toast'); if(!t){ alert(msg); return; }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>t.classList.remove('show'), ms);
}

/////////////////////////// routing //////////////////////////////
const qs = () => new URLSearchParams(location.search);
function setParams(obj){
  const p = qs();
  for(const [k,v] of Object.entries(obj)){ if(v==null) p.delete(k); else p.set(k,v); }
  history.pushState(null,'',location.pathname+'?'+p);
}
function isStudent(){ return qs().get('mode')==='student'; }

function activate(view){
  if(isStudent() && ADMIN_VIEWS.has(view)){ view='practice'; setParams({view}); }
  window.removeEventListener('keydown', window.__bqPracticeKeys__);
  window.removeEventListener('keydown', window.__bqQuizKeys__);

  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-'+view));
  $$('.menu-item').forEach(i => i.classList.toggle('active', i.dataset.route===view));
  $$('.student-nav-btn').forEach(i => i.classList.toggle('active', i.dataset.route===view));

  if(view==='create')   renderCreate();
  if(view==='build')    renderBuild();
  if(view==='practice') renderPracticeScreen();
  if(view==='quiz')     renderQuizScreen();
  if(view==='grades')   renderGrades();
  if(view==='quizzes')  renderQuizzes();
  if(view==='reports')  renderReports();
  if(view==='settings') renderSettings();

  closeMenu();
}
window.addEventListener('popstate', ()=>activate(qs().get('view')||'create'));

/////////////////////// mobile menu (robust) /////////////////////
function menuEls(){ return { btn: $('#menuBtn'), list: $('#menuList') }; }
function openMenu(){ const {btn,list}=menuEls(); if(!btn||!list) return; list.classList.add('open'); btn.setAttribute('aria-expanded','true'); }
function closeMenu(){ const {btn,list}=menuEls(); if(!btn||!list) return; list.classList.remove('open'); btn.setAttribute('aria-expanded','false'); }
function toggleMenu(e){ const {btn,list}=menuEls(); if(!btn||!list) return; e&&e.stopPropagation(); list.classList.contains('open')?closeMenu():openMenu(); }
(function bindMenu(){
  const {btn,list}=menuEls(); if(!btn||!list) return;
  btn.addEventListener('click', toggleMenu);
  list.addEventListener('click', (e)=>{
    const item = e.target.closest('.menu-item'); if(!item) return;
    const route = item.dataset.route; if(route){ setParams({view:route}); activate(route); }
    closeMenu();
  });
  document.addEventListener('click', (e)=>{
    const studentBtn = e.target.closest('.student-nav-btn');
    if(!studentBtn) return;
    const route = studentBtn.dataset.route;
    if(route){ setParams({view:route}); activate(route); }
  });
  document.addEventListener('click', e=>{ if(!e.target.closest('.menu')) closeMenu(); });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu, {passive:true});
  window.addEventListener('orientationchange', closeMenu, {passive:true});
})();

/////////////////////// student mode /////////////////////////////
function applyStudentMode(){
  const p = qs(); const student = isStudent();
  document.body.classList.toggle('student', student);
  if(student){
    const nameRaw = p.get('test')||'';
    const name = normalizeName(nameRaw);
    if(name){
      const entry = Object.entries(state.tests)
        .find(([,t])=> normalizeName(t.name) === name);
      if(entry){ state.quiz.locked=true; state.quiz.testId=entry[0]; }
    }
    const next = p.get('view') && !ADMIN_VIEWS.has(p.get('view')) ? p.get('view') : 'practice';
    setParams({view:next});
  }
}

/////////////////////// deck merge helpers ///////////////////////
function listUniqueDecks(){
  if(cache.deckListVersion === state.meta.decksVersion && cache.deckList.length){
    return cache.deckList.slice();
  }
  const seen=new Set(), arr=[];
  for(const d of Object.values(state.decks)){
    const k=deckKey(d); if(!seen.has(k)){ seen.add(k); arr.push(d); }
  }
  arr.sort((a,b)=> (a.className||'').localeCompare(b.className||'') || (a.deckName||'').localeCompare(b.deckName||'')); 
  cache.deckListVersion = state.meta.decksVersion;
  cache.deckList = arr.slice();
  return arr;
}
function deckSubTags(d){
  const fromCards=(d.cards||[]).map(c=>c.sub||'').filter(Boolean);
  const declared=(d.tags||[]);
  const legacy=d.subdeck?[d.subdeck]:[];
  return unique([...fromCards,...declared,...legacy]).sort((a,b)=>a.localeCompare(b));
}
function mergeDecksByName(){
  const mapByKey=new Map(), idRemap=new Map();
  for(const [id,d] of Object.entries(state.decks)){
    d.cards=Array.isArray(d.cards)?d.cards:[]; d.tags=Array.isArray(d.tags)?d.tags:[];
    const k=deckKey(d);
    if(!mapByKey.has(k)){ mapByKey.set(k,id); if(d.subdeck) d.tags=unique([...(d.tags||[]),d.subdeck]); continue; }
    const primaryId=mapByKey.get(k), P=state.decks[primaryId];
    P.cards=[...(P.cards||[]),...(d.cards||[])];
    P.tags=unique([...(P.tags||[]),...(d.tags||[]),...(d.subdeck?[d.subdeck]:[])]);
    idRemap.set(id,primaryId);
    delete state.decks[id];
  }
  let changed=false;
  for(const t of Object.values(state.tests)){
    if(!t.selections) continue;
    for(const sel of t.selections){
      if(idRemap.has(sel.deckId)){ sel.deckId=idRemap.get(sel.deckId); changed=true; }
    }
    t.selections=dedupeSelections(t.selections||[]);
  }
  if(changed) saveTests();
  saveDecks();
}

// ---- Always-visible CTA to load/refresh tests from Cloud ----
async function loadTestsNow(btn){
  const beforeTests = Object.keys(state.tests || {}).length;
  const beforeDecks = Object.keys(state.decks || {}).length;

  try{
    if(btn){
      btn.disabled = true;
      btn.textContent = 'Loading…';
      btn.style.opacity = '0.7';
    }

    // Force pull from Apps Script
    await maybeHydrateFromCloud(true);

    // Normalize + persist
    mergeDecksByName();
    normalizeTests();
    saveDecks();
    saveTests();

    // Re-render UI that depends on tests
    renderCreate();
    renderBuild();
    renderPracticeScreen();
    renderQuizScreen();

    const afterTests = Object.keys(state.tests || {}).length;
    const afterDecks = Object.keys(state.decks || {}).length;

    // Build a friendly status
    const deltaTests = afterTests - beforeTests;
    const deltaDecks = afterDecks - beforeDecks;
    const parts = [];
    parts.push(`${afterTests} test${afterTests===1?'':'s'}`);
    parts.push(`${afterDecks} deck${afterDecks===1?'':'s'}`);
    const deltaText =
      (deltaTests || deltaDecks)
        ? ` (+${Math.max(0,deltaTests)} tests, +${Math.max(0,deltaDecks)} decks)`
        : '';

    toast(`Loaded ${parts.join(' & ')}${deltaText}. Select a test above to begin.`, 3200);

  }catch(err){
    console.error('Load/Refresh failed:', err);
    alert('Failed to load from Cloud: ' + (err?.message || err));
  }finally{
    if(btn){
      btn.disabled = false;
      btn.textContent = 'Click Here to Load or Refresh Quizes'; // change to “Quizzes” if desired
      btn.style.opacity = '1';
    }
  }
}

function ensureLoadTestsCTA(whereEl){
  // Avoid duplicates
  if(document.getElementById('loadTestsBtnWrap')) return;

  // Default host is the Practice card; fall back to view container
  const host = whereEl || document.querySelector('#view-practice .card') || document.querySelector('#view-practice') || document.body;

  const wrap = document.createElement('div');
  wrap.id = 'loadTestsBtnWrap';
  wrap.style.textAlign = 'center';
  wrap.style.margin = '12px 0';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id   = 'loadTestsBtn';
  btn.textContent = 'Click Here to Load or Refresh Quizes'; // (keep your wording)
  btn.style.fontSize = '18px';
  btn.style.fontWeight = '800';
  btn.style.padding = '16px 22px';
  btn.style.borderRadius = '999px';
  btn.style.border = '0';
  btn.style.cursor = 'pointer';
  btn.style.boxShadow = '0 10px 30px rgba(0,0,0,.35)';
  btn.style.transition = 'transform .05s ease';
  btn.style.color = '#0b1220';
  btn.style.background = 'linear-gradient(90deg, #64d6ff, #6ff)';
  btn.onpointerdown = ()=> btn.style.transform = 'scale(.985)';
  btn.onpointerup   = ()=> btn.style.transform = 'scale(1)';
  btn.onclick = ()=> loadTestsNow(btn);

  const hint = document.createElement('div');
  hint.textContent = 'Loads/refreshes decks & tests from the Cloud (Google Sheet).';
  hint.style.fontSize = '12px';
  hint.style.opacity = '.8';
  hint.style.marginTop = '8px';

  wrap.appendChild(btn);
  wrap.appendChild(hint);

  // Try to put it near the “Select Test” UI
  const slot = document.querySelector('#view-practice .card .grid') || host;
  slot.prepend(wrap);
}


//////////////////////////// CREATE //////////////////////////////
function renderCreate(){
  ensureBackupButtons(); // adds Export/Import + Cloud Pull/Push if missing

  const classListEl = $('#classNames');
  const deckListEl  = $('#deckNames');
  if (classListEl && deckListEl){
    const arr=listUniqueDecks();
    const classes=unique(arr.map(d=>d.className).filter(Boolean)).sort();
    const decks=unique(arr.map(d=>d.deckName).filter(Boolean)).sort();
    classListEl.innerHTML=classes.map(v=>`<option value="${esc(v)}"></option>`).join('');
    deckListEl.innerHTML=decks.map(v=>`<option value="${esc(v)}"></option>`).join('');
  }

  renderDeckSelect();
  renderDeckMeta();
  renderSubdeckManager();
  renderFolderTree();
  renderCardsList();

  bindOnce($('#createSubdeckBtn'),'click',createSubdeck);
  bindOnce($('#toggleSubdeckBtn'),'click',toggleNewSubdeck);
  bindOnce($('#addDeckBtn'),'click',addDeck);
  bindOnce($('#renameDeckBtn'),'click',renameDeck);
  bindOnce($('#editDeckMetaBtn'),'click',editDeckMeta);
  bindOnce($('#deleteDeckBtn'),'click',deleteDeck);
  bindOnce($('#exportDeckBtn'),'click',exportDeck);
  bindOnce($('#importDeckBtn'),'click',()=>{ toast('Choose a JSON or TXT file to import…',1400); $('#importDeckInput')?.click(); });
  bindOnce($('#importDeckInput'),'change',importDeckInputChange);
  bindOnce($('#bulkSummaryBtn'),'click',()=>setTimeout(()=>toast('Format: Q | Correct | Wrong1 | Wrong2 | Wrong3 | #Sub-deck(optional)'),60));
  bindOnce($('#bulkAddBtn'),'click',bulkAddCards);
  bindOnce($('#addCardBtn'),'click',addCard);

  bindOnce($('#deckSelect'),'change',()=>{ 
    state.ui.subFilter=''; 
    renderDeckMeta(); renderSubdeckManager(); renderFolderTree(); renderCardsList(); 
  });
}

function renderSettings(){
  ensureBackupButtons();
  bindOnce($('#cloudPullBtn'),'click',cloudPullHandler);
  bindOnce($('#cloudPushBtn'),'click',cloudPushHandler);
  bindOnce($('#bulkGlobalAddBtn'),'click',bulkAddGlobalCards);
}

function renderDeckSelect(){
  const deckSelect = $('#deckSelect'); if(!deckSelect) return;
  const arr=listUniqueDecks();
  if(arr.length===0){ deckSelect.innerHTML=`<option value="">No decks yet</option>`; return; }
  deckSelect.innerHTML=arr.map(d=>{
    const subs=deckSubTags(d);
    const subTxt=subs.length?` • ${subs.length} sub-deck${subs.length>1?'s':''}`:''; 
    return `<option value="${d.id}">${esc(d.deckName)} (${d.cards.length}) [${esc(d.className)}${subTxt}]</option>`;
  }).join('');
  deckSelect.style.pointerEvents='auto';
}
function selectedDeckId(){const id=$('#deckSelect')?.value;return id&&state.decks[id]?id:null}

function renderDeckMeta(){
  const titleEl=$('#deckMetaTitle'), subsEl=$('#deckMetaSubs'); if(!titleEl||!subsEl) return;
  const id=selectedDeckId();
  if(!id){ titleEl.textContent='No deck selected'; subsEl.innerHTML=''; return; }
  const d=state.decks[id]; const subs=deckSubTags(d);
  titleEl.textContent=`${d.deckName} — ${d.className} • ${d.cards.length} card${d.cards.length!==1?'s':''}`;
  subsEl.innerHTML=subs.length?subs.map(s=>`
    <span class="chip">${esc(s)} <button class="remove" data-sub="${esc(s)}" title="Remove tag" aria-label="Remove tag">&times;</button></span>
  `).join(''):`<span class="hint">No sub-decks yet</span>`;
  bindOnce(subsEl, 'click', (event)=>{
    const btn = event.target.closest('.remove');
    if(!btn) return;
    const tag=btn.dataset.sub;
    const alsoClear=confirm(`Remove sub-deck “${tag}” from deck tags?\n\nOK = also clear this tag from ALL cards.\nCancel = just remove declared tag.`);
    d.tags=(d.tags||[]).filter(t=>t!==tag);
    if(alsoClear){ (d.cards||[]).forEach(c=>{ if((c.sub||'')===tag) c.sub=''; }); }
    saveDecks();
    renderDeckMeta(); renderSubdeckManager(); renderFolderTree(); renderCardsList();
  }, 'deckMetaRemove');

  const subSel = $('#cardsSubFilter');
  if(subSel){
    const curr = state.ui.subFilter || '';
    subSel.innerHTML = `<option value="">All sub-decks</option>` + subs.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if(curr && subs.includes(curr)) subSel.value = curr; else subSel.value = '';
    subSel.onchange = ()=>{ state.ui.subFilter = subSel.value || ''; renderCardsList(); };
  }
  renderFolderTree();
}
function renderSubdeckManager(){
  const list=$('#subdeckManagerList'); if(!list) return;
  const id=selectedDeckId();
  if(!id){ list.innerHTML='<span class="hint">Select a deck first.</span>'; return; }
  const d=state.decks[id]; const subs=deckSubTags(d);
  list.innerHTML=subs.length?subs.map(s=>`
    <span class="chip">${esc(s)} <button class="remove" data-sub="${esc(s)}" title="Remove tag" aria-label="Remove tag">&times;</button></span>
  `).join(''):`<span class="hint">No sub-decks yet.</span>`;
  bindOnce(list, 'click', (event)=>{
    const btn = event.target.closest('.remove');
    if(!btn) return;
    const tag=btn.dataset.sub;
    const alsoClear=confirm(`Remove sub-deck “${tag}” from deck tags?\n\nOK = also clear this tag from ALL cards.\nCancel = just remove declared tag.`);
    d.tags=(d.tags||[]).filter(t=>t!==tag);
    if(alsoClear){ (d.cards||[]).forEach(c=>{ if((c.sub||'')===tag) c.sub=''; }); }
    saveDecks();
    renderDeckMeta(); renderSubdeckManager(); renderFolderTree(); renderCardsList();
  }, 'subdeckRemove');
}
function renderFolderTree(){
  const tree = $('#folderTree'); if(!tree) return;
  const decks = Object.values(state.decks || {});
  if(!decks.length){ tree.innerHTML = '<div class="hint">No folders yet. Create a deck to get started.</div>'; return; }

  const selectedDeck = selectedDeckId();
  const selectedSub = (state.ui.subFilter || '').trim();

  const classMap = new Map();
  for(const d of decks){
    const cls = (d.className || 'Uncategorized').trim() || 'Uncategorized';
    if(!classMap.has(cls)) classMap.set(cls, []);
    classMap.get(cls).push(d);
  }

  const classes = [...classMap.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  tree.innerHTML = classes.map(([cls, classDecks])=>{
    const sortedDecks = classDecks.slice().sort((a,b)=>a.deckName.localeCompare(b.deckName));
    const deckHtml = sortedDecks.map(d=>{
      const subs = deckSubTags(d);
      const totalCards = (d.cards || []).length;
      const deckSelected = selectedDeck === d.id && !selectedSub;
      const subsHtml = subs.map(s=>{
        const count = (d.cards || []).filter(c=>String(c.sub||'')===String(s)).length;
        const subSelected = selectedDeck === d.id && selectedSub === s;
        return `<button class="folder-link sub-link ${subSelected?'selected':''}" data-deck="${d.id}" data-sub="${esc(s)}">
          <span class="name">${esc(s)}</span><span class="count">${count}</span>
        </button>`;
      }).join('');

      return `<div class="folder-deck">
        <div class="folder-row">
          <button class="folder-link deck-link ${deckSelected?'selected':''}" data-deck="${d.id}">
            <span class="name">${esc(d.deckName)}</span>
            <span class="meta">(${totalCards} card${totalCards!==1?'s':''})</span>
          </button>
          <button class="btn ghost tiny add-sub" data-deck="${d.id}">+ Subfolder</button>
        </div>
        ${subsHtml?`<div class="folder-subs">${subsHtml}</div>`:'<div class="hint mt-sm">No subfolders yet.</div>'}
      </div>`;
    }).join('');

    return `<details class="folder-group" open>
      <summary>
        <span class="name">${esc(cls)}</span>
        <span class="count">${sortedDecks.length} deck${sortedDecks.length!==1?'s':''}</span>
      </summary>
      <div class="folder-decks">${deckHtml}</div>
    </details>`;
  }).join('');

  bindOnce(tree, 'click', (event)=>{
    const addBtn = event.target.closest('.add-sub');
    if(addBtn){
      const deckId = addBtn.dataset.deck;
      const d = state.decks[deckId];
      if(!d) return;
      const next = prompt('New subfolder name:');
      if(next == null) return;
      const name = next.trim();
      if(!name) return alert('Subfolder name cannot be empty.');
      d.tags = unique([...(d.tags||[]), name]);
      saveDecks();
      renderDeckMeta(); renderSubdeckManager(); renderFolderTree(); renderCardsList();
      return;
    }

    const deckLink = event.target.closest('.deck-link');
    const subLink = event.target.closest('.sub-link');
    if(!deckLink && !subLink) return;
    const deckId = (deckLink || subLink).dataset.deck;
    const sub = subLink ? subLink.dataset.sub : '';
    setSelectedFolder(deckId, sub);
  }, 'folderTree');
}
function setSelectedFolder(deckId, sub){
  const deckSelect = $('#deckSelect');
  if(deckSelect) deckSelect.value = deckId || '';
  state.ui.subFilter = sub || '';
  const subSel = $('#cardsSubFilter');
  if(subSel) subSel.value = sub || '';
  const cardSubInput = $('#cardSubInput');
  if(cardSubInput && sub) cardSubInput.value = sub;
  renderDeckMeta(); renderSubdeckManager(); renderFolderTree(); renderCardsList();
}
function renderCardsList(){
  const cardsList=$('#cardsList'); if(!cardsList) return;
  renderFolderTree();
  const id=selectedDeckId();
  if(!id){ cardsList.innerHTML='<div class="hint">Create a deck, then add cards.</div>'; return; }
  const d=state.decks[id];

  const subFilter = ($('#cardsSubFilter')?.value || state.ui.subFilter || '').trim();
  const list = subFilter ? (d.cards||[]).filter(c => (c.sub||'') === subFilter) : (d.cards||[]);

  if(!list.length){ cardsList.innerHTML='<div class="hint">No cards yet—add your first one above.</div>'; return; }
  cardsList.innerHTML=list.map(c=>`
    <div class="cardline" data-id="${c.id}">
      <div><strong>Q:</strong> ${esc(c.q)}</div>
      <div><strong>Correct:</strong> ${esc(c.a)}<br><span class="hint">Wrong:</span> ${esc((c.distractors||[]).join(' | '))}${c.sub? `<br><span class="hint">Sub-deck: ${esc(c.sub)}</span>`:''}</div>
      <div class="actions"><button class="btn ghost btn-edit">Edit</button><button class="btn danger btn-del">Delete</button></div>
    </div>`).join('');

  bindOnce(cardsList, 'click', (event)=>{
    const delBtn = event.target.closest('.btn-del');
    const editBtn = event.target.closest('.btn-edit');
    if(!delBtn && !editBtn) return;
    const keepDeckId = selectedDeckId(); if(!keepDeckId) return;
    const y = window.scrollY;
    const deck = state.decks[keepDeckId];
    const cid = event.target.closest('.cardline')?.dataset.id;
    if(!cid || !deck) return;

    if(delBtn){
      deck.cards = deck.cards.filter(c=>c.id!==cid);
      saveDecks();
      renderDeckSelect();
      const deckSelect = $('#deckSelect');
      if (deckSelect) deckSelect.value = keepDeckId;
      renderDeckMeta(); renderSubdeckManager(); renderCardsList();
      window.scrollTo(0, y);
      toast('Card deleted');
      return;
    }

    if(editBtn){
      const card = deck.cards.find(c=>c.id===cid); if(!card) return;
      const q=prompt('Question:',card.q); if(q===null) return;
      const a=prompt('Correct answer:',card.a); if(a===null) return;
      const wrong=prompt('Wrong answers (separate by |):',(card.distractors||[]).join('|'));
      const sub=prompt('Card sub-deck (optional):',card.sub||''); if(sub===null) return;
      card.q=q.trim(); card.a=a.trim(); card.distractors=(wrong||'').split('|').map(s=>s.trim()).filter(Boolean); card.sub=sub.trim();
      if(card.sub){ deck.tags=unique([...(deck.tags||[]),card.sub]); }
      saveDecks(); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
      toast('Card updated');
    }
  }, 'cardsList');
}

function renderGrades(){
  const list = $('#gradesList'); if(!list) return;
  const local = (state.results || []).filter(r => !r.clientId || r.clientId === clientId);
  if(!local.length){
    list.innerHTML = '<div class="hint">No grades yet. Submit a quiz to see your results here.</div>';
    return;
  }
  const rows = local
    .slice()
    .sort((a,b)=> (b.time || b.timeEpoch || 0) - (a.time || a.timeEpoch || 0))
    .map(r=>{
      const when = r.date || (r.time || r.timeEpoch ? new Date(r.time || r.timeEpoch).toLocaleDateString() : '');
      const score = typeof r.score === 'number' ? `${r.score}%` : '';
      const of = Number.isFinite(r.correct) && Number.isFinite(r.of) ? ` (${r.correct}/${r.of})` : '';
      return `<div class="cardline">
        <div><strong>${esc(r.testName || 'Quiz')}</strong><div class="hint">${esc(when)}</div></div>
        <div><strong>${esc(score)}</strong>${esc(of)}</div>
      </div>`;
    }).join('');
  list.innerHTML = rows;
}

function renderQuizzes(){
  const sel = $('#quizShareSelect');
  const list = $('#quizShareList');
  const tests = Object.values(state.tests || {}).slice().sort((a,b)=>testDisplayName(a).localeCompare(testDisplayName(b)));

  if(sel){
    if(!tests.length){
      sel.innerHTML = '<option value="">No quizzes yet</option>';
    } else {
      sel.innerHTML = tests.map(t=>`<option value="${esc(t.id)}">${esc(testDisplayName(t))}</option>`).join('');
    }
  }

  if(list){
    if(!tests.length){
      list.innerHTML = '<div class="hint">No quizzes yet. Build a quiz first.</div>';
    } else {
      list.innerHTML = tests.map(t=>`
        <div class="cardline" data-id="${t.id}">
          <div><strong>${esc(testDisplayName(t))}</strong><div class="hint">${esc(t.name || '')}</div></div>
          <div><span class="hint">Questions:</span> ${t.n || 0}</div>
          <div class="actions">
            <button class="btn ghost btn-copy-link">Copy Link</button>
            <button class="btn btn-open-link">Open</button>
          </div>
        </div>
      `).join('');
    }
  }

  bindOnce($('#quizShareCopyBtn'),'click',()=>copyShareLinkForId(sel?.value));
  bindOnce($('#quizShareOpenBtn'),'click',()=>openShareLinkForId(sel?.value));
  if(list){
    bindOnce(list, 'click', (event)=>{
      const row = event.target.closest('.cardline'); if(!row) return;
      const id = row.dataset.id;
      if(event.target.closest('.btn-copy-link')) return copyShareLinkForId(id);
      if(event.target.closest('.btn-open-link')) return openShareLinkForId(id);
    }, 'quizShareList');
  }
}

function buildShareUrlForTest(t){
  const url=new URL(location.href);
  url.searchParams.set('mode','student');
  url.searchParams.set('test',t.name);
  url.searchParams.set('view','practice');
  return url.toString();
}
function copyShareLinkForId(id){
  const t = state.tests?.[id];
  if(!t) return alert('Select a quiz first.');
  navigator.clipboard.writeText(buildShareUrlForTest(t));
  toast('Quiz link copied');
}
function openShareLinkForId(id){
  const t = state.tests?.[id];
  if(!t) return alert('Select a quiz first.');
  open(buildShareUrlForTest(t),'_blank');
}

// CREATE handlers
function createSubdeck(){
  const id=selectedDeckId(); if(!id) return alert('Select a deck first.');
  const name=($('#subdeckNewName')?.value||'').trim(); if(!name) return;
  const d=state.decks[id]; d.tags=unique([...(d.tags||[]),name]);
  saveDecks(); $('#subdeckNewName').value='';
  renderDeckMeta(); renderSubdeckManager(); toast('Sub-deck added');
}
function toggleNewSubdeck(){
  const el=$('#newSubdeck'); if(!el) return;
  const isHidden=el.classList.toggle('hidden');
  $('#toggleSubdeckBtn')?.setAttribute('aria-expanded', String(!isHidden));
}
function addDeck(){
  const cls=$('#newClassName')?.value.trim();
  const dnm=$('#newDeckName')?.value.trim();
  const sdn=$('#newSubdeck')?.classList.contains('hidden')?'':($('#newSubdeck')?.value.trim()||'');
  if(!cls||!dnm) return alert('Class and Deck are required.');

  let existing=Object.values(state.decks).find(d=>(d.className||'').toLowerCase()===cls.toLowerCase()&&(d.deckName||'').toLowerCase()===dnm.toLowerCase());
  if(existing){
    const deckSelect=$('#deckSelect'); if(deckSelect) deckSelect.value=existing.id;
    if(sdn){ existing.tags=unique([...(existing.tags||[]),sdn]); saveDecks(); }
    renderDeckMeta(); renderSubdeckManager(); renderCardsList(); renderDeckSelect();
    toast('Selected existing deck'); return;
  }
  const id=uid('deck');
  state.decks[id]={id,className:cls,deckName:dnm,cards:[],tags:sdn?[sdn]:[],createdAt:Date.now()};
  saveDecks();

  if($('#newClassName')) $('#newClassName').value='';
  if($('#newDeckName'))  $('#newDeckName').value='';
  if($('#newSubdeck')){ $('#newSubdeck').value=''; $('#newSubdeck').classList.add('hidden'); }

  renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
  const deckSelect=$('#deckSelect'); if (deckSelect){ deckSelect.value = id; }
  toast('Deck created');
}
function renameDeck(){
  const id=selectedDeckId(); if(!id) return;
  const d=state.decks[id];
  const cls=prompt('Class:',d.className||''); if(cls===null) return;
  const dnk=prompt('Deck (by name):',d.deckName||''); if(dnk===null) return;
  d.className=cls.trim(); d.deckName=dnk.trim();
  saveDecks(); mergeDecksByName();
  renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
  toast('Deck renamed');
}
function editDeckMeta(){
  const id=selectedDeckId(); if(!id) return;
  const d=state.decks[id];
  const cls=prompt('Edit Class:',d.className||''); if(cls===null) return;
  d.className=cls.trim();
  saveDecks(); mergeDecksByName();
  renderDeckSelect(); renderDeckMeta();
  toast('Meta updated');
}
function deleteDeck(){
  const id=selectedDeckId(); if(!id) return;
  if(confirm('Delete this deck and its cards?')){
    delete state.decks[id];
    saveDecks();
    renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
    toast('Deck deleted');
  }
}
function exportDeck(){
  const id=selectedDeckId(); if(!id) return;
  const blob=new Blob([JSON.stringify(state.decks[id],null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=`${(state.decks[id].deckName||'Deck').replace(/\W+/g,'_')}.json`; a.click(); URL.revokeObjectURL(a.href);
  toast('Deck exported');
}
async function importDeckInputChange(e){
  const f=e.target.files?.[0]; if(!f) return;
  const txt=await f.text(); e.target.value='';
  try{
    let data=null; try{data=JSON.parse(txt)}catch{}
    const upsertDeck=(cls,dk,cards,declaredTag='')=>{
      let ex=Object.values(state.decks).find(d=>(d.className||'').toLowerCase()===cls.toLowerCase()&&(d.deckName||'').toLowerCase()===dk.toLowerCase());
      if(!ex){
        const id=uid('deck');
        ex=state.decks[id]={id,className:cls||'Class',deckName:dk||f.name.replace(/\.[^.]+$/,''),cards:[],tags:[],createdAt:Date.now()};
      }
      ex.cards.push(...cards.map(c=>({
        id:uid('card'),
        q:(c.q||c.Question||'').trim(),
        a:(c.a||c['Correct Answer']||'').trim(),
        distractors:(c.distractors||[c['Wrong Answer 1'],c['Wrong Answer 2'],c['Wrong Answer 3']]).filter(Boolean).map(s=>String(s).trim()),
        sub:(c.sub||c.Subdeck||'').trim(),
        createdAt:Date.now()
      })));
      if(declaredTag) ex.tags=unique([...(ex.tags||[]),declaredTag]);
      saveDecks();
      renderDeckSelect(); toast('Deck imported');
    };
    if(data && data.deckName && Array.isArray(data.cards)){ upsertDeck(data.className||'Class',data.deckName,data.cards,(data.subdeck||'').trim()); }
    else if(Array.isArray(data) && data[0] && (data[0].Question||data[0]['Correct Answer'])){ upsertDeck('Class',f.name.replace(/\.json$/i,'').replace(/_/g,' '),data); }
    else{
      const lines=txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
      const cards=lines.map(line=>{
        const parts=line.split('|').map(s=>s.trim()); if(parts.length<3) throw new Error('Each line needs at least: Question | Correct | Wrong1');
        const tag=parts[parts.length-1]?.startsWith('#')?parts.pop().slice(1):'';
        const [q,a,...wrongs]=parts; return {q,a,distractors:wrongs,sub:tag};
      });
      upsertDeck('Class',f.name.replace(/\.[^.]+$/,'').replace(/_/g,' '),cards);
    }
  }catch(err){ alert('Import failed: '+err.message); }
}
function bulkAddCards(){
  const id=selectedDeckId(); if(!id) return alert('Select a deck first.');
  const txt=$('#bulkTextarea')?.value.trim(); if(!txt) return alert('Paste at least one line.');
  let n=0; for(const line of txt.split(/\r?\n/)){
    const parts=line.split('|').map(s=>s.trim()).filter(Boolean); if(parts.length<3) continue;
    let sub=''; if(parts[parts.length-1].startsWith?.('#')) sub=parts.pop().slice(1);
    const [q,a,...wrongs]=parts; state.decks[id].cards.push({id:uid('card'),q,a,distractors:wrongs,sub,createdAt:Date.now()}); n++;
  }
  saveDecks(); if($('#bulkTextarea')) $('#bulkTextarea').value='';
  renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
  toast(`Added ${n} card(s)`);
}

function bulkAddGlobalCards(){
  const txt=$('#bulkGlobalTextarea')?.value.trim(); if(!txt) return alert('Paste at least one line.');
  let n=0; let createdDecks=0;

  const findOrCreateDeck = (cls, name)=>{
    let ex=Object.values(state.decks).find(d=>
      (d.className||'').toLowerCase()===cls.toLowerCase() &&
      (d.deckName||'').toLowerCase()===name.toLowerCase()
    );
    if(!ex){
      const id=uid('deck');
      ex=state.decks[id]={id,className:cls,deckName:name,cards:[],tags:[],createdAt:Date.now()};
      createdDecks++;
    }
    return ex;
  };

  for(const rawLine of txt.split(/\r?\n/)){
    const line = rawLine.trim();
    if(!line) continue;
    const parts=line.split('|').map(s=>s.trim()).filter(Boolean);
    if(parts.length<4) continue;
    let sub='';
    if(parts[parts.length-1].startsWith?.('#')) sub=parts.pop().slice(1).trim();
    if(parts.length<4) continue;
    const [cls, deck, q, a, ...wrongs]=parts;
    if(!cls || !deck || !q || !a || wrongs.length===0) continue;

    const target = findOrCreateDeck(cls, deck);
    target.cards.push({id:uid('card'),q,a,distractors:wrongs,sub,createdAt:Date.now()});
    if(sub) target.tags=unique([...(target.tags||[]),sub]);
    n++;
  }

  saveDecks();
  if($('#bulkGlobalTextarea')) $('#bulkGlobalTextarea').value='';
  renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderFolderTree(); renderCardsList();
  toast(`Added ${n} card(s)${createdDecks?` • ${createdDecks} new deck${createdDecks===1?'':'s'}`:''}`);
}
function addCard(){
  const id=selectedDeckId(); if(!id) return alert('Select a deck first.');
  const q=$('#qInput')?.value.trim(), a=$('#aCorrectInput')?.value.trim(), w1=$('#aWrong1Input')?.value.trim(),
        w2=$('#aWrong2Input')?.value.trim(), w3=$('#aWrong3Input')?.value.trim(), sub=$('#cardSubInput')?.value.trim();
  if(!q||!a||!w1) return alert('Enter question, correct, and at least one wrong answer.');
  state.decks[id].cards.push({id:uid('card'),q,a,distractors:[w1,w2,w3].filter(Boolean),sub,createdAt:Date.now()});
  if(sub){ const d=state.decks[id]; d.tags=unique([...(d.tags||[]),sub]); }
  saveDecks();
  ['#qInput','#aCorrectInput','#aWrong1Input','#aWrong2Input','#aWrong3Input','#cardSubInput'].forEach(sel=>{ if($(sel)) $(sel).value=''; });
  renderDeckMeta(); renderSubdeckManager(); renderCardsList();
  toast('Card saved');
}

//////////////////////////// BUILD //////////////////////////////
function renderBuild(){ 
  renderTestsDatalist(); 
  renderDeckPickList(); 
  bindBuildButtons();
  syncPreview();
}
function renderTestsDatalist(){
  const dl=$('#testsList'); if(!dl) return;
  const arr=Object.values(state.tests).sort((a,b)=>a.name.localeCompare(b.name));
  dl.innerHTML=arr.map(t=>`<option value="${esc(t.name)}"></option>`).join('');
}
function bindBuildButtons(){
  bindOnce($('#saveTestBtn'),'click',saveTest);
  bindOnce($('#renameTestBtn'),'click',renameTest);
  bindOnce($('#deleteTestBtn'),'click',deleteTest);
  bindOnce($('#buildPushBtn'),'click',pushCurrentTestToCloud);
  bindOnce($('#copyShareBtn'),'click',copyShareLink);
  bindOnce($('#openShareBtn'),'click',openSharePreview);
  bindOnce($('#previewToggle'),'change',syncPreview);
  bindOnce($('#previewPracticeBtn'),'click',()=>{ setParams({view:'practice'}); activate('practice'); });
  bindOnce($('#previewQuizBtn'),'click',()=>{ setParams({view:'quiz'}); activate('quiz'); });
  bindOnce($('#testNameInput'),'input',handleTestNameInput);
}
function handleTestNameInput(){
  const typed = $('#testNameInput')?.value.trim().toLowerCase();
  if(!typed) { state.ui.currentTestId=null; return; }
  const entry = Object.entries(state.tests).find(([,t])=>t.name.toLowerCase()===typed);
  state.ui.currentTestId = entry? entry[0] : null;
  const t = state.tests[state.ui.currentTestId] || null;
  if(t){
    if($('#builderTitle')) $('#builderTitle').value = t.title || t.name || '';
    if($('#builderCount')) $('#builderCount').value = t.n || 30;
    renderDeckPickList();
  }
}
function saveTest(){
  const testNameInput=$('#testNameInput'); if(!testNameInput) return;
  const typedName = testNameInput.value.trim();
  if(!typedName) return alert('Enter or select a test name.');

  let id = state.ui.currentTestId;
  let t  = id ? state.tests[id] : null;

  if(!t){
    const match = Object.entries(state.tests).find(([,x])=>x.name.toLowerCase()===typedName.toLowerCase());
    if(match){ id = match[0]; t = state.tests[id]; state.ui.currentTestId = id; }
  }

  if(!t){
    id = uid('test');
    t = state.tests[id] = { id, name: typedName, title: typedName, n: 30, selections: [], updatedAt: Date.now() };
    state.ui.currentTestId = id;
  } else {
    t.name = typedName;
  }

  t.title = ($('#builderTitle')?.value.trim() || t.title || typedName);
  t.n = Math.max(1, +($('#builderCount')?.value) || t.n || 30);
  t.selections = dedupeSelections(readSelectionsFromUI());
  t.updatedAt = Date.now();

  saveTests();
  renderTestsDatalist();
  toast(`Test “${t.name}” saved`);
}
function renameTest(){
  const id = state.ui.currentTestId;
  if(!id) return alert('Select an existing test first (pick from the list).');
  const t = state.tests[id];
  const next = prompt('New test name:', t.name);
  if(next==null) return;
  const newName = next.trim();
  if(!newName) return alert('Name cannot be empty.');
  t.name = newName;
  t.title = ($('#builderTitle')?.value.trim() || t.title || newName);
  t.updatedAt = Date.now();
  saveTests();
  renderTestsDatalist();
  if($('#testNameInput')) $('#testNameInput').value = newName;
  toast('Test renamed');
}
function deleteTest(){
  let id = state.ui.currentTestId;
  if(!id){
    const name = $('#testNameInput')?.value.trim().toLowerCase();
    const entry = Object.entries(state.tests).find(([,t])=>t.name.toLowerCase()===name);
    if(entry) id = entry[0];
  }
  if(!id) return alert('Select an existing test to delete (pick from the list first).');

  const name = state.tests[id]?.name || 'Test';
  if(confirm(`Delete test “${name}”?`)){
    delete state.tests[id];
    saveTests();
    state.ui.currentTestId = null;
    if($('#testNameInput')) $('#testNameInput').value = '';
    if($('#builderTitle')) $('#builderTitle').value = '';
    if($('#builderCount')) $('#builderCount').value = 30;
    renderTestsDatalist();
    renderDeckPickList();
    toast('Test deleted');
  }
}
function renderDeckPickList(){
  const wrap = $('#deckPickList'); if(!wrap) return;
  const decks=listUniqueDecks();
  const typedName=$('#testNameInput')?.value.trim().toLowerCase();
  const selected = state.ui.currentTestId ? state.tests[state.ui.currentTestId]
                : Object.values(state.tests).find(t=>t.name.toLowerCase()===typedName);

  const selMap=new Map((selected?.selections||[]).map(s=>[s.deckId,s]));
  wrap.innerHTML=decks.map(d=>{
    const subs=deckSubTags(d);
    const saved=selMap.get(d.id);
    const whole=saved?!!saved.whole:true; const savedSubs=new Set(saved?.subs||[]);
    return `<div class="deck-row" data-deck="${d.id}">
      <div class="top">
        <label class="wrap"><input type="checkbox" class="ck-whole" ${whole?'checked':''}><strong>${esc(d.deckName)}</strong><span class="hint">[Class: ${esc(d.className)}]</span></label>
        ${subs.length?`<button type="button" class="btn ghost btn-expand">Sub-decks</button>`:`<span class="hint">No sub-decks</span>`}
      </div>
      <div class="subs hidden">${subs.map(s=>`<label class="subchip"><input type="checkbox" class="ck-sub" value="${esc(s)}" ${savedSubs.has(s)?'checked':''}><span>${esc(s)}</span></label>`).join('')}</div>
    </div>`;
  }).join('') || `<div class="hint">No decks yet. Add some in Create.</div>`;

  wrap.querySelectorAll('.btn-expand').forEach(b=>b.addEventListener('click',()=>b.closest('.deck-row').querySelector('.subs').classList.toggle('hidden')));
  wrap.querySelectorAll('.ck-sub').forEach(cb=>cb.addEventListener('change',()=>{
    const row=cb.closest('.deck-row'); const any=row.querySelectorAll('.ck-sub:checked').length>0; row.querySelector('.ck-whole').checked=!any;
  }));
  wrap.querySelectorAll('.ck-whole').forEach(cb=>cb.addEventListener('change',()=>{ if(cb.checked) cb.closest('.deck-row').querySelectorAll('.ck-sub').forEach(s=>s.checked=false) }));

  const selectedTest = selected;
  if(selectedTest){ if($('#builderTitle')) $('#builderTitle').value=selectedTest.title||selectedTest.name; if($('#builderCount')) $('#builderCount').value=selectedTest.n||30; }
}
function readSelectionsFromUI(){
  const rows = $$('#deckPickList .deck-row');
  return rows.map(row=>{
    const deckId=row.dataset.deck; const subs=[...row.querySelectorAll('.ck-sub:checked')].map(i=>i.value);
    const whole=subs.length===0 && row.querySelector('.ck-whole')?.checked; return {deckId,whole,subs};
  }).filter(s=>s.whole || s.subs.length>0);
}
function dedupeSelections(selections){
  const map=new Map();
  for(const s of selections){
    if(!map.has(s.deckId)) map.set(s.deckId,{deckId:s.deckId,whole:false,subs:new Set()});
    const agg=map.get(s.deckId);
    agg.whole=agg.whole||s.whole;
    (s.subs||[]).forEach(x=>agg.subs.add(x));
  }
  return [...map.values()].map(x=>({deckId:x.deckId,whole:x.whole && x.subs.size===0,subs:[...x.subs]}));
}
function copyShareLink(){
  const t=getCurrentTestOrSave(); if(!t) return;
  const url=new URL(location.href); url.searchParams.set('mode','student'); url.searchParams.set('test',t.name); url.searchParams.set('view','practice');
  navigator.clipboard.writeText(url.toString());
  toast('Student link copied — ready to send!');
}
function openSharePreview(){
  const t=getCurrentTestOrSave(); if(!t) return;
  const url=new URL(location.href); url.searchParams.set('mode','student'); url.searchParams.set('test',t.name); url.searchParams.set('view','practice');
  open(url.toString(),'_blank'); toast('Opened student preview');
}
function getCurrentTestOrSave(){
  const testNameInput=$('#testNameInput'); if(!testNameInput) return null;
  const typedName=testNameInput.value.trim();
  if(!typedName) return alert('Enter a test name first.'), null;
  let t = state.ui.currentTestId ? state.tests[state.ui.currentTestId] : null;
  if(!t){
    const match = Object.values(state.tests).find(x=>x.name.toLowerCase()===typedName.toLowerCase());
    if(!match){ alert('Save the test first.'); return null; }
    t = match;
  }
  t.title=($('#builderTitle')?.value.trim()||t.title||typedName);
  t.n=Math.max(1,+($('#builderCount')?.value)||t.n||30);
  t.selections=dedupeSelections(readSelectionsFromUI());
  t.updatedAt = Date.now();
  saveTests(); 
  return t;
}
async function pushCurrentTestToCloud(){
  const t = getCurrentTestOrSave(); if(!t) return;
  await cloudPushHandler();
}
function syncPreview(){
  const on = $('#previewToggle')?.checked;
  if($('#deckChooser')) $('#deckChooser').open=!on;
  $('#previewPanel')?.classList.toggle('hidden',!on);
  if(!on) return;
  const t=getCurrentTestOrSave(); if(!t) return;
  const n=computePoolForTest(t).length;
  const pt=$('#previewTitle'), pm=$('#previewMeta');
  if(pt) pt.textContent=t.title||t.name;
  if(pm) pm.textContent=`~${n} eligible questions • ${t.n} will be asked`;
}
function computePoolForTest(t){
  const normalized=dedupeSelections(t.selections||[]);
  const pool=[];
  for(const sel of normalized){
    const d=state.decks[sel.deckId]; if(!d) continue;
    if(sel.whole){ pool.push(...d.cards); }
    else if(sel.subs?.length){ pool.push(...d.cards.filter(c=>sel.subs.includes(c.sub||''))); }
  }
  return pool;
}
const deckLabel=d=>`${d.deckName} — ${d.className}`;
const testDisplayName=t=>(t?.title || t?.name || 'Test');

//////////////////////// PRACTICE ////////////////////////////////
function renderPracticeScreen(){
  fillTestsSelect($('#practiceTestSelect'),true);
  const last=store.get('bq_last_test',null);
  const sel=$('#practiceTestSelect');
  if(last && sel?.querySelector(`option[value="${last}"]`)) sel.value=last;
  buildPracticeDeckChecks();

  bindOnce($('#practiceTestSelect'),'change',()=>{ buildPracticeDeckChecks(); store.set('bq_last_test',$('#practiceTestSelect').value); });
  bindOnce($('#startPracticeBtn'),'click',startPractice);
  bindOnce($('#practicePrev'),'click',()=>{ state.practice.idx=Math.max(0,state.practice.idx-1); showPractice(); });
  bindOnce($('#practiceNext'),'click',()=>{ state.practice.idx=Math.min(state.practice.cards.length-1,state.practice.idx+1); showPractice(); });
  bindOnce($('#practiceShuffle'),'click',()=>{ state.practice.cards=shuffle(state.practice.cards); state.practice.idx=0; showPractice(); });
}
function fillTestsSelect(sel,lockToStudent=false){
  if(!sel) return;
  const list=Object.entries(state.tests).sort((a,b)=>{
    const aStamp = a[1]?.updatedAt || 0;
    const bStamp = b[1]?.updatedAt || 0;
    if (bStamp !== aStamp) return bStamp - aStamp;
    return (a[1]?.name || '').localeCompare(b[1]?.name || '');
  });
  if(state.quiz.locked && state.quiz.testId && lockToStudent){
    const t=state.tests[state.quiz.testId]; sel.innerHTML=t?`<option value="${state.quiz.testId}">${esc(testDisplayName(t))}</option>`:'';
    sel.value=state.quiz.testId; sel.disabled=true; return;
  }
  sel.disabled=false;
  sel.innerHTML=list.map(([id,t])=>`<option value="${id}">${esc(testDisplayName(t))}</option>`).join('')||'';
}
function buildPracticeDeckChecks(){
  const container=$('#practiceDeckChecks'); if(!container) return;
  const tid=$('#practiceTestSelect')?.value; const t=state.tests[tid]; container.innerHTML='';
  if(!t){ container.innerHTML='<span class="hint">No test selected.</span>'; return; }
  const seen=new Set(), chips=[];
  for(const sel of dedupeSelections(t.selections||[])){
    if(seen.has(sel.deckId)) continue; seen.add(sel.deckId);
    const d=state.decks[sel.deckId]; if(!d) continue;
    const chip=document.createElement('label'); chip.className='chip';
    const ck=document.createElement('input'); ck.type='checkbox'; ck.dataset.deck=sel.deckId; ck.checked=true; chip.appendChild(ck);
    const span=document.createElement('span'); span.textContent=deckLabel(d); chip.appendChild(span);
    chips.push(chip);
  }
  if(chips.length) chips.forEach(c=>container.appendChild(c));
  else container.innerHTML='<span class="hint">This test has no decks selected.</span>';
}
function startPractice(){
  const tid=$('#practiceTestSelect')?.value; const t=state.tests[tid]; if(!t) return alert('Pick a test.');
  const chosen=new Set([...$('#practiceDeckChecks')?.querySelectorAll('input[type=checkbox]:checked')||[]].map(i=>i.dataset.deck));
  const pool=[];
  for(const sel of dedupeSelections(t.selections||[])){
    if(!chosen.has(sel.deckId)) continue;
    const d=state.decks[sel.deckId]; if(!d) continue;
    if(sel.whole) pool.push(...d.cards); else pool.push(...d.cards.filter(c=>sel.subs.includes(c.sub||'')));
  }
  if(!pool.length) return alert('No cards to practice.');
  state.practice.cards=shuffle(pool); state.practice.idx=0; if($('#practiceArea')) $('#practiceArea').hidden=false; showPractice();
}
function showPractice(){
  const idx=state.practice.idx, total=state.practice.cards.length, c=state.practice.cards[idx]; if(!c) return;
  if($('#practiceLabel')) $('#practiceLabel').textContent=`Card ${idx+1} of ${total}`;
  if($('#practiceProgress')) $('#practiceProgress').textContent=`Tap card to flip. Use ←/→ to navigate.`;
  if($('#practiceQuestion')) $('#practiceQuestion').textContent=c.q;
  if($('#practiceAnswer'))   $('#practiceAnswer').textContent=c.a;
  const card=$('#practiceCard'); if(!card) return;
  card.classList.remove('flipped'); card.onclick=()=>card.classList.toggle('flipped');

  const handler=(e)=>{
    if(e.key===' '){ e.preventDefault(); card.classList.toggle('flipped'); }
    if(e.key==='ArrowRight'){ $('#practiceNext')?.click(); }
    if(e.key==='ArrowLeft'){ $('#practicePrev')?.click(); }
  };
  window.removeEventListener('keydown', window.__bqPracticeKeys__);
  window.__bqPracticeKeys__=handler;
  window.addEventListener('keydown', handler);

ensureLoadTestsCTA(document.querySelector('#view-practice .card'));

}

//////////////////////////// QUIZ //////////////////////////////////
function renderQuizScreen(){
  fillTestsSelect($('#quizTestSelect'),true);
  const last=store.get('bq_last_test',null);
  const sel=$('#quizTestSelect');
  if(last && sel?.querySelector(`option[value="${last}"]`)) sel.value=last;
  if($('#studentDate') && !$('#studentDate').value) $('#studentDate').value=todayISO();

  const studentLocSel=$('#studentLocationSelect');
  const studentLocOther=$('#studentLocationOther');
  if(studentLocSel){
    if(window.__locHandler__) studentLocSel.removeEventListener('change', window.__locHandler__);
    window.__locHandler__ = () => {
      const other = studentLocSel.value === '__OTHER__';
      if(studentLocOther){
        studentLocOther.classList.toggle('hidden', !other);
        if (other) studentLocOther.focus();
      }
    };
    studentLocSel.addEventListener('change', window.__locHandler__);
     ensureLoadTestsCTA(document.querySelector('#view-quiz .card'));

  }

  startOrRefreshQuiz();

  bindOnce($('#quizTestSelect'),'change',()=>{ startOrRefreshQuiz(); store.set('bq_last_test',$('#quizTestSelect').value); });
  bindOnce($('#quizPrev'),'click',()=>{ state.quiz.idx=Math.max(0,state.quiz.idx-1); drawQuiz(); });
  bindOnce($('#quizNext'),'click',()=>{ state.quiz.idx=Math.min(state.quiz.items.length-1,state.quiz.idx+1); drawQuiz(); });
  bindOnce($('#submitQuizBtn'),'click',submitQuiz);
}
function startOrRefreshQuiz(){
  const tid=$('#quizTestSelect')?.value; const t=state.tests[tid];
  const quizOptions=$('#quizOptions'), quizQuestion=$('#quizQuestion');
  if(!t){ if(quizOptions) quizOptions.innerHTML=''; if(quizQuestion) quizQuestion.textContent='Select a test above'; return; }
  const pool=computePoolForTest(t);
  if(!pool.length){ if(quizOptions) quizOptions.innerHTML=''; if(quizQuestion) quizQuestion.textContent='No questions in this test.'; return; }
  const n=Math.min(t.n||30,pool.length);
  state.quiz.items=sample(pool,n).map(q=>{
    const opts=unique([q.a,...(q.distractors||[])].map(s=>(s??'').trim()).filter(Boolean));
    if(opts.length<2) opts.push('—');
    return {q:q.q,a:q.a,opts:shuffle(opts),picked:null};
  });
  state.quiz.idx=0; state.quiz.n=n;
  $('#quizArea')?.classList.remove('hidden'); $('#quizFinished')?.classList.add('hidden');
  drawQuiz();
}
function drawQuiz(){
  const i=state.quiz.idx, it=state.quiz.items[i]; if(!it) return;
  if($('#quizQuestion')) $('#quizQuestion').textContent=it.q;
  if($('#quizProgress')) $('#quizProgress').textContent=`${i+1}/${state.quiz.items.length}`;
  const quizOptions=$('#quizOptions'); if(!quizOptions) return;
  quizOptions.innerHTML=it.opts.map((opt,idx)=>`
    <label class="option">
      <input type="radio" name="q${i}" value="${esc(opt)}" ${it.picked===opt?'checked':''}>
      <span><kbd>${idx+1}</kbd> ${esc(opt)}</span>
    </label>
  `).join('');
  quizOptions.querySelectorAll('input[type=radio]').forEach(r=>r.addEventListener('change',()=>{ it.picked=r.value; }));
  const handler=(e)=>{
    if(e.target.tagName==='INPUT') return;
    const n=e.keyCode-49;
    if(n>=0 && n<it.opts.length){
      const radios=quizOptions.querySelectorAll('input[type=radio]');
      if(radios[n]){ radios[n].checked=true; radios[n].dispatchEvent(new Event('change')); }
    }
    if(e.key==='ArrowRight'){ $('#quizNext')?.click(); }
    if(e.key==='ArrowLeft'){ $('#quizPrev')?.click(); }
  };
  window.removeEventListener('keydown', window.__bqQuizKeys__);
  window.__bqQuizKeys__=handler;
  window.addEventListener('keydown', handler);
}
async function submitQuiz(){
  if(state.quiz.submitting) return;
  state.quiz.submitting = true;
  $('#submitQuizBtn')?.setAttribute('disabled','true');
  const name=$('#studentName')?.value.trim();
  const studentLocSel=$('#studentLocationSelect');
  const studentLocOther=$('#studentLocationOther');
  let loc='';
  if (studentLocSel) {
    loc = studentLocSel.value === '__OTHER__'
        ? (studentLocOther?.value || '').trim()
        : (studentLocSel.value || '').trim();
  } else {
    loc = ($('#studentLocation')?.value || '').trim();
  }
  const dt=$('#studentDate')?.value;
  if(!name||!loc||!dt){
    alert('Name, location and date are required.');
    state.quiz.submitting = false;
    $('#submitQuizBtn')?.removeAttribute('disabled');
    return;
  }
  const tid=$('#quizTestSelect')?.value; const t=state.tests[tid];
  if(!t){
    alert('No test selected.');
    state.quiz.submitting = false;
    $('#submitQuizBtn')?.removeAttribute('disabled');
    return;
  }
  const total=state.quiz.items.length; const correct=state.quiz.items.filter(x=>x.picked===x.a).length; const score=Math.round(100*correct/Math.max(1,total));
  const answers=state.quiz.items.map((x,i)=>({i,q:x.q,correct:x.a,picked:x.picked}));

  const row={
    id: uid('res'),
    clientId,
    idempotencyKey: `${clientId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
    name,
    location: loc,
    date: dt,
    time: Date.now(),
    testId: tid,
    testName: t.name,
    score,
    correct,
    of: total,
    answers
  };

  const validationError = validateResultRow(row);
  if(validationError){
    alert(`Submission invalid: ${validationError}`);
    state.quiz.submitting = false;
    $('#submitQuizBtn')?.removeAttribute('disabled');
    return;
  }

  state.results.push(row); saveResults();

  try{
    enqueueOutbox('submitresult', row);
    await flushOutbox(true);
  }catch(err){
    console.warn('Cloud submit failed', err); toast('Saved locally (offline).');
  }

  $('#quizArea')?.classList.add('hidden'); $('#quizFinished')?.classList.remove('hidden');
  if($('#finishedMsg')) $('#finishedMsg').innerHTML=`Thanks, <strong>${esc(name)}</strong>! You scored <strong>${score}%</strong> (${correct}/${total}).`;
  if($('#finishedAnswers')) $('#finishedAnswers').innerHTML=answers.map(a=>`
    <div class="row">
      <div class="q">${esc(a.q)}</div>
      <div class="a">
        <span class="tag ${a.picked===a.correct?'good':'bad'}">Your: ${esc(a.picked??'—')}</span>
        <span class="tag good">Correct: ${esc(a.correct)}</span>
      </div>
    </div>`).join('');
  if(isOutboxPending(row.id)){
    toast('Submission queued (offline)');
  }else{
    toast('Submission synced');
  }

  on($('#restartQuizBtn'),'click',()=>{ $('#quizFinished')?.classList.add('hidden'); $('#quizArea')?.classList.remove('hidden'); startOrRefreshQuiz(); }, { once:true });
  on($('#finishedPracticeBtn'),'click',()=>{ setParams({view:'practice'}); activate('practice'); }, { once:true });

  state.quiz.submitting = false;
  $('#submitQuizBtn')?.removeAttribute('disabled');
}

/////////////////////////// REPORTS //////////////////////////////
function renderReports(){
  ensureReportsButtons();

  const locs=unique(state.results.map(r=>r.location)).filter(Boolean).sort();
  const keepLoc=$('#repLocation')?.value;
  if($('#repLocation')) $('#repLocation').innerHTML=`<option value="">All locations</option>`+locs.map(l=>`<option ${keepLoc===l?'selected':''}>${esc(l)}</option>`).join('');

  const repTestSel = $('#repTest');
  if (repTestSel){
    const keepTest = repTestSel.value || '';
    const tests = Object.values(state.tests).sort((a,b)=>a.name.localeCompare(b.name));
    repTestSel.innerHTML = `<option value="">All tests</option>` + tests.map(t=>`<option ${keepTest===t.name?'selected':''}>${esc(t.name)}</option>`).join('');
  }

  drawReports();

  bindOnce($('#repLocation'),'change',drawReports);
  bindOnce($('#repAttemptView'),'change',drawReports);
  bindOnce($('#repSort'),'change',drawReports);
  bindOnce($('#repView'),'change',drawReports);
  bindOnce($('#repDateFrom'),'change',drawReports);
  bindOnce($('#repDateTo'),'change',drawReports);
  bindOnce($('#repTest'),'change',drawReports);
}
function drawReports(){
  const view    = ($('#repView')?.value || 'active');
  const loc     = $('#repLocation')?.value || '';
  const attempt = $('#repAttemptView')?.value || 'all';
  const sort    = $('#repSort')?.value || 'date_desc';
  const fromISO = $('#repDateFrom')?.value || '';
  const toISO   = $('#repDateTo')?.value   || '';
  const testNm  = $('#repTest')?.value     || '';

  let rows = view==='archived' ? [...state.archived] : [...state.results];

  if(testNm) rows = rows.filter(r=>r.testName===testNm);
  if(fromISO) rows = rows.filter(r => (r.date || '') >= fromISO);
  if(toISO)   rows = rows.filter(r => (r.date || '') <= toISO);

  if(attempt!=='all'){
    const map=new Map();
    for(const r of rows){ const k=r.name+'|'+r.testName; (map.get(k)||map.set(k,[]).get(k)).push(r); }
    rows=[]; map.forEach(arr=>{ arr.sort((a,b)=>a.time-b.time); rows.push(attempt==='first'?arr[0]:arr[arr.length-1]); });
  }

  const baseRows = rows.slice();
  if(loc) rows = rows.filter(r=>r.location===loc);

  if(sort==='date_desc') rows.sort((a,b)=>b.time-a.time);
  if(sort==='date_asc')  rows.sort((a,b)=>a.time-b.time);
  if(sort==='test_asc')  rows.sort((a,b)=>a.testName.localeCompare(b.testName));
  if(sort==='test_desc') rows.sort((a,b)=>b.testName.localeCompare(a.testName));
  if(sort==='loc_asc')   rows.sort((a,b)=> (a.location||'').localeCompare(b.location||''));  
  if(sort==='loc_desc')  rows.sort((a,b)=> (b.location||'').localeCompare(a.location||''));  

  renderReportKpis(rows);
  renderTestBreakdown(baseRows);
  renderLocationCharts(baseRows, loc);
  renderLocationTrends(baseRows);

  const tb=$('#repTable tbody'); if(!tb) return;
  tb.innerHTML=rows.map(r=>`<tr data-id="${r.id}">
    <td>${new Date(r.time).toLocaleString()}</td>
    <td>${esc(r.name)}</td>
    <td>${esc(r.location)}</td>
    <td>${esc(r.testName)}</td>
    <td>${r.score}%</td>
    <td>${r.correct}/${r.of}</td>
    <td><button class="btn ghost view-btn">Open</button></td>
    <td class="actions">
      ${view==='archived'
        ? `<button class="btn small" data-act="restore">Restore</button>
           <button class="btn danger small" data-act="delete-forever">Delete</button>`
        : `<button class="btn small" data-act="archive">Archive</button>
           <button class="btn danger small" data-act="delete-forever">Delete</button>`}
    </td>
  </tr>`).join('');

  bindOnce(tb, 'click', async (event)=>{
    const row = event.target.closest('tr'); if(!row) return;
    const id = row.dataset.id;
    const viewMode = ($('#repView')?.value || 'active');
    if(event.target.closest('.view-btn')){
      const src = viewMode==='archived'?state.archived:state.results;
      const r=src.find(x=>x.id===id); if(!r) return;
      const rows=r.answers.map(a=>`<div style="border:1px solid #ddd;padding:8px;margin:8px 0;border-radius:8px;">
        <div style="font-weight:600;margin-bottom:4px">${esc(a.q)}</div>
        <div><span style="background:#fee;border:1px solid #e88;border-radius:999px;padding:2px 6px;">Your: ${esc(a.picked??'—')}</span>
        <span style="background:#efe;border:1px solid #2c8;border-radius:999px;padding:2px 6px;margin-left:6px;">Correct: ${esc(a.correct)}</span></div>
      </div>`).join('');
      const w=open('', '_blank','width=760,height=900,scrollbars=yes'); if(!w) return;
      w.document.write(`<title>${esc(r.name)} • ${esc(r.testName)}</title><body style="font-family:system-ui;padding:16px;background:#fff;color:#222">
        <h3>${esc(r.name)} @ ${esc(r.location)} — ${esc(r.testName)} (${r.score}% | ${r.correct}/${r.of})</h3>
        <div>${rows}</div>
      </body>`);
      return;
    }

    const act = event.target.closest('button[data-act]')?.dataset.act;
    if(!act) return;
    if (act==='archive'){
      if (await archiveResult(id)) toast('Result archived');
    } else if (act==='restore'){
      if (await restoreResult(id)) toast('Result restored');
    } else if (act==='delete-forever'){
      if (confirm('Delete this result permanently?')) {
        if (await deleteForever(id, viewMode==='archived'?'archived':'active')) toast('Result deleted');
      }
    }
    drawReports();
  }, 'reportsTable');

  renderLocationAverages(view, loc, attempt, fromISO, toISO, testNm);

  if($('#missedSummary')) $('#missedSummary').innerHTML = getMissedSummaryHtml();
}

function renderReportKpis(rows){
  const attempts = rows.length;
  const avg = attempts ? Math.round(rows.reduce((s,r)=>s+(Number(r.score)||0),0)/attempts) : 0;
  const unique = new Set(rows.map(r=>(r.name||'').trim()).filter(Boolean)).size;
  if($('#kpiAttempts')) $('#kpiAttempts').textContent = String(attempts);
  if($('#kpiAverage')) $('#kpiAverage').textContent = `${avg}%`;
  if($('#kpiUnique')) $('#kpiUnique').textContent = String(unique);
}

function renderTestBreakdown(rows){
  const box = $('#testBreakdown'); if(!box) return;
  if(!rows.length){
    box.innerHTML = '<div class="hint">No attempts yet for this filter.</div>';
    return;
  }
  const map = new Map();
  for(const r of rows){
    const key = r.testName || 'Untitled';
    if(!map.has(key)) map.set(key, { name: key, attempts: 0, sum: 0, correct: 0, of: 0, users: new Set() });
    const entry = map.get(key);
    entry.attempts += 1;
    entry.sum += Number(r.score)||0;
    entry.correct += Number(r.correct)||0;
    entry.of += Number(r.of)||0;
    if(r.name) entry.users.add(r.name);
  }
  const out = [...map.values()].sort((a,b)=> b.attempts - a.attempts);
  box.innerHTML = out.map(t=>{
    const avg = t.attempts ? Math.round(t.sum / t.attempts) : 0;
    const accuracy = t.of ? Math.round((t.correct / t.of) * 100) : 0;
    return `<div class="report-row" data-test="${esc(t.name)}">
      <div>
        <strong>${esc(t.name)}</strong>
        <div class="hint">${t.attempts} attempt${t.attempts!==1?'s':''} • ${t.users.size} barista${t.users.size!==1?'s':''}</div>
      </div>
      <div><div class="hint">Avg score</div><strong>${avg}%</strong></div>
      <div><div class="hint">Accuracy</div><strong>${accuracy}%</strong></div>
      <div><button class="btn ghost small test-focus">Open attempts</button></div>
    </div>`;
  }).join('');

  bindOnce(box, 'click', (event)=>{
    const btn = event.target.closest('.test-focus');
    if(!btn) return;
    const row = event.target.closest('.report-row');
    const name = row?.dataset.test || '';
    const repTest = $('#repTest');
    if(repTest && name){
      repTest.value = name;
      drawReports();
      const table = document.querySelector('#repTable');
      if(table) table.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, 'testBreakdown');
}

function renderLocationCharts(rows, selectedLoc){
  const box = $('#locationCharts'); if(!box) return;
  if(!rows.length){ box.innerHTML = '<div class="hint">No location data yet.</div>'; return; }
  const data = computeLocationAverages(rows);
  const maxCount = Math.max(...data.map(d=>d.count));
  box.innerHTML = data.map(d=>{
    const pct = maxCount ? Math.round((d.count / maxCount) * 100) : 0;
    const avg = Math.round(d.avg);
    const active = selectedLoc && selectedLoc === d.location;
    return `<div class="chart-row ${active?'selected':''}">
      <div class="chart-label">${esc(d.location)}</div>
      <div class="chart-bar"><span style="width:${pct}%"></span></div>
      <div class="chart-value">${avg}% • ${d.count}</div>
    </div>`;
  }).join('');
}

function renderLocationTrends(rows){
  const box = $('#locationTrends'); if(!box) return;
  if(!rows.length){ box.innerHTML = '<div class="hint">No trend data yet.</div>'; return; }
  const map = new Map();
  for(const r of rows){
    const key = (r.location || 'Unknown').trim();
    if(!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  const out = [];
  map.forEach((list, loc)=>{
    const sorted = list.slice().sort((a,b)=>a.time-b.time);
    const tail = sorted.slice(-6);
    const maxScore = Math.max(1, ...tail.map(r=>Number(r.score)||0));
    const bars = tail.map(r=>{
      const height = Math.max(12, Math.round(((Number(r.score)||0) / maxScore) * 100));
      const active = (Number(r.score)||0) >= 80;
      return `<span class="${active?'active':''}" style="height:${height}%"></span>`;
    }).join('');
    out.push({ loc, bars });
  });
  out.sort((a,b)=>a.loc.localeCompare(b.loc));
  box.innerHTML = out.map(d=>`
    <div class="trend-row">
      <div class="chart-label">${esc(d.loc)}</div>
      <div class="sparkline" aria-hidden="true">${d.bars}</div>
    </div>
  `).join('');
}
async function archiveResult(id){
  const i = state.results.findIndex(r=>r.id===id);
  if(i>-1){
    const [row]=state.results.splice(i,1);
    state.archived.push(row);
    saveResults();
    saveArchived();
    try{ await cloudPOST('archivemove', { id, to:'archived' }); }catch(_){}
    return true;
  }
  return false;
}
async function restoreResult(id){
  const i = state.archived.findIndex(r=>r.id===id);
  if(i>-1){
    const [row]=state.archived.splice(i,1);
    state.results.push(row);
    saveResults();
    saveArchived();
    try{ await cloudPOST('archivemove', { id, to:'active' }); }catch(_){}
    return true;
  }
  return false;
}
async function deleteForever(id, from='active'){
  const list = from==='archived' ? state.archived : state.results;
  const i = list.findIndex(r=>r.id===id);
  if(i>-1){
    list.splice(i,1);
    saveResults();
    saveArchived();
    try{ await cloudPOST('deleteforever', { id, from }); }catch(_){}
    return true;
  }
  return false;
}

function computeLocationAverages(rows){
  const map = new Map();
  for (const r of rows) {
    const key = (r.location || 'Unknown').trim();
    if (!map.has(key)) map.set(key, { sum:0, n:0 });
    const m = map.get(key);
    m.sum += (Number(r.score) || 0);
    m.n += 1;
  }
  const out = [];
  map.forEach((v,k)=> out.push({ location:k, avg: v.n ? (v.sum/v.n) : 0, count: v.n }));
  out.sort((a,b)=> a.location.localeCompare(b.location));
  return out;
}
function renderLocationAverages(view='active', locFilter='', attempt='all', fromISO='', toISO='', testNm=''){
  const box  = $('#locationAverages'); if(!box) return;
  const cacheKey = [
    state.meta.resultsVersion,
    state.meta.archivedVersion,
    view, locFilter, attempt, fromISO, toISO, testNm
  ].join('|');
  if(cache.locationKey === cacheKey && cache.locationHtml){
    box.innerHTML = cache.locationHtml;
    return;
  }
  let base = view==='archived' ? [...state.archived] : [...state.results];

  if (locFilter) base = base.filter(r => r.location === locFilter);
  if (testNm)    base = base.filter(r => r.testName === testNm);
  if (fromISO)   base = base.filter(r => (r.date || '') >= fromISO);
  if (toISO)     base = base.filter(r => (r.date || '') <= toISO);

  if (attempt!=='all'){
    const map=new Map();
    for(const r of base){ const k=r.name+'|'+r.testName; (map.get(k)||map.set(k,[]).get(k)).push(r); }
    base=[]; map.forEach(arr=>{ arr.sort((a,b)=>a.time-b.time); base.push(attempt==='first'?arr[0]:arr[arr.length-1]); });
  }

  const avgs = computeLocationAverages(base);
  if (!avgs.length){
    cache.locationKey = cacheKey;
    cache.locationHtml = '<div class="hint">No data yet.</div>';
    box.innerHTML = cache.locationHtml;
    return;
  }
  cache.locationKey = cacheKey;
  cache.locationHtml = avgs.map(x=>`
    <div class="missrow">
      <div class="misscount"><div>${x.count}</div><div class="hint">attempts</div></div>
      <div class="missq"><strong>${esc(x.location)}</strong> — avg <strong>${Math.round(x.avg)}%</strong></div>
    </div>
  `).join('');
  box.innerHTML = cache.locationHtml;
}

function getMissedSummaryHtml(){
  if(cache.missedVersion === state.meta.resultsVersion && cache.missedHtml){
    return cache.missedHtml;
  }
  const baseRows=[...state.results];
  const missMap=new Map();
  for(const r of baseRows){
    for(const a of (r.answers||[])){
      const k=a.q; if(!missMap.has(k)) missMap.set(k,{q:k,misses:0,total:0});
      const m=missMap.get(k); m.total++; if(a.picked!==a.correct) m.misses++;
    }
  }
  const top=[...missMap.values()].filter(x=>x.total>0).sort((a,b)=>b.misses-a.misses).slice(0,10);
  cache.missedVersion = state.meta.resultsVersion;
  cache.missedHtml = top.length ? top.map(m=>`
    <div class="missrow">
      <div class="misscount"><div>${m.misses}/${m.total}</div><div class="hint">missed</div></div>
      <div class="missq">${esc(m.q)}</div>
    </div>`).join('') : '<div class="hint">No data yet.</div>';
  return cache.missedHtml;
}

//////////////////// Full Backup / Restore //////////////////////
function ensureBackupButtons(){
  const hdr = $('#view-settings .card .card-head'); if(!hdr) return;

  if(!$('#exportAllBtn')){
    const ex = document.createElement('button');
    ex.id='exportAllBtn'; ex.className='btn'; ex.textContent='Export All';
    hdr.appendChild(ex); ex.addEventListener('click', exportAllBackup);
  }
  if(!$('#importBackupBtn')){
    const im = document.createElement('button');
    im.id='importBackupBtn'; im.className='btn'; im.textContent='Import Backup…';
    hdr.appendChild(im); im.addEventListener('click', importBackupFlow);
  }
  if(!$('#importBackupInput')){
    const fi = document.createElement('input');
    fi.type='file'; fi.accept='.json,application/json,text/plain';
    fi.id='importBackupInput'; fi.hidden=true; hdr.appendChild(fi);
    fi.addEventListener('change', async (e)=>{
      const f=e.target.files?.[0]; if(!f) return;
      const txt=await f.text(); e.target.value='';
      try { const data=JSON.parse(txt); importBackupData(data); } 
      catch(err){ alert('Invalid backup JSON: '+err.message); }
    });
  }
  // Cloud buttons already exist in HTML
}
function exportAllBackup(){
  const backup = makeBackupObject();
  const json = JSON.stringify(backup, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json],{type:'application/json'}));
  a.download = `bq_backup_${stamp}.json`; a.click(); URL.revokeObjectURL(a.href);
  navigator.clipboard?.writeText(json).then(()=>toast('Backup downloaded & copied'),()=>toast('Backup downloaded'));
}
function importBackupFlow(){
  const useFile = confirm('Import from a file?\n\nOK = Choose file\nCancel = Paste JSON');
  if(useFile){ $('#importBackupInput')?.click(); return; }
  const txt = prompt('Paste full backup JSON here:'); if(!txt) return;
  try { const data=JSON.parse(txt); importBackupData(data); }
  catch(err){ alert('Invalid backup JSON: '+err.message); }
}
function importBackupData(data){
  if(!data || data.schema!=='bq_backup_v1'){ 
    if(!confirm('Schema missing or unknown. Attempt import anyway?')) return;
  }
  const modeMerge = confirm('How to apply backup?\n\nOK = MERGE into existing\nCancel = REPLACE (wipe current and restore backup)');
  if(modeMerge) mergeBackup(data); else replaceBackup(data);
  saveDecks();
  saveTests();
  saveResults();
  saveArchived();
  toast(modeMerge ? 'Backup merged' : 'Backup restored (replaced)');
  renderCreate(); renderBuild(); renderReports();
}
function sanitizeDecksObject(obj){
  const out={};
  for(const [id,d] of Object.entries(obj||{})){
    if(!d) continue;
    const _id = d.id && typeof d.id==='string' ? d.id : uid('deck');
    out[_id] = {
      id: _id,
      className: d.className || '',
      deckName : d.deckName || (d.name||'Deck'),
      cards    : Array.isArray(d.cards) ? d.cards : [],
      tags     : Array.isArray(d.tags) ? d.tags : [],
      createdAt: d.createdAt || Date.now()
    };
  }
  return out;
}
function sanitizeTestsObject(obj){
  if(Array.isArray(obj)){
    const map={};
    for(const t of obj){
      const id = t?.id || uid('test');
      map[id] = { id, name:t?.name||'Test', title:t?.title||t?.name||'Test', n:Math.max(1,+t?.n||30), selections:Array.isArray(t?.selections)?t.selections:[] };
    }
    return map;
  }
  const out={};
  for(const [id,t] of Object.entries(obj||{})){
    const _id = t?.id || id || uid('test');
    out[_id] = { id:_id, name:t?.name||'Test', title:t?.title||t?.name||'Test', n:Math.max(1,+t?.n||30), selections:Array.isArray(t?.selections)?t.selections:[] };
  }
  return out;
}
function replaceBackup(data){
  state.decks    = sanitizeDecksObject(data.decks || {});
  state.tests    = sanitizeTestsObject(data.tests || {});
  state.results  = Array.isArray(data.results)  ? data.results  : [];
  state.archived = Array.isArray(data.archived) ? data.archived : [];
  mergeDecksByName();
}
function mergeBackup(data){
  const incomingDecks = sanitizeDecksObject(data.decks || {});
  const incomingTests = sanitizeTestsObject(data.tests || {});
  const incomingResults  = Array.isArray(data.results)  ? data.results  : [];
  const incomingArchived = Array.isArray(data.archived) ? data.archived : [];

  const keyToId = new Map();
  for(const [id,d] of Object.entries(state.decks)) keyToId.set(deckKey(d), id);
  const importedKeyToExistingId = new Map();

  for(const [impId, impDeck] of Object.entries(incomingDecks)){
    const k = deckKey(impDeck);
    if(!keyToId.has(k)){
      const newId = uid('deck');
      state.decks[newId] = deepCopy({...impDeck, id:newId});
      keyToId.set(k, newId);
      importedKeyToExistingId.set(impId, newId);
    } else {
      const existingId = keyToId.get(k);
      importedKeyToExistingId.set(impId, existingId);
      const dst = state.decks[existingId];
      dst.tags = unique([...(dst.tags||[]), ...(impDeck.tags||[]), ...(impDeck.subdeck?[impDeck.subdeck]:[])]);
      const seen = new Set((dst.cards||[]).map(c => cardKey(c)));
      const incomingCards = (impDeck.cards||[]).map(c => ({
        id: uid('card'),
        q: (c.q||'').trim(),
        a: (c.a||'').trim(),
        distractors: (c.distractors||[]).map(s=>String(s).trim()).filter(Boolean),
        sub: (c.sub||'').trim(),
        createdAt: c.createdAt || Date.now()
      }));
      for(const c of incomingCards){
        const key = cardKey(c);
        if(!seen.has(key)){ (dst.cards ||= []).push(c); seen.add(key); }
      }
    }
  }

  for(const [tid,t] of Object.entries(incomingTests)){
    const remappedSelections = dedupeSelections((t.selections||[]).map(sel=>{
      const targetId = importedKeyToExistingId.get(sel.deckId) || sel.deckId;
      return { deckId: targetId, whole: !!sel.whole, subs: (sel.subs||[]) };
    }));
    const match = Object.entries(state.tests).find(([,x])=>x.name.toLowerCase()===String(t.name||'').toLowerCase());
    if(!match){
      const newId = uid('test');
      state.tests[newId] = {
        id: newId, name: t.name || 'Test', title: t.title || t.name || 'Test',
        n: Math.max(1, +t.n || 30), selections: remappedSelections
      };
    }else{
      const id = match[0], dst = state.tests[id];
      dst.selections = dedupeSelections([...(dst.selections||[]), ...remappedSelections]);
      dst.n = Math.max(+dst.n||30, +t.n||30);
      if(!dst.title && t.title) dst.title = t.title;
    }
  }

  const allIds = new Set([...state.results, ...state.archived].map(r=>r.id));
  for(const r of incomingResults){ const x=deepCopy(r||{}); if(!x.id || allIds.has(x.id)) x.id = uid('res'); state.results.push(x); allIds.add(x.id); }
  for(const r of incomingArchived){ const x=deepCopy(r||{}); if(!x.id || allIds.has(x.id)) x.id = uid('res'); state.archived.push(x); allIds.add(x.id); }

  mergeDecksByName();
}

//////////////////////// normalize & boot ////////////////////////
function normalizeTests(){
  let changed=false;
  for(const id of Object.keys(state.tests)){
    const t=state.tests[id];
    const norm=dedupeSelections(t.selections||[]);
    if(JSON.stringify(norm)!==JSON.stringify(t.selections||[])){ t.selections=norm; changed=true; }
  }
  if(changed) saveTests();
}

function ensureReportsButtons(){
  const existing = $('#repCloudPullBtn');
  if(existing){
    if(!existing.__bound){ on(existing,'click', resultsRefreshFromCloud); existing.__bound = true; }
    return;
  }
  const headerCard = $('#view-reports .card'); if(!headerCard) return;
  if(!$('#resultsCloudBtn')){
    const btn = document.createElement('button');
    btn.id='resultsCloudBtn'; btn.className='btn'; btn.textContent='Refresh from Cloud';
    headerCard.querySelector('.grid')?.appendChild(document.createElement('div'))?.appendChild?.(btn) || headerCard.appendChild(btn);
    on(btn,'click',resultsRefreshFromCloud);
  }
}

/* ---------------------- UPDATED (drop-in) ---------------------- */
async function boot(){
  mergeDecksByName();
  normalizeTests();
  ensureOutboxIndicator();

  // optional: add a small student loading banner container if not present
  if(!$('#studentLoading')){
    const b=document.createElement('div');
    b.id='studentLoading';
    b.className='banner hidden'; // style in CSS: position:sticky; top:0; etc.
    b.textContent='Loading latest decks & tests…';
    document.body.prepend(b);
  }

  const forcePull = (new URLSearchParams(location.search).get('mode') === 'student');
  await maybeHydrateFromCloud(forcePull);

  applyStudentMode();

   ensureLoadTestsCTA(document.querySelector('#view-practice .card'));

  window.addEventListener('online', ()=>flushOutbox());
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible') flushOutbox();
  });
  setInterval(()=>flushOutbox(), 30000);
  flushOutbox();

  $$('select').forEach(sel=>{
    sel.style.pointerEvents='auto';
    sel.addEventListener('touchstart',()=>sel.focus(),{passive:true});
  });

  if($('#studentDate') && !$('#studentDate').value) $('#studentDate').value=todayISO();

  activate(qs().get('view') || (isStudent() ? 'practice' : 'create'));
}
/* --------------------------------------------------------------- */
window.boot = boot;

// Safer boot wrapper (handles script timing & shows clear error)
(function safeBoot(){
  try{
    if (document.readyState !== 'loading') boot();
    else window.addEventListener('DOMContentLoaded', boot, { once:true });
  }catch(e){
    console.error('Boot error:', e);
    alert('App failed to start. See console for details.');
  }
})();
