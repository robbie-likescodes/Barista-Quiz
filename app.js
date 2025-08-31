/* =========================================================
   Barista Flashcards & Quizzes — app.js (with Google Sheets sync)
   Local-first SPA + Cloud sync (pull/push/submit/results)
========================================================= */

/* ========= Cloud API Config (EDIT ONLY IF YOU REDEPLOY) ========= */
const CLOUD = {
  BASE: "https://script.google.com/macros/s/AKfycbwjRzGAFZUZld6-IhJlcQclaJN0rGrduInI_xYuBp_isfBJigUBtaUH5luuVXcUmjjDhg/exec",
  API_KEY: "longrandomstringwhatwhat" // must match Script Property 'API_KEY'
};
/* ================================================================ */

//////////////////// tiny DOM/storage helpers ////////////////////
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const on = (el, ev, fn, opt) => el && el.addEventListener(ev, fn, opt);

const store = {
  get(k, f){ try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } },
  set(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
};

//////////////////////////// constants ///////////////////////////
const KEYS = {
  decks   : 'bq_decks_v6',
  tests   : 'bq_tests_v6',
  results : 'bq_results_v6',
  archived: 'bq_results_archived_v1'
};
const ADMIN_VIEWS = new Set(['create','build','reports']);

//////////////////////////// utils ///////////////////////////////
const uid      = (p='id') => p+'_'+Math.random().toString(36).slice(2,10);
const todayISO = () => new Date().toISOString().slice(0,10);
const esc      = s => (s??'').toString().replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const shuffle  = a => { const x=a.slice(); for(let i=x.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]] } return x; };
const sample   = (a,n) => shuffle(a).slice(0,n);
const unique   = xs => Array.from(new Set(xs));
const deepCopy = obj => JSON.parse(JSON.stringify(obj));
const deckKey  = d => `${(d.className||'').trim().toLowerCase()}||${(d.deckName||'').trim().toLowerCase()}`;
const cardKey  = c => `${(c.q||'').trim().toLowerCase()}|${(c.a||'').trim().toLowerCase()}|${(c.sub||'').trim().toLowerCase()}`;

