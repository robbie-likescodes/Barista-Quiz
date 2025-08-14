/* Barista Flashcards & Quizzes — full SPA (Tests + Deck/Subcategory selection) */
/* All data is localStorage-based so it works on GitHub Pages with no backend. */

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ---------- Storage / State ---------- */
const store = {
  get(k, fb){ try{ return JSON.parse(localStorage.getItem(k)) ?? fb; }catch{ return fb; } },
  set(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
};
const KEYS = {
  decks:'fc_decks',         // { [id]: {id,name,category,subcategory,cards:[{id,q,a,distractors,sub?}]} }
  tests:'fc_tests',         // { [id]: {id,name,title,n,selections:[{deckId,whole:boolean,subs:string[]}]} }
  results:'fc_results',
  myResults:'fc_my_results'
};
const uid = (p='id') => p + '_' + Math.random().toString(36).slice(2,10);
const todayISO = () => new Date().toISOString().slice(0,10);

let state = {
  decks: store.get(KEYS.decks, {}),
  tests: store.get(KEYS.tests, {}),
  results: store.get(KEYS.results, []),
  myResults: store.get(KEYS.myResults, []),

  practice: { cards:[], idx:0 },
  quiz: { items:[], idx:0, title:'', deckPool:[], locked:false, n:30 }
};

/* ---------- Router ---------- */
function getParams(){ return new URLSearchParams(location.search); }
function baseUrl(){ return location.href.split('?')[0]; }
function routeTo(view, extras={}){
  const p = getParams();
  p.set('view', view);
  for(const [k,v] of Object.entries(extras)){ if(v==null) p.delete(k); else p.set(k, v); }
  history.pushState(null, '', baseUrl() + '?' + p.toString());
  activateView(view);
}
function activateView(view){
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-'+view));
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.route===view));
  if(view==='create')   renderCreate();
  if(view==='build')    renderBuild();
  if(view==='practice') renderPracticeDeckChecks();
  if(view==='quiz')     startQuizFromParams();
  if(view==='reports')  renderReports();
  if(view==='myresults')renderMyResults();
}
window.addEventListener('popstate', ()=>{
  const v = getParams().get('view') || 'create';
  activateView(v);
});
$$('.tab').forEach(btn=> btn.addEventListener('click', ()=> routeTo(btn.dataset.route)));

/* ---------- Helpers ---------- */
const esc = s => (s??'').toString().replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
const shuffle = a => { const x=a.slice(); for(let i=x.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]]; } return x; };
const sample  = (a,n)=> shuffle(a).slice(0,n);
const unique  = xs => Array.from(new Set(xs));

/* ======================================================================
   CREATE (decks & cards)
====================================================================== */
const deckSelect = $('#deckSelect');
const deckNames  = $('#deckNames');
const cardsList  = $('#cardsList');

function renderCreate(){
  renderDeckLists();
  renderCardsList();
}
function renderDeckLists(){
  const arr = Object.values(state.decks).sort((a,b)=> a.name.localeCompare(b.name));
  deckSelect.innerHTML = arr.length
    ? arr.map(d=>`<option value="${d.id}">${esc(d.name)} (${d.cards.length}) [${esc(d.category||'—')}${d.subcategory? ' / '+esc(d.subcategory):''}]</option>`).join('')
    : `<option value="">No decks yet</option>`;
  deckNames.innerHTML  = arr.map(d=>`<option value="${esc(d.name)}"></option>`).join('');
}
function getSelectedDeckId(){ const id = deckSelect.value; return state.decks[id] ? id : null; }

$('#toggleSubcatBtn').addEventListener('click', ()=> $('#newDeckSub').classList.toggle('hidden'));

