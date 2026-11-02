import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {TASKS, LESSONS} from './lessons.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const fmt = (x,n=3) => Number(x).toFixed(n);
const nf = x => Number(x).toLocaleString('en-US');
const json = x => `<pre>${esc(JSON.stringify(x,null,2))}</pre>`;
const note = s => `<div class="note">${s}</div>`;
const empty = s => `<div class="empty">${s}</div>`;
const color = {ink:'#253442',muted:'#667686',violet:'#625b9e',teal:'#328b91',word:'#a8c1cc',prompt:'#c4bedc',warm:'#bb8a64',paper:'#f9fbfd'};
const S = {task:'entities',example:0,step:0,tab:'what',view:'tower',query:0,focus:0,word:0,head:-1,slot:0,bioLabel:0,layer:0,overview:true,intro:true,busy:false,playing:false};
let INFO, EXAMPLES, DATA, STEPS=[], STATIC=false, manifest=null, documentData=null, uploadedFile=null, serial=0;
let timer=null, mapTimer=null;
document.body.classList.add('intro-mode');

async function fetchJSON(url,options={}) {
  const response=await fetch(url,options);
  let body;
  try{body=await response.json();}catch{throw new Error(`Could not read ${url}. Is the server running?`);}
  if(!response.ok)throw new Error(body.error||`Request failed (${response.status}).`);
  return body;
}
async function compressedJSON(path) {
  const response=await fetch(path);
  if(!response.ok)throw new Error('This recorded example is unavailable. Run bake.py to regenerate it.');
  const stream=response.body.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
function showError(message='') {$('#error').hidden=!message;$('#error').textContent=message;}
function busy(value) {
  S.busy=value;$('#busy').hidden=!value;
  $$('#tasks button,#examples button,#analyze-form input,#analyze-form textarea,#run,#document-page').forEach(el=>el.disabled=value||STATIC&&el.closest('#analyze-form')!==null);
  $('#download').disabled=value||!DATA;
}
function parseNames(value){return value.split(',').map(s=>s.trim()).filter(Boolean);}
function requestBody() {
  const fields=TASKS[S.task].fields;
  const body={text:$('#text').value,threshold:Number($('#threshold').value),multi_label:$('#multi-label').checked};
  if(fields.includes('entities'))body.entities=parseNames($('#entities').value);
  if(fields.includes('relations'))body.relations=parseNames($('#relations').value);
  if(fields.includes('classes')) {
    body.classes={};
    for(const group of $('#classes').value.split(';').filter(s=>s.trim())) {
      const colon=group.indexOf(':');
      if(colon<1)throw new Error('Write classification groups as “topic: science, sports”.');
      body.classes[group.slice(0,colon).trim()]=parseNames(group.slice(colon+1));
    }
  }
  if(fields.includes('structures')) {
    try{body.structures=JSON.parse($('#structures').value||'{}');}
    catch{throw new Error('The structure schema must be valid JSON. Start with one of the examples.');}
  }
  if(fields.includes('compare'))body.compare=$('#compare').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if(S.task==='document') {
    if(!documentData)throw new Error('Open a document or choose the invoice example first.');
    body.document=documentData;body.use_layout=$('#use-layout').checked;
  }
  return body;
}

function buildSteps() {
  const steps=['input'];
  if(DATA.document)steps.push('document');
  steps.push('tokens');
  if(DATA.spatial)steps.push('spatial');
  steps.push('embed');
  STEPS=steps.map(key=>({key,...LESSONS[key]}));
  for(let layer=1;layer<=INFO.layers;layer++)STEPS.push({key:'layer',layer,...LESSONS.layer,title:`Layer ${layer} of ${INFO.layers}`});
  if(S.task!=='embedding')STEPS.push(...['words','rnn'].filter(k=>k!=='rnn'||DATA.rnn).map(key=>({key,...LESSONS[key]})));
  const available=key=>!(['bio','entities'].includes(key)&&!DATA.stages.bio?.length)
    && !(key==='classification'&&!DATA.stages.classes?.length)
    && !(['fields','slots','membership','hierarchy'].includes(key)&&!DATA.stages.records?.length);
  STEPS.push(...TASKS[S.task].heads.filter(available).map(key=>({key,...LESSONS[key]})));
  STEPS.push({key:'result',...LESSONS.result});
}
function renderTasks() {
  $('#tasks').innerHTML=Object.entries(TASKS).map(([key,t])=>`<button data-task="${key}" class="${key===S.task?'on':''}" aria-pressed="${key===S.task}"><span class="task-dot"></span>${t.title}</button>`).join('');
  $('#landing-tasks').innerHTML=Object.entries(TASKS).filter(([k])=>k!=='all').map(([k,t])=>`<button data-start-task="${k}"><b>${t.title}</b><span>${t.short}</span></button>`).join('');
  $('#about-tasks').innerHTML=Object.entries(TASKS).filter(([k])=>k!=='all').map(([,t])=>`<div><b>${t.title}</b><span>${t.short}</span></div>`).join('');
}
function renderExamples() {
  $('#examples').innerHTML=EXAMPLES[S.task].map((e,i)=>`<button data-example="${i}" class="${i===S.example?'on':''}">${esc(e.name)}</button>`).join('');
  $$('#tasks button').forEach(b=>{b.classList.toggle('on',b.dataset.task===S.task);b.setAttribute('aria-pressed',String(b.dataset.task===S.task));});
  $$('.field').forEach(f=>f.hidden=!TASKS[S.task].fields.includes(f.dataset.field));
  $('#multi-label-control').hidden=!['classification','all'].includes(S.task);
  $('#text').readOnly=S.task==='document';
  $('#text-help').textContent=STATIC?'Recorded model run. Custom text and schemas are available with the local Python server.':S.task==='document'?'Text comes from this page. Words are aligned with their document boxes.':'Labels can change at inference time. Start with an example, then make it yours.';
}
function renderRail() {
  if(!STEPS.length)return;
  let last='',html='';
  for(let i=0;i<STEPS.length;i++) {
    const step=STEPS[i];
    if(step.key==='layer') {
      if(step.layer!==1)continue;
      html+=`<div class="rail-group">24 Transformer layers</div><div class="layer-grid">`;
      for(let l=1;l<=INFO.layers;l++)html+=`<button data-step="${i+l-1}" class="${S.step===i+l-1?'on':''}" title="Transformer layer ${l}" aria-label="Transformer layer ${l}">${l}</button>`;
      html+='</div>';last='Encoder';continue;
    }
    if(step.group!==last){last=step.group;html+=`<div class="rail-group">${esc(last)}</div>`;}
    html+=`<button data-step="${i}" class="${i===S.step&&!S.overview?'on':''}"><span class="step-num">${String(i+1).padStart(2,'0')}</span>${esc(step.title)}</button>`;
  }
  $('#rail').innerHTML=html;
}

async function chooseExample(index,run=true) {
  S.example=index;const e=EXAMPLES[S.task][index];
  $('#text').value=e.text||'';$('#entities').value=(e.entities||[]).join(', ');
  $('#classes').value=Object.entries(e.classes||{}).map(([k,v])=>`${k}: ${v.join(', ')}`).join('; ');
  $('#relations').value=(e.relations||[]).join(', ');$('#structures').value=JSON.stringify(e.structures||{});
  $('#compare').value=(e.compare||[]).join('\n');$('#threshold').value='0.5';$('#threshold-value').value='0.50';
  $('#multi-label').checked=false;$('#use-layout').checked=true;S.bioLabel=0;S.query=0;S.focus=0;S.word=0;S.slot=0;
  documentData=null;uploadedFile=null;
  if(S.task==='document') {
    documentData=STATIC?await compressedJSON('./static/document.json.gz'):await fetchJSON('/api/document/example');
    $('#text').value=documentData.text;renderDocumentMeta();
  }
  renderExamples();if(run)await runAnalysis();
}
async function chooseTask(task,start=false) {
  if(S.busy)return;
  if(start)startExploring();
  stop();S.task=task;S.step=0;S.layer=0;S.view='tower';S.overview=true;S.tab='what';
  showError();await chooseExample(0);
}
async function runAnalysis() {
  if(S.busy)return;
  const current=++serial,previousStage=selectedStage();showError();busy(true);stop();
  try {
    let out;
    if(STATIC) {
      const recorded=manifest.traces.find(t=>t.task===S.task&&t.index===S.example);
      if(!recorded)throw new Error('This example was not baked. Run the live server to explore it.');
      out=await compressedJSON('./static/'+recorded.file);
    } else {
      out=await fetchJSON('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(requestBody())});
    }
    if(current!==serial)return;
    DATA=out;buildSteps();S.step=Math.max(0,STEPS.findIndex(s=>s.key===previousStage.key&&(s.key!=='layer'||s.layer===previousStage.layer)));S.query=Math.max(0,DATA.queries.findIndex(q=>q.kind!=='schema'));S.focus=DATA.queries[S.query]?.token||0;S.head=-1;S.slot=DATA.stages.records?.[0]?.slot_order?.[0]||0;S.bioLabel=0;
    if(S.task==='document')documentData=DATA.document;
    buildTower();buildMap();renderRail();renderPanel();renderDocument();updateView();
    $('#timing').textContent=`${nf(DATA.tokens.length)} tokens · ${DATA.ms} ms inference · ${DATA.total_ms} ms trace`;
    $('#download').disabled=false;
    if(S.intro)introCamera();else if(S.overview)towerCamera();else focusStage();
  }catch(error){showError(error.message);}
  finally{if(current===serial)busy(false);}
}
function startExploring() {
  S.intro=false;$('#landing').hidden=true;document.body.classList.remove('intro-mode');
  requestAnimationFrame(()=>{resize();towerCamera();});
}

function selectedStage(){return STEPS[S.step]||{key:'input',...LESSONS.input};}
function layerIndex(){const st=selectedStage();return st.key==='layer'?st.layer:st.key==='embed'?0:INFO.layers;}
function selectedBio(){return DATA.stages.bio?.[0];}
function selectedRecord(){return DATA.stages.records?.[0];}
function wordAttention(layer){return DATA.queries[S.query]?.token===S.focus?(S.head<0?layer.query_attention?.[S.query]:layer.heads?.[S.head]?.[S.query]):DATA.words.map((_,wi)=>DATA.tokens.reduce((total,t,ti)=>total+(t.word===wi?(layer.attention[S.focus]?.[ti]||0):0),0));}
function queryControl() {
  if(!DATA.queries.length)return '';
  return `<label class="sub-label" for="query-select">Follow a schema question</label><select class="query-selector" id="query-select">${DATA.queries.map((q,i)=>`<option value="${i}" ${i===S.query?'selected':''}>${esc(q.kind+' · '+q.name)}</option>`).join('')}</select>`;
}
function wordControl(){return `<label class="sub-label" for="word-select">Inspect a source word</label><select class="query-selector" id="word-select">${DATA.words.map((w,i)=>`<option value="${i}" ${i===S.word?'selected':''}>${i} · ${esc(w.text)}</option>`).join('')}</select>`;}
function slotControl() {
  const rec=selectedRecord();if(!rec)return '';
  return `<label class="sub-label" for="slot-select">Inspect a record slot · sorted by objectness</label><select class="query-selector" id="slot-select">${rec.slot_order.map(id=>`<option value="${id}" ${id===S.slot?'selected':''}>Slot ${id} · objectness ${fmt(rec.objectness[id])}</option>`).join('')}</select>`;
}
function bioControl(labels) {return `<label class="sub-label" for="bio-select">Entity type / field</label><select class="query-selector" id="bio-select">${labels.map((name,i)=>`<option value="${i}" ${i===S.bioLabel?'selected':''}>${esc(name)}</option>`).join('')}</select>`;}
function bars(items,signed=false) {
  return `<div class="bars">${items.map(it=>`<div class="bar-row ${it.chosen?'chosen':''}"><span class="bar-name" title="${esc(it.name)}">${esc(it.name)}</span><span class="bar-track"><span class="bar-fill" style="width:${clamp((signed?(it.value+1)/2:it.value)*100,0,100)}%;${it.color?'background:'+it.color:''}"></span></span><span class="bar-value">${fmt(it.value)}</span></div>`).join('')}</div>`;
}
function strip(values) {
  return `<div class="heat-strip">${values.map((v,i)=>`<span title="Dimension ${i}: ${v}" style="background:${heat(v,true)}"></span>`).join('')}</div><div class="help">First ${values.length} of ${INFO.hidden} dimensions · hover a cell for its value</div>`;
}
function stats(items){return `<div class="stats">${items.map(([value,name])=>`<div class="stat"><b>${value}</b>${esc(name)}</div>`).join('')}</div>`;}
function matrix(rows,columns,values,signed=false) {
  return `<div class="matrix-wrap"><table class="matrix"><thead><tr><th></th>${columns.map(c=>`<th title="${esc(c)}">${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r,i)=>`<tr><th title="${esc(r)}">${esc(r)}</th>${columns.map((c,j)=>`<td style="background:${heat(values[i]?.[j]||0,signed)}" title="${esc(r+' → '+c)}: ${values[i]?.[j]}">${fmt(values[i]?.[j]||0,2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function entityResult() {
  const entities=DATA.result.ner?.[0]||[];
  if(!entities.length)return empty('No entities passed the current threshold. Inspect the word scores or try another threshold.');
  const sorted=[...entities].sort((a,b)=>a.start-b.start),text=DATA.input.text;
  let end=0,html='';
  for(const e of sorted){if(e.start<end)continue;html+=esc(text.slice(end,e.start))+`<span class="mention">${esc(text.slice(e.start,e.end))}<small>${esc(e.label)}</small></span>`;end=e.end;}
  html+=esc(text.slice(end));
  return `<div class="sentence">${html}</div><div class="entity-list">${sorted.map(e=>`<div class="entity-item"><b>${esc(e.text)}</b><span>${esc(e.label)} · [${e.start}, ${e.end})</span><strong>${fmt(e.score)}</strong></div>`).join('')}</div>`;
}
function relationCards(pairs,limit=20) {
  if(!pairs.length)return empty('No directed pairs are available at this threshold. The head needs at least two detected entities.');
  return pairs.slice(0,limit).map(p=>`<div class="relation-card"><b>${esc(p.head.text)}</b><span class="arrow">${esc(p.relation)} →<small>${fmt(p.score)} ${p.score>DATA.input.threshold?'✓':''}</small></span><b>${esc(p.tail.text)}</b></div>`).join('')+(pairs.length>limit?note(`Showing ${limit} of ${pairs.length} candidates. Download the full trace to inspect all pairs.`):'');
}

function dataContent(key) {
  const n=DATA.tokens.length,w=DATA.words.length,L=DATA.layers[layerIndex()],q=DATA.queries[S.query],rec=selectedRecord();
  switch(key) {
    case 'input':return `<p class="sentence">${esc(DATA.input.text)}</p>${stats([[n,'subword tokens'],[w,'word units'],[DATA.queries.length,'schema markers']])}<h3>Your questions</h3>${json({entities:DATA.input.entities,classes:DATA.input.classes,relations:DATA.input.relations,structures:DATA.input.structures})}`;
    case 'document':return `${note(`${esc(DATA.document.source)}. ${DATA.provenance.layout_used?'The model used these 2D boxes.':'Word positions were disabled for this run.'}`)}${wordControl()}${boxInfo()}<p>Switch to the Document view and click any box. A split word may have several model units sharing the same source box.</p>`;
    case 'tokens':return `<p>The exact prompt and source pieces, in the order read by the encoder.</p><div class="token-cloud">${DATA.tokens.map((t,i)=>`<button class="token ${t.kind} ${i===S.focus?'selected':''}" data-token="${i}" title="Token ${i} · ID ${t.id}">${esc(t.piece)}</button>`).join('')}</div><h3>Selected piece</h3>${tokenInfo()}`;
    case 'spatial':return `${wordControl()}${boxInfo()}<h3>Spatial contribution</h3>${strip(DATA.spatial.strip[DATA.words[S.word].token]||DATA.spatial.strip[tokenForWord(S.word)])}${note('This is the spatial embedding before it is added to the word vector and normalized. It is not a pixel feature.')}`;
    case 'embed':return `${tokenChoices()}${tokenInfo()}${strip(DATA.layers[0].strip[S.focus])}`;
    case 'layer': {
      const followsQuery=q?.token===S.focus;
      const attention=wordAttention(L);
      return `${queryControl()}${followsQuery?`<label class="sub-label" for="head-select">Attention head</label><select class="query-selector" id="head-select"><option value="-1" ${S.head<0?'selected':''}>Average of all ${INFO.heads} heads</option>${Array.from({length:INFO.heads},(_,i)=>`<option value="${i}" ${S.head===i?'selected':''}>Head ${i+1}</option>`).join('')}</select>`:''}<h3>Where “${esc(followsQuery?q.name:DATA.tokens[S.focus].piece)}” looks</h3>${bars(DATA.words.map((word,i)=>({name:word.text,value:attention?.[i]||0})))}${!followsQuery?note('Following the selected piece. Values are the mean across all heads. Select a schema question above to inspect individual heads.'):''}<h3>Attention between all pieces</h3>${smallAttention(L)}<h3>Selected piece after this layer</h3>${strip(L.strip[S.focus])}`;
    }
    case 'words':return `${wordControl()}<p>The selected word starts at subword token <b>${tokenForWord(S.word)}</b>.</p><h3>After the Transformer</h3>${strip(DATA.layers.at(-1).strip[tokenForWord(S.word)])}`;
    case 'rnn':return `${wordControl()}<h3>Before the word LSTM</h3>${strip(DATA.rnn.before[S.word])}<h3>After the word LSTM</h3>${strip(DATA.rnn.after[S.word])}`;
    case 'anchors':return `${queryControl()}${Object.entries(DATA.stages.anchors||{}).map(([name,a])=>`<h3>${esc(name)} · fused question vectors</h3><code>${esc(a.shape.join(' × '))}</code>${a.strip.length?strip(a.strip[0]):''}`).join('')}${note('The strips above show the first fused anchor–label vector captured in each head. Shared NER calls can also supply structure-field questions.')}`;
    case 'bio': {
      const bio=selectedBio();if(!bio)return empty('This run has no standalone entity BIO scores.');
      const i=clamp(S.bioLabel,0,bio.labels.length-1);
      return `${bioControl(bio.labels)}${matrix(DATA.words.map(w=>w.text),['start','end','inside'],bio.probs.map(row=>row[i]))}<p>The same word can be a plausible boundary for one type and implausible for another.</p>`;
    }
    case 'entities':return entityResult();
    case 'classification':return (DATA.stages.classes||[]).map(group=>`<h3>${esc(group.group)}</h3>${bars(group.labels.map((name,i)=>({name,value:group.probs[i],chosen:group.probs[i]>DATA.input.threshold&&(DATA.input.multi_label||group.probs[i]===Math.max(...group.probs))})))}<div class="help">Sigmoid scores. Threshold ${fmt(DATA.input.threshold,2)}. ${DATA.input.multi_label?'Multiple labels allowed.':'Highest label only.'}</div>`).join('');
    case 'pairs':return `${stats([[(DATA.result.ner?.[0]||[]).length,'detected entities'],[new Set((DATA.stages.pairs||[]).map(p=>`${p.head.start}:${p.tail.start}`)).size,'directed pairs'],[DATA.input.relations.length,'relation types']])}${relationCards(DATA.stages.pairs||[])}`;
    case 'relations':return `<h3>Candidate scores</h3>${relationCards(DATA.stages.pairs||[])}<h3>Framework result</h3>${json(DATA.result.joint_relex?.[0]||[])}`;
    case 'fields':return !rec?empty('No structuring head in this run.'):`<h3>${esc(rec.name)} · candidate spans</h3>${matrix(rec.spans.map(s=>s.text),rec.fields,rec.field_probs)}${note('Field evidence and record membership are different scores. A span can have strong field evidence before the model assigns its record.')}${rec.field_bio?`<h3>Word-level field extraction</h3>${bioControl(rec.fields)}${matrix(DATA.words.map(w=>w.text),['start','end','inside'],rec.field_bio.map(row=>row[clamp(S.bioLabel,0,rec.fields.length-1)]))}`:''}`;
    case 'slots':return !rec?'':`${stats([[rec.objectness.length,'possible slots'],[rec.objectness.filter(x=>x>DATA.input.threshold).length,'above threshold'],[rec.spans.length,'candidate spans']])}${slotControl()}${bars(rec.slot_order.slice(0,20).map(i=>({name:`Slot ${i}`,value:rec.objectness[i],chosen:i===S.slot})))}${note('The strongest 20 objectness scores are listed here. The selector and trace include every slot.')}`;
    case 'membership':return !rec?'':`${slotControl()}<p>Slot <b>${S.slot}</b> · objectness <b>${fmt(rec.objectness[S.slot])}</b></p>${bars(rec.spans.map((span,i)=>({name:span.text,value:rec.memberships[S.slot]?.[i]||0,chosen:(rec.memberships[S.slot]?.[i]||0)>DATA.input.threshold})))}<h3>Field evidence for these spans</h3>${matrix(rec.spans.map(s=>s.text),rec.fields,rec.field_probs)}`;
    case 'hierarchy': {
      if(!rec)return '';
      const ids=rec.slot_order.filter(i=>rec.objectness[i]>.05).slice(0,12);
      return `<h3>Predicted structured records</h3>${json(DATA.result.structuring?.[0]||{})}<h3>Anchor connections</h3>${rec.anchor_relations&&ids.length?matrix(ids.map(i=>'slot '+i),ids.map(i=>'slot '+i),ids.map(i=>ids.map(j=>rec.anchor_relations[i][j]))):empty('No active anchor connections to display.')}<h3>Decoder hierarchy diagnostics</h3>${json(DATA.result.structuring_anchor_diagnostics?.[0]||{})}`;
    }
    case 'embedding': {
      const e=DATA.embeddings;if(!e)return empty('Choose the Embeddings task to compare prompt-free sentence vectors.');
      return `<p class="sentence">${esc(e.texts[0])}</p>${bars(e.texts.slice(1).map((t,i)=>({name:t,value:e.similarities[0][i+1]})),true)}${note('Bar positions map cosine −1…1 to the available width. The numbers are full-vector cosine similarities, not probabilities.')}<h3>All pairwise similarities</h3>${matrix(e.texts.map((_,i)=>'Text '+(i+1)),e.texts.map((_,i)=>'Text '+(i+1)),e.similarities,true)}<h3>First sentence vector</h3>${strip(e.vectors[0].slice(0,32))}`;
    }
    case 'result':return `${DATA.result.ner?entityResult():''}${DATA.result.structuring?`<h3>Structured records</h3>${json(DATA.result.structuring[0])}`:''}${DATA.embeddings?dataContent('embedding'):''}<h3>Raw framework output</h3>${json(DATA.result)}<h3>Trace provenance</h3>${json(DATA.provenance)}`;
    default:return '';
  }
}
function tokenForWord(word){return DATA.tokens.findIndex(t=>t.word===word);}
function tokenChoices(){return `<div class="token-cloud">${DATA.tokens.map((t,i)=>`<button class="token ${t.kind} ${i===S.focus?'selected':''}" data-token="${i}">${esc(t.piece)}</button>`).join('')}</div>`;}
function tokenInfo(){const t=DATA.tokens[S.focus];return `<dl class="tech"><dt>Piece</dt><dd><code>${esc(t.piece)}</code></dd><dt>Vocabulary ID</dt><dd>${t.id}</dd><dt>Sequence index</dt><dd>${S.focus}</dd><dt>Role</dt><dd>${esc(t.kind)}</dd><dt>Source word</dt><dd>${t.word===null?'Prompt / special token':esc(DATA.words[t.word]?.text)}</dd></dl>`;}
function boxInfo(){const w=DATA.words[S.word];return `<dl class="tech"><dt>Word</dt><dd>${esc(w.text)}</dd><dt>Characters</dt><dd>[${w.start}, ${w.end})</dd><dt>Box</dt><dd>${w.bbox?esc('['+w.bbox.join(', ')+']'):'No document box'}</dd></dl>`;}
function smallAttention(layer) {
  const ids=[...new Set([S.focus,...DATA.tokens.map((t,i)=>({i,v:layer.attention?.[S.focus]?.[i]||0})).sort((a,b)=>b.v-a.v).slice(0,11).map(x=>x.i)])].sort((a,b)=>a-b);
  return matrix(ids.map(i=>DATA.tokens[i].piece),ids.map(i=>DATA.tokens[i].piece),ids.map(i=>ids.map(j=>layer.attention?.[i]?.[j]||0)))+`<span class="help">Selected piece and up to 11 strongest destinations. Mean of all heads.</span>`;
}
function renderPanel() {
  if(!DATA)return;
  const st=selectedStage();
  $('#stage-number').textContent=S.overview?'THE WALKTHROUGH':`${st.group.toUpperCase()} · STAGE ${S.step+1}`;
  $('#stage-title').textContent=S.overview?'One model, step by step.':st.title;
  $('#stage-subtitle').textContent=S.overview?TASKS[S.task].short:st.short;
  $$('#panel-tabs button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===S.tab)));
  let html;
  if(S.overview) {
    html=`<p>This is <b>GLiFormer Large v1</b> by Knowledgator. Follow your input through its shared encoder, then into the ${esc(TASKS[S.task].title.toLowerCase())} head.</p><p>Pick a plate in the tower or a stage in the list. Use the three tabs to move from the plain-language idea to the real values and the source code.</p>${stats([[INFO.layers,'Transformer layers'],[nf(INFO.hidden),'dimensions'],[(INFO.params/1e6).toFixed(1)+'M','parameters']])}<div class="mini-nav"><button data-jump="input">Start at the input →</button><button data-jump="result">See the answers →</button></div>${note(DATA.document?'This run follows a page through text extraction and 2D layout. Click Document to see the boxes.':'Every attention weight, vector strip and task score comes from this sentence’s real forward pass.')}<h3>This run</h3><p class="sentence">${esc(DATA.input.text)}</p>`;
  } else if(S.tab==='what')html=st.what;
  else if(S.tab==='data')html=dataContent(st.key);
  else html=st.tech+`<dl class="tech"><dt>Checkpoint</dt><dd>${esc(INFO.name)}@${INFO.revision?.slice(0,8)||'local'}</dd><dt>Framework</dt><dd>GLiFormer ${esc(INFO.versions.gliformer)}</dd><dt>Device</dt><dd>${esc(INFO.device)}</dd></dl><p><a href="${INFO.sources[st.source]||INFO.sources.encoder}" target="_blank" rel="noopener">Read the exact source revision ↗</a></p>`;
  $('#panel-content').innerHTML=html;
  $('#step-count').textContent=`${S.step+1} / ${STEPS.length}`;
  $('#prev').disabled=S.step===0;$('#next').disabled=S.step===STEPS.length-1;
}

// The scene draws captured values. A neutral architectural tower is used until the first trace arrives.
const canvas=$('#scene');
let renderer,scene,camera,controls;
const tower=new THREE.Group(),map=new THREE.Group(),arcs=new THREE.Group(),labels=new THREE.Group();
let plates=[],mapPoints=[],raycaster=new THREE.Raycaster(),pointer=new THREE.Vector2(),anim=null;
const boxGeo=new THREE.BoxGeometry(1,1,1),lineMaterial=new THREE.LineBasicMaterial({color:color.violet,transparent:true,opacity:.6});
const materials=new Map(),textCache=new Map();
function material(c,opacity=1){const k=c+':'+opacity;if(!materials.has(k))materials.set(k,new THREE.MeshStandardMaterial({color:c,roughness:.85,transparent:opacity<1,opacity}));return materials.get(k);}
function heat(value,signed=false){const a=new THREE.Color('#f2f5f9');return '#'+a.lerp(new THREE.Color(signed&&value<0?color.warm:color.violet),clamp(Math.abs(value)*(signed?.28:1),0,1)).getHexString();}
function disposeGroup(group){while(group.children.length){const obj=group.children.pop();obj.parent=null;obj.traverse(o=>{if(o.geometry&&o.geometry!==boxGeo)o.geometry.dispose();if(o.isInstancedMesh)o.dispose();});}}
function textSprite(text,size=.24,c=color.muted) {
  const key=text+':'+c;
  if(!textCache.has(key)) {
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font='500 36px sans-serif';
    canvas.width=Math.ceil(ctx.measureText(text).width)+16;canvas.height=54;ctx.font='500 36px sans-serif';ctx.fillStyle=c;ctx.textBaseline='middle';ctx.fillText(text,8,27);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    textCache.set(key,{material:new THREE.SpriteMaterial({map:texture,transparent:true,depthTest:false}),ratio:canvas.width/canvas.height});
  }
  const item=textCache.get(key),sprite=new THREE.Sprite(item.material);sprite.scale.set(size*item.ratio,size,1);sprite.renderOrder=5;return sprite;
}
function clearTextCache(){textCache.forEach(v=>{v.material.map.dispose();v.material.dispose();});textCache.clear();}
function initScene() {
  try{renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});}
  catch{$('#scene-hint').textContent='3D needs WebGL. All stage explanations and model data are available in the panel.';return;}
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor('#edf2f6');
  scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(35,1,.1,400);camera.position.set(21,18,35);
  controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.dampingFactor=.08;controls.maxDistance=150;controls.minDistance=3;
  scene.add(new THREE.HemisphereLight('#ffffff','#bac8d9',2.1));const sun=new THREE.DirectionalLight('#ffffff',2.4);sun.position.set(5,20,15);scene.add(sun);
  scene.add(tower,map,arcs,labels);map.visible=false;
  resize();requestAnimationFrame(frame);
}
function stageItems(st) {
  if(!DATA)return Array.from({length:14},(_,i)=>({name:'',value:.2,color:i<4?color.prompt:color.word}));
  let rows=[];const rec=selectedRecord(),l=st.key==='layer'?st.layer:st.key==='embed'?0:INFO.layers;
  if(['input','tokens','embed','layer'].includes(st.key)) {
    const source=st.key==='layer'?DATA.layers[l].attention?.[S.focus]:null;
    const oneHead=st.key==='layer'&&S.head>=0&&DATA.queries[S.query]?.token===S.focus?DATA.layers[l].heads[S.head]?.[S.query]:null;
    rows=DATA.tokens.map((t,i)=>({name:t.piece,token:i,word:t.word,
      value:oneHead?(t.word!==null&&tokenForWord(t.word)===i?oneHead[t.word]:0):source?source[i]:DATA.layers[l].strip[i]?.[0]||0,
      heightScale:source?7:.18,caption:oneHead?'Attention to the whole source word':source?'Mean attention':'Hidden dimension 0',
      color:t.word!==null?color.word:color.prompt}));
  }else if(st.key==='spatial'||st.key==='document') {
    rows=DATA.words.map((w,i)=>({name:w.text,word:i,value:st.key==='spatial'?Math.sqrt((DATA.spatial?.strip[tokenForWord(i)]||[]).reduce((s,v)=>s+v*v,0)):0,heightScale:.12,color:color.teal,bbox:w.bbox,caption:'Spatial-vector norm over the first 32 dimensions'}));
  }else if(st.key==='bio') {
    const b=selectedBio(),q=clamp(S.bioLabel,0,(b?.labels.length||1)-1);
    for(let ch=0;ch<3;ch++)DATA.words.forEach((w,i)=>rows.push({name:w.text,word:i,value:b?.probs[i]?.[q]?.[ch]||0,color:[color.violet,color.teal,color.warm][ch],lane:ch}));
  }else if(st.key==='classification') {
    rows=(DATA.stages.classes||[]).flatMap(g=>g.labels.map((name,i)=>({name,value:g.probs[i],color:color.violet})));
  }else if(st.key==='slots') {
    rows=rec?rec.objectness.map((p,i)=>({name:'Slot '+i,value:p,color:i===S.slot?color.teal:color.violet,slot:i})):[];
  }else if(st.key==='membership') {
    rows=rec?rec.spans.map((s,i)=>({name:s.text,value:rec.memberships[S.slot]?.[i]||0,color:color.teal,span:s})):[];
  }else if(st.key==='fields') {
    rows=rec?rec.spans.map((s,i)=>({name:s.text,value:Math.max(...rec.field_probs[i]),color:color.teal,span:s})):[];
  }else if(st.key==='pairs') {
    rows=(DATA.stages.pairs||[]).slice(0,40).map(p=>({name:p.head.text+' → '+p.tail.text,value:p.score,color:p.score>DATA.input.threshold?color.teal:color.prompt,pair:p}));
  }else if(st.key==='relations') {
    const entities=DATA.result.ner?.[0]||[];
    rows=DATA.words.map((w,i)=>{const entity=entities.find(e=>e.start<=w.start&&e.end>=w.end);return {name:w.text,word:i,value:entity?.score||0,color:entity?color.teal:color.word};});
  }else if(st.key==='anchors') {
    rows=DATA.queries.map(q=>({name:q.name,value:DATA.layers.at(-1).strip[q.token][0],heightScale:.18,caption:'Contextualized question · dimension 0',color:q.kind==='schema'?color.warm:color.violet,token:q.token}));
  }else if(st.key==='hierarchy') {
    rows=rec?rec.slot_order.filter(i=>rec.objectness[i]>.05).slice(0,30).map(i=>({name:'Slot '+i,value:rec.objectness[i],color:color.violet,slot:i})):[];
  }else if(st.key==='embedding') {
    rows=DATA.embeddings?DATA.embeddings.texts.map((t,i)=>({name:i?'Text '+(i+1):'Your sentence',value:DATA.embeddings.similarities[0][i],caption:'Cosine similarity',color:DATA.embeddings.similarities[0][i]<0?color.warm:i?color.violet:color.teal})):[];
  }else {
    const entities=DATA.result.ner?.[0]||[];
    rows=DATA.words.map((w,i)=>{const e=entities.find(e=>e.start<=w.start&&e.end>=w.end);return {name:w.text,word:i,value:st.key==='entities'?(e?.score||0):st.key==='words'?DATA.layers.at(-1).strip[tokenForWord(i)][0]:DATA.word_vectors[i]?.[0]||0,heightScale:st.key==='entities'?1:.18,caption:st.key==='entities'?'Entity score':'Word vector · dimension 0',color:e?color.teal:color.word};});
  }
  return rows;
}
const dummy=new THREE.Object3D(),instanceColor=new THREE.Color();
const tileHeight=it=>.055+clamp(Math.abs(it.value)*(it.heightScale??1),0,1)*.65;
function createPlate(st,index,y) {
  const group=new THREE.Group();group.position.y=y;group.userData={stage:index};
  const items=stageItems(st),cols=st.key==='bio'?Math.min(DATA?.words.length||10,16):Math.min(16,Math.max(4,Math.ceil(Math.sqrt(Math.max(items.length,1)*3))));
  const rowCount=Math.ceil(Math.max(items.length,1)/cols),isPage=['spatial','document'].includes(st.key)&&DATA?.document,
    depth=isPage?6.4:Math.max(2.1,rowCount*.47+.85),width=12;
  const base=new THREE.Mesh(boxGeo,material('#dce5ef',.88));base.scale.set(width,.065,depth);base.userData={stage:index,base:true};group.add(base);
  const mesh=new THREE.InstancedMesh(boxGeo,new THREE.MeshStandardMaterial({roughness:.8}),items.length||1);mesh.userData={stage:index,items};
  const points=[],widths=[],depths=[];
  items.forEach((it,i)=>{
    const b=it.bbox,x=isPage&&b?((b[0]+b[2])/2-500)/90:(i%cols-(cols-1)/2)*(10.9/cols),z=isPage&&b?((b[1]+b[3])/2-500)/170:(Math.floor(i/cols)-(rowCount-1)/2)*.47;
    const h=tileHeight(it),tw=isPage&&b?Math.max(.08,(b[2]-b[0])/95):10.9/cols*.75,td=isPage&&b?Math.max(.06,(b[3]-b[1])/180):.3;
    widths.push(tw);depths.push(td);
    dummy.position.set(x,h/2+.05,z);dummy.scale.set(tw,h,td);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);
    instanceColor.set(it.color);mesh.setColorAt(i,instanceColor);points.push(new THREE.Vector3(x,h+.08,z));
  });
  mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;group.add(mesh);
  const title=textSprite(st.key==='layer'?String(st.layer).padStart(2,'0'):st.title,.22,st.key==='layer'?color.muted:color.ink);title.position.set(-7.5,.12,0);group.add(title);
  tower.add(group);return {group,base,mesh,items,points,widths,depths,depth,y,st};
}
function buildTower() {
  if(!renderer)return;disposeGroup(tower);disposeGroup(arcs);disposeGroup(labels);plates=[];
  // Clear textures after detached plate sprites are gone, then rebuild their labels.
  clearTextCache();
  let y=0;
  const stages=DATA?STEPS:[{key:'input',title:'Your text'},{key:'tokens',title:'Tokenizer'},{key:'embed',title:'Embeddings'},...Array.from({length:24},(_,i)=>({key:'layer',layer:i+1,title:'Transformer'})),{key:'result',title:'Answers'}];
  stages.forEach((st,i)=>{plates.push(createPlate(st,i,y));y+=st.key==='layer'?.55:1.05;});
  tower.userData.height=y;refreshFocus();
}
function updatePlate(index) {
  if(!renderer||!plates[index])return;
  const plate=plates[index],items=stageItems(plate.st);
  items.forEach((it,i)=>{
    const point=plate.points[i];if(!point)return;
    const h=tileHeight(it);
    dummy.position.set(point.x,h/2+.05,point.z);dummy.scale.set(plate.widths[i],h,plate.depths[i]);dummy.updateMatrix();plate.mesh.setMatrixAt(i,dummy.matrix);
    plate.mesh.setColorAt(i,instanceColor.set(it.color));point.y=h+.08;
  });
  plate.items=items;plate.mesh.userData.items=items;plate.mesh.instanceMatrix.needsUpdate=true;plate.mesh.instanceColor.needsUpdate=true;
}
function refreshFocus() {
  if(!renderer)return;
  disposeGroup(arcs);disposeGroup(labels);
  const index=S.step,plate=plates[index];
  plates.forEach((p,i)=>{const focus=!S.overview&&!S.intro&&S.view==='tower';p.group.visible=!focus||Math.abs(i-index)<3;p.base.material=material(i===index&&!S.overview?'#e4e1f1':'#dce5ef',.88);});
  if(!DATA||S.overview||S.intro||!plate||S.view!=='tower')return;
  updatePlate(index);
  plate.items.forEach((item,i)=>{
    if(plate.items.length>75&&i%3)return;
    const label=textSprite(item.name.length>20?item.name.slice(0,19)+'…':item.name,.17,item.token===S.focus||item.word===S.word?color.violet:color.ink);
    label.position.copy(plate.points[i]).add(new THREE.Vector3(0,plate.y+.24,0));labels.add(label);
  });
  if(plate.st.key==='layer') {
    const att=plate.items.map(it=>it.value);
    const from=plate.points[S.focus];
    if(from)att.map((v,i)=>({v,i})).filter(o=>o.i!==S.focus&&o.v>0).sort((a,b)=>b.v-a.v).slice(0,9).forEach(({v,i})=>{
      const to=plate.points[i];if(!to)return;
      const a=from.clone().add(new THREE.Vector3(0,plate.y,0)),b=to.clone().add(new THREE.Vector3(0,plate.y,0));
      const mid=a.clone().add(b).multiplyScalar(.5);mid.y+=.5+Math.sqrt(v)*3;
      const curve=new THREE.QuadraticBezierCurve3(a,mid,b);
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(25)),lineMaterial);arcs.add(line);
    });
  }
  if(plate.st.key==='relations') {
    (DATA.stages.pairs||[]).filter(p=>p.score>DATA.input.threshold).slice(0,10).forEach((pair,i)=>{
      const from=plate.points[pair.head.s],to=plate.points[pair.tail.s];if(!from||!to)return;
      const a=from.clone().add(new THREE.Vector3(0,plate.y,0)),b=to.clone().add(new THREE.Vector3(0,plate.y,0));
      const mid=a.clone().add(b).multiplyScalar(.5);mid.y+=1.1+i*.22;
      const curve=new THREE.QuadraticBezierCurve3(a,mid,b);
      arcs.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(35)),lineMaterial));
      const label=textSprite(pair.relation+' · '+fmt(pair.score),.19,color.violet);label.position.copy(curve.getPoint(.5));labels.add(label);
      const cone=new THREE.Mesh(new THREE.ConeGeometry(.08,.22,8),material(color.violet));cone.position.copy(b);cone.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),curve.getTangent(.99).normalize());arcs.add(cone);
    });
  }
  if(plate.st.key==='hierarchy') {
    const rec=selectedRecord(),connections=[];
    if(rec?.anchor_relations)plate.items.forEach((a,i)=>plate.items.forEach((b,j)=>{const score=rec.anchor_relations[a.slot][b.slot];if(i!==j&&score>DATA.input.threshold)connections.push({i,j,score});}));
    connections.sort((a,b)=>b.score-a.score).slice(0,10).forEach(({i,j,score},rank)=>{
      const a=plate.points[i].clone().add(new THREE.Vector3(0,plate.y,0)),b=plate.points[j].clone().add(new THREE.Vector3(0,plate.y,0)),mid=a.clone().add(b).multiplyScalar(.5);mid.y+=.8+rank*.15;
      const curve=new THREE.QuadraticBezierCurve3(a,mid,b);arcs.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(25)),lineMaterial));
      const label=textSprite(fmt(score),.16,color.violet);label.position.copy(curve.getPoint(.5));labels.add(label);
    });
  }
}
function buildMap() {
  if(!renderer||!DATA)return;disposeGroup(map);mapPoints=[];
  const geo=new THREE.SphereGeometry(.095,12,8);
  DATA.tokens.forEach((t,i)=>{
    const dot=new THREE.Mesh(geo,material(t.word!==null?color.teal:color.violet));dot.userData={token:i,map:true};map.add(dot);mapPoints.push(dot);
    const label=textSprite(t.piece,.19,t.word!==null?color.ink:color.violet);label.userData={label:i};map.add(label);
  });
  updateMap(true);
}
function updateMap(immediate=false) {
  if(!renderer||!DATA)return;
  const l=DATA.layers[S.layer];
  mapPoints.forEach((point,i)=>{
    const target=new THREE.Vector3(...l.pos[i]).multiplyScalar(3.1);point.userData.target=target;
    if(immediate)point.position.copy(target);
    const scale=i===S.focus?1.7:1;point.scale.setScalar(scale);
  });
  $('#map-layer').value=S.layer;$('#map-value').textContent=S.layer;
}
function resize() {
  if(!renderer)return;const r=$('#viewport').getBoundingClientRect();if(!r.width||!r.height)return;
  renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();
}
function fly(position,target,duration=700) {
  if(!renderer)return;if(matchMedia('(prefers-reduced-motion: reduce)').matches)duration=0;
  anim={position:camera.position.clone(),target:controls.target.clone(),to:position,at:target,start:performance.now(),duration};
}
function towerCamera(){if(!renderer)return;const h=tower.userData.height||24;fly(new THREE.Vector3(22,h*.75,Math.max(30,h*1.45)),new THREE.Vector3(0,h*.48,0));}
function introCamera(){if(!renderer)return;const h=tower.userData.height||24;fly(new THREE.Vector3(25,h*.8,42),new THREE.Vector3(0,h*.47,0));}
function focusStage(){if(!renderer||!plates[S.step])return;const p=plates[S.step];fly(new THREE.Vector3(5,p.y+9,Math.max(13,p.depth*1.5)),new THREE.Vector3(0,p.y,0));}
function selectStep(index) {
  if(!DATA)return;S.step=clamp(index,0,STEPS.length-1);S.overview=false;
  const st=selectedStage();if(st.key==='layer')S.layer=st.layer;else if(st.key==='embed')S.layer=0;
  renderRail();renderPanel();updateView();refreshFocus();
  if(S.view==='tower')focusStage();if(S.view==='map')updateMap();
  $('#rail .on')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function setView(view) {
  if(view==='document'&&!DATA?.document)return;S.view=view;updateView();
  if(view==='map'){updateMap(true);fly(new THREE.Vector3(12,8,18),new THREE.Vector3(0,0,0));}
  else if(view==='tower'){if(S.overview)towerCamera();else focusStage();}
}
function updateView() {
  if(!DATA)return;
  const doc=S.view==='document',mp=S.view==='map';
  $('#doc-view').hidden=!doc;$('#scene').style.visibility=doc?'hidden':'visible';
  $('#map-control').hidden=!mp;$('#view-switch [data-view="document"]').hidden=!DATA.document;
  $$('#view-switch button').forEach(b=>b.classList.toggle('on',b.dataset.view===S.view));
  $('#scene-title').textContent=doc?'A page, one word at a time.':mp?`Meaning map · layer ${S.layer}`:S.overview?'One encoder. Many ways to read.':selectedStage().title;
  $('#scene-subtitle').textContent=doc?(DATA.provenance.layout_used?'Words + 2D positions entered the model.':'Word positions were disabled for this run.'):mp?'3D PCA projection · the comparison scores use the full vectors.':S.overview?'Every number is captured from the real model.':selectedStage().short;
  if(doc&&selectedStage().key==='layer')$('#scene-subtitle').textContent=`Layer ${selectedStage().layer} · ${DATA.queries[S.query]?.token===S.focus?DATA.queries[S.query].name:DATA.tokens[S.focus].piece} attention over page words${DATA.provenance.layout_used?'':' · positions disabled'}`;
  $('#scene-tools').hidden=doc;$('#scene-hint').textContent=doc?'Click a box to follow that source word.':'Drag to orbit · Scroll to zoom · Click a piece to inspect';
  if(renderer){tower.visible=!mp&&!doc;map.visible=mp;arcs.visible=!mp&&!doc;labels.visible=!mp&&!doc;refreshFocus();}
  if(doc)renderDocument();
}
function renderDocumentMeta() {
  if(!documentData)return;$('#document-name').textContent=`${documentData.name} · ${documentData.words.length} words · ${documentData.source}`;
  $('#page-control').hidden=documentData.pages<=1;
  $('#document-page').innerHTML=Array.from({length:documentData.pages},(_,i)=>`<option value="${i}" ${i===documentData.page?'selected':''}>${i+1}</option>`).join('');
}
function renderDocument() {
  if(!DATA.document)return;$('#doc-image').src=DATA.document.image;
  const entities=DATA.result.ner?.[0]||[];
  const stage=selectedStage(),layer=stage.key==='layer'?DATA.layers[stage.layer]:null,
    attention=layer?wordAttention(layer):null;
  const peak=attention?Math.max(.001,...attention):1;
  $('#doc-boxes').innerHTML=DATA.words.map((w,i)=>{const b=w.bbox||[0,0,0,0],e=entities.find(e=>e.start<=w.start&&e.end>=w.end);return `<rect x="${b[0]}" y="${b[1]}" width="${Math.max(1,b[2]-b[0])}" height="${Math.max(1,b[3]-b[1])}" data-word="${i}" class="${i===S.word?'selected ':''}${e?'entity-box':''}" ${attention?`style="fill:rgba(98,91,158,${.04+.5*(attention[i]||0)/peak})"`:''}><title>${esc(w.text)} · [${b.join(', ')}]${e?' · '+esc(e.label):''}${attention?' · attention '+fmt(attention[i]||0,4):''}</title></rect>`;}).join('');
}
function stop(){S.playing=false;clearInterval(timer);timer=null;$('#play').textContent='▶ Play stages';}
function play(){if(S.playing){stop();return;}S.playing=true;$('#play').textContent='Ⅱ Pause';if(S.step===STEPS.length-1)selectStep(0);timer=setInterval(()=>{if(S.step>=STEPS.length-1){stop();return;}selectStep(S.step+1);},1600);}
function pickAt(event,click=false) {
  if(!renderer||S.view==='document'||S.intro)return;
  const r=canvas.getBoundingClientRect();pointer.set((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1);raycaster.setFromCamera(pointer,camera);
  const hit=raycaster.intersectObjects(S.view==='map'?map.children:tower.children,true).find(h=>h.object.userData.stage!==undefined||h.object.userData.token!==undefined);
  if(!hit){$('#tooltip').hidden=true;canvas.style.cursor='grab';return;}
  canvas.style.cursor='pointer';const info=hit.object.userData;
  const item=hit.instanceId!==undefined?info.items?.[hit.instanceId]:null;
  const ti=item?.token??info.token;
  if(click) {
    if(info.stage!==undefined&&(S.overview||S.step!==info.stage)){selectStep(info.stage);return;}
    if(ti!==undefined){S.focus=ti;const q=DATA.tokens[ti].query;if(q!==null&&q!==undefined)S.query=q;const wi=DATA.tokens[ti].word;if(wi!==null)S.word=wi;}
    if(item?.word!==undefined){S.word=item.word;S.focus=tokenForWord(S.word);}
    if(item?.slot!==undefined)S.slot=item.slot;
    S.tab='data';renderPanel();refreshFocus();updateMap();renderDocument();return;
  }
  const title=item?.name||(ti!==undefined?DATA.tokens[ti].piece:STEPS[info.stage]?.title)||'';
  $('#tooltip').innerHTML=`<b>${esc(title)}</b>${ti!==undefined?'Token '+ti+' · vocabulary ID '+DATA.tokens[ti].id:''}${item?.value!==undefined?'<br>'+esc(item.caption||'Score')+' '+fmt(item.value):ti===undefined?'Click to explore this stage':''}`;
  $('#tooltip').hidden=false;$('#tooltip').style.left=clamp(event.clientX-r.left+12,8,r.width-235)+'px';$('#tooltip').style.top=clamp(event.clientY-r.top+12,8,r.height-80)+'px';
}
function frame(now) {
  requestAnimationFrame(frame);
  if(anim){const t=anim.duration?clamp((now-anim.start)/anim.duration,0,1):1,s=t*t*(3-2*t);camera.position.lerpVectors(anim.position,anim.to,s);controls.target.lerpVectors(anim.target,anim.at,s);if(t===1)anim=null;}
  if(S.view==='map'&&DATA){mapPoints.forEach(point=>point.position.lerp(point.userData.target,.12));map.children.filter(o=>o.isSprite).forEach(label=>{const p=mapPoints[label.userData.label];label.position.copy(p.position).add(new THREE.Vector3(0,.24,0));label.visible=DATA.tokens.length<80||label.userData.label===S.focus||DATA.tokens[label.userData.label].query!==null;});}
  controls.update();renderer.render(scene,camera);
}

async function uploadDocument(page=0) {
  const file=uploadedFile;if(!file)return;if(file.size>10*1024*1024){showError('Use a PDF or image smaller than 10 MB.');return;}
  busy(true);showError();
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    documentData=await fetchJSON('/api/document',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:file.name,data:btoa(binary),page})});
    $('#text').value=documentData.text;renderDocumentMeta();S.example=-1;renderExamples();
  }catch(e){showError(e.message);busy(false);return;}
  busy(false);await runAnalysis();if(DATA?.document)setView('document');
}

