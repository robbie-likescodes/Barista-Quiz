/**************************************************************
 * Barista Quiz DB — Google Apps Script Web API (Code.gs)
 *
 * Required Sheets (tabs + headers on row 1):
 * Decks   : deckId, className, deckName, tags, createdAt
 * Cards   : cardId, deckId, q, a, distractors, sub, createdAt
 * Tests   : testId, name, title, n, selectionsJSON
 * Results : resId, clientId, idempotencyKey, name, location, date, timeEpoch, testId, testName, score, correct, of, answersJSON
 * Archived: resId, clientId, idempotencyKey, name, location, date, timeEpoch, testId, testName, score, correct, of, answersJSON
 * Meta    : key, value         (optional row2: schema | bq_backup_v1)
 **************************************************************/

const SHEETS = {
  DECKS   : 'Decks',
  CARDS   : 'Cards',
  TESTS   : 'Tests',
  RESULTS : 'Results',
  ARCHIVED: 'Archived',
  META    : 'Meta'
};

const HEADERS = {
  Decks   : ['deckId','className','deckName','tags','createdAt'],
  Cards   : ['cardId','deckId','q','a','distractors','sub','createdAt'],
  Tests   : ['testId','name','title','n','selectionsJSON'],
  Results : ['resId','clientId','idempotencyKey','name','location','date','timeEpoch','testId','testName','score','correct','of','answersJSON'],
  Archived: ['resId','clientId','idempotencyKey','name','location','date','timeEpoch','testId','testName','score','correct','of','answersJSON'],
  Meta    : ['key','value']
};

const CACHE_SECONDS = 60; // cache list() to keep student hydration snappy

/* ============================ ROUTER ============================ */

function doGet(e) {
  const p = e && e.parameter ? e.parameter : {};
  const act = String(p.action || 'getAll').toLowerCase(); // default to getAll

  try {
    // Read-only (no auth needed) — app.js may still send ?key=… which is ignored here
    if (act === 'ping')                            return ok({ pong:true, schema:getMeta('schema') || 'bq_backup_v1' });
    if (act === 'getall' || act === 'list')       return ok(listAll());                 // cached decks+cards+tests
    if (act === 'getresults' || act === 'results')return ok(readResults(p));            // ?limit & ?since supported
    if (act === 'decks')                          return ok(readSheet(SHEETS.DECKS));
    if (act === 'cards')                          return ok(readSheet(SHEETS.CARDS));
    if (act === 'tests')                          return ok(readSheet(SHEETS.TESTS));

    return err('Unknown GET action: ' + act, 400);
  } catch (ex) {
    return err(ex.message || 'Server error', 500);
  }
}

function doPost(e) {
  const p = e && e.parameter ? e.parameter : {};
  const body = parseBody(e);
  const act = String((body.action || p.action || '')).toLowerCase();

  // Write routes require API key (accept body.apiKey or ?key=…)
  const needsAuth = ['submitresult','backup','bulkupsert','archivemove','deleteforever'];
  if (needsAuth.indexOf(act) !== -1) {
    const supplied = String(body.apiKey || p.key || '');
    if (!isAuthorized(supplied)) return err('Unauthorized', 401);
  }

  try {
    if (act === 'submitresult') {
      const row = sanitizeResultRow(body.row || body);
      const dup = isDuplicateResult(row.resId, row.idempotencyKey);
      if (dup) return ok({ status:'ok', saved:false, duplicate:true, id:row.resId });
      appendRow(SHEETS.RESULTS, row, HEADERS.Results);
      clearListCache();
      return ok({ status:'ok', saved:true, id:row.resId });
    }

    // app.js calls "bulkupsert" — keep "backup" as an alias
    if (act === 'backup' || act === 'bulkupsert') {
      const mode = String(body.mode || p.mode || 'merge').toLowerCase(); // 'merge' | 'replace'
      const norm = normaliseIncoming(body);
      bulkUpsertFromNormalised(norm, mode);
      clearListCache();
      return ok({
        status:'ok',
        mode,
        counts:{
          decks   : norm.decksRows.length,
          cards   : norm.cardsRows.length,
          tests   : norm.testsRows.length,
          results : (norm.resultsRows   || []).length,
          archived: (norm.archivedRows  || []).length
        }
      });
    }

    if (act === 'archivemove') {
      const moved = archiveMove(String(body.id || ''), body.to === 'archived');
      clearListCache();
      return ok({ status:'ok', moved });
    }

    if (act === 'deleteforever') {
      const cnt = deleteForever(String(body.id || ''), String(body.from || ''));
      clearListCache();
      return ok({ status:'ok', deleted: cnt });
    }

    return err('Unknown POST action: ' + act, 400);
  } catch (ex) {
    return err(ex.message || 'Server error', 500);
  }
}

