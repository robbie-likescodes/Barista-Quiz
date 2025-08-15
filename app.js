/* =============================
   Storage model
   =============================

state = {
  classes: {
    "<className>": {
      decks: {
        "<deckName>": {   // unique within class
          subdecks: { "<subName>": true, ... },
          cards: [ {q,a,wrongs:[...], class, deck, sub } ... ]
        }, ...
      }
    }, ...
  },
  tests: {
    "<testName>": {
      title, count,
      // selections is a normalized tree { [class]: { [deck]: Set(subdeckNames or '*') } }
      selections
    }
  },
  results: [ {id, test, title, name, location, dateISO, score, total, items:[{q,correct,choice,answer}], mode:'student'} ... ]
}

Everything is persisted in localStorage under BARISTA_APP_V3
*/

const KEY = 'BARISTA_APP_V3';

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { classes:{}, tests:{}, results:[] };
}
function save(){ localStorage.setItem(KEY, JSON.stringify(state)); }

/* ---------- Utilities ---------- */
const todayISO = () => new Date().toISOString().slice(0,10);
const uid = () => Math.random().toString(36).slice(2,10);

/* Normalize & helpers */
function ensureClassDeck(cName, dName){
  if(!state.classes[cName]) state.classes[cName] = {decks:{}};
  const decks = state.classes[cName].decks;
  if(!decks[dName]) decks[dName] = {subdecks:{}, cards:[]};
  return decks[dName];
}
function allDeckOptions() {
  // return [{class, deck, label:"Deck — Class"}] unique per (class,deck)
  const out = [];
  for (const [cls, {decks}] of Object.entries(state.classes)) {
    for (const deck of Object.keys(decks)) {
      out.push({class:cls, deck, label:`${deck} — ${cls}`});
    }
  }
  // stable sort
  out.sort((a,b)=> (a.class+a.deck).localeCompare(b.class+b.deck));
  return out;
}
function classDeckTree() {
  // -> [{class, decks:[{deck, sub:[...]}]}] with unique deck names per class
  const list = [];
  for (const [cls, obj] of Object.entries(state.classes)) {
    const decks = Object.entries(obj.decks).map(([deck,dobj])=>{
      return { deck, sub: Object.keys(dobj.subdecks).sort() };
    }).sort((a,b)=>a.deck.localeCompare(b.deck));
    list.push({class:cls, decks});
  }
  list.sort((a,b)=>a.class.localeCompare(b.class));
  return list;
}
function pickCardsFromSelections(selections) {
  // selections = { class:{ deck:Set(subs or '*') } }
  const pool = [];
  for(const [cls, dmap] of Object.entries(selections)){
    for(const [deck, subs] of Object.entries(dmap)){
      const deckObj = state.classes?.[cls]?.decks?.[deck];
      if(!deckObj) continue;
      for(const c of deckObj.cards){
        if(subs === '*' || subs.has(c.sub || '')) pool.push(c);
      }
    }
  }
  return pool;
}
function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

/* ---------- Router ---------- */
function getParams(){
  return new URLSearchParams(location.search);
}
function setParams(patch){
  const sp = getParams();
  for(const [k,v] of Object.entries(patch)){
    if(v===null) sp.delete(k); else sp.set(k,v);
  }
  history.replaceState(null,'',`${location.pathname}?${sp.toString()}`);
}
function activateView(v){
  $$('.view').forEach(el=>el.classList.add('hidden'));
  $(`#view-${v}`)?.classList.remove('hidden');
  $$('.tab').forEach(b=>b.classList.toggle('active', b.dataset.route===v));
}

/* ---------- UI Populate helpers ---------- */
function fillDatalist(id, values){
  const dl = $(id);
  dl.innerHTML = values.map(v=>`<option value="${escapeHtml(v)}"></option>`).join('');
}
function fillSelect(sel, items, withBlank=true){
  const el = $(sel);
  const ops = [];
  if(withBlank) ops.push(`<option value="">—</option>`);
  for(const it of items){
    if(typeof it==='string') ops.push(`<option value="${escapeHtml(it)}">${escapeHtml(it)}</option>`);
    else ops.push(`<option value="${escapeHtml(it.value)}">${escapeHtml(it.label)}</option>`);
  }
  el.innerHTML = ops.join('');
}
function escapeHtml(s){ return (s??'').toString().replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])) }