$('#addDeckBtn').addEventListener('click', ()=>{
  const name = $('#newDeckName').value.trim();
  if(!name) return alert('Deck name required.');
  const existing = Object.values(state.decks).find(d=>d.name.toLowerCase()===name.toLowerCase());
  if(existing){ deckSelect.value = existing.id; renderCardsList(); alert('Selected existing deck.'); return; }
  const id = uid('deck');
  state.decks[id] = {
    id, name,
    category: $('#newDeckCat').value.trim(),
    subcategory: $('#newDeckSub').classList.contains('hidden') ? '' : $('#newDeckSub').value.trim(),
    cards: [], createdAt: Date.now()
  };
  $('#newDeckName').value = '';
  $('#newDeckCat').value = '';
  $('#newDeckSub').value = '';
  $('#newDeckSub').classList.add('hidden');
  store.set(KEYS.decks, state.decks);
  renderDeckLists(); deckSelect.value = id; renderCardsList();
});

$('#renameDeckBtn').addEventListener('click', ()=>{
  const id = getSelectedDeckId(); if(!id) return;
  const nm = prompt('New deck name:', state.decks[id].name);
  if(nm && nm.trim()){ state.decks[id].name = nm.trim(); store.set(KEYS.decks, state.decks); renderDeckLists(); }
});
$('#editDeckMetaBtn').addEventListener('click', ()=>{
  const id = getSelectedDeckId(); if(!id) return;
  const d = state.decks[id];
  const cat = prompt('Category:', d.category||''); if(cat===null) return;
  const sub = prompt('Deck subcategory (blank for none):', d.subcategory||''); if(sub===null) return;
  d.category = cat.trim(); d.subcategory = sub.trim();
  store.set(KEYS.decks, state.decks); renderDeckLists();
});
$('#deleteDeckBtn').addEventListener('click', ()=>{
  const id = getSelectedDeckId(); if(!id) return;
  if(confirm('Delete this deck and its cards?')){ delete state.decks[id]; store.set(KEYS.decks, state.decks); renderDeckLists(); renderCardsList(); }
});
$('#exportDeckBtn').addEventListener('click', ()=>{
  const id = getSelectedDeckId(); if(!id) return;
  const blob = new Blob([JSON.stringify(state.decks[id], null, 2)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${state.decks[id].name.replace(/\W+/g,'_')}.json`; a.click(); URL.revokeObjectURL(a.href);
});

/* Import (with notice) */
$('#importDeckBtn').addEventListener('click', ()=>{
  alert(`Import formats:
1) App deck JSON: {"name","category?","subcategory?","cards":[{"q","a","distractors":[],"sub?":""}]}
2) MCQ JSON array: [{"Question","Correct Answer","Wrong Answer 1","Wrong Answer 2","Wrong Answer 3","Subcategory?"}, ...]
3) TXT: Question | Correct | Wrong1 | Wrong2 | Wrong3 | #Subcat(optional)`);
  $('#importDeckInput').click();
});
$('#importDeckInput').addEventListener('change', async (e)=>{
  const file = e.target.files?.[0]; if(!file) return;
  const text = await file.text();
  try{
    let data=null; try{ data = JSON.parse(text); }catch{}
    const createDeck = (name, cards, category='', subcategory='')=>{
      const id = uid('deck');
      state.decks[id] = {
        id, name: name || file.name.replace(/\.[^.]+$/,'').replace(/_/g,' '),
        category, subcategory,
        cards: cards.map(c=>({
          id: uid('card'),
          q:(c.q || c.Question || '').trim(),
          a:(c.a || c['Correct Answer'] || '').trim(),
          distractors:(c.distractors || [c['Wrong Answer 1'],c['Wrong Answer 2'],c['Wrong Answer 3']]).filter(Boolean).map(s=>String(s).trim()),
          sub:(c.sub || c.Subcategory || '').trim(),
          createdAt: Date.now()
        })),
        createdAt: Date.now()
      };
      store.set(KEYS.decks, state.decks);
      renderDeckLists(); alert('Deck imported.');
    };
    if(data && data.name && Array.isArray(data.cards)){
      createDeck(data.name, data.cards, data.category||'', data.subcategory||'');
    }else if(Array.isArray(data) && data[0] && (data[0].Question || data[0]['Correct Answer'])){
      createDeck(file.name.replace(/\.json$/i,'').replace(/_/g,' '), data);
    }else{
      const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
      const cards = lines.map(line=>{
        const parts = line.split('|').map(s=>s.trim());
        if(parts.length<3) throw new Error('Each line needs at least: Question | Correct | Wrong1');
        const tag = parts[parts.length-1]?.startsWith('#') ? parts.pop().slice(1) : '';
        const [q,a,...wrongs] = parts;
        return { q, a, distractors: wrongs, sub: tag };
      });
      createDeck(file.name.replace(/\.[^.]+$/,'').replace(/_/g,' '), cards);
    }
  }catch(err){ alert('Import failed: ' + err.message); }
  e.target.value='';
});