document.addEventListener('click',async event=>{
  const task=event.target.closest('[data-task]');if(task){await chooseTask(task.dataset.task,true);return;}
  const start=event.target.closest('[data-start-task]');if(start){await chooseTask(start.dataset.startTask,true);return;}
  const ex=event.target.closest('[data-example]');if(ex&&!S.busy){await chooseExample(Number(ex.dataset.example));return;}
  const step=event.target.closest('[data-step]');if(step){stop();selectStep(Number(step.dataset.step));return;}
  const tab=event.target.closest('[data-tab]');if(tab){const wasOverview=S.overview;S.tab=tab.dataset.tab;S.overview=false;renderRail();renderPanel();refreshFocus();if(wasOverview&&S.view==='tower')focusStage();return;}
  const view=event.target.closest('[data-view]');if(view){setView(view.dataset.view);return;}
  const jump=event.target.closest('[data-jump]');if(jump){selectStep(STEPS.findIndex(s=>s.key===jump.dataset.jump));return;}
  const token=event.target.closest('[data-token]');if(token){S.focus=Number(token.dataset.token);const t=DATA.tokens[S.focus];if(t.query!==null)S.query=t.query;if(t.word!==null)S.word=t.word;renderPanel();refreshFocus();updateMap();return;}
  const word=event.target.closest('#doc-boxes [data-word]');if(word){S.word=Number(word.dataset.word);S.focus=tokenForWord(S.word);S.tab='data';S.overview=false;const idx=STEPS.findIndex(s=>s.key==='document');if(idx>=0)S.step=idx;renderPanel();renderRail();renderDocument();}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='query-select'){S.query=Number(el.value);S.focus=DATA.queries[S.query].token;renderPanel();refreshFocus();updateMap();if(S.view==='document')updateView();}
  if(el.id==='head-select'){S.head=Number(el.value);renderPanel();refreshFocus();if(S.view==='document')renderDocument();}
  if(el.id==='word-select'){S.word=Number(el.value);S.focus=tokenForWord(S.word);renderPanel();refreshFocus();renderDocument();}
  if(el.id==='slot-select'){S.slot=Number(el.value);renderPanel();refreshFocus();}
  if(el.id==='bio-select'){S.bioLabel=Number(el.value);renderPanel();refreshFocus();}
  if(el.id==='upload'){uploadedFile=el.files[0];uploadDocument();}
  if(el.id==='document-page')uploadDocument(Number(el.value));
});
$('#analyze-form').addEventListener('submit',event=>{event.preventDefault();runAnalysis();});
$('#threshold').addEventListener('input',()=>{$('#threshold-value').value=fmt($('#threshold').value,2);});
$('#prev').onclick=()=>{stop();selectStep(S.step-1);};$('#next').onclick=()=>{stop();selectStep(S.step+1);};
$('#start').onclick=startExploring;$('#brand').onclick=()=>{stop();S.intro=true;$('#landing').hidden=false;document.body.classList.add('intro-mode');requestAnimationFrame(()=>{resize();introCamera();});};
$('#about').onclick=()=>$('#about-dialog').showModal();$('#close-about').onclick=()=>$('#about-dialog').close();
$('#about-dialog').addEventListener('click',e=>{if(e.target===$('#about-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
$('#overview').onclick=()=>{stop();S.overview=true;renderRail();renderPanel();refreshFocus();towerCamera();updateView();};$('#play').onclick=play;
$('#reset-camera').onclick=()=>S.view==='map'?fly(new THREE.Vector3(12,8,18),new THREE.Vector3()):S.overview?towerCamera():focusStage();
function selectMapLayer(layer){S.layer=layer;const index=STEPS.findIndex(s=>layer===0?s.key==='embed':s.key==='layer'&&s.layer===layer);if(index>=0){S.step=index;S.overview=false;renderRail();renderPanel();}updateMap();updateView();}
$('#map-layer').oninput=event=>selectMapLayer(Number(event.target.value));
$('#map-play').onclick=()=>{if(mapTimer){clearInterval(mapTimer);mapTimer=null;$('#map-play').textContent='▶';return;}$('#map-play').textContent='Ⅱ';mapTimer=setInterval(()=>selectMapLayer((S.layer+1)%(INFO.layers+1)),1000);};
$('#download').onclick=()=>{const blob=new Blob([JSON.stringify({model_info:INFO,...DATA})],{type:'application/json'});const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='gliformer-trace-'+S.task+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
let down=null;canvas.addEventListener('pointerdown',e=>{down=[e.clientX,e.clientY];});canvas.addEventListener('pointerup',e=>{if(down&&Math.hypot(e.clientX-down[0],e.clientY-down[1])<5)pickAt(e,true);down=null;});
canvas.addEventListener('pointermove',e=>pickAt(e));canvas.addEventListener('pointerleave',()=>$('#tooltip').hidden=true);
window.addEventListener('resize',resize);new ResizeObserver(resize).observe($('#viewport'));
document.addEventListener('keydown',event=>{if(event.target.matches('input,textarea,select')||$('#about-dialog').open||S.intro)return;if(event.key==='ArrowRight'){event.preventDefault();selectStep(S.step+1);}if(event.key==='ArrowLeft'){event.preventDefault();selectStep(S.step-1);}if(event.key==='Escape'){stop();clearInterval(mapTimer);mapTimer=null;}});

async function boot() {
  renderTasks();initScene();buildTower();introCamera();
  try {
    try{[INFO,EXAMPLES]=await Promise.all([fetchJSON('/api/info'),fetchJSON('/api/examples')]);}
    catch{manifest=await fetchJSON('./static/manifest.json');INFO=manifest.info;EXAMPLES=manifest.examples;STATIC=true;}
    $('#mode').textContent=STATIC?'Recorded real model runs':'Live model · '+INFO.device;$('#mode').classList.toggle('live',!STATIC);
    $('#model-spec').textContent=`${INFO.layers} layers · ${nf(INFO.hidden)} dimensions · ${(INFO.params/1e6).toFixed(1)}M parameters`;
    $('#map-layer').max=INFO.layers;await chooseExample(0);
  }catch(error){$('#mode').textContent='Model unavailable';showError(error.message+' Start the app with “uv run server.py”, or generate the static examples with bake.py.');$('#busy').hidden=true;}
}
boot();