//////////////////////// Cloud helpers /////////////////////////
async function cloudGET(params={}){
  const url = new URL(CLOUD.BASE);
  Object.entries(params).forEach(([k,v])=> url.searchParams.set(k, String(v)));
  const r = await fetch(url.toString(), { method:'GET' });
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function cloudPOST(action, payload={}, extraQS={}){
  const url = new URL(CLOUD.BASE);
  url.searchParams.set('action', action);
  if (CLOUD.API_KEY) url.searchParams.set('key', CLOUD.API_KEY);
  for(const [k,v] of Object.entries(extraQS||{})) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getAllFromCloud(){
  const data = await cloudGET({action:'getAll'}); // {decks:[],cards:[],tests:[]}
  if(!data || !Array.isArray(data.decks) || !Array.isArray(data.cards) || !Array.isArray(data.tests)){
    throw new Error('Malformed getAll response');
  }
  const decks = {};
  for(const d of data.decks){
    const id = d.deckId || d.id || uid('deck');
    decks[id] = {
      id,
      className: d.className || '',
      deckName : d.deckName || (d.name || 'Deck'),
      cards    : [],
      tags     : Array.isArray(d.tags) ? d.tags
               : (typeof d.tags==='string' && d.tags ? String(d.tags).split(',').map(s=>s.trim()).filter(Boolean) : []),
      createdAt: d.createdAt || Date.now()
    };
  }
  for(const c of data.cards){
    const deckId = c.deckId;
    if(!deckId || !decks[deckId]) continue;
    (decks[deckId].cards ||= []).push({
      id: c.cardId || uid('card'),
      q: c.q || '',
      a: c.a || '',
      distractors: Array.isArray(c.distractors) ? c.distractors
                 : (typeof c.distractors==='string' && c.distractors ? String(c.distractors).split('|').map(s=>s.trim()).filter(Boolean) : []),
      sub: c.sub || '',
      createdAt: c.createdAt || Date.now()
    });
  }
  const tests = {};
  for(const t of data.tests){
    const id = t.id || uid('test');
    tests[id] = { id, name: t.name || 'Test', title: t.title || t.name || 'Test', n: Math.max(1, +t.n || 30), selections: Array.isArray(t.selections) ? t.selections : [] };
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
    $('#cloudPullBtn')?.setAttribute('disabled','true');
    const {decks, tests} = await getAllFromCloud();
    state.decks = decks; state.tests = tests;
    mergeDecksByName(); normalizeTests();
    store.set(KEYS.decks, state.decks);
    store.set(KEYS.tests, state.tests);
    renderCreate(); renderBuild(); renderReports();
    toast('Pulled from Cloud');
  }catch(err){
    alert('Cloud pull failed: '+(err.message||err));
  }finally{ $('#cloudPullBtn')?.removeAttribute('disabled'); }
}
async function cloudPushHandler(){
  const modeMerge = confirm('Push to Cloud?\n\nOK = MERGE into Sheets\nCancel = REPLACE (overwrite Sheets with local)');
  try{
    $('#cloudPushBtn')?.setAttribute('disabled','true');
    const backup = makeBackupObject();
    const resp = await cloudPOST('backup', backup, {mode: modeMerge ? 'merge' : 'replace'});
    if(resp?.status==='ok'){ toast(modeMerge ? 'Merged to Cloud' : 'Replaced in Cloud'); }
    else{
      const msg = resp?.message || resp?.reason || JSON.stringify(resp||{});
      throw new Error(msg);
    }
  }catch(err){
    alert('Cloud push failed: '+(err.message||err));
  }finally{ $('#cloudPushBtn')?.removeAttribute('disabled'); }
}
async function resultsRefreshFromCloud(){
  try{
    const rows = await cloudGET({action:'getResults',limit:500});
    if(!Array.isArray(rows)) throw new Error('Bad getResults response');
    state.results = rows.map(r=>({
      id:r.id||uid('res'), name:r.name||'', location:r.location||'', date:r.date||'',
      time:Number(r.time)||Date.now(), testId:r.testId||'', testName:r.testName||'',
      score:Number(r.score)||0, correct:Number(r.correct)||0, of:Number(r.of)||0,
      answers:Array.isArray(r.answers)?r.answers:[]
    }));
    store.set(KEYS.results, state.results);
    renderReports();
    toast('Results pulled from Cloud');
  }catch(err){
    alert('Failed to refresh results: '+(err.message||err));
  }
}
async function maybeHydrateFromCloud(){
  try{
    const needHydrate = isStudent() ||
      (Object.keys(state.decks||{}).length===0 && Object.keys(state.tests||{}).length===0);
    if(!needHydrate) return;
    const {decks, tests} = await getAllFromCloud();
    state.decks = decks; state.tests = tests;
    store.set(KEYS.decks, decks); store.set(KEYS.tests, tests);
    toast('Loaded latest decks & tests from Cloud');
  }catch(err){
    console.warn('Cloud hydrate failed:', err.message||err);
  }
}

/////////////////////////// global state /////////////////////////
let state = {
  decks   : store.get(KEYS.decks, {}),
  tests   : store.get(KEYS.tests, {}),
  results : store.get(KEYS.results, []),
  archived: store.get(KEYS.archived, []),
  practice: { cards:[], idx:0 },
  quiz    : { items:[], idx:0, n:30, locked:false, testId:'' },
  ui      : { currentTestId: null, subFilter: '' }
};

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

  if(view==='create')   renderCreate();
  if(view==='build')    renderBuild();
  if(view==='practice') renderPracticeScreen();
  if(view==='quiz')     renderQuizScreen();
  if(view==='reports')  renderReports();

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
    const name = p.get('test')||'';
    if(name){
      const entry = Object.entries(state.tests).find(([,t])=>t.name.toLowerCase()===name.toLowerCase());
      if(entry){ state.quiz.locked=true; state.quiz.testId=entry[0]; }
    }
    const next = p.get('view') && !ADMIN_VIEWS.has(p.get('view')) ? p.get('view') : 'practice';
    setParams({view:next});
  }
}