/* ---------- Create view ---------- */
function renderCreate(){
  // datalists
  fillDatalist('#clsList', Object.keys(state.classes).sort());
  const deckNames = new Set();
  for(const c of Object.values(state.classes)) Object.keys(c.decks).forEach(n=>deckNames.add(n));
  fillDatalist('#deckList', [...deckNames].sort());

  // pick by deck (unique by class+deck label)
  fillSelect('#pickDeckByName', allDeckOptions().map(x=>({value:`${x.class}::${x.deck}`, label:x.label})), false);
}

$('#btnAddDeck').addEventListener('click', ()=>{
  const cls = $('#clsName').value.trim();
  const deck = $('#deckName').value.trim();
  const sub = $('#subdeckName').value.trim();
  if(!cls || !deck){ alert('Class and Deck are required.'); return; }
  const d = ensureClassDeck(cls, deck);
  if(sub) d.subdecks[sub]=true;
  save(); renderCreate(); renderBuildTrees();
});

$('#btnBulkAdd').addEventListener('click', ()=>{
  const sel = $('#pickDeckByName').value || '';
  if(!sel){ alert('Pick a deck (by name) above first.'); return; }
  const [cls, deck] = sel.split('::');
  const d = ensureClassDeck(cls, deck);

  const lines = $('#bulkText').value.split('\n').map(s=>s.trim()).filter(Boolean);
  let added=0, bad=0;
  for(const line of lines){
    const parts = line.split('|').map(x=>x.trim());
    if(parts.length<3){ bad++; continue; }
    const q = parts[0], a = parts[1];
    const wrongs = parts.slice(2,5).filter(Boolean);
    const maybeSub = parts.slice(5).join('|').trim();
    const sub = maybeSub.startsWith('#') ? maybeSub.slice(1).trim() : (maybeSub||'');
    if(!wrongs.length){ bad++; continue; }
    if(sub) d.subdecks[sub]=true;
    d.cards.push({q,a,wrongs, class:cls, deck, sub});
    added++;
  }
  save(); renderBuildTrees();
  alert(`Bulk import: added ${added} card(s). ${bad? bad+' line(s) skipped.':''}`);
});

$('#btnSaveCard').addEventListener('click', ()=>{
  const sel = $('#pickDeckByName').value || '';
  if(!sel){ alert('Pick a deck (by name) above first.'); return; }
  const [cls, deck] = sel.split('::');
  const d = ensureClassDeck(cls, deck);
  const q=$('#q').value.trim(),
        a=$('#a').value.trim(),
        w1=$('#w1').value.trim(),
        w2=$('#w2').value.trim(),
        w3=$('#w3').value.trim(),
        sub=$('#sd').value.trim();
  if(!q || !a || !w1){ alert('Question, Correct, and Wrong1 are required.'); return; }
  const wrongs=[w1,w2,w3].filter(Boolean);
  if(sub) d.subdecks[sub]=true;
  d.cards.push({q,a,wrongs,class:cls,deck,sub});
  save();
  ['#q','#a','#w1','#w2','#w3','#sd'].forEach(id=>$(id).value='');
  alert('Card saved to deck.');
});