/* ========================= PUBLIC READS ======================== */

function listAll() {
  const cache = CacheService.getScriptCache();
  const key = 'bq_list_all_v1';
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const decks = readSheet(SHEETS.DECKS);
  const cards = readSheet(SHEETS.CARDS);
  const tests = readSheet(SHEETS.TESTS);

  const data = { decks, cards, tests, version: getMeta('schema') || 'bq_backup_v1' };
  cache.put(key, JSON.stringify(data), CACHE_SECONDS);
  return data;
}

function clearListCache(){ CacheService.getScriptCache().remove('bq_list_all_v1'); }

function readResults(p) {
  let rows = readSheet(SHEETS.RESULTS);
  const since = p.since ? Number(p.since) : null;     // ?since=1700000000000
  if (since) rows = rows.filter(r => Number(r.timeEpoch || 0) >= since);
  const lim = p.limit ? Math.max(1, Number(p.limit)) : null; // ?limit=100
  if (lim) rows = rows.slice(-lim);
  return rows;
}

/* ========================= WRITE ACTIONS ======================= */

function sanitizeResultRow(r){
  const now = Date.now();
  return {
    resId          : String(r.resId || r.id || uid('res')),
    clientId       : String(r.clientId || ''),
    idempotencyKey : String(r.idempotencyKey || ''),
    name           : String(r.name || ''),
    location       : String(r.location || ''),
    date           : String(r.date || ''),
    timeEpoch      : Number(r.time || now),
    testId         : String(r.testId || ''),
    testName       : String(r.testName || ''),
    score          : Number(r.score || 0),
    correct        : Number(r.correct || 0),
    of             : Number(r.of || 0),
    answersJSON    : JSON.stringify(r.answers || r.answer || [])
  };
}

function isDuplicateResult(resId, idempotencyKey){
  if (!resId && !idempotencyKey) return false;
  return hasResultIdOrKey(SHEETS.RESULTS, resId, idempotencyKey)
      || hasResultIdOrKey(SHEETS.ARCHIVED, resId, idempotencyKey);
}

function hasResultIdOrKey(sheetName, resId, idempotencyKey){
  const s = sh(sheetName);
  ensureHeaders(s, sheetName === SHEETS.RESULTS ? HEADERS.Results : HEADERS.Archived);
  const hdr = s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(String);
  const idIdx = hdr.indexOf('resId');
  const keyIdx = hdr.indexOf('idempotencyKey');
  if (idIdx < 0 && keyIdx < 0) return false;
  const last = s.getLastRow();
  if (last < 2) return false;
  const rows = s.getRange(2,1,last-1,hdr.length).getValues();
  for (let i=0; i<rows.length; i++){
    const rowId = idIdx >= 0 ? String(rows[i][idIdx]) : '';
    const rowKey = keyIdx >= 0 ? String(rows[i][keyIdx]) : '';
    if (resId && rowId === String(resId)) return true;
    if (idempotencyKey && rowKey === String(idempotencyKey)) return true;
  }
  return false;
}

function archiveMove(id, toArchived){
  if (!id) throw new Error('Missing id');
  if (toArchived){
    const row = takeRowById(SHEETS.RESULTS, 'resId', id, HEADERS.Results);
    if (!row) return false;
    appendRow(SHEETS.ARCHIVED, row, HEADERS.Archived);
    return true;
  } else {
    const row = takeRowById(SHEETS.ARCHIVED, 'resId', id, HEADERS.Archived);
    if (!row) return false;
    appendRow(SHEETS.RESULTS, row, HEADERS.Results);
    return true;
  }
}

function deleteForever(id, from){
  if (!id) throw new Error('Missing id');
  const tab = (from || '').toLowerCase() === 'archived' ? SHEETS.ARCHIVED : SHEETS.RESULTS;
  return removeRowById(tab, 'resId', id, tab === SHEETS.ARCHIVED ? HEADERS.Archived : HEADERS.Results);
}

/* ========================= BULK UPSERT ======================== */
/**
 * Accepts either:
 * A) Full backup from app.js exportAllBackup():
 *    { schema:'bq_backup_v1', decks:{id:{...}}, tests:{id:{...}}, results:[...], archived:[...] }
 * B) Direct row arrays:
 *    { decksRows:[], cardsRows:[], testsRows:[] }
 * mode: 'merge' (default) or 'replace'
 */