/////////////////////// deck merge helpers ///////////////////////
function listUniqueDecks(){
  const seen=new Set(), arr=[];
  for(const d of Object.values(state.decks)){
    const k=deckKey(d); if(!seen.has(k)){ seen.add(k); arr.push(d); }
  }
  arr.sort((a,b)=> (a.className||'').localeCompare(b.className||'') || (a.deckName||'').localeCompare(b.deckName||'')); 
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
  if(changed) store.set(KEYS.tests,state.tests);
  store.set(KEYS.decks,state.decks);
}

//////////////////////////// CREATE //////////////////////////////
function renderCreate(){
  ensureBackupButtons(); // adds Export/Import + Cloud Pull/Push

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
  renderCardsList();

  on($('#createSubdeckBtn'),'click',createSubdeck);
  on($('#toggleSubdeckBtn'),'click',toggleNewSubdeck);
  on($('#addDeckBtn'),'click',addDeck);
  on($('#renameDeckBtn'),'click',renameDeck);
  on($('#editDeckMetaBtn'),'click',editDeckMeta);
  on($('#deleteDeckBtn'),'click',deleteDeck);
  on($('#exportDeckBtn'),'click',exportDeck);
  on($('#importDeckBtn'),'click',()=>{ toast('Choose a JSON or TXT file to import…',1400); $('#importDeckInput')?.click(); });
  on($('#importDeckInput'),'change',importDeckInputChange);
  on($('#bulkSummaryBtn'),'click',()=>setTimeout(()=>toast('Format: Q | Correct | Wrong1 | Wrong2 | Wrong3 | #Sub-deck(optional)'),60));
  on($('#bulkAddBtn'),'click',bulkAddCards);
  on($('#addCardBtn'),'click',addCard);

  on($('#cloudPullBtn'),'click',cloudPullHandler);
  on($('#cloudPushBtn'),'click',cloudPushHandler);

  on($('#deckSelect'),'change',()=>{ 
    state.ui.subFilter=''; 
    renderDeckMeta(); renderSubdeckManager(); renderCardsList(); 
  });
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
  subsEl.querySelectorAll('.remove').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const tag=btn.dataset.sub;
      const alsoClear=confirm(`Remove sub-deck “${tag}” from deck tags?\n\nOK = also clear this tag from ALL cards.\nCancel = just remove declared tag.`);
      d.tags=(d.tags||[]).filter(t=>t!==tag);
      if(alsoClear){ (d.cards||[]).forEach(c=>{ if((c.sub||'')===tag) c.sub=''; }); }
      store.set(KEYS.decks,state.decks);
      renderDeckMeta(); renderSubdeckManager(); renderCardsList();
    });
  });

  const subSel = $('#cardsSubFilter');
  if(subSel){
    const curr = state.ui.subFilter || '';
    subSel.innerHTML = `<option value="">All sub-decks</option>` + subs.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if(curr && subs.includes(curr)) subSel.value = curr; else subSel.value = '';
    subSel.onchange = ()=>{ state.ui.subFilter = subSel.value || ''; renderCardsList(); };
  }
}
function renderSubdeckManager(){
  const list=$('#subdeckManagerList'); if(!list) return;
  const id=selectedDeckId();
  if(!id){ list.innerHTML='<span class="hint">Select a deck first.</span>'; return; }
  const d=state.decks[id]; const subs=deckSubTags(d);
  list.innerHTML=subs.length?subs.map(s=>`
    <span class="chip">${esc(s)} <button class="remove" data-sub="${esc(s)}" title="Remove tag" aria-label="Remove tag">&times;</button></span>
  `).join(''):`<span class="hint">No sub-decks yet</span>`;
  list.querySelectorAll('.remove').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const tag=btn.dataset.sub;
      const alsoClear=confirm(`Remove sub-deck “${tag}” from deck tags?\n\nOK = also clear this tag from ALL cards.\nCancel = just remove declared tag.`);
      d.tags=(d.tags||[]).filter(t=>t!==tag);
      if(alsoClear){ (d.cards||[]).forEach(c=>{ if((c.sub||'')===tag) c.sub=''; }); }
      store.set(KEYS.decks,state.decks);
      renderDeckMeta(); renderSubdeckManager(); renderCardsList();
    });
  });
}
function renderCardsList(){
  const cardsList=$('#cardsList'); if(!cardsList) return;
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

  cardsList.querySelectorAll('.btn-del').forEach(b=>b.addEventListener('click',()=>{
    const keepDeckId = selectedDeckId(); if(!keepDeckId) return;
    const y = window.scrollY;
    const d=state.decks[keepDeckId];
    const cid=b.closest('.cardline').dataset.id;
    d.cards=d.cards.filter(c=>c.id!==cid);
    store.set(KEYS.decks,state.decks);

    renderDeckSelect();
    const deckSelect = $('#deckSelect');
    if (deckSelect) deckSelect.value = keepDeckId;

    renderDeckMeta(); renderSubdeckManager(); renderCardsList();
    window.scrollTo(0, y);
    toast('Card deleted');
  }));

  cardsList.querySelectorAll('.btn-edit').forEach(b=>b.addEventListener('click',()=>{
    const cid=b.closest('.cardline').dataset.id; const card=d.cards.find(c=>c.id===cid); if(!card) return;
    const q=prompt('Question:',card.q); if(q===null) return;
    const a=prompt('Correct answer:',card.a); if(a===null) return;
    const wrong=prompt('Wrong answers (separate by |):',(card.distractors||[]).join('|'));
    const sub=prompt('Card sub-deck (optional):',card.sub||''); if(sub===null) return;
    card.q=q.trim(); card.a=a.trim(); card.distractors=(wrong||'').split('|').map(s=>s.trim()).filter(Boolean); card.sub=sub.trim();
    if(card.sub){ d.tags=unique([...(d.tags||[]),card.sub]); }
    store.set(KEYS.decks,state.decks); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
    toast('Card updated');
  }));
}