/* ---------- Build view ---------- */
function selectionsFromTree(root){
  // read checkboxes -> normalized selections
  const sel = {};
  $$('.tree input[type=checkbox][data-level="class"]', root).forEach(clsBox=>{
    if(!clsBox.checked) return;
    const cls = clsBox.value;
    // whole class?
    if(clsBox.dataset.all==='1'){
      // include all decks fully
      const dmap = {};
      for(const d of Object.keys(state.classes[cls]?.decks||{})) dmap[d] = '*';
      sel[cls] = dmap;
      return;
    }
  });

  // deck-level
  $$('.tree input[type=checkbox][data-level="deck"]', root).forEach(dBox=>{
    if(!dBox.checked) return;
    const cls = dBox.dataset.class, deck = dBox.value;
    if(!sel[cls]) sel[cls]={};
    if(dBox.dataset.all==='1'){ sel[cls][deck]='*'; }
  });

  // subdeck-level (if any are checked)
  $$('.tree input[type=checkbox][data-level="sub"]', root).forEach(sBox=>{
    if(!sBox.checked) return;
    const cls=sBox.dataset.class, deck=sBox.dataset.deck, sub=sBox.value;
    if(!sel[cls]) sel[cls]={};
    if(!sel[cls][deck] || sel[cls][deck]==='*') sel[cls][deck]=new Set();
    sel[cls][deck] instanceof Set ? sel[cls][deck].add(sub) : sel[cls][deck]=new Set([sub]);
  });

  // convert sets to serializable
  for(const [cls,dmap] of Object.entries(sel)){
    for(const [deck,v] of Object.entries(dmap)){
      if(v instanceof Set) dmap[deck] = Array.from(v);
    }
  }
  return sel;
}
function deserializeSelections(obj){
  // convert array to Set where needed
  const out={};
  for(const [cls,dmap] of Object.entries(obj||{})){
    out[cls]={};
    for(const [deck,v] of Object.entries(dmap)){
      out[cls][deck] = (v==='*') ? '*' : new Set(v);
    }
  }
  return out;
}

function buildTree(containerId, allowClassAll=true){
  const box = $(containerId);
  const tree = classDeckTree();
  box.innerHTML = '';
  const wrap = document.createElement('div'); wrap.className='tree';
  tree.forEach(node=>{
    const clsId = uid();
    const clsLi = document.createElement('div');
    clsLi.innerHTML = `
      <label><input type="checkbox" data-level="class" data-all="${allowClassAll?1:0}" value="${escapeHtml(node.class)}">
      <strong>${escapeHtml(node.class)}</strong></label>
      <ul></ul>`;
    const ul = $('ul', clsLi);
    // merge by deck name (already unique in model)
    node.decks.forEach(d=>{
      const deckLi = document.createElement('li');
      const subList = d.sub.length ? `<ul>${d.sub.map(s=>`
          <li><label><input type="checkbox" data-level="sub" data-class="${escapeHtml(node.class)}" data-deck="${escapeHtml(d.deck)}" value="${escapeHtml(s)}"><span class="badge-pill">${escapeHtml(s)}</span></label></li>`).join('')}</ul>` : '';
      deckLi.innerHTML = `
        <label><input type="checkbox" data-level="deck" data-class="${escapeHtml(node.class)}" data-all="1" value="${escapeHtml(d.deck)}">
          <span class="badge-pill">📚 ${escapeHtml(d.deck)}</span>
        </label>
        ${subList}`;
      ul.appendChild(deckLi);
    });
    wrap.appendChild(clsLi);
  });
  box.appendChild(wrap);
  return wrap;
}

let chooseTreeEl, practiceTreeEl;

function renderBuildTrees(){
  // for Create
  renderCreate();
  // for Build
  chooseTreeEl = buildTree('#chooseTree');
  // for Practice (student/admin preview)
  practiceTreeEl = buildTree('#practiceTree', false);
}

$('#btnSaveTest').addEventListener('click', ()=>{
  const name = $('#testName').value.trim();
  if(!name){ alert('Enter a test name.'); return; }
  const title = $('#testTitle').value.trim() || name;
  const count = parseInt($('#testCount').value,10) || 30;
  const selections = selectionsFromTree(chooseTreeEl);
  if(Object.keys(selections).length===0){ alert('Pick at least one class/deck/sub‑deck.'); return; }
  state.tests[name] = {title, count, selections};
  save(); renderBuild(); alert('Test saved.');
});

$('#btnDeleteTest').addEventListener('click', ()=>{
  const t = $('#testName').value.trim();
  if(!t || !state.tests[t]){ alert('Pick a test to delete.'); return; }
  if(confirm(`Delete test "${t}"?`)){ delete state.tests[t]; save(); renderBuild(); }
});

