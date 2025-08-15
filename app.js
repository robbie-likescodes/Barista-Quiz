/* =============================
   Persistent state + shape
   ============================= */
const KEY = 'BARISTA_APP_V3';
const $ = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));

let state = load();
function load(){ try{const r=localStorage.getItem(KEY); if(r) return JSON.parse(r);}catch{} return {classes:{},tests:{},results:[]}; }
function save(){ localStorage.setItem(KEY, JSON.stringify(state)); }

const todayISO = () => new Date().toISOString().slice(0,10);
const uid = () => Math.random().toString(36).slice(2,10);
const esc = s => (s??'').toString().replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));

/* ---------- Data helpers ---------- */
function ensureClassDeck(cls, deck){
  if(!state.classes[cls]) state.classes[cls] = { decks:{} };
  if(!state.classes[cls].decks[deck]) state.classes[cls].decks[deck] = { subdecks:{}, cards:[] };
  return state.classes[cls].decks[deck];
}
function classDeckTree(){
  const out = [];
  for(const [cls, obj] of Object.entries(state.classes)){
    const decks = Object.entries(obj.decks).map(([deck, dobj]) => ({
      deck,
      sub: Object.keys(dobj.subdecks).sort()
    })).sort((a,b)=>a.deck.localeCompare(b.deck));
    out.push({class:cls, decks});
  }
  out.sort((a,b)=>a.class.localeCompare(b.class));
  return out;
}
function allDeckOptions(){
  // unique by (class,deck) for dropdowns
  const list = [];
  for (const [cls, obj] of Object.entries(state.classes)){
    for (const deck of Object.keys(obj.decks)){
      list.push({value:`${cls}::${deck}`, label:`${deck} — ${cls}`});
    }
  }
  list.sort((a,b)=>a.label.localeCompare(b.label));
  return list;
}
function pickCardsFromSelections(selections){
  // selections: { class: { deck: '*' | [subs] } }
  const pool=[];
  for(const [cls, dmap] of Object.entries(selections||{})){
    for(const [deck, sel] of Object.entries(dmap||{})){
      const d = state.classes?.[cls]?.decks?.[deck];
      if(!d) continue;
      const subs = sel==='*' ? null : new Set(sel);
      for(const c of d.cards){
        if(!subs || subs.has(c.sub||'')) pool.push(c);
      }
    }
  }
  return pool;
}
function deserializeSelections(raw){
  // arrays as-is, '*' kept
  const out={};
  for(const [cls,dmap] of Object.entries(raw||{})){
    out[cls]={};
    for(const [deck,v] of Object.entries(dmap)) out[cls][deck]=v;
  }
  return out;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } return a; }

/* ---------- Router ---------- */
function getParams(){ return new URLSearchParams(location.search); }
function setParams(patch){ const sp=getParams(); for(const[k,v] of Object.entries(patch)){ if(v===null) sp.delete(k); else sp.set(k,v); } history.replaceState(null,'',`${location.pathname}?${sp.toString()}`); }
function activateView(v){
  $$('.view').forEach(x=>x.classList.add('hidden'));
  $(`#view-${v}`)?.classList.remove('hidden');
  $$('.tab').forEach(b=>b.classList.toggle('active', b.dataset.route===v));
}

/* ---------- Fill helpers ---------- */
function fillDatalist(id, arr){ const el=$(id); el.innerHTML = arr.map(x=>`<option value="${esc(x)}"></option>`).join(''); }
function fillSelect(sel, items, withBlank=true){
  const el=$(sel); const ops=[]; if(withBlank) ops.push(`<option value="">—</option>`);
  for(const it of items){ ops.push(`<option value="${esc(it.value)}">${esc(it.label)}</option>`); }
  el.innerHTML = ops.join('');
}