// CREATE handlers
function createSubdeck(){
  const id=selectedDeckId(); if(!id) return alert('Select a deck first.');
  const name=($('#subdeckNewName')?.value||'').trim(); if(!name) return;
  const d=state.decks[id]; d.tags=unique([...(d.tags||[]),name]);
  store.set(KEYS.decks,state.decks); $('#subdeckNewName').value='';
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
    if(sdn){ existing.tags=unique([...(existing.tags||[]),sdn]); store.set(KEYS.decks,state.decks); }
    renderDeckMeta(); renderSubdeckManager(); renderCardsList(); renderDeckSelect();
    toast('Selected existing deck'); return;
  }
  const id=uid('deck');
  state.decks[id]={id,className:cls,deckName:dnm,cards:[],tags:sdn?[sdn]:[],createdAt:Date.now()};
  store.set(KEYS.decks,state.decks);

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
  store.set(KEYS.decks,state.decks); mergeDecksByName();
  renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
  toast('Deck renamed');
}
function editDeckMeta(){
  const id=selectedDeckId(); if(!id) return;
  const d=state.decks[id];
  const cls=prompt('Edit Class:',d.className||''); if(cls===null) return;
  d.className=cls.trim();
  store.set(KEYS.decks,state.decks); mergeDecksByName();
  renderDeckSelect(); renderDeckMeta();
  toast('Meta updated');
}
function deleteDeck(){
  const id=selectedDeckId(); if(!id) return;
  if(confirm('Delete this deck and its cards?')){
    delete state.decks[id];
    store.set(KEYS.decks,state.decks);
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
      store.set(KEYS.decks,state.decks);
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
  store.set(KEYS.decks,state.decks); if($('#bulkTextarea')) $('#bulkTextarea').value='';
  renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
  toast(`Added ${n} card(s)`);
}
function addCard(){
  const id=selectedDeckId(); if(!id) return alert('Select a deck first.');
  const q=$('#qInput')?.value.trim(), a=$('#aCorrectInput')?.value.trim(), w1=$('#aWrong1Input')?.value.trim(),
        w2=$('#aWrong2Input')?.value.trim(), w3=$('#aWrong3Input')?.value.trim(), sub=$('#cardSubInput')?.value.trim();
  if(!q||!a||!w1) return alert('Enter question, correct, and at least one wrong answer.');
  state.decks[id].cards.push({id:uid('card'),q,a,distractors:[w1,w2,w3].filter(Boolean),sub,createdAt:Date.now()});
  if(sub){ const d=state.decks[id]; d.tags=unique([...(d.tags||[]),sub]); }
  store.set(KEYS.decks,state.decks);
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
  on($('#saveTestBtn'),'click',saveTest);
  on($('#renameTestBtn'),'click',renameTest);
  on($('#deleteTestBtn'),'click',deleteTest);
  on($('#copyShareBtn'),'click',copyShareLink);
  on($('#openShareBtn'),'click',openSharePreview);
  on($('#previewToggle'),'change',syncPreview);
  on($('#previewPracticeBtn'),'click',()=>{ setParams({view:'practice'}); activate('practice'); });
  on($('#previewQuizBtn'),'click',()=>{ setParams({view:'quiz'}); activate('quiz'); });
  on($('#testNameInput'),'input',handleTestNameInput);
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
    t = state.tests[id] = { id, name: typedName, title: typedName, n: 30, selections: [] };
    state.ui.currentTestId = id;
  } else {
    t.name = typedName;
  }

  t.title = ($('#builderTitle')?.value.trim() || t.title || typedName);
  t.n = Math.max(1, +($('#builderCount')?.value) || t.n || 30);
  t.selections = dedupeSelections(readSelectionsFromUI());

  store.set(KEYS.tests,state.tests);
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
  store.set(KEYS.tests, state.tests);
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
    store.set(KEYS.tests,state.tests);
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
  store.set(KEYS.tests,state.tests); 
  return t;
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

//////////////////////// PRACTICE ////////////////////////////////
function renderPracticeScreen(){
  fillTestsSelect($('#practiceTestSelect'),true);
  const last=store.get('bq_last_test',null);
  const sel=$('#practiceTestSelect');
  if(last && sel?.querySelector(`option[value="${last}"]`)) sel.value=last;
  buildPracticeDeckChecks();

  on($('#practiceTestSelect'),'change',()=>{ buildPracticeDeckChecks(); store.set('bq_last_test',$('#practiceTestSelect').value); });
  on($('#startPracticeBtn'),'click',startPractice);
  on($('#practicePrev'),'click',()=>{ state.practice.idx=Math.max(0,state.practice.idx-1); showPractice(); });
  on($('#practiceNext'),'click',()=>{ state.practice.idx=Math.min(state.practice.cards.length-1,state.practice.idx+1); showPractice(); });
  on($('#practiceShuffle'),'click',()=>{ state.practice.cards=shuffle(state.practice.cards); state.practice.idx=0; showPractice(); });
}
function fillTestsSelect(sel,lockToStudent=false){
  if(!sel) return;
  const list=Object.entries(state.tests).sort((a,b)=>a[1].name.localeCompare(b[1].name));
  if(state.quiz.locked && state.quiz.testId && lockToStudent){
    const t=state.tests[state.quiz.testId]; sel.innerHTML=t?`<option value="${state.quiz.testId}">${esc(t.name)}</option>`:'';
    sel.value=state.quiz.testId; sel.disabled=true; return;
  }
  sel.disabled=false;
  sel.innerHTML=list.map(([id,t])=>`<option value="${id}">${esc(t.name)}</option>`).join('')||'';
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
  }

  startOrRefreshQuiz();

  on($('#quizTestSelect'),'change',()=>{ startOrRefreshQuiz(); store.set('bq_last_test',$('#quizTestSelect').value); });
  on($('#quizPrev'),'click',()=>{ state.quiz.idx=Math.max(0,state.quiz.idx-1); drawQuiz(); });
  on($('#quizNext'),'click',()=>{ state.quiz.idx=Math.min(state.quiz.items.length-1,state.quiz.idx+1); drawQuiz(); });
  on($('#submitQuizBtn'),'click',submitQuiz);
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
  if(!name||!loc||!dt) return alert('Name, location and date are required.');
  const tid=$('#quizTestSelect')?.value; const t=state.tests[tid]; if(!t) return alert('No test selected.');
  const total=state.quiz.items.length; const correct=state.quiz.items.filter(x=>x.picked===x.a).length; const score=Math.round(100*correct/Math.max(1,total));
  const answers=state.quiz.items.map((x,i)=>({i,q:x.q,correct:x.a,picked:x.picked}));

  const row={id:uid('res'),name,location:loc,date:dt,time:Date.now(),testId:tid,testName:t.name,score,correct,of:total,answers};
  state.results.push(row); store.set(KEYS.results,state.results);

  // Try to write to Cloud (does not block UI)
  try{
    const resp = await cloudPOST('submitResult', row);
    if(resp?.status==='ok') { /* ok */ }
    else { console.warn('submitResult resp', resp); toast('Saved locally; cloud error.'); }
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
  toast('Submission saved');

  on($('#restartQuizBtn'),'click',()=>{ $('#quizFinished')?.classList.add('hidden'); $('#quizArea')?.classList.remove('hidden'); startOrRefreshQuiz(); }, { once:true });
  on($('#finishedPracticeBtn'),'click',()=>{ setParams({view:'practice'}); activate('practice'); }, { once:true });
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

  on($('#repLocation'),'change',drawReports);
  on($('#repAttemptView'),'change',drawReports);
  on($('#repSort'),'change',drawReports);
  on($('#repView'),'change',drawReports);
  on($('#repDateFrom'),'change',drawReports);
  on($('#repDateTo'),'change',drawReports);
  on($('#repTest'),'change',drawReports);
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

  if(loc)    rows = rows.filter(r=>r.location===loc);
  if(testNm) rows = rows.filter(r=>r.testName===testNm);
  if(fromISO) rows = rows.filter(r => (r.date || '') >= fromISO);
  if(toISO)   rows = rows.filter(r => (r.date || '') <= toISO);

  if(attempt!=='all'){
    const map=new Map();
    for(const r of rows){ const k=r.name+'|'+r.testName; (map.get(k)||map.set(k,[]).get(k)).push(r); }
    rows=[]; map.forEach(arr=>{ arr.sort((a,b)=>a.time-b.time); rows.push(attempt==='first'?arr[0]:arr[arr.length-1]); });
  }

  if(sort==='date_desc') rows.sort((a,b)=>b.time-a.time);
  if(sort==='date_asc')  rows.sort((a,b)=>a.time-b.time);
  if(sort==='test_asc')  rows.sort((a,b)=>a.testName.localeCompare(b.testName));
  if(sort==='test_desc') rows.sort((a,b)=>b.testName.localeCompare(a.testName));
  if(sort==='loc_asc')   rows.sort((a,b)=> (a.location||'').localeCompare(b.location||''));
  if(sort==='loc_desc')  rows.sort((a,b)=> (b.location||'').localeCompare(a.location||''));  

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

  tb.querySelectorAll('.view-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const id=btn.closest('tr').dataset.id; const src = view==='archived'?state.archived:state.results;
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
  }));
  tb.querySelectorAll('button[data-act]').forEach(b=>b.addEventListener('click',()=>{
    const id = b.closest('tr').dataset.id;
    const act= b.dataset.act;
    if (act==='archive')        archiveResult(id);
    else if (act==='restore')   restoreResult(id);
    else if (act==='delete-forever'){
      if (confirm('Delete this result permanently?')) deleteForever(id, view==='archived'?'archived':'active');
    }
  }));

  renderLocationAverages(view, loc, attempt, fromISO, toISO, testNm);

  const baseRows=[...state.results];
  const missMap=new Map();
  for(const r of baseRows){
    for(const a of (r.answers||[])){
      const k=a.q; if(!missMap.has(k)) missMap.set(k,{q:k,misses:0,total:0});
      const m=missMap.get(k); m.total++; if(a.picked!==a.correct) m.misses++;
    }
  }
  const top=[...missMap.values()].filter(x=>x.total>0).sort((a,b)=>b.misses-a.misses).slice(0,10);
  if($('#missedSummary')) $('#missedSummary').innerHTML = top.length? top.map(m=>`
    <div class="missrow">
      <div class="misscount"><div>${m.misses}/${m.total}</div><div class="hint">missed</div></div>
      <div class="missq">${esc(m.q)}</div>
    </div>`).join('') : '<div class="hint">No data yet.</div>';
}
function archiveResult(id){
  const i = state.results.findIndex(r=>r.id===id);
  if(i>-1){
    const [row]=state.results.splice(i,1);
    state.archived.push(row);
    store.set(KEYS.results,state.results);
    store.set(KEYS.archived,state.archived);
    drawReports(); toast('Result archived');
  }
}
function restoreResult(id){
  const i = state.archived.findIndex(r=>r.id===id);
  if(i>-1){
    const [row]=state.archived.splice(i,1);
    state.results.push(row);
    store.set(KEYS.results,state.results);
    store.set(KEYS.archived,state.archived);
    drawReports(); toast('Result restored');
  }
}
function deleteForever(id, from='active'){
  const list = from==='archived' ? state.archived : state.results;
  const i = list.findIndex(r=>r.id===id);
  if(i>-1){
    list.splice(i,1);
    store.set(KEYS.results,state.results);
    store.set(KEYS.archived,state.archived);
    drawReports(); toast('Result deleted');
  }
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
    box.innerHTML = '<div class="hint">No data yet.</div>'; return;
  }
  box.innerHTML = avgs.map(x=>`
    <div class="missrow">
      <div class="misscount"><div>${x.count}</div><div class="hint">attempts</div></div>
      <div class="missq"><strong>${esc(x.location)}</strong> — avg <strong>${Math.round(x.avg)}%</strong></div>
    </div>
  `).join('');
}