/* Bulk add */
$('#bulkSummaryBtn').addEventListener('click', ()=>{
  setTimeout(()=>alert('Bulk Add format:\nQuestion | Correct answer | Wrong 1 | Wrong 2 | Wrong 3 | #Subcat(optional)\n(At least one wrong answer is required.)'), 40);
});
$('#bulkAddBtn').addEventListener('click', ()=>{
  const id = getSelectedDeckId(); if(!id) return alert('Select a deck first.');
  const text = $('#bulkTextarea').value.trim(); if(!text) return alert('Paste at least one line.');
  const lines = text.split(/\r?\n/);
  let added=0;
  for(const line of lines){
    const parts = line.split('|').map(s=>s.trim()).filter(Boolean);
    if(parts.length>=3){
      let sub = '';
      if(parts[parts.length-1].startsWith?.('#')) sub = parts.pop().slice(1);
      const [q,a,...wrongs] = parts;
      state.decks[id].cards.push({ id:uid('card'), q, a, distractors:wrongs, sub, createdAt:Date.now() });
      added++;
    }
  }
  store.set(KEYS.decks, state.decks);
  $('#bulkTextarea').value='';
  renderDeckLists(); renderCardsList();
  alert(`Added ${added} card(s).`);
});

/* Add card */
$('#addCardBtn').addEventListener('click', ()=>{
  const id = getSelectedDeckId(); if(!id) return alert('Select a deck first.');
  const q = $('#qInput').value.trim();
  const a = $('#aCorrectInput').value.trim();
  const w1 = $('#aWrong1Input').value.trim();
  const w2 = $('#aWrong2Input').value.trim();
  const w3 = $('#aWrong3Input').value.trim();
  const sub = $('#cardSubInput').value.trim();
  if(!q || !a || !w1) return alert('Enter question, correct, and at least one wrong answer.');
  state.decks[id].cards.push({ id:uid('card'), q, a, distractors:[w1,w2,w3].filter(Boolean), sub, createdAt:Date.now() });
  store.set(KEYS.decks, state.decks);
  $('#qInput').value = $('#aCorrectInput').value = $('#aWrong1Input').value = $('#aWrong2Input').value = $('#aWrong3Input').value = $('#cardSubInput').value = '';
  renderCardsList();
});
deckSelect.addEventListener('change', renderCardsList);