/* ---------- Create view ---------- */
function renderCreate(){
  fillDatalist('#clsList', Object.keys(state.classes).sort());
  const allDecks = new Set(); Object.values(state.classes).forEach(c => Object.keys(c.decks).forEach(d=>allDecks.add(d)));
  fillDatalist('#deckList', [...allDecks].sort());

  // deck picker (unique deck names, grouped by class)
  const deckSel = $('#pickDeckByName');
  deckSel.innerHTML = allDeckOptions().map(o=>`<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  if(!deckSel.value && deckSel.options.length) deckSel.selectedIndex=0;

  // subdeck picker for selected deck
  refreshSubdeckPicker();
  renderCardList();
}
function refreshSubdeckPicker(){
  const sel = $('#pickDeckByName').value || '';
  const [cls, deck] = sel.split('::');
  const subSel = $('#pickSubByName');
  const subs = Object.keys(state.classes?.[cls]?.decks?.[deck]?.subdecks || {});
  subSel.innerHTML = `<option value="">(all/none)</option>` + subs.map(s=>`<option>${esc(s)}</option>`).join('');
}
function renderCardList(){
  const sel = $('#pickDeckByName').value || '';
  const [cls, deck] = sel.split('::');
  const sub = $('#pickSubByName').value || '';
  const container = $('#cardList');
  const d = state.classes?.[cls]?.decks?.[deck];
  if(!d){ $('#cardStats').textContent='No deck selected.'; container.innerHTML=''; return; }
  const items = d.cards.filter(c => !sub || (c.sub||'')===sub);
  $('#cardStats').textContent = `${cls} › ${deck}${sub? ' › '+sub:''} — ${items.length} card(s)`;
  container.innerHTML = items.map((c,i)=>`
    <div class="item">
      <div>
        <div class="small muted">Q${i+1}</div>
        <div>${esc(c.q)}</div>
        <div class="small muted">A: ${esc(c.a)} ${c.sub? ` • sub: ${esc(c.sub)}`:''}</div>
      </div>
      <div class="row">
        <button data-del="${i}">Delete</button>
      </div>
    </div>`).join('');
  $$('button[data-del]',container).forEach(b=> b.onclick = ()=>{
    const idx = +b.dataset.del;
    const subset = d.cards.filter(c => !sub || (c.sub||'')===sub);
    const target = subset[idx];
    const globalIdx = d.cards.indexOf(target);
    if(globalIdx>-1){ d.cards.splice(globalIdx,1); save(); renderCardList(); }
  });
}

/* Create handlers */
$('#btnAddDeck').addEventListener('click', ()=>{
  const cls=$('#clsName').value.trim(), deck=$('#deckName').value.trim(), sub=$('#subdeckName').value.trim();
  if(!cls || !deck){ alert('Class and Deck required.'); return; }
  const d=ensureClassDeck(cls, deck);
  if(sub) d.subdecks[sub]=true;
  save(); ['#subdeckName'].forEach(id=>$(id).value='');
  renderCreate();
});
$('#pickDeckByName').addEventListener('change', ()=>{ refreshSubdeckPicker(); renderCardList(); });
$('#pickSubByName').addEventListener('change', renderCardList);

$('#btnExportDeck').addEventListener('click', ()=>{
  const sel=$('#pickDeckByName').value; if(!sel){alert('Pick a deck first.');return;}
  const [cls,deck]=sel.split('::'); const d=state.classes?.[cls]?.decks?.[deck];
  const lines = d.cards.map(c => [c.q,c.a,...c.wrongs,(c.sub?('#'+c.sub):'')].join(' | '));
  const blob=new Blob([lines.join('\n')],{type:'text/plain'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`${deck}-${cls}.txt`; a.click(); URL.revokeObjectURL(a.href);
});

$('#importFile').addEventListener('change', e=>{
  const file = e.target.files?.[0]; if(!file) return;
  const sel=$('#pickDeckByName').value; if(!sel){ alert('Pick a deck to import into first.'); e.target.value=''; return; }
  const [cls,deck]=sel.split('::'); const d=ensureClassDeck(cls,deck);
  const reader=new FileReader();
  reader.onload=()=>{
    try{
      let text = String(reader.result||'');
      // allow JSON export of our deck too
      if(file.name.endsWith('.json')){
        const obj = JSON.parse(text);
        if(Array.isArray(obj.cards)){
          obj.cards.forEach(c=>{ if(c.sub) d.subdecks[c.sub]=true; d.cards.push(c); });
        }
      }else{
        const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
        let ok=0, bad=0;
        for(const line of lines){
          const parts=line.split('|').map(x=>x.trim());
          if(parts.length<3){ bad++; continue; }
          const q=parts[0], a=parts[1], wrongs=parts.slice(2,5).filter(Boolean);
          let sub=''; const tail=parts.slice(5).join('|').trim();
          if(tail.startsWith('#')) sub=tail.slice(1).trim();
          if(!wrongs.length){ bad++; continue; }
          if(sub) d.subdecks[sub]=true;
          d.cards.push({q,a,wrongs,class:cls,deck,sub});
          ok++;
        }
        alert(`Import complete: ${ok} added${bad?`, ${bad} skipped`:''}.`);
      }
      save(); refreshSubdeckPicker(); renderCardList();
    }catch(err){ alert('Import failed: '+err.message); }
    e.target.value='';
  };
  reader.readAsText(file);
});

$('#btnBulkAdd').addEventListener('click', ()=>{
  const sel=$('#pickDeckByName').value; if(!sel){ alert('Pick a deck first.'); return; }
  const [cls,deck]=sel.split('::'); const d=ensureClassDeck(cls,deck);
  const preferredSub = $('#pickSubByName').value.trim(); // optional default sub
  const lines=$('#bulkText').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if(!lines.length){ alert('Paste some lines first.'); return; }
  let ok=0,bad=0;
  for(const line of lines){
    const parts=line.split('|').map(x=>x.trim());
    if(parts.length<3){ bad++; continue; }
    const q=parts[0], a=parts[1], wrongs=parts.slice(2,5).filter(Boolean);
    let sub=preferredSub; const tail=parts.slice(5).join('|').trim();
    if(tail.startsWith('#')) sub=tail.slice(1).trim();
    if(!wrongs.length){ bad++; continue; }
    if(sub) d.subdecks[sub]=true;
    d.cards.push({q,a,wrongs,class:cls,deck,sub});
    ok++;
  }
  save(); renderCardList();
  alert(`Bulk import: added ${ok} card(s). ${bad? bad+' skipped for format.':''}`);
});
$('#btnClearBulk').addEventListener('click', ()=> $('#bulkText').value='');

/* ---------- Build view ---------- */
let chooseTreeEl, practiceTreeEl;

function buildTree(containerId, allowClassAll=true){
  const host=$(containerId);
  host.innerHTML='';
  const tree = classDeckTree();
  const wrap=document.createElement('div'); wrap.className='tree';
  tree.forEach(node=>{
    const clsDiv=document.createElement('div');
    clsDiv.innerHTML = `
      <label><input type="checkbox" data-level="class" data-all="${allowClassAll?1:0}" value="${esc(node.class)}"><strong>${esc(node.class)}</strong></label>
      <ul></ul>`;
    const ul=$('ul',clsDiv);
    node.decks.forEach(d=>{
      const li=document.createElement('li');
      const subList = d.sub.length ? `<ul>${d.sub.map(s=>`
        <li><label><input type="checkbox" data-level="sub" data-class="${esc(node.class)}" data-deck="${esc(d.deck)}" value="${esc(s)}"><span class="badge-pill">${esc(s)}</span></label></li>
      `).join('')}</ul>` : '';
      li.innerHTML = `
        <label><input type="checkbox" data-level="deck" data-class="${esc(node.class)}" data-all="1" value="${esc(d.deck)}">
          <span class="badge-pill">📚 ${esc(d.deck)}</span></label>
        ${subList}`;
      ul.appendChild(li);
    });
    wrap.appendChild(clsDiv);
  });
  host.appendChild(wrap);
  return wrap;
}
function selectionsFromTree(root){
  const sel={};
  // decks
  $$('input[data-level="deck"]',root).forEach(b=>{
    if(!b.checked) return;
    const cls=b.dataset.class, deck=b.value;
    sel[cls] ??= {};
    sel[cls][deck] = '*'; // whole deck
  });
  // subs
  $$('input[data-level="sub"]',root).forEach(b=>{
    if(!b.checked) return;
    const cls=b.dataset.class, deck=b.dataset.deck, sub=b.value;
    sel[cls] ??= {}; sel[cls][deck] ??= [];
    if(sel[cls][deck] === '*') return; // already whole deck
    if(!Array.isArray(sel[cls][deck])) sel[cls][deck]=[];
    if(!sel[cls][deck].includes(sub)) sel[cls][deck].push(sub);
  });
  // class-all (if checked but not overridden by deck/sub we’ll expand) – do after
  $$('input[data-level="class"]',root).forEach(b=>{
    if(!b.checked || b.dataset.all!=='1') return;
    const cls=b.value;
    sel[cls] ??= {};
    const decks = Object.keys(state.classes?.[cls]?.decks||{});
    decks.forEach(d=>{ sel[cls][d] ??= '*'; });
  });
  return sel;
}
function renderBuild(){
  fillDatalist('#testList', Object.keys(state.tests).sort());
  chooseTreeEl = buildTree('#chooseTree', true);
}
$('#btnSaveTest').addEventListener('click', ()=>{
  const name=$('#testName').value.trim(); if(!name){ alert('Enter a test name.'); return; }
  const title=$('#testTitle').value.trim() || name;
  const count=parseInt($('#testCount').value,10)||30;
  const selections=selectionsFromTree(chooseTreeEl);
  if(!Object.keys(selections).length){ alert('Pick some content from the tree.'); return; }
  state.tests[name] = {title,count,selections};
  save(); alert('Test saved.');
});
$('#btnDeleteTest').addEventListener('click', ()=>{
  const name=$('#testName').value.trim(); if(!name||!state.tests[name]){ alert('Pick an existing test.'); return; }
  if(confirm(`Delete test "${name}"?`)){ delete state.tests[name]; save(); renderBuild(); }
});
$('#btnCopyStudent').addEventListener('click', ()=>{
  const name=$('#testName').value.trim(); if(!name||!state.tests[name]){ alert('Save/select a test first.'); return; }
  const url = `${location.origin}${location.pathname}?view=quiz&mode=student&test=${encodeURIComponent(name)}`;
  navigator.clipboard.writeText(url).then(()=> alert('Student link copied.'));
});
$('#btnOpenStudent').addEventListener('click', ()=>{
  const name=$('#testName').value.trim(); if(!name||!state.tests[name]){ alert('Save/select a test first.'); return; }
  const url = `${location.origin}${location.pathname}?view=quiz&mode=student&test=${encodeURIComponent(name)}`;
  window.open(url,'_blank');
});

/* ---------- Practice (flip cards) ---------- */
let practiceTreeEl;
function renderPractice(){
  const tests = Object.keys(state.tests).map(t=>({value:t,label:t}));
  fillSelect('#practiceTest', tests);
  practiceTreeEl = buildTree('#practiceTree', false);
  $('#practiceStage').classList.add('hidden');
}
$('#btnStartPractice').addEventListener('click', ()=>{
  const t=$('#practiceTest').value; if(!t){ alert('Select a test.'); return; }
  const base = deserializeSelections(state.tests[t].selections);
  const pick = selectionsFromTree(practiceTreeEl);
  const use = Object.keys(pick).length ? intersectSel(base,pick) : base;
  const cards=pickCardsFromSelections(use);
  if(!cards.length){ alert('No cards match selection.'); return; }
  startFlashcards(cards);
});
function intersectSel(a,b){
  const out={};
  for(const [cls, dmap] of Object.entries(a)){
    for(const [deck, va] of Object.entries(dmap)){
      const vb = b?.[cls]?.[deck];
      if(!vb) continue;
      if(va==='*' && vb==='*'){ out[cls]??={}; out[cls][deck]='*'; continue; }
      const Sa = va==='*' ? new Set(Object.keys(state.classes[cls].decks[deck].subdecks)) : new Set(va);
      const Sb = vb==='*' ? new Set(Object.keys(state.classes[cls].decks[deck].subdecks)) : new Set(vb);
      const inter=[...Sa].filter(x=>Sb.has(x));
      if(inter.length){ out[cls]??={}; out[cls][deck]=inter; }
    }
  }
  return out;
}
function startFlashcards(cards){
  const stage=$('#practiceStage'); stage.classList.remove('hidden');
  let i=0; cards = shuffle([...cards]);
  const render=()=>{
    stage.innerHTML='';
    const card=$('#tpl-flip').content.firstElementChild.cloneNode(true);
    $('.qtext',card).textContent = `Q${i+1}/${cards.length}: ${cards[i].q}`;
    $('.ans',card).textContent = cards[i].a;
    card.addEventListener('click', ()=> card.classList.toggle('flipped'));
    const nav=document.createElement('div'); nav.className='row qnav';
    nav.innerHTML=`<button class="ghost" id="prev">Prev</button>
                   <div class="muted small">${i+1}/${cards.length}</div>
                   <button class="ghost" id="shuffle">Shuffle</button>
                   <button class="primary" id="next">Next</button>`;
    stage.append(card, nav);
    $('#prev').onclick=()=>{ i=Math.max(0,i-1); render(); }
    $('#next').onclick=()=>{ i=Math.min(cards.length-1,i+1); render(); }
    $('#shuffle').onclick=()=>{ shuffle(cards); i=0; render(); }
  };
  render();
}

/* ---------- Quiz (MCQ) ---------- */
function renderQuiz(){
  const tests=Object.keys(state.tests).map(t=>({value:t,label:t}));
  fillSelect('#quizTest', tests);
  $('#studentDate').value=todayISO();
  $('#quizStage').classList.add('hidden');
}
$('#btnStartQuiz').addEventListener('click', ()=>{
  const t=$('#quizTest').value, nm=$('#studentName').value.trim(), loc=$('#studentLoc').value.trim(), dt=$('#studentDate').value;
  if(!t){ alert('Select a test.'); return; }
  if(!nm || !loc){ alert('Name and Location required.'); return; }
  const test=state.tests[t]; const pool=pickCardsFromSelections(deserializeSelections(test.selections));
  if(!pool.length){ alert('This test has no cards.'); return; }
  const questions = shuffle(pool).slice(0, Math.min(test.count||30, pool.length));
  startQuiz(t, test.title||t, questions, nm, loc, dt);
});

function startQuiz(testName, title, questions, name, location, dateISO){
  const stage=$('#quizStage'); stage.classList.remove('hidden');
  let idx=0; const answers=new Array(questions.length).fill(null);

  const renderQ=()=>{
    stage.innerHTML='';
    const q=questions[idx];
    const node=$('#tpl-question').content.firstElementChild.cloneNode(true);
    $('.qtext',node).textContent = `Q${idx+1}/${questions.length}: ${q.q}`;
    const opts=shuffle([q.a, ...q.wrongs]).slice(0, Math.max(2, Math.min(4, 1+q.wrongs.length)));
    const box=$('.opts',node);
    opts.forEach(op=>{
      const b=document.createElement('button');
      b.className='opt';
      b.textContent=op;
      if(answers[idx] && answers[idx].choice===op){
        b.classList.add(answers[idx].correct?'correct':'incorrect');
      }
      b.onclick=()=>{
        const correct=(op===q.a);
        answers[idx]={ q:q.q, answer:q.a, choice:op, correct };
        // show immediate feedback
        $$('button',box).forEach(x=>x.disabled=true);
        b.classList.add(correct?'correct':'incorrect');
      };
      box.appendChild(b);
    });
    $('[data-progress]',node).textContent = `${idx+1}/${questions.length}`;
    $('[data-prev]',node).onclick = ()=>{ idx=Math.max(0,idx-1); renderQ(); };
    $('[data-next]',node).onclick = ()=>{
      if(idx<questions.length-1){ idx++; renderQ(); } else { finish(); }
    };
    $('[data-shuffle]',node).onclick = ()=>{ shuffle(questions); idx=0; renderQ(); };
    stage.appendChild(node);
  };

  const finish=()=>{
    const filled = answers.map((a,i)=> a || {q:questions[i].q, answer:questions[i].a, choice:'(blank)', correct:false});
    const score = filled.filter(x=>x.correct).length;
    const rec={ id:uid(), test:testName, title, name, location, dateISO, score, total:filled.length, items:filled,
                mode: (getParams().get('mode')==='student')?'student':'admin' };
    state.results.push(rec); save();
    stage.innerHTML = `
      <div class="qcard">
        <h3>Finished!</h3>
        <p>Thanks, <strong>${esc(name)}</strong>! You scored <strong>${Math.round(score/filled.length*100)}%</strong> (${score}/${filled.length}).</p>
        <div class="row">
          <button id="btnRestart" class="primary">Restart (fresh shuffle)</button>
          <button id="btnToPractice">Go to Practice</button>
          <button id="btnShowKey" class="success">Your Answers & Key</button>
        </div>
      </div>
      <div id="ansKey" class="qcard hidden"></div>`;
    $('#btnRestart').onclick = ()=> startQuiz(testName,title,shuffle([...questions]),name,location,dateISO);
    $('#btnToPractice').onclick = ()=> routeTo('practice');
    $('#btnShowKey').onclick = ()=>{
      const key=$('#ansKey'); key.classList.remove('hidden');
      key.innerHTML = filled.map((a,i)=>`
        <div class="qcard">
          <div class="qtext">Q${i+1}: ${esc(a.q)}</div>
          <div class="opt ${a.correct?'correct':'incorrect'}">Your choice: ${esc(a.choice)}</div>
          <div class="opt correct">Correct: ${esc(a.answer)}</div>
        </div>`).join('');
    };
  };

  renderQ();
}

/* ---------- Reports & My Results ---------- */
function renderReports(){
  const tests=Object.keys(state.tests).map(t=>({value:t,label:t}));
  fillSelect('#repTest', [{value:'',label:'All'},...tests], false);
  const locSet=[...new Set(state.results.map(r=>r.location).filter(Boolean))].sort();
  $('#repLocation').innerHTML = `<option value="">All</option>` + locSet.map(l=>`<option>${esc(l)}</option>`).join('');
  $('#repSort').value='dateDesc';
  renderRepTable(); renderMissed();
}
function renderRepTable(){
  const t=$('#repTest').value, loc=$('#repLocation').value, sort=$('#repSort').value;
  let rows = state.results.slice();
  if(t) rows = rows.filter(r=>r.test===t);
  if(loc) rows = rows.filter(r=>r.location===loc);
  rows.sort((a,b)=>{
    if(sort==='dateDesc') return b.dateISO.localeCompare(a.dateISO);
    if(sort==='dateAsc') return a.dateISO.localeCompare(b.dateISO);
    if(sort==='scoreDesc') return (b.score/b.total)-(a.score/a.total);
    return (a.score/a.total)-(b.score/b.total);
  });
  $('#repTable').innerHTML = rows.length? `
    <table class="table">
      <thead><tr><th>Date</th><th>Name</th><th>Location</th><th>Test</th><th>Score</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r=>`
          <tr>
            <td>${esc(r.dateISO)}</td>
            <td>${esc(r.name)}</td>
            <td>${esc(r.location)}</td>
            <td>${esc(r.title||r.test)}</td>
            <td>${r.score}/${r.total}</td>
            <td><button data-open="${r.id}">Open</button></td>
          </tr>`).join('')}
      </tbody>
    </table>` : `<div class="muted">No results yet.</div>`;
  $$('button[data-open]').forEach(b=> b.onclick = ()=> openResultWindow(state.results.find(x=>x.id===b.dataset.open)));
}
function renderMissed(){
  const t=$('#repTest').value;
  const rows = state.results.filter(r=>!t || r.test===t);
  const map=new Map(); // q -> [wrong,total]
  rows.forEach(r=> r.items.forEach(it=>{
    const m=map.get(it.q)||[0,0]; m[1]++; if(!it.correct) m[0]++; map.set(it.q,m);
  }));
  const list=[...map.entries()].map(([q,[w,tot]])=>({q,w,tot,p:w/tot})).sort((a,b)=>b.p-a.p).slice(0,20);
  $('#repMissed').innerHTML = list.length? `
    <table class="table">
      <thead><tr><th>Question</th><th>Wrong</th><th>Total</th><th>% Missed</th></tr></thead>
      <tbody>${list.map(x=>`<tr><td>${esc(x.q)}</td><td>${x.w}</td><td>${x.tot}</td><td>${Math.round(x.p*100)}%</td></tr>`).join('')}</tbody>
    </table>` : `<div class="muted">No data yet.</div>`;
}

/* My results */
function renderMine(){
  const name = (getParams().get('name')||'').trim();
  const mine = name ? state.results.filter(r=>r.name.toLowerCase()===name.toLowerCase()) : state.results.slice(-50);
  $('#mineTable').innerHTML = mine.length? `
    <table class="table">
      <thead><tr><th>Date</th><th>Name</th><th>Test</th><th>Score</th><th></th></tr></thead>
      <tbody>${mine.map(r=>`
        <tr>
          <td>${esc(r.dateISO)}</td>
          <td>${esc(r.name)}</td>
          <td>${esc(r.title||r.test)}</td>
          <td>${r.score}/${r.total}</td>
          <td><button data-open="${r.id}">Open</button></td>
        </tr>`).join('')}</tbody>
    </table>` : `<div class="muted">No results yet.</div>`;
  $$(`#view-mine button[data-open]`).forEach(b=> b.onclick = ()=> openResultWindow(state.results.find(x=>x.id===b.dataset.open)));
}