$('#btnCopyStudent').addEventListener('click', ()=>{
  const t = $('#testName').value.trim();
  if(!t || !state.tests[t]){ alert('Save/select a test first.'); return; }
  const url = `${location.origin}${location.pathname}?view=quiz&mode=student&test=${encodeURIComponent(t)}`;
  navigator.clipboard.writeText(url).then(()=> alert('Student link copied to clipboard.'));
});
$('#btnOpenStudent').addEventListener('click', ()=>{
  const t = $('#testName').value.trim();
  if(!t || !state.tests[t]){ alert('Save/select a test first.'); return; }
  const url = `${location.origin}${location.pathname}?view=quiz&mode=student&test=${encodeURIComponent(t)}`;
  window.open(url, '_blank');
});

function renderBuild(){
  // lists
  fillDatalist('#testList', Object.keys(state.tests).sort());
  renderBuildTrees();

  // if testName matches existing, load its selections
  const tname = $('#testName').value.trim();
  if(state.tests[tname]){
    $('#testTitle').value = state.tests[tname].title || tname;
    $('#testCount').value = state.tests[tname].count || 30;
    // check boxes based on selections
    const sel = deserializeSelections(state.tests[tname].selections);
    // clear
    $$('input[type=checkbox]', chooseTreeEl).forEach(b=>b.checked=false);
    for(const [cls,dmap] of Object.entries(sel)){
      if(dmap && Object.keys(dmap).length === Object.keys(state.classes[cls]?.decks||{}).length){
        // may set class checkbox (visual)
        const cbox = $(`input[data-level="class"][value="${CSS.escape(cls)}"]`, chooseTreeEl);
        if(cbox) cbox.checked = false; // leave to per-deck to be explicit
      }
      for(const [deck,v] of Object.entries(dmap)){
        const dbox = $(`input[data-level="deck"][data-class="${CSS.escape(cls)}"][value="${CSS.escape(deck)}"]`, chooseTreeEl);
        if(dbox){ dbox.checked = (v==='*'); }
        if(v!=='*' && v instanceof Set === false){
          // array of subs
          for(const s of v){
            const sbox = $(`input[data-level="sub"][data-class="${CSS.escape(cls)}"][data-deck="${CSS.escape(deck)}"][value="${CSS.escape(s)}"]`, chooseTreeEl);
            if(sbox) sbox.checked = true;
          }
        }
      }
    }
  }
}

/* ---------- Practice view ---------- */
function renderPractice(){
  const tests = Object.keys(state.tests);
  fillSelect('#practiceTest', tests);
  renderBuildTrees(); // ensure tree is fresh
  $('#practiceStage').classList.add('hidden');
}

$('#btnStartPractice').addEventListener('click', ()=>{
  const t = $('#practiceTest').value;
  if(!t){ alert('Select a test first.'); return; }
  const baseSel = deserializeSelections(state.tests[t].selections);
  // override with user's hand‑picked items in practiceTree (optional)
  const pick = selectionsFromTree(practiceTreeEl);
  // merge: if pick empty, use baseSel; else intersect
  const sel = Object.keys(pick).length? intersectSelections(baseSel, deserializeSelections(pick)) : baseSel;
  const pool = pickCardsFromSelections(sel);
  if(pool.length===0){ alert('No cards matched your selection.'); return; }
  const stage = $('#practiceStage');
  stage.classList.remove('hidden');
  runFlashcards(stage, shuffle([...pool]));
});

function intersectSelections(a,b){
  // returns selections that exist in both
  const out={};
  for(const [cls,dmap] of Object.entries(a)){
    for(const [deck,va] of Object.entries(dmap)){
      const vb = b?.[cls]?.[deck];
      if(!vb) continue;
      if(va==='*' && vb==='*'){ if(!out[cls]) out[cls]={}; out[cls][deck]='*'; continue; }
      const setA = (va==='*') ? new Set(Object.keys(state.classes[cls]?.decks?.[deck]?.subdecks||{})) : new Set(va);
      const setB = (vb==='*') ? new Set(Object.keys(state.classes[cls]?.decks?.[deck]?.subdecks||{})) : new Set(vb);
      const inter = new Set([...setA].filter(s=>setB.has(s)));
      if(inter.size){ if(!out[cls]) out[cls]={}; out[cls][deck]=inter; }
    }
  }
  return out;
}

