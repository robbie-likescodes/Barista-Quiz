/* Barista Flashcards & Quizzes — local-first SPA with student-restricted link
   Merged-by-name model:
   - Deck identity = (className + deckName) only. Sub-decks are tags on cards or deck.tags.
   - On boot we merge legacy duplicates and update tests.
*/
const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const store={get(k,f){try{return JSON.parse(localStorage.getItem(k))??f}catch{return f}},set(k,v){localStorage.setItem(k,JSON.stringify(v))}};
const KEYS={decks:'bq_decks_v6',tests:'bq_tests_v6',results:'bq_results_v6',my:'bq_my_v6'};
const uid=(p='id')=>p+'_'+Math.random().toString(36).slice(2,10);
const todayISO=()=>new Date().toISOString().slice(0,10);
const esc=s=>(s??'').toString().replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const shuffle=a=>{const x=a.slice();for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]]}return x};
const sample=(a,n)=>shuffle(a).slice(0,n);
const unique=xs=>Array.from(new Set(xs));
const ADMIN_VIEWS=new Set(['create','build','reports']);

let state={
  decks:store.get(KEYS.decks,{}),
  tests:store.get(KEYS.tests,{}),
  results:store.get(KEYS.results,[]),
  my:store.get(KEYS.my,[]),
  practice:{cards:[],idx:0},
  quiz:{items:[],idx:0,n:30,locked:false,testId:''}
};

/* ---------- Router & Mode ---------- */
const qs=()=>new URLSearchParams(location.search);
function setParams(obj){const p=qs();for(const[k,v]of Object.entries(obj)){if(v==null)p.delete(k);else p.set(k,v)}history.pushState(null,'',location.pathname+'?'+p)}
function isStudent(){ return qs().get('mode')==='student'; }

function activate(view){
  if(isStudent() && ADMIN_VIEWS.has(view)){ view='practice'; setParams({view}); }
  window.removeEventListener('keydown', window.__bqPracticeKeys__);
  window.removeEventListener('keydown', window.__bqQuizKeys__);

  $$('.view').forEach(v=>v.classList.toggle('active',v.id==='view-'+view));
  $$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.route===view));
  if(view==='create') renderCreate();
  if(view==='build')  renderBuild();
  if(view==='practice') renderPracticeScreen();
  if(view==='quiz') renderQuizScreen();
  if(view==='reports') renderReports();
  if(view==='myresults') renderMyResults();
}
window.addEventListener('popstate',()=>activate(qs().get('view')||'create'));
$$('.tab').forEach(b=>b.addEventListener('click',()=>{setParams({view:b.dataset.route});activate(b.dataset.route)}));

function applyStudentMode(){
  const p=qs();
  const student=isStudent();
  document.body.classList.toggle('student',student);
  if(student){
    const name=p.get('test')||'';
    if(name){
      const entry=Object.entries(state.tests).find(([,t])=>t.name.toLowerCase()===name.toLowerCase());
      if(entry){ state.quiz.locked=true; state.quiz.testId=entry[0]; }
    }
    const next = p.get('view') && !ADMIN_VIEWS.has(p.get('view')) ? p.get('view') : 'practice';
    setParams({view:next});
  }
}

/* ===================================================================
   Merge helpers (same-name decks => one deck)
=================================================================== */
const deckKey = d => `${(d.className||'').trim().toLowerCase()}||${(d.deckName||'').trim().toLowerCase()}`;

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
    if(!mapByKey.has(k)){
      mapByKey.set(k,id);
      if(d.subdeck) d.tags=unique([...(d.tags||[]),d.subdeck]);
      continue;
    }
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

/* ===================================================================
   CREATE
=================================================================== */
const classListEl=$('#classNames'), deckListEl=$('#deckNames'), deckSelect=$('#deckSelect'), cardsList=$('#cardsList');

function renderCreate(){
  renderClassDeckDatalists();
  renderDeckSelect();
  renderDeckMeta();
  renderSubdeckManager();
  renderCardsList();
}
function renderClassDeckDatalists(){
  const arr=listUniqueDecks();
  const classes=unique(arr.map(d=>d.className).filter(Boolean)).sort();
  const decks=unique(arr.map(d=>d.deckName).filter(Boolean)).sort();
  classListEl.innerHTML=classes.map(v=>`<option value="${esc(v)}"></option>`).join('');
  deckListEl.innerHTML=decks.map(v=>`<option value="${esc(v)}"></option>`).join('');
}
function renderDeckSelect(){
  const arr=listUniqueDecks();
  if(arr.length===0){ deckSelect.innerHTML=`<option value="">No decks yet</option>`; return; }
  deckSelect.innerHTML=arr.map(d=>{
    const subs=deckSubTags(d);
    const subTxt=subs.length?` • ${subs.length} sub‑deck${subs.length>1?'s':''}`:'';
    return `<option value="${d.id}">${esc(d.deckName)} (${d.cards.length}) [${esc(d.className)}${subTxt}]</option>`;
  }).join('');
  deckSelect.style.pointerEvents='auto';
}
function selectedDeckId(){const id=deckSelect.value;return state.decks[id]?id:null}