function renderCardsList(){
  const id = getSelectedDeckId();
  if(!id){ cardsList.innerHTML = `<div class="hint">Create a deck, then add cards.</div>`; return; }
  const d = state.decks[id];
  if(!d.cards.length){ cardsList.innerHTML = `<div class="hint">No cards yet—add your first one above.</div>`; return; }
  cardsList.innerHTML = d.cards.map(c=>`
    <div class="cardline" data-id="${c.id}">
      <div class="q"><strong>Q:</strong> ${esc(c.q)}</div>
      <div class="a"><strong>Correct:</strong> ${esc(c.a)}<br><span class="hint">Wrong:</span> ${esc((c.distractors||[]).join(' | '))}${c.sub? `<br><span class="hint">Sub: ${esc(c.sub)}</span>`:''}</div>
      <div class="actions">
        <button class="btn ghost btn-edit">Edit</button>
        <button class="btn danger btn-del">Delete</button>
      </div>
    </div>
  `).join('');

  cardsList.querySelectorAll('.btn-del').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const cid = btn.closest('.cardline').dataset.id;
      state.decks[id].cards = state.decks[id].cards.filter(c=>c.id!==cid);
      store.set(KEYS.decks, state.decks); renderCardsList(); renderDeckLists();
    });
  });
  cardsList.querySelectorAll('.btn-edit').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const cid = btn.closest('.cardline').dataset.id;
      const card = state.decks[id].cards.find(c=>c.id===cid);
      if(!card) return;
      const q = prompt('Question:', card.q); if(q===null) return;
      const a = prompt('Correct answer:', card.a); if(a===null) return;
      const wrong = prompt('Wrong answers (separate by |):', (card.distractors||[]).join('|'));
      const sub = prompt('Card subcategory (optional):', card.sub||''); if(sub===null) return;
      card.q=q.trim(); card.a=a.trim();
      card.distractors=(wrong||'').split('|').map(s=>s.trim()).filter(Boolean);
      card.sub=sub.trim();
      store.set(KEYS.decks, state.decks); renderCardsList();
    });
  });
}

/* ======================================================================
   BUILD TEST (select decks / subs, preview, share)
====================================================================== */
const testsList     = $('#testsList');
const testNameInput = $('#testNameInput');
const deckPickList  = $('#deckPickList');
const previewToggle = $('#previewToggle');
const previewPanel  = $('#previewPanel');
const previewTitle  = $('#previewTitle');
const previewMeta   = $('#previewMeta');

function renderBuild(){
  renderTestsDatalist();
  renderDeckPickList();
  syncPreviewPanel();
}
function renderTestsDatalist(){
  const arr = Object.values(state.tests).sort((a,b)=>a.name.localeCompare(b.name));
  testsList.innerHTML = arr.map(t=>`<option value="${esc(t.name)}"></option>`).join('');
}
$('#saveTestBtn').addEventListener('click', ()=>{
  const name = testNameInput.value.trim();
  if(!name) return alert('Enter or select a test name.');
  let t = Object.values(state.tests).find(x=>x.name.toLowerCase()===name.toLowerCase());
  if(!t){ const id = uid('test'); t = state.tests[id] = { id, name, title:name, n:30, selections:[] }; }
  t.title = $('#builderTitle').value.trim() || t.title || name;
  t.n = Math.max(1, +$('#builderCount').value||t.n||30);
  t.selections = readSelectionsFromUI();
  store.set(KEYS.tests, state.tests);
  alert(`Test “${name}” saved.`);
  renderTestsDatalist();
});
$('#deleteTestBtn').addEventListener('click', ()=>{
  const name = testNameInput.value.trim(); if(!name) return;
  const entry = Object.entries(state.tests).find(([,t])=>t.name.toLowerCase()===name.toLowerCase());
  if(!entry) return alert('Test not found.');
  if(confirm(`Delete test “${name}”?`)){
    delete state.tests[entry[0]];
    store.set(KEYS.tests, state.tests);
    testNameInput.value=''; renderTestsDatalist(); renderDeckPickList();
  }
});