function runFlashcards(container, cards){
  let i=0;
  function render(){
    if(i>=cards.length){
      container.innerHTML = `<div class="qcard"><strong>All done.</strong></div>`;
      return;
    }
    const c = cards[i];
    container.innerHTML = `
      <div class="qcard">
        <div class="qtext">Q${i+1}/${cards.length}: ${escapeHtml(c.q)}</div>
        <button class="primary" id="flip">Show answer</button>
        <div id="ans" class="hidden" style="margin-top:10px">
          <div class="opt correct">Answer: ${escapeHtml(c.a)}</div>
          <div class="muted small">Sub‑deck: ${escapeHtml(c.sub||'—')}</div>
          <div class="row"><button id="prev">Prev</button><button id="next" class="primary">Next</button></div>
        </div>
      </div>`;
    $('#flip',container).onclick=()=>$('#ans',container).classList.remove('hidden');
    $('#prev',container).onclick=()=>{ i=Math.max(0,i-1); render(); };
    $('#next',container).onclick=()=>{ i++; render(); };
  }
  render();
}

/* ---------- Quiz view ---------- */
function renderQuiz(){
  const tests = Object.keys(state.tests);
  fillSelect('#quizTest', tests);
  $('#studentDate').value = todayISO();
  $('#quizStage').classList.add('hidden');
}

$('#btnStartQuiz').addEventListener('click', ()=>{
  const t = $('#quizTest').value;
  const nm = $('#studentName').value.trim();
  const loc = $('#studentLoc').value.trim();
  const dt = $('#studentDate').value;
  if(!t){ alert('Select a test first.'); return; }
  if(!nm || !loc){ alert('Name and Location are required.'); return; }

  const test = state.tests[t];
  const pool = pickCardsFromSelections( deserializeSelections(test.selections) );
  if(!pool.length){ alert('No cards in this test.'); return; }
  const questions = shuffle(pool).slice(0, Math.min(test.count || 30, pool.length));
  const stage = $('#quizStage'); stage.classList.remove('hidden');

  const answers = [];
  let idx=0;

  function renderQ(){
    if(idx>=questions.length){ return renderFinish(); }
    const q = questions[idx];
    // build options
    const opts = shuffle([q.a, ...q.wrongs]).slice(0, Math.max(2, Math.min(4, 1+q.wrongs.length)));
    stage.innerHTML = '';
    const card = $('#tpl-question').content.firstElementChild.cloneNode(true);
    $('.qtext',card).textContent = `Q${idx+1}/${questions.length}: ${q.q}`;
    const box = $('.opts',card);
    opts.forEach(op=>{
      const b = document.createElement('button');
      b.className='opt';
      b.textContent = op;
      b.onclick = ()=>{
        const correct = (op===q.a);
        answers.push({q:q.q, answer:q.a, choice:op, correct});
        idx++; renderQ();
      };
      box.appendChild(b);
    });
    stage.appendChild(card);
  }

  function renderFinish(){
    const score = answers.filter(x=>x.correct).length;
    const total = answers.length;
    const rec = { id:uid(), test:t, title:test.title||t, name:nm, location:loc, dateISO:dt, score, total,
                  items:answers, mode: (getParams().get('mode')==='student')?'student':'admin' };
    state.results.push(rec); save();

    stage.innerHTML = `
      <div class="qcard">
        <h3>Finished!</h3>
        <p>Thanks, <strong>${escapeHtml(nm)}</strong>! You scored <strong>${Math.round(score/total*100)}%</strong> (${score}/${total}).</p>
        <div class="row">
          <button id="btnRestart" class="primary">Restart with fresh questions</button>
          <button id="btnToPractice">Go to Practice</button>
          <button id="btnShowKey" class="success">Your Answers & Key</button>
        </div>
      </div>
      <div id="ansKey" class="qcard hidden"></div>
    `;
    $('#btnRestart').onclick = ()=>{ idx=0; answers.length=0; shuffle(questions); renderQ(); };
    $('#btnToPractice').onclick = ()=> routeTo('practice');
    $('#btnShowKey').onclick = ()=>{
      const panel = $('#ansKey');
      panel.classList.remove('hidden');
      panel.innerHTML = answers.map((a,i)=>`
        <div class="qcard">
          <div class="qtext">Q${i+1}: ${escapeHtml(a.q)}</div>
          <div class="opt ${a.correct?'correct':'incorrect'}">Your choice: ${escapeHtml(a.choice)}</div>
          <div class="opt correct">Correct: ${escapeHtml(a.answer)}</div>
        </div>`).join('');
    };
  }

  renderQ();
});