function renderDeckMeta(){
  const id=selectedDeckId(); const titleEl=$('#deckMetaTitle'), subsEl=$('#deckMetaSubs');
  if(!id){ titleEl.textContent='No deck selected'; subsEl.innerHTML=''; return; }
  const d=state.decks[id]; const subs=deckSubTags(d);
  titleEl.textContent=`${d.deckName} — ${d.className} • ${d.cards.length} card${d.cards.length!==1?'s':''}`;
  subsEl.innerHTML=subs.length?subs.map(s=>`
    <span class="chip">${esc(s)} <button class="remove" data-sub="${esc(s)}" title="Remove tag" aria-label="Remove tag">&times;</button></span>
  `).join(''):`<span class="hint">No sub‑decks yet</span>`;
  subsEl.querySelectorAll('.remove').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const tag=btn.dataset.sub;
      const alsoClear=confirm(`Remove sub‑deck “${tag}” from deck tags?\n\nOK = also clear this tag from ALL cards in this deck.\nCancel = just remove declared tag (cards keep their tag).`);
      d.tags=(d.tags||[]).filter(t=>t!==tag);
      if(alsoClear){ (d.cards||[]).forEach(c=>{ if((c.sub||'')===tag) c.sub=''; }); }
      store.set(KEYS.decks,state.decks);
      renderDeckMeta(); renderSubdeckManager(); renderCardsList();
    });
  });
}
function renderSubdeckManager(){
  const id=selectedDeckId(); const list=$('#subdeckManagerList');
  if(!id){ list.innerHTML='<span class="hint">Select a deck first.</span>'; return; }
  const d=state.decks[id]; const subs=deckSubTags(d);
  list.innerHTML=subs.length?subs.map(s=>`
    <span class="chip">${esc(s)} <button class="remove" data-sub="${esc(s)}" title="Remove tag" aria-label="Remove tag">&times;</button></span>
  `).join(''):`<span class="hint">No sub‑decks yet</span>`;
  list.querySelectorAll('.remove').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const tag=btn.dataset.sub;
      const alsoClear=confirm(`Remove sub‑deck “${tag}” from deck tags?\n\nOK = also clear this tag from ALL cards in this deck.\nCancel = just remove declared tag (cards keep their tag).`);
      d.tags=(d.tags||[]).filter(t=>t!==tag);
      if(alsoClear){ (d.cards||[]).forEach(c=>{ if((c.sub||'')===tag) c.sub=''; }); }
      store.set(KEYS.decks,state.decks);
      renderDeckMeta(); renderSubdeckManager(); renderCardsList();
    });
  });
}
$('#createSubdeckBtn')?.addEventListener('click',()=>{
  const id=selectedDeckId(); if(!id) return alert('Select a deck first.');
  const name=($('#subdeckNewName').value||'').trim(); if(!name) return;
  const d=state.decks[id]; d.tags=unique([...(d.tags||[]),name]);
  store.set(KEYS.decks,state.decks); $('#subdeckNewName').value='';
  renderDeckMeta(); renderSubdeckManager();
});

$('#toggleSubdeckBtn').addEventListener('click',()=>{
  const el=$('#newSubdeck'); const isHidden=el.classList.toggle('hidden');
  $('#toggleSubdeckBtn').setAttribute('aria-expanded', String(!isHidden));
});

$('#addDeckBtn').addEventListener('click',()=>{
  const cls=$('#newClassName').value.trim();
  const dnm=$('#newDeckName').value.trim();
  const sdn=$('#newSubdeck').classList.contains('hidden')?'':$('#newSubdeck').value.trim();
  if(!cls||!dnm) return alert('Class and Deck are required.');

  let existing=Object.values(state.decks).find(d=>(d.className||'').toLowerCase()===cls.toLowerCase()&&(d.deckName||'').toLowerCase()===dnm.toLowerCase());
  if(existing){
    deckSelect.value=existing.id;
    if(sdn){ existing.tags=unique([...(existing.tags||[]),sdn]); store.set(KEYS.decks,state.decks); }
    renderDeckMeta(); renderSubdeckManager(); renderCardsList();
    alert('Selected existing deck.');
    return;
  }
  const id=uid('deck');
  state.decks[id]={id,className:cls,deckName:dnm,cards:[],tags:sdn?[sdn]:[],createdAt:Date.now()};
  store.set(KEYS.decks,state.decks);
  $('#newClassName').value=$('#newDeckName').value=$('#newSubdeck').value=''; $('#newSubdeck').classList.add('hidden');
  renderClassDeckDatalists(); renderDeckSelect(); deckSelect.value=id; renderDeckMeta(); renderSubdeckManager(); renderCardsList();
});