function normaliseIncoming(body){
  const coerceJSON = v => {
    if (v == null) return v;
    if (typeof v === 'string'){ try { return JSON.parse(v); } catch(e){ return v; } }
    return v;
  };

  const schema   = body.schema || '';
  const decksObj = coerceJSON(body.decks)  || {};
  const testsObj = coerceJSON(body.tests)  || {};
  const resultsA = coerceJSON(body.results);
  const archA    = coerceJSON(body.archived);

  // Case A: app backup schema or presence of objects
  if (String(schema) === 'bq_backup_v1' || decksObj || testsObj){
    const results  = Array.isArray(resultsA) ? resultsA : [];
    const archived = Array.isArray(archA)    ? archA    : [];

    const decksRows = [];
    const cardsRows = [];

    Object.values(decksObj || {}).forEach(d=>{
      const deckId = String(d.id || uid('deck'));
      decksRows.push({
        deckId,
        className: String(d.className || ''),
        deckName : String(d.deckName || d.name || ''),
        tags     : (Array.isArray(d.tags)? d.tags: []).join('|'),
        createdAt: Number(d.createdAt || Date.now())
      });

      (Array.isArray(d.cards)? d.cards: []).forEach(c=>{
        cardsRows.push({
          cardId     : String(c.id || uid('card')),
          deckId     : deckId,
          q          : String(c.q || ''),
          a          : String(c.a || ''),
          distractors: (Array.isArray(c.distractors)? c.distractors: []).map(x=>String(x)).join('|'),
          sub        : String(c.sub || ''),
          createdAt  : Number(c.createdAt || Date.now())
        });
      });
    });

    const testsRows = Object.values(testsObj || {}).map(t=>({
      testId        : String(t.id || uid('test')),
      name          : String(t.name || 'Test'),
      title         : String(t.title || t.name || 'Test'),
      n             : Number(t.n || 30),
      selectionsJSON: JSON.stringify(Array.isArray(t.selections) ? t.selections : [])
    }));

    const resultsRows  = results.map(sanitizeResultRow);
    const archivedRows = archived.map(sanitizeResultRow);

    return { schema:'bq_backup_v1', decksRows, cardsRows, testsRows, resultsRows, archivedRows };
  }

  // Case B: raw rows
  return {
    decksRows   : body.decksRows    || [],
    cardsRows   : body.cardsRows    || [],
    testsRows   : body.testsRows    || [],
    resultsRows : body.resultsRows  || [],
    archivedRows: body.archivedRows || [],
    schema      : body.schema       || ''
  };
}

function bulkUpsertFromNormalised(norm, mode){
  const replace = (mode === 'replace');

  if (replace){
    clearAndWrite(SHEETS.DECKS,    HEADERS.Decks,    norm.decksRows);
    clearAndWrite(SHEETS.CARDS,    HEADERS.Cards,    norm.cardsRows);
    clearAndWrite(SHEETS.TESTS,    HEADERS.Tests,    norm.testsRows);

    if (Array.isArray(norm.resultsRows))
      clearAndWrite(SHEETS.RESULTS,  HEADERS.Results,  norm.resultsRows);
    if (Array.isArray(norm.archivedRows))
      clearAndWrite(SHEETS.ARCHIVED, HEADERS.Archived, norm.archivedRows);

    if (norm.schema) upsertMeta('schema', norm.schema);
    return;
  }

  // MERGE
  const existingDecks = indexBy(readSheet(SHEETS.DECKS), 'deckId');
  norm.decksRows.forEach(r => existingDecks[r.deckId] = mergeDeckRow(existingDecks[r.deckId], r));
  writeFromMap(SHEETS.DECKS, HEADERS.Decks, existingDecks);

  const existingCards = indexBy(readSheet(SHEETS.CARDS), 'cardId');
  norm.cardsRows.forEach(r => existingCards[r.cardId] = r);
  writeFromMap(SHEETS.CARDS, HEADERS.Cards, existingCards);

  const existingTests = indexBy(readSheet(SHEETS.TESTS), 'testId');
  norm.testsRows.forEach(r => existingTests[r.testId] = mergeTestRow(existingTests[r.testId], r));
  writeFromMap(SHEETS.TESTS, HEADERS.Tests, existingTests);

  const resIds = new Set(readSheet(SHEETS.RESULTS).map(r=>r.resId));
  const resKeys = new Set(readSheet(SHEETS.RESULTS).map(r=>r.idempotencyKey || ''));
  const toAddR = (norm.resultsRows || []).filter(r => !resIds.has(r.resId) && !resKeys.has(r.idempotencyKey || ''));
  if (toAddR.length) appendMany(SHEETS.RESULTS, toAddR, HEADERS.Results);

  const archIds = new Set(readSheet(SHEETS.ARCHIVED).map(r=>r.resId));
  const archKeys = new Set(readSheet(SHEETS.ARCHIVED).map(r=>r.idempotencyKey || ''));
  const toAddA  = (norm.archivedRows || []).filter(r => !archIds.has(r.resId) && !archKeys.has(r.idempotencyKey || ''));
  if (toAddA.length) appendMany(SHEETS.ARCHIVED, toAddA, HEADERS.Archived);

  if (norm.schema) upsertMeta('schema', norm.schema);
}