/* ---------- Reports (admin) & My Results ---------- */
function renderReports(){
  const tests = Object.keys(state.tests);
  fillSelect('#repTest', tests);
  const locSet = new Set(state.results.map(r=>r.location).filter(Boolean));
  $('#repLocation').innerHTML = `<option value="">All</option>` + [...locSet].sort().map(l=>`<option>${escapeHtml(l)}</option>`).join('');
  renderRepTable();
  renderMissed();
}
function renderRepTable(){
  const t = $('#repTest').value, loc = $('#repLocation').value, sort = $('#repSort').value;
  let rows = state.results.slice();
  if(t) rows = rows.filter(r=>r.test===t);
  if(loc) rows = rows.filter(r=>r.location===loc);
  rows.sort((a,b)=>{
    if(sort==='dateDesc') return b.dateISO.localeCompare(a.dateISO);
    if(sort==='dateAsc') return a.dateISO.localeCompare(b.dateISO);
    if(sort==='scoreDesc') return (b.score/b.total) - (a.score/a.total);
    return (a.score/a.total) - (b.score/b.total);
  });
  const html = `
    <table class="table">
      <thead><tr><th>Date</th><th>Name</th><th>Location</th><th>Test</th><th>Score</th><th></th></tr></thead>
      <tbody>
      ${rows.map(r=>`
        <tr>
          <td>${escapeHtml(r.dateISO)}</td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.location)}</td>
          <td>${escapeHtml(r.title||r.test)}</td>
          <td>${r.score}/${r.total}</td>
          <td><button data-open="${r.id}">Open</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
  $('#repTable').innerHTML = html;
  $$('button[data-open]').forEach(b=> b.onclick = ()=>{
    const r = state.results.find(x=>x.id===b.dataset.open);
    openResultModal(r);
  });
}
function renderMissed(){
  const t = $('#repTest').value;
  const rows = state.results.filter(r=>!t || r.test===t);
  const map = new Map(); // q -> [wrongCount, total]
  for(const r of rows){
    for(const it of r.items){
      const m = map.get(it.q) || [0,0];
      m[1]++; if(!it.correct) m[0]++; map.set(it.q,m);
    }
  }
  const list = [...map.entries()]
    .map(([q,[w,tot]])=>({q,w,tot,p: tot? (w/tot):0}))
    .sort((a,b)=>b.p-a.p).slice(0,15);
  $('#repMissed').innerHTML = list.length? `
    <table class="table">
      <thead><tr><th>Question</th><th>Wrong</th><th>Total</th><th>% Missed</th></tr></thead>
      <tbody>${list.map(x=>`<tr><td>${escapeHtml(x.q)}</td><td>${x.w}</td><td>${x.tot}</td><td>${Math.round(x.p*100)}%</td></tr>`).join('')}</tbody>
    </table>` : `<div class="muted">No data yet.</div>`;
}