function renderDeckPickList(){
  const decks = Object.values(state.decks).sort((a,b)=> a.name.localeCompare(b.name));
  const selectedTest = Object.values(state.tests).find(t=>t.name.toLowerCase()===testNameInput.value.trim().toLowerCase());
  const selMap = new Map((selectedTest?.selections||[]).map(s=>[s.deckId, s]));

  deckPickList.innerHTML = decks.map(d=>{
    const subs = unique(d.cards.map(c=>c.sub||'').filter(Boolean)).sort();
    const saved = selMap.get(d.id);
    const whole = saved ? !!saved.whole : true;
    const savedSubs = new Set(saved?.subs || []);
    return `
      <div class="deck-row" data-deck="${d.id}">
        <div class="top">
          <label class="wrap">
            <input type="checkbox" class="ck-whole" ${whole?'checked':''}>
            <strong>${esc(d.name)}</strong>
            <span class="hint">[${esc(d.category||'—')}${d.subcategory?' / '+esc(d.subcategory):''}]</span>
          </label>
          ${subs.length ? `<button class="btn ghost btn-expand" type="button">Subcategories</button>` : `<span class="hint">No subcategories</span>`}
        </div>
        <div class="subs hidden">
          ${subs.map(s=>`
            <label class="subchip">
              <input type="checkbox" class="ck-sub" value="${esc(s)}" ${savedSubs.has(s)?'checked':''}>
              <span>${esc(s)}</span>
            </label>`).join('')}
        </div>
      </div>
    `;
  }).join('') || `<div class="hint">No decks created yet. Add decks in “Create”.</div>`;

  deckPickList.querySelectorAll('.btn-expand').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const row = btn.closest('.deck-row'); row.querySelector('.subs').classList.toggle('hidden');
    });
  });
  deckPickList.querySelectorAll('.ck-sub').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      const row = cb.closest('.deck-row');
      const any = row.querySelectorAll('.ck-sub:checked').length>0;
      row.querySelector('.ck-whole').checked = !any;
    });
  });
  deckPickList.querySelectorAll('.ck-whole').forEach(cb=>{
    cb.addEventListener('change', ()=>{
      if(cb.checked){
        cb.closest('.deck-row').querySelectorAll('.ck-sub').forEach(s=> s.checked=false);
      }
    });
  });

  if(selectedTest){
    $('#builderTitle').value = selectedTest.title || selectedTest.name;
    $('#builderCount').value = selectedTest.n || 30;
  }
}
function readSelectionsFromUI(){
  const rows = [...deckPickList.querySelectorAll('.deck-row')];
  return rows.map(row=>{
    const deckId = row.dataset.deck;
    const subs = [...row.querySelectorAll('.ck-sub:checked')].map(i=>i.value);
    const whole = subs.length===0 && row.querySelector('.ck-whole').checked;
    return { deckId, whole, subs };
  }).filter(s => s.whole || s.subs.length>0);
}

previewToggle.addEventListener('change', syncPreviewPanel);
function syncPreviewPanel(){
  const on = previewToggle.checked;
  $('#deckChooser').open = !on;
  previewPanel.classList.toggle('hidden', !on);
  if(!on) return;

  const nm = testNameInput.value.trim() || 'Untitled Test';
  let t = Object.values(state.tests).find(x=>x.name.toLowerCase()===nm.toLowerCase());
  if(!t){ const id = uid('test'); t = state.tests[id] = { id, name:nm, title:nm, n:30, selections:[] }; }
  t.title = $('#builderTitle').value.trim() || t.title || nm;
  t.n = Math.max(1, +$('#builderCount').value||t.n||30);
  t.selections = readSelectionsFromUI();
  state.tests[t.id] = t;
  store.set(KEYS.tests, state.tests);

  previewTitle.textContent = `${t.title} (Preview)`;
  const decksCount = t.selections.length;
  const poolSize = calcPoolForTest(t).length;
  previewMeta.textContent = `${t.n} questions • ${decksCount} deck(s) • pool ${poolSize}`;
}
$('#previewPracticeBtn').addEventListener('click', ()=>{
  const t = getCurrentTest(); if(!t || !t.selections.length) return alert('Save a test and select at least one deck.');
  routeTo('practice', { test:t.id });
});
$('#previewQuizBtn').addEventListener('click', ()=>{
  const t = getCurrentTest(); if(!t || !t.selections.length) return alert('Save a test and select at least one deck.');
  routeTo('quiz', { test:t.id });
});
$('#copyShareBtn').addEventListener('click', ()=>{
  const t = getCurrentTest(); if(!t || !t.selections.length) return alert('Save a test and select at least one deck.');
  const url = baseUrl() + `?view=practice&test=${t.id}`;
  navigator.clipboard.writeText(url).then(()=> alert('Share link copied! Send this URL by text/email.'));
});
$('#openShareBtn').addEventListener('click', ()=>{
  const t = getCurrentTest(); if(!t || !t.selections.length) return alert('Save a test and select at least one deck.');
  routeTo('practice', { test:t.id });
});
function getCurrentTest(){
  const nm = testNameInput.value.trim();
  return Object.values(state.tests).find(x=>x.name.toLowerCase()===nm.toLowerCase());
}