//////////////////// Full Backup / Restore //////////////////////
function ensureBackupButtons(){
  const hdr = $('#view-create .card .card-head'); if(!hdr) return;

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

  // Cloud buttons
  if(!$('#cloudPullBtn')){
    const cp = document.createElement('button');
    cp.id='cloudPullBtn'; cp.className='btn ghost'; cp.textContent='Pull from Cloud';
    hdr.appendChild(cp);
  }
  if(!$('#cloudPushBtn')){
    const pb = document.createElement('button');
    pb.id='cloudPushBtn'; pb.className='btn success'; pb.textContent='Push Backup';
    hdr.appendChild(pb);
  }
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
  store.set(KEYS.decks,   state.decks);
  store.set(KEYS.tests,   state.tests);
  store.set(KEYS.results, state.results);
  store.set(KEYS.archived,state.archived);
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
  if(changed) store.set(KEYS.tests,state.tests);
}

function ensureReportsButtons(){
  const headerCard = $('#view-reports .card'); if(!headerCard) return;
  if(!$('#resultsCloudBtn')){
    const btn = document.createElement('button');
    btn.id='resultsCloudBtn'; btn.className='btn'; btn.textContent='Refresh from Cloud';
    headerCard.querySelector('.grid')?.appendChild(document.createElement('div'))?.appendChild?.(btn) || headerCard.appendChild(btn);
    on(btn,'click',resultsRefreshFromCloud);
  }
}

async function boot(){
  mergeDecksByName();
  normalizeTests();

  await maybeHydrateFromCloud(); // load from Sheets for student/empty devices
  applyStudentMode();

  $$('select').forEach(sel=>{
    sel.style.pointerEvents='auto';
    sel.addEventListener('touchstart',()=>sel.focus(),{passive:true});
  });

  if($('#studentDate') && !$('#studentDate').value) $('#studentDate').value=todayISO();

  activate(qs().get('view') || (isStudent() ? 'practice' : 'create'));
}
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