function mergeDeckRow(oldR, newR){
  if (!oldR) return newR;
  const tags = uniq([
    ...(String(oldR.tags || '').split('|').filter(Boolean)),
    ...(String(newR.tags || '').split('|').filter(Boolean))
  ]).join('|');
  return {
    deckId   : newR.deckId || oldR.deckId,
    className: newR.className || oldR.className || '',
    deckName : newR.deckName || oldR.deckName  || '',
    tags,
    createdAt: Number(oldR.createdAt || newR.createdAt || Date.now())
  };
}

function mergeTestRow(oldR, newR){
  if (!oldR) return newR;
  const aSel = tryParseJSON(oldR.selectionsJSON) || [];
  const bSel = tryParseJSON(newR.selectionsJSON) || [];
  const merged = dedupeSelections(aSel.concat(bSel));
  return {
    testId        : oldR.testId || newR.testId,
    name          : newR.name   || oldR.name,
    title         : newR.title  || oldR.title || newR.name || oldR.name,
    n             : Math.max(Number(oldR.n || 30), Number(newR.n || 30)),
    selectionsJSON: JSON.stringify(merged)
  };
}

function dedupeSelections(selections){
  const map = {};
  (selections || []).forEach(s=>{
    const id = String(s.deckId || '');
    if (!map[id]) map[id] = { deckId:id, whole:false, subs:{} };
    map[id].whole = map[id].whole || !!s.whole;
    (Array.isArray(s.subs) ? s.subs : []).forEach(x => map[id].subs[String(x)] = true);
  });
  return Object.values(map).map(v=>({
    deckId: v.deckId,
    whole : v.whole && Object.keys(v.subs).length === 0,
    subs  : Object.keys(v.subs)
  }));
}

/* ======================== SHEET HELPERS ======================= */

function ss(){
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Missing SPREADSHEET_ID Script Property');
  return SpreadsheetApp.openById(id);
}

function sh(name){
  const s = ss().getSheetByName(name);
  if (!s) throw new Error('Missing sheet: ' + name);
  return s;
}

function headerForSheet(name){
  switch(name){
    case SHEETS.DECKS: return HEADERS.Decks;
    case SHEETS.CARDS: return HEADERS.Cards;
    case SHEETS.TESTS: return HEADERS.Tests;
    case SHEETS.RESULTS: return HEADERS.Results;
    case SHEETS.ARCHIVED: return HEADERS.Archived;
    case SHEETS.META: return HEADERS.Meta;
    default: return null;
  }
}

function ensureHeaders(sheet, headerArr){
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0){
    sheet.getRange(1,1,1,headerArr.length).setValues([headerArr]);
    return;
  }
  const current = sheet.getRange(1,1,1,lastCol).getValues()[0].map(String);
  let changed = false;
  headerArr.forEach((h, idx) => {
    if (current[idx] !== h) {
      current[idx] = h;
      changed = true;
    }
  });
  if (current.length < headerArr.length){
    for (let i=current.length; i<headerArr.length; i++){
      current[i] = headerArr[i];
    }
    changed = true;
  }
  if (changed){
    sheet.getRange(1,1,1,current.length).setValues([current]);
  }
}

function readSheet(name){
  const s = sh(name);
  const desired = headerForSheet(name);
  ensureHeaders(s, desired || s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(String));
  const values = s.getDataRange().getValues();
  if (!values.length) return [];
  const hdr = values[0].map(String);
  const rows = [];
  for (let i=1; i<values.length; i++){
    const r = values[i];
    if (r.every(v => v === '' || v === null)) continue;
    const obj = {};
    hdr.forEach((h, idx) => obj[h] = r[idx]);
    rows.push(obj);
  }
  return rows;
}