$('#renameDeckBtn').addEventListener('click',()=>{
  const id=selectedDeckId(); if(!id) return;
  const d=state.decks[id];
  const cls=prompt('Class:',d.className||''); if(cls===null) return;
  const dnk=prompt('Deck (by name):',d.deckName||''); if(dnk===null) return;
  d.className=cls.trim(); d.deckName=dnk.trim();
  store.set(KEYS.decks,state.decks); mergeDecksByName();
  renderClassDeckDatalists(); renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
});

$('#editDeckMetaBtn').addEventListener('click',()=>{
  const id=selectedDeckId(); if(!id) return;
  const d=state.decks[id];
  const cls=prompt('Edit Class:',d.className||''); if(cls===null) return;
  d.className=cls.trim();
  store.set(KEYS.decks,state.decks); mergeDecksByName();
  renderClassDeckDatalists(); renderDeckSelect(); renderDeckMeta();
});

$('#deleteDeckBtn').addEventListener('click',()=>{
  const id=selectedDeckId(); if(!id) return;
  if(confirm('Delete this deck and its cards?')){
    delete state.decks[id];
    store.set(KEYS.decks,state.decks);
    renderClassDeckDatalists(); renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
  }
});

$('#exportDeckBtn').addEventListener('click',()=>{
  const id=selectedDeckId(); if(!id) return;
  const blob=new Blob([JSON.stringify(state.decks[id],null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`${(state.decks[id].deckName||'Deck').replace(/\W+/g,'_')}.json`; a.click(); URL.revokeObjectURL(a.href);
});

$('#importDeckBtn').addEventListener('click',()=>{
  alert(`Import formats:
1) App deck JSON (this app's export)
2) MCQ JSON array: [{"Question":"...","Correct Answer":"...","Wrong Answer 1":"...","Wrong Answer 2":"...","Wrong Answer 3":"...","Subdeck":""}, ...]
3) TXT lines: Question | Correct | Wrong1 | Wrong2 | Wrong3 | #Sub‑deck(optional)`);
  $('#importDeckInput').click();
});
$('#importDeckInput').addEventListener('change',async e=>{
  const f=e.target.files?.[0]; if(!f) return;
  const txt=await f.text();
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
      renderClassDeckDatalists(); renderDeckSelect(); alert('Deck imported.');
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
  e.target.value='';
});

$('#bulkSummaryBtn').addEventListener('click',()=>setTimeout(()=>alert('Bulk Add format:\nQuestion | Correct answer | Wrong 1 | Wrong 2 | Wrong 3 | #Sub‑deck(optional)\n(At least one wrong answer is required.)'),60));
$('#bulkAddBtn').addEventListener('click',()=>{
  const id=selectedDeckId(); if(!id) return alert('Select a deck first.');
  const txt=$('#bulkTextarea').value.trim(); if(!txt) return alert('Paste at least one line.');
  let n=0; for(const line of txt.split(/\r?\n/)){
    const parts=line.split('|').map(s=>s.trim()).filter(Boolean); if(parts.length<3) continue;
    let sub=''; if(parts[parts.length-1].startsWith?.('#')) sub=parts.pop().slice(1);
    const [q,a,...wrongs]=parts; state.decks[id].cards.push({id:uid('card'),q,a,distractors:wrongs,sub,createdAt:Date.now()}); n++;
  }
  store.set(KEYS.decks,state.decks); $('#bulkTextarea').value=''; renderDeckSelect(); renderDeckMeta(); renderSubdeckManager(); renderCardsList(); alert(`Added ${n} card(s).`);
});

$('#addCardBtn').addEventListener('click',()=>{
  const id=selectedDeckId(); if(!id) return alert('Select a deck first.');
  const q=$('#qInput').value.trim(), a=$('#aCorrectInput').value.trim(), w1=$('#aWrong1Input').value.trim(), w2=$('#aWrong2Input').value.trim(), w3=$('#aWrong3Input').value.trim(), sub=$('#cardSubInput').value.trim();
  if(!q||!a||!w1) return alert('Enter question, correct, and at least one wrong answer.');
  state.decks[id].cards.push({id:uid('card'),q,a,distractors:[w1,w2,w3].filter(Boolean),sub,createdAt:Date.now()});
  if(sub){ const d=state.decks[id]; d.tags=unique([...(d.tags||[]),sub]); }
  store.set(KEYS.decks,state.decks);
  ['#qInput','#aCorrectInput','#aWrong1Input','#aWrong2Input','#aWrong3Input','#cardSubInput'].forEach(sel=>$(sel).value='');
  renderDeckMeta(); renderSubdeckManager(); renderCardsList();
});
deckSelect.addEventListener('change',()=>{ renderDeckMeta(); renderSubdeckManager(); renderCardsList(); });

function renderCardsList(){
  const id=selectedDeckId();
  if(!id){ cardsList.innerHTML='<div class="hint">Create a deck, then add cards.</div>'; return; }
  const d=state.decks[id];
  if(!d.cards.length){ cardsList.innerHTML='<div class="hint">No cards yet—add your first one above.</div>'; return; }
  cardsList.innerHTML=d.cards.map(c=>`
    <div class="cardline" data-id="${c.id}">
      <div><strong>Q:</strong> ${esc(c.q)}</div>
      <div><strong>Correct:</strong> ${esc(c.a)}<br><span class="hint">Wrong:</span> ${esc((c.distractors||[]).join(' | '))}${c.sub? `<br><span class="hint">Sub‑deck: ${esc(c.sub)}</span>`:''}</div>
      <div class="actions"><button class="btn ghost btn-edit">Edit</button><button class="btn danger btn-del">Delete</button></div>
    </div>`).join('');
  cardsList.querySelectorAll('.btn-del').forEach(b=>b.addEventListener('click',()=>{
    const cid=b.closest('.cardline').dataset.id; d.cards=d.cards.filter(c=>c.id!==cid); store.set(KEYS.decks,state.decks); renderDeckMeta(); renderSubdeckManager(); renderCardsList(); renderDeckSelect();
  }));
  cardsList.querySelectorAll('.btn-edit').forEach(b=>b.addEventListener('click',()=>{
    const cid=b.closest('.cardline').dataset.id; const card=d.cards.find(c=>c.id===cid); if(!card) return;
    const q=prompt('Question:',card.q); if(q===null) return;
    const a=prompt('Correct answer:',card.a); if(a===null) return;
    const wrong=prompt('Wrong answers (separate by |):',(card.distractors||[]).join('|'));
    const sub=prompt('Card sub‑deck (optional):',card.sub||''); if(sub===null) return;
    card.q=q.trim(); card.a=a.trim(); card.distractors=(wrong||'').split('|').map(s=>s.trim()).filter(Boolean); card.sub=sub.trim();
    if(card.sub){ d.tags=unique([...(d.tags||[]),card.sub]); }
    store.set(KEYS.decks,state.decks); renderDeckMeta(); renderSubdeckManager(); renderCardsList();
  }));
}

/* ===================================================================
   BUILD TEST
=================================================================== */
const testsList=$('#testsList'), testNameInput=$('#testNameInput'), deckPickList=$('#deckPickList');
const previewToggle=$('#previewToggle'), previewPanel=$('#previewPanel'), previewTitle=$('#previewTitle'), previewMeta=$('#previewMeta');

function renderBuild(){ renderTestsDatalist(); renderDeckPickList(); syncPreview() }
function renderTestsDatalist(){
  const arr=Object.values(state.tests).sort((a,b)=>a.name.localeCompare(b.name));
  testsList.innerHTML=arr.map(t=>`<option value="${esc(t.name)}"></option>`).join('');
}
$('#saveTestBtn').addEventListener('click',()=>{
  const name=testNameInput.value.trim(); if(!name) return alert('Enter or select a test name.');
  let t=Object.values(state.tests).find(x=>x.name.toLowerCase()===name.toLowerCase());
  if(!t){ const id=uid('test'); t=state.tests[id]={id,name,title:name,n:30,selections:[]}; }
  t.title=$('#builderTitle').value.trim()||t.title||name;
  t.n=Math.max(1,+$('#builderCount').value||t.n||30);
  t.selections=dedupeSelections(readSelectionsFromUI());
  store.set(KEYS.tests,state.tests);
  alert(`Test “${name}” saved.`);
  renderTestsDatalist();
});
$('#deleteTestBtn').addEventListener('click',()=>{
  const name=testNameInput.value.trim(); if(!name) return;
  const entry=Object.entries(state.tests).find(([,t])=>t.name.toLowerCase()===name.toLowerCase());
  if(!entry) return alert('Test not found.');
  if(confirm(`Delete test “${name}”?`)){ delete state.tests[entry[0]]; store.set(KEYS.tests,state.tests); testNameInput.value=''; renderTestsDatalist(); renderDeckPickList(); }
});

function renderDeckPickList(){
  const decks=listUniqueDecks();
  const selected=Object.values(state.tests).find(t=>t.name.toLowerCase()===testNameInput.value.trim().toLowerCase());
  const selMap=new Map((selected?.selections||[]).map(s=>[s.deckId,s]));
  deckPickList.innerHTML=decks.map(d=>{
    const subs=deckSubTags(d);
    const saved=selMap.get(d.id);
    const whole=saved?!!saved.whole:true; const savedSubs=new Set(saved?.subs||[]);
    return `<div class="deck-row" data-deck="${d.id}">
      <div class="top">
        <label class="wrap"><input type="checkbox" class="ck-whole" ${whole?'checked':''}><strong>${esc(d.deckName)}</strong><span class="hint">[Class: ${esc(d.className)}]</span></label>
        ${subs.length?`<button type="button" class="btn ghost btn-expand">Sub‑decks</button>`:`<span class="hint">No sub‑decks</span>`}
      </div>
      <div class="subs hidden">${subs.map(s=>`<label class="subchip"><input type="checkbox" class="ck-sub" value="${esc(s)}" ${savedSubs.has(s)?'checked':''}><span>${esc(s)}</span></label>`).join('')}</div>
    </div>`;
  }).join('') || `<div class="hint">No decks yet. Add some in Create.</div>`;

  deckPickList.querySelectorAll('.btn-expand').forEach(b=>b.addEventListener('click',()=>b.closest('.deck-row').querySelector('.subs').classList.toggle('hidden')));
  deckPickList.querySelectorAll('.ck-sub').forEach(cb=>cb.addEventListener('change',()=>{
    const row=cb.closest('.deck-row'); const any=row.querySelectorAll('.ck-sub:checked').length>0; row.querySelector('.ck-whole').checked=!any;
  }));
  deckPickList.querySelectorAll('.ck-whole').forEach(cb=>cb.addEventListener('change',()=>{ if(cb.checked) cb.closest('.deck-row').querySelectorAll('.ck-sub').forEach(s=>s.checked=false) }));

  if(selected){ $('#builderTitle').value=selected.title||selected.name; $('#builderCount').value=selected.n||30; }
}
function readSelectionsFromUI(){
  return [...deckPickList.querySelectorAll('.deck-row')].map(row=>{
    const deckId=row.dataset.deck; const subs=[...row.querySelectorAll('.ck-sub:checked')].map(i=>i.value);
    const whole=subs.length===0 && row.querySelector('.ck-whole').checked; return {deckId,whole,subs};
  }).filter(s=>s.whole || s.subs.length>0);
}
function dedupeSelections(selections){
  const map=new Map();
  for(const s of selections){
    if(!map.has(s.deckId)) map.set(s.deckId,{deckId:s.deckId,whole:false,subs:new Set()});
    const agg=map.get(s.deckId);
    agg.whole=agg.whole||s.whole;
    s.subs?.forEach(x=>agg.subs.add(x));
  }
  return [...map.values()].map(x=>({deckId:x.deckId,whole:x.whole && x.subs.size===0,subs:[...x.subs]}));
}

/* Share + Preview */
$('#copyShareBtn').addEventListener('click',()=>{
  const t=getCurrentTestOrSave(); if(!t) return;
  const url=new URL(location.href); url.searchParams.set('mode','student'); url.searchParams.set('test',t.name); url.searchParams.set('view','practice');
  navigator.clipboard.writeText(url.toString()); alert('Student link copied to clipboard!');
});
$('#openShareBtn').addEventListener('click',()=>{
  const t=getCurrentTestOrSave(); if(!t) return;
  const url=new URL(location.href); url.searchParams.set('mode','student'); url.searchParams.set('test',t.name); url.searchParams.set('view','practice');
  open(url.toString(),'_blank');
});
function getCurrentTestOrSave(){
  const name=testNameInput.value.trim(); if(!name) return alert('Enter a test name first.');
  let t=Object.values(state.tests).find(x=>x.name.toLowerCase()===name.toLowerCase());
  if(!t){ alert('Save the test first.'); return null; }
  t.title=$('#builderTitle').value.trim()||t.title||name; t.n=Math.max(1,+$('#builderCount').value||t.n||30); t.selections=dedupeSelections(readSelectionsFromUI()); store.set(KEYS.tests,state.tests); return t;
}
previewToggle.addEventListener('change',syncPreview);
function syncPreview(){
  const on=previewToggle.checked; $('#deckChooser').open=!on; $('#previewPanel').classList.toggle('hidden',!on);
  if(!on) return;
  const t=getCurrentTestOrSave(); if(!t) return;
  previewTitle.textContent=t.title||t.name;
  const n=computePoolForTest(t).length;
  previewMeta.textContent=`~${n} eligible questions • ${t.n} will be asked`;
}
$('#previewPracticeBtn').addEventListener('click',()=>{ setParams({view:'practice'}); activate('practice'); });
$('#previewQuizBtn').addEventListener('click',()=>{ setParams({view:'quiz'}); activate('quiz'); });

/* Helpers */
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

/* ===================================================================
   PRACTICE
=================================================================== */
const practiceTestSelect=$('#practiceTestSelect'), practiceDeckChecks=$('#practiceDeckChecks'), practiceArea=$('#practiceArea');

function renderPracticeScreen(){
  fillTestsSelect(practiceTestSelect,true);
  const last=store.get('bq_last_test',null);
  if(last && practiceTestSelect.querySelector(`option[value="${last}"]`)) practiceTestSelect.value=last;
  buildPracticeDeckChecks();
}
function fillTestsSelect(sel,lockToStudent=false){
  const list=Object.entries(state.tests).sort((a,b)=>a[1].name.localeCompare(b[1].name));
  if(state.quiz.locked && state.quiz.testId && lockToStudent){
    const t=state.tests[state.quiz.testId]; sel.innerHTML=t?`<option value="${state.quiz.testId}">${esc(t.name)}</option>`:''; sel.value=state.quiz.testId; sel.disabled=true; return;
  }
  sel.disabled=false;
  sel.innerHTML=list.map(([id,t])=>`<option value="${id}">${esc(t.name)}</option>`).join('')||'';
}
practiceTestSelect.addEventListener('change',()=>{ buildPracticeDeckChecks(); store.set('bq_last_test',practiceTestSelect.value); });

function buildPracticeDeckChecks(){
  const tid=practiceTestSelect.value; const t=state.tests[tid]; practiceDeckChecks.innerHTML='';
  if(!t){ practiceDeckChecks.innerHTML='<span class="hint">No test selected.</span>'; return; }
  const seen=new Set(), chips=[];
  for(const sel of dedupeSelections(t.selections||[])){
    if(seen.has(sel.deckId)) continue; seen.add(sel.deckId);
    const d=state.decks[sel.deckId]; if(!d) continue;
    const chip=document.createElement('label'); chip.className='chip';
    const ck=document.createElement('input'); ck.type='checkbox'; ck.dataset.deck=sel.deckId; ck.checked=true; chip.appendChild(ck);
    const span=document.createElement('span'); span.textContent=deckLabel(d); chip.appendChild(span);
    chips.push(chip);
  }
  if(chips.length) chips.forEach(c=>practiceDeckChecks.appendChild(c));
  else practiceDeckChecks.innerHTML='<span class="hint">This test has no decks selected.</span>';
}
$('#startPracticeBtn').addEventListener('click',()=>{
  const tid=practiceTestSelect.value; const t=state.tests[tid]; if(!t) return alert('Pick a test.');
  const chosen=new Set([...practiceDeckChecks.querySelectorAll('input[type=checkbox]:checked')].map(i=>i.dataset.deck));
  const pool=[];
  for(const sel of dedupeSelections(t.selections||[])){
    if(!chosen.has(sel.deckId)) continue;
    const d=state.decks[sel.deckId]; if(!d) continue;
    if(sel.whole) pool.push(...d.cards); else pool.push(...d.cards.filter(c=>sel.subs.includes(c.sub||'')));
  }
  if(!pool.length) return alert('No cards to practice.');
  state.practice.cards=shuffle(pool); state.practice.idx=0; practiceArea.hidden=false; showPractice();
});
function showPractice(){
  const idx=state.practice.idx, total=state.practice.cards.length, c=state.practice.cards[idx];
  $('#practiceLabel').textContent=`Card ${idx+1} of ${total}`;
  $('#practiceProgress').textContent=`Tap card to flip. Use ←/→ to navigate.`;
  $('#practiceQuestion').textContent=c.q; $('#practiceAnswer').textContent=c.a;
  const card=$('#practiceCard'); card.classList.remove('flipped'); card.onclick=()=>card.classList.toggle('flipped');

  const handler=(e)=>{
    if(e.key===' '){ e.preventDefault(); card.classList.toggle('flipped'); }
    if(e.key==='ArrowRight'){ $('#practiceNext').click(); }
    if(e.key==='ArrowLeft'){ $('#practicePrev').click(); }
  };
  window.removeEventListener('keydown', window.__bqPracticeKeys__);
  window.__bqPracticeKeys__=handler;
  window.addEventListener('keydown', handler);
}
$('#practicePrev').addEventListener('click',()=>{ state.practice.idx=Math.max(0,state.practice.idx-1); showPractice(); });
$('#practiceNext').addEventListener('click',()=>{ state.practice.idx=Math.min(state.practice.cards.length-1,state.practice.idx+1); showPractice(); });
$('#practiceShuffle').addEventListener('click',()=>{ state.practice.cards=shuffle(state.practice.cards); state.practice.idx=0; showPractice(); });

/* ===================================================================
   QUIZ
=================================================================== */
const quizTestSelect=$('#quizTestSelect'), quizOptions=$('#quizOptions'), quizQuestion=$('#quizQuestion'), quizProgress=$('#quizProgress');

function renderQuizScreen(){
  fillTestsSelect(quizTestSelect,true);
  const last=store.get('bq_last_test',null);
  if(last && quizTestSelect.querySelector(`option[value="${last}"]`)) quizTestSelect.value=last;
  if(!$('#studentDate').value) $('#studentDate').value=todayISO();
  startOrRefreshQuiz();
}
quizTestSelect.addEventListener('change',()=>{ startOrRefreshQuiz(); store.set('bq_last_test',quizTestSelect.value); });

function startOrRefreshQuiz(){
  const tid=quizTestSelect.value; const t=state.tests[tid];
  if(!t){ quizOptions.innerHTML=''; quizQuestion.textContent='Select a test above'; return; }
  const pool=computePoolForTest(t);
  if(!pool.length){ quizOptions.innerHTML=''; quizQuestion.textContent='No questions in this test.'; return; }
  const n=Math.min(t.n||30,pool.length);
  state.quiz.items=sample(pool,n).map(q=>{
    const opts=unique([q.a,...(q.distractors||[])].map(s=>(s??'').trim()).filter(Boolean));
    if(opts.length<2) opts.push('—');
    return {q:q.q,a:q.a,opts:shuffle(opts),picked:null};
  });
  state.quiz.idx=0; state.quiz.n=n;
  $('#quizArea').classList.remove('hidden'); $('#quizFinished').classList.add('hidden');
  drawQuiz();
}
function drawQuiz(){
  const i=state.quiz.idx, it=state.quiz.items[i]; if(!it) return;
  quizQuestion.textContent=it.q; quizProgress.textContent=`${i+1}/${state.quiz.items.length}`;
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
    if(e.key==='ArrowRight'){ $('#quizNext').click(); }
    if(e.key==='ArrowLeft'){ $('#quizPrev').click(); }
  };
  window.removeEventListener('keydown', window.__bqQuizKeys__);
  window.__bqQuizKeys__=handler;
  window.addEventListener('keydown', handler);
}
$('#quizPrev').addEventListener('click',()=>{ state.quiz.idx=Math.max(0,state.quiz.idx-1); drawQuiz(); });
$('#quizNext').addEventListener('click',()=>{ state.quiz.idx=Math.min(state.quiz.items.length-1,state.quiz.idx+1); drawQuiz(); });

$('#submitQuizBtn').addEventListener('click',()=>{
  const name=$('#studentName').value.trim(), loc=$('#studentLocation').value.trim(), dt=$('#studentDate').value;
  if(!name||!loc||!dt) return alert('Name, location and date are required.');
  const tid=quizTestSelect.value; const t=state.tests[tid]; if(!t) return alert('No test selected.');
  const total=state.quiz.items.length; const correct=state.quiz.items.filter(x=>x.picked===x.a).length; const score=Math.round(100*correct/Math.max(1,total));
  const answers=state.quiz.items.map((x,i)=>({i,q:x.q,correct:x.a,picked:x.picked}));

  const row={id:uid('res'),name,location:loc,date:dt,time:Date.now(),testId:tid,testName:t.name,score,correct,of:total,answers};
  state.results.push(row); store.set(KEYS.results,state.results);
  state.my.push({id:uid('myres'),date:dt,time:row.time,testId:tid,testName:t.name,location:loc,score,correct,of:total,answers});
  store.set(KEYS.my,state.my);

  $('#quizArea').classList.add('hidden'); $('#quizFinished').classList.remove('hidden');
  $('#finishedMsg').innerHTML=`Thanks, <strong>${esc(name)}</strong>! You scored <strong>${score}%</strong> (${correct}/${total}).`;
  $('#finishedAnswers').innerHTML=answers.map(a=>`
    <div class="row">
      <div class="q">${esc(a.q)}</div>
      <div class="a">
        <span class="tag ${a.picked===a.correct?'good':'bad'}">Your: ${esc(a.picked??'—')}</span>
        <span class="tag good">Correct: ${esc(a.correct)}</span>
      </div>
    </div>`).join('');
});
$('#restartQuizBtn').addEventListener('click',()=>{ $('#quizFinished').classList.add('hidden'); $('#quizArea').classList.remove('hidden'); startOrRefreshQuiz(); });
$('#finishedPracticeBtn').addEventListener('click',()=>{ setParams({view:'practice'}); activate('practice'); });

/* ===================================================================
   REPORTS & MY RESULTS
=================================================================== */
function renderReports(){
  const locs=unique(state.results.map(r=>r.location)).filter(Boolean).sort();
  const keep=$('#repLocation').value;
  $('#repLocation').innerHTML=`<option value="">All locations</option>`+locs.map(l=>`<option ${keep===l?'selected':''}>${esc(l)}</option>`).join('');
  drawReports();
}
$('#repLocation').addEventListener('change',drawReports);
$('#repAttemptView').addEventListener('change',drawReports);
$('#repSort').addEventListener('change',drawReports);

function drawReports(){
  const loc=$('#repLocation').value, attempt=$('#repAttemptView').value, sort=$('#repSort').value;
  let rows=[...state.results];
  if(loc) rows=rows.filter(r=>r.location===loc);
  if(attempt!=='all'){
    const map=new Map();
    for(const r of rows){ const k=r.name+'|'+r.testName; (map.get(k)||map.set(k,[]).get(k)).push(r); }
    rows=[]; map.forEach(arr=>{ arr.sort((a,b)=>a.time-b.time); rows.push(attempt==='first'?arr[0]:arr[arr.length-1]); });
  }
  if(sort==='date_desc') rows.sort((a,b)=>b.time-a.time);
  if(sort==='date_asc')  rows.sort((a,b)=>a.time-b.time);
  if(sort==='test_asc')  rows.sort((a,b)=>a.testName.localeCompare(b.testName));
  if(sort==='test_desc') rows.sort((a,b)=>b.testName.localeCompare(a.testName));

  const tb=$('#repTable tbody');
  tb.innerHTML=rows.map(r=>`<tr data-id="${r.id}">
    <td>${new Date(r.time).toLocaleString()}</td>
    <td>${esc(r.name)}</td>
    <td>${esc(r.location)}</td>
    <td>${esc(r.testName)}</td>
    <td>${r.score}%</td>
    <td>${r.correct}/${r.of}</td>
    <td><button class="btn ghost view-btn">Open</button></td>
  </tr>`).join('');

  tb.querySelectorAll('.view-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const id=btn.closest('tr').dataset.id; const r=state.results.find(x=>x.id===id); if(!r) return;
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

  const missMap=new Map();
  for(const r of rows){
    for(const a of (r.answers||[])){
      const k=a.q; if(!missMap.has(k)) missMap.set(k,{q:k,misses:0,total:0});
      const m=missMap.get(k); m.total++; if(a.picked!==a.correct) m.misses++;
    }
  }
  const top=[...missMap.values()].filter(x=>x.total>0).sort((a,b)=>b.misses-a.misses).slice(0,10);
  $('#missedSummary').innerHTML = top.length? top.map(m=>`
    <div class="missrow">
      <div class="misscount"><div>${m.misses}/${m.total}</div><div class="hint">missed</div></div>
      <div class="missq">${esc(m.q)}</div>
    </div>`).join('') : '<div class="hint">No data yet.</div>';
}

/* My Results */
function renderMyResults(){
  const tb=$('#myResultsTable tbody');
  const q=($('#myResultsSearch').value||'').toLowerCase();
  const rows=state.my.filter(r=>`${r.testName} ${r.location}`.toLowerCase().includes(q)).sort((a,b)=>b.time-a.time);
  tb.innerHTML=rows.map(r=>`<tr data-id="${r.id}"><td>${new Date(r.time).toLocaleString()}</td><td>${esc(r.testName)}</td><td>${esc(r.location)}</td><td>${r.score}%</td><td>${r.correct}/${r.of}</td><td><button class="btn ghost view-btn">Open</button></td></tr>`).join('');
  const panel=$('#myDetail'), body=$('#myDetailBody'); panel.classList.add('hidden');
  tb.querySelectorAll('.view-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const id=btn.closest('tr').dataset.id; const r=state.my.find(x=>x.id===id); if(!r) return;
    body.innerHTML=r.answers.map(a=>`
      <div class="row"><div class="q">${esc(a.q)}</div>
        <div class="a">
          <span class="tag ${a.picked===a.correct?'good':'bad'}">Your: ${esc(a.picked??'—')}</span>
          <span class="tag good">Correct: ${esc(a.correct)}</span>
        </div>
      </div>`).join('');
    panel.classList.remove('hidden'); panel.open=true; panel.scrollIntoView({behavior:'smooth'});
  }));
}
$('#myResultsSearch').addEventListener('input',renderMyResults);
$('#clearMyResultsBtn').addEventListener('click',()=>{ if(confirm('Clear your local “My Results”?')){ state.my=[]; store.set(KEYS.my,state.my); renderMyResults(); }});

/* ===================================================================
   Boot
=================================================================== */
function normalizeTests(){
  let changed=false;
  for(const id of Object.keys(state.tests)){
    const t=state.tests[id];
    const norm=dedupeSelections(t.selections||[]);
    if(JSON.stringify(norm)!==JSON.stringify(t.selections||[])){ t.selections=norm; changed=true; }
  }
  if(changed) store.set(KEYS.tests,state.tests);
}
function boot(){
  mergeDecksByName();
  normalizeTests();
  applyStudentMode();
  $$('select').forEach(sel=>{
    sel.style.pointerEvents='auto';
    sel.addEventListener('touchstart',()=>sel.focus(),{passive:true});
  });
  if(!$('#studentDate').value) $('#studentDate').value=todayISO();
  activate(qs().get('view')|| (isStudent() ? 'practice' : 'create'));
}
boot();