/* ======================================================================
   PRACTICE (barista)
====================================================================== */
const practiceDeckChecks = $('#practiceDeckChecks');
const practiceArea = $('#practiceArea');
const practiceQuestion = $('#practiceQuestion');
const practiceAnswer = $('#practiceAnswer');
const practiceProgress = $('#practiceProgress');
const practiceCard = $('#practiceCard');
const practiceLabel = $('#practiceLabel');

function loadTestFromURL(){
  const tid = getParams().get('test');
  const t = state.tests[tid];
  if(!t){ alert('Invalid or missing test link.'); return null; }
  return t;
}
function calcPoolForTest(t){
  const pool = [];
  t.selections.forEach(sel=>{
    const d = state.decks[sel.deckId]; if(!d) return;
    if(sel.whole || sel.subs.length===0){
      pool.push(...d.cards);
    }else{
      pool.push(...d.cards.filter(c => sel.subs.includes(c.sub||'')));
    }
  });
  return pool;
}
function renderPracticeDeckChecks(){
  const t = loadTestFromURL(); if(!t){ practiceDeckChecks.innerHTML = `<span class="hint">Ask your admin for a valid test link.</span>`; return; }
  const chips = t.selections.map(sel=>{
    const d = state.decks[sel.deckId];
    const label = d ? d.name : '(missing deck)';
    return `<label class="chip"><input type="checkbox" value="${sel.deckId}" checked> ${esc(label)}</label>`;
  }).join('');
  practiceDeckChecks.innerHTML = chips || `<span class="hint">No decks in this test.</span>`;
}
$('#startPracticeBtn').addEventListener('click', ()=>{
  const t = loadTestFromURL(); if(!t) return;
  const pickIds = [...practiceDeckChecks.querySelectorAll('input:checked')].map(i=>i.value);
  const subsetTest = { ...t, selections: t.selections.filter(s=> pickIds.includes(s.deckId)) };
  const cards = calcPoolForTest(subsetTest);
  if(!cards.length) return alert('No cards in the selected decks.');
  state.practice.cards = cards.map(c=>({ q:c.q, a:c.a }));
  state.practice.idx = 0;
  practiceArea.hidden = false;
  practiceLabel.textContent = `Studying ${cards.length} cards`;
  renderPracticeCard();
});
function renderPracticeCard(){
  const { cards, idx } = state.practice;
  const c = cards[idx];
  practiceQuestion.textContent = c.q;
  practiceAnswer.textContent = c.a;
  practiceProgress.textContent = `${idx+1} / ${cards.length}`;
  practiceCard.classList.remove('flipped');
}
practiceCard.addEventListener('click', ()=> practiceCard.classList.toggle('flipped'));
practiceCard.addEventListener('keypress', e=>{ if(e.key===' '||e.key==='Enter') practiceCard.click(); });
$('#practicePrev').addEventListener('click', ()=>{ state.practice.idx = (state.practice.idx-1+state.practice.cards.length)%state.practice.cards.length; renderPracticeCard(); });
$('#practiceNext').addEventListener('click', ()=>{ state.practice.idx = (state.practice.idx+1)%state.practice.cards.length; renderPracticeCard(); });
$('#practiceShuffle').addEventListener('click', ()=>{ state.practice.cards = shuffle(state.practice.cards); state.practice.idx = 0; renderPracticeCard(); });