/* My results */
function renderMine(){
  const nm = (getParams().get('name')||'').trim();
  const mine = nm ? state.results.filter(r=>r.name.toLowerCase()===nm.toLowerCase()) : state.results.slice(-50);
  $('#mineTable').innerHTML = mine.length? `
    <table class="table">
      <thead><tr><th>Date</th><th>Name</th><th>Test</th><th>Score</th><th></th></tr></thead>
      <tbody>${mine.map(r=>`
        <tr>
          <td>${escapeHtml(r.dateISO)}</td>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.title||r.test)}</td>
          <td>${r.score}/${r.total}</td>
          <td><button data-open="${r.id}">Open</button></td>
        </tr>`).join('')}</tbody>
    </table>` : `<div class="muted">No results yet.</div>`;
  $$(`#view-mine button[data-open]`).forEach(b=> b.onclick = ()=>{
    const r = state.results.find(x=>x.id===b.dataset.open); openResultModal(r);
  });
}

function openResultModal(r){
  if(!r) return;
  const win = window.open('', '_blank','width=720,height=800');
  const rows = r.items.map((it,i)=>`
    <div class="qcard">
      <div class="qtext">Q${i+1}: ${escapeHtml(it.q)}</div>
      <div class="opt ${it.correct?'correct':'incorrect'}">Choice: ${escapeHtml(it.choice)}</div>
      <div class="opt correct">Correct: ${escapeHtml(it.answer)}</div>
    </div>`).join('');
  win.document.write(`
    <title>${escapeHtml(r.title||r.test)} — ${escapeHtml(r.name)}</title>
    <link rel="stylesheet" href="${location.origin+location.pathname.replace(/[^/]+$/,'')}styles.css">
    <div class="view">
      <h2>${escapeHtml(r.title||r.test)}</h2>
      <div class="card">
        <div class="kv">
          <div class="muted">Name</div><div>${escapeHtml(r.name)}</div>
          <div class="muted">Location</div><div>${escapeHtml(r.location)}</div>
          <div class="muted">Date</div><div>${escapeHtml(r.dateISO)}</div>
          <div class="muted">Score</div><div><strong>${r.score}/${r.total}</strong></div>
        </div>
      </div>
      <section class="card">${rows}</section>
    </div>`);
  win.document.close();
}

/* ---------- Export CSV ---------- */
$('#btnExportCSV').addEventListener('click', ()=>{
  const fields = ['dateISO','name','location','test','title','score','total'];
  const lines = [fields.join(',')];
  for(const r of state.results){
    const row = fields.map(f => `"${String(r[f]??'').replace(/"/g,'""')}"`).join(',');
    lines.push(row);
  }
  const blob = new Blob([lines.join('\n')],{type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download='results.csv'; a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------- Router wiring & restrictions ---------- */
function routeTo(view){
  setParams({view});
  activateView(view); // also refresh content each time
  if(view==='create') renderCreate();
  if(view==='build') renderBuild();
  if(view==='practice') renderPractice();
  if(view==='quiz') renderQuiz();
  if(view==='reports') renderReports();
  if(view==='mine') renderMine();
}

// Tabs act as router
$$('.tab').forEach(btn=> btn.addEventListener('click', ()=> routeTo(btn.dataset.route)));

function boot(){
  renderBuildTrees();

  // Student restriction mode
  const sp = getParams();
  const mode = sp.get('mode') || '';
  const testParam = sp.get('test') || '';

  if(mode==='student'){
    // hide admin tabs, lock to student
    $('#modeBadge').textContent = 'Student link';
    // only show Practice/Quiz/My Results
    $$('.tab').forEach(b=>{
      const ok = ['practice','quiz','mine'].includes(b.dataset.route);
      b.style.display = ok? '' : 'none';
    });
    // preselect test in dropdowns
    requestAnimationFrame(()=>{
      routeTo(sp.get('view') || 'quiz');
      if(testParam && state.tests[testParam]){
        fillSelect('#quizTest', [testParam], false);
        fillSelect('#practiceTest', [testParam], false);
      }
    });
  } else {
    $('#modeBadge').textContent = 'Admin';
    routeTo(sp.get('view') || 'create');
  }

  // default date
  const d = $('#studentDate'); if(d) d.value = todayISO();
}
boot();

/* End */ 