function appendRow(name, obj, headerArr){
  const s = sh(name);
  const hdr = headerArr || s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(String);
  ensureHeaders(s, hdr);
  const row = hdr.map(h => (h in obj ? obj[h] : ''));
  s.appendRow(row);
}

function appendMany(name, arr, headerArr){
  if (!arr || !arr.length) return;
  const s = sh(name);
  const hdr = headerArr || s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(String);
  ensureHeaders(s, hdr);
  const out = arr.map(obj => hdr.map(h => (h in obj ? obj[h] : '')));
  s.getRange(s.getLastRow()+1, 1, out.length, hdr.length).setValues(out);
}

function clearAndWrite(name, headerArr, rows){
  const s = sh(name);
  s.clearContents();
  s.getRange(1,1,1,headerArr.length).setValues([headerArr]);
  if (rows && rows.length){
    const out = rows.map(r => headerArr.map(h => (h in r ? r[h] : '')));
    s.getRange(2,1,out.length,headerArr.length).setValues(out);
  }
}

function takeRowById(name, idField, idValue, headerArr){
  const s = sh(name);
  const hdr = headerArr || s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(String);
  const idIdx = hdr.indexOf(idField);
  if (idIdx < 0) throw new Error('Missing field ' + idField + ' in ' + name);

  const last = s.getLastRow();
  if (last < 2) return null;

  const rng = s.getRange(2,1,last-1,hdr.length).getValues();
  for (let i=0; i<rng.length; i++){
    if (String(rng[i][idIdx]) === String(idValue)){
      const rowVals = rng[i];
      s.deleteRow(i + 2);
      const obj = {};
      hdr.forEach((h, ix) => obj[h] = rowVals[ix]);
      return obj;
    }
  }
  return null;
}

function removeRowById(name, idField, idValue, headerArr){
  const s = sh(name);
  const hdr = headerArr || s.getRange(1,1,1,s.getLastColumn()).getValues()[0].map(String);
  const idIdx = hdr.indexOf(idField);
  if (idIdx < 0) throw new Error('Missing field ' + idField + ' in ' + name);

  const last = s.getLastRow();
  if (last < 2) return 0;

  const rng = s.getRange(2,1,last-1,hdr.length).getValues();
  for (let i=0; i<rng.length; i++){
    if (String(rng[i][idIdx]) === String(idValue)){
      s.deleteRow(i + 2);
      return 1;
    }
  }
  return 0;
}

function writeFromMap(name, headerArr, map){
  const rows = Object.values(map);
  clearAndWrite(name, headerArr, rows);
}

/* =========================== META ============================ */

function getMeta(key){
  try{
    const rows = readSheet(SHEETS.META);
    const hit = rows.find(r => String(r.key) === String(key));
    return hit ? hit.value : '';
  }catch(_){ return ''; }
}

function upsertMeta(key, value){
  try{
    const s = sh(SHEETS.META);
    const hdr = HEADERS.Meta;
    if (s.getLastRow() < 1) s.getRange(1,1,1,hdr.length).setValues([hdr]);

    const rows = readSheet(SHEETS.META);
    const idx = rows.findIndex(r => String(r.key) === String(key));
    if (idx === -1){
      appendRow(SHEETS.META, { key, value }, hdr);
    } else {
      s.getRange(idx + 2, 1, 1, 2).setValues([[key, value]]);
    }
  }catch(_){ /* Meta tab optional */ }
}

/* ========================== UTIL ============================= */

function ok(data){
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function err(message, code){
  return ContentService
    .createTextOutput(JSON.stringify({ error: message, code: code || 500 }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Tolerant body parser: try JSON regardless of Content-Type; else fall back to URL-encoded params
function parseBody(e){
  if (!e || !e.postData) return {};
  var raw = e.postData.contents || '';
  try { return JSON.parse(raw); } catch (_) {}
  var p = e.parameter || {};
  var o = {};
  Object.keys(p).forEach(function(k){ o[k] = p[k]; });
  return o;
}

function isAuthorized(supplied){
  const req  = String(supplied || '');
  const conf = PropertiesService.getScriptProperties().getProperty('API_KEY') || '';
  return conf && req && req === conf;
}

function indexBy(arr, key){
  const m = {};
  (arr || []).forEach(x => { m[String(x[key])] = x; });
  return m;
}

function uid(pfx){ return String(pfx || 'id') + '_' + Math.random().toString(36).slice(2,10); }

function uniq(arr){
  const s = {};
  (arr || []).forEach(v => { s[String(v)] = true; });
  return Object.keys(s);
}

function tryParseJSON(s){ try { return JSON.parse(s); } catch(_){ return null; } }