function openResultWindow(r){
  const w=window.open('','_blank','width=760,height=900');
  const rows = r.items.map((it,i)=>`
    <div class="qcard">
      <div class="qtext">Q${i+1}: ${esc(it.q)}</div>
      <div class="opt ${it.correct?'correct':'incorrect'}">Your choice: ${esc(it.choice)}</div>
      <div class="opt correct">Correct: ${esc(it.answer)}</div>
    </div>`).join('');
  w.document.write(`
    <title>${esc(r.title||r.test)} — ${esc(r.name)}</title>
    <link rel="stylesheet" href="styles.css">
    <main class="view">
      <h2>${esc(r.title||r.test)}</h2>
      <div class="card">
        <div class="kv">
          <div class="muted">Name</div><div>${esc(r.name)}</div>
          <div class="muted">Location</div><div>${esc(r.location)}</div>
          <div class="muted">Date</div><div>${esc(r.dateISO)}</div>
          <div class="muted">Score</div><div><strong>${r.score}/${r.total}</strong></div>
        </div>
      </div>
      <section class="card">${rows}</section>
    </main>`);
  w.document.close();
}

/* ---------- Export CSV ---------- */
$('#btnExportCSV').addEventListener('click', ()=>{
  const fields=['dateISO','name','location','test','title','score','total'];
  const lines=[fields.join(',')];
  for(const r of state.results){
    lines.push(fields.map(f=>`"${String(r[f]??'').replace(/"/g,'""')}"`).join(','));
  }
  const blob=new Blob([lines.join('\n')],{type:'text/csv'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='results.csv'; a.click(); URL.revokeObjectURL(a.href);
});

/* ---------- Navigation ---------- */
function routeTo(view){
  setParams({view});
  activateView(view);
  if(view==='create') renderCreate();
  if(view==='build') renderBuild();
  if(view==='practice') renderPractice();
  if(view==='quiz') renderQuiz();
  if(view==='reports') renderReports();
  if(view==='mine') renderMine();
}
$$('.tab').forEach(b=> b.addEventListener('click', ()=> routeTo(b.dataset.route)));

/* ---------- Boot & Student restrictions ---------- */
function boot(){
  const sp=getParams();
  const mode=sp.get('mode')||'';
  const test=sp.get('test')||'';

  if(mode==='student'){
    $('#modeBadge').textContent='Student link';
    // Hide admin-only tabs
    $$('.tab').forEach(b=>{
      const ok=['practice','quiz','mine'].includes(b.dataset.route);
      b.style.display = ok? '' : 'none';
    });
  }else{
    $('#modeBadge').textContent='Admin';
  }

  // First render
  routeTo(sp.get('view') || (mode==='student'?'quiz':'create'));

  // Pre-select test for student link
  if(mode==='student' && test && state.tests[test]){
    fillSelect('#quizTest', [{value:test,label:test}], false);
    fillSelect('#practiceTest', [{value:test,label:test}], false);
  }

  // Default date
  const d=$('#studentDate'); if(d) d.value=todayISO();
}
boot();