/* ======================================================================
   QUIZ (barista)
====================================================================== */
const quizArea = $('#quizArea');
const quizHeading = $('#quizHeading');
const quizSubLabel = $('#quizSubLabel');
const quizQuestion = $('#quizQuestion');
const quizOptions = $('#quizOptions');
const quizProgress = $('#quizProgress');
const quizFinished = $('#quizFinished');
const finishedMsg = $('#finishedMsg');

$('#quizPrev').addEventListener('click', ()=>{ persistChoice(); state.quiz.idx = Math.max(0, state.quiz.idx-1); renderQuizItem(); });
$('#quizNext').addEventListener('click', ()=>{ persistChoice(); state.quiz.idx = Math.min(state.quiz.items.length-1, state.quiz.idx+1); renderQuizItem(); });
$('#submitQuizBtn').addEventListener('click', submitQuiz);
$('#restartQuizBtn').addEventListener('click', ()=> buildQuizItems(true));
$('#finishedPracticeBtn').addEventListener('click', ()=>{
  const t = loadTestFromURL(); if(!t) return;
  routeTo('practice', { test:t.id });
});

function makeMCQ(card){
  const opts = shuffle([card.a, ...(card.distractors||[])]).slice(0, Math.max(2, Math.min(4, 1+(card.distractors||[]).length)));
  if(!opts.includes(card.a)) opts[0]=card.a;
  return { qid:card.id, q:card.q, correct:card.a, options: shuffle(opts), chosen:null };
}
function startQuizFromParams(){
  quizFinished.classList.add('hidden');
  const t = loadTestFromURL(); if(!t){ quizArea.hidden = true; return; }
  quizHeading.textContent = t.title || t.name;
  $('#studentDate').value = todayISO();

  state.quiz.deckPool = calcPoolForTest(t);
  if(!state.quiz.deckPool.length){ quizArea.hidden = true; alert('This test has no cards.'); return; }
  state.quiz.title = t.title || t.name;
  state.quiz.n = t.n || 30;

  buildQuizItems(false);
}
function buildQuizItems(isRestart){
  const pool = state.quiz.deckPool.slice();
  const n = Math.max(1, +state.quiz.n||30);
  const items = sample(pool, Math.min(n, pool.length)).map(c=>makeMCQ(c));
  state.quiz.items = items;
  state.quiz.idx = 0;
  state.quiz.locked = false;

  quizArea.hidden = false;
  quizSubLabel.textContent = `${items.length} questions • pool size ${pool.length}`;
  renderQuizItem();
  if(isRestart) alert('Quiz restarted with a fresh shuffle.');
}
function renderQuizItem(){
  const { items, idx } = state.quiz;
  const it = items[idx];
  quizQuestion.textContent = it.q;
  quizProgress.textContent = `${idx+1} / ${items.length}`;
  quizOptions.innerHTML = it.options.map(opt=>`
    <label class="option ${state.quiz.locked?'disabled':''}">
      <input type="radio" name="opt" value="${esc(opt)}" ${it.chosen===opt?'checked':''} ${state.quiz.locked?'disabled':''}>
      <span>${esc(opt)}</span>
    </label>
  `).join('');
  if(state.quiz.locked) markPostSubmit();
  quizOptions.querySelectorAll('input[type=radio]').forEach(r=>{
    r.addEventListener('change', ()=> it.chosen = r.value);
  });
}
function persistChoice(){
  const checked = quizOptions.querySelector('input[type=radio]:checked');
  if(checked){ state.quiz.items[state.quiz.idx].chosen = checked.value; }
}
function submitQuiz(){
  const name = $('#studentName').value.trim();
  const date = $('#studentDate').value.trim();
  const loc  = $('#studentLocation').value.trim();
  if(!name || !date || !loc) return alert('Please enter Name, Date, and Location.');

  let correct = 0;
  const graded = state.quiz.items.map(it=>{
    const ok = (it.chosen === it.correct); if(ok) correct++;
    return { ...it, correctBool: ok };
  });
  const total = graded.length;
  const scorePct = Math.round((correct/total)*100);
  const attempt = {
    id: uid('attempt'),
    dateISO: new Date(date+'T00:00:00').toISOString(),
    studentName: name, location: loc,
    quizTitle: state.quiz.title,
    total, correct, scorePct,
    items: graded.map(g=>({ qid:g.qid, q:g.q, chosen:g.chosen, correctBool:g.correctBool }))
  };

  state.quiz.locked = true; renderQuizItem();
  finishedMsg.textContent = `${name} scored ${scorePct}% (${correct}/${total}) on “${state.quiz.title}”.`;
  quizFinished.classList.remove('hidden');

  state.results.unshift(attempt); store.set(KEYS.results, state.results);
  state.myResults.unshift(attempt); store.set(KEYS.myResults, state.myResults);
}
function markPostSubmit(){
  const { items, idx } = state.quiz; const it = items[idx];
  $$('#quizOptions .option').forEach(lbl=>{
    const val = lbl.querySelector('input')?.value;
    lbl.classList.remove('correct','incorrect');
    if(val === it.chosen){
      if(it.chosen === it.correct) lbl.classList.add('correct');
      else lbl.classList.add('incorrect');
    }
  });
}

/* ======================================================================
   My Results (barista)
====================================================================== */
const myResultsTableBody = $('#myResultsTable tbody');
const myResultsSearch = $('#myResultsSearch');
$('#clearMyResultsBtn').addEventListener('click', ()=>{
  if(confirm('Clear your local results?')){ state.myResults = []; store.set(KEYS.myResults, state.myResults); renderMyResults(); }
});
myResultsSearch.addEventListener('input', renderMyResults);
function renderMyResults(){
  const q = myResultsSearch.value.trim().toLowerCase();
  const rows = state.myResults
    .filter(r=>{
      const blob = [r.quizTitle, r.location].join(' ').toLowerCase();
      return !q || blob.includes(q);
    })
    .map(r=>`
      <tr>
        <td>${new Date(r.dateISO).toLocaleString()}</td>
        <td>${esc(r.quizTitle)}</td>
        <td>${esc(r.location)}</td>
        <td><strong>${r.scorePct}%</strong></td>
        <td>${r.correct}/${r.total}</td>
      </tr>`).join('');
  myResultsTableBody.innerHTML = rows || `<tr><td colspan="5" class="hint">No attempts yet.</td></tr>`;
}

/* ======================================================================
   Reports (admin)
====================================================================== */
const repLocation = $('#repLocation');
const repAttemptView = $('#repAttemptView');
const repSort = $('#repSort');
const repTableBody = $('#repTable tbody');
[repLocation, repAttemptView, repSort].forEach(el=> el.addEventListener('change', renderReports));

function renderReports(){
  const locSet = new Set(state.results.map(r=>r.location).filter(Boolean));
  const keep = repLocation.value;
  repLocation.innerHTML = `<option value="">All locations</option>` + [... function boot(){
  ensureSeed();
  const v = getParams().get('view') || 'create';
  activateView(v);
  const d = $('#studentDate'); if(d) d.value = todayISO();
  // Make all in-header buttons act as router links
  $$('.tab[data-route]').forEach(btn => btn.addEventListener('click', ()=> routeTo(btn.dataset.route)));
}
boot();
                                                                      
