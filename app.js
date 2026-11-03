import * as THREE from 'three';
import {createWalkthrough} from './walkthrough.js';
import {TASKS, LESSONS, describeQuestion, wordQuestion} from './lessons.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
const fmt = (x,n=3) => Number(x).toFixed(n);
const nf = x => Number(x).toLocaleString('en-US');
const json = x => `<pre>${esc(JSON.stringify(x,null,2))}</pre>`;
const note = s => `<div class="note">${s}</div>`;
const empty = s => `<div class="empty">${s}</div>`;
const color = {ink:'#1F2D3D',muted:'#5E6E82',violet:'#3D6FB0',teal:'#4A9AA6',word:'#AFC3D9',prompt:'#D5DEE8',warm:'#C99A55',paper:'#F8FAFD'};
const LABEL_COLORS=['#3D6FB0','#4A9AA6','#86A86E','#C99A55','#C27C7C','#9B84C2','#5E96CF','#6FA595'];
const labelColor=name=>LABEL_COLORS[Math.max(0,DATA?.input.entities?.indexOf(name)??0)%LABEL_COLORS.length];
const queryColor=q=>q.kind==='class'?'#5B57A8':q.kind==='entity'?labelColor(q.name):LABEL_COLORS[(DATA.input.entities.length+Math.max(0,DATA.queries.filter(a=>a.kind===q.kind).indexOf(q)))%LABEL_COLORS.length];
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
  $$('#tasks button,#examples button,#analyze-form input,#analyze-form textarea,#run,#document-page').forEach(el=>el.disabled=value||STATIC&&el.matches('input,textarea,#run,#document-page'));
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
    && !(key==='scorer'&&!wordQuestion(DATA,S.query))
    && !(key==='classification'&&!DATA.stages.classes?.length)
    && !(['fields','slots','membership','hierarchy'].includes(key)&&!DATA.stages.records?.length);
  STEPS.push(...TASKS[S.task].heads.filter(available).map(key=>({key,...LESSONS[key]})));
  if(S.task==='all')STEPS.push({key:'result',...LESSONS.result});
}
function renderTasks() {
  $('#tasks').innerHTML=Object.entries(TASKS).map(([key,t])=>`<button data-task="${key}" class="${key===S.task?'on':''}" aria-pressed="${key===S.task}"><span class="task-dot"></span>${t.title}</button>`).join('');
  $('#landing-tasks').innerHTML=Object.entries(TASKS).filter(([k])=>k!=='all').map(([k,t])=>`<button data-start-task="${k}"><b>${t.title}</b><span>${t.short}</span></button>`).join('');
  $('#about-tasks').innerHTML=Object.entries(TASKS).filter(([k])=>k!=='all').map(([,t])=>`<div><b>${t.title}</b><span>${t.short}</span></div>`).join('');
}
function renderExamples() {
  $('#examples').innerHTML=EXAMPLES[S.task].map((e,i)=>`<button data-example="${i}" class="${i===S.example?'on':''}">${esc(e.name)}</button>`).join('');
  $$('#tasks button').forEach(b=>{b.classList.toggle('on',b.dataset.task===S.task);b.setAttribute('aria-pressed',String(b.dataset.task===S.task));});
  $$('.field[data-field]').forEach(f=>f.hidden=!TASKS[S.task].fields.includes(f.dataset.field));
  $('#multi-label-control').hidden=!['classification','all'].includes(S.task);
  $('#text').readOnly=S.task==='document';$('#analyze-form').classList.toggle('wide',TASKS[S.task].fields.length>2);
  $('#text-help').textContent=STATIC?'Example-only demo: sentences, schemas and threshold are fixed because these are real precomputed model runs. Run the Python server to analyze your own text.':S.task==='document'?'The page supplies text and word boxes. Turn word positions on or off and rerun to compare.':'';
}
function renderRail(){
  if(!STEPS.length)return;let group=0,html=`<button class="item" type="button" data-open-about><span class="num">i</span><span class="t">What is GLiFormer?</span><span class="s">The model, its tasks and the text–layout path.</span></button>`;
  STEPS.forEach((st,i)=>{
    if(st.key==='layer'&&st.layer!==1)return;group++;
    const selected=selectedStage(),on=!S.overview&&(st.key==='layer'?selected.key==='layer':S.step===i);
    const dots=st.key==='layer'?`<div class="dots layer-grid">${Array.from({length:INFO.layers},(_,l)=>`<span role="button" tabindex="0" data-step="${i+l}" class="${selected.key==='layer'&&selected.layer===l+1?'on':''}" aria-label="Transformer layer ${l+1}">${l+1}</span>`).join('')}</div>`:'';
    html+=`<button class="item ${on?'on':''}" data-step="${i}" type="button"><span class="num">${String(group).padStart(2,'0')}</span><span class="t">${st.key==='layer'?'Transformer · '+INFO.layers+' layers':esc(st.title)}</span><span class="s">${esc(st.short)}</span>${dots}</button>`;
  });$('#rail').innerHTML=html;
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
    busy(true);
    try{documentData=STATIC?await compressedJSON('./static/document.json.gz'):await fetchJSON('/api/document/example');$('#text').value=documentData.text;renderDocumentMeta();}
    catch(error){showError(error.message);busy(false);return;}
    busy(false);
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
    DATA=out;S.word=clamp(S.word,0,DATA.words.length-1);buildSteps();S.step=Math.max(0,STEPS.findIndex(s=>s.key===previousStage.key&&(s.key!=='layer'||s.layer===previousStage.layer)));S.query=Math.max(0,DATA.queries.findIndex(q=>q.kind!=='schema'));S.focus=DATA.queries[S.query]?.token||0;S.head=-1;S.slot=DATA.stages.records?.[0]?.slot_order?.[0]||0;S.bioLabel=0;
    if(S.task==='document')documentData=DATA.document;
    buildTower();buildMap();renderRail();renderPanel();renderDocument();updateView();
    $('#timing').textContent=`${nf(DATA.tokens.length)} tokens · ${DATA.ms} ms inference · ${DATA.total_ms} ms trace`;$('#mode').textContent=INFO.name+' · '+DATA.ms+' ms'+(STATIC?' (precomputed)':' · '+INFO.device);
    $('#download').disabled=false;
    if(S.intro)introCamera();else if(S.overview)towerCamera();else focusStage();
  }catch(error){showError(error.message);}
  finally{if(current===serial)busy(false);}
}
function startExploring() {
  S.intro=false;$('#landing').hidden=true;document.body.classList.remove('intro-mode');engine?.setView();
  requestAnimationFrame(()=>{resize();towerCamera();});
}

function selectedStage(){return STEPS[S.step]||{key:'input',...LESSONS.input};}
function layerIndex(){const st=selectedStage();return st.key==='layer'?st.layer:st.key==='embed'?0:INFO.layers;}
function selectedBio(){const a=DATA.stages.anchors?.questions?.find(a=>a.query===S.query&&a.task==='ner');return DATA.stages.bio?.[a?.indices[0]||0];}
function selectedRecord(){const a=DATA.stages.anchors?.questions?.find(a=>a.query===S.query&&a.task==='structuring');return DATA.stages.records?.[a?.indices[0]||0];}
function wordAttention(layer){return DATA.queries[S.query]?.token===S.focus?(S.head<0?layer.query_attention?.[S.query]:layer.heads?.[S.head]?.[S.query]):DATA.words.map((_,wi)=>DATA.tokens.reduce((total,t,ti)=>total+(t.word===wi?(layer.attention[S.focus]?.[ti]||0):0),0));}
function queryControl(kinds=null) {
  if(!DATA.queries.length)return '';
  return `<label class="sub-label" for="query-select">Follow a schema question</label><select class="query-selector" id="query-select">${DATA.queries.map((q,i)=>kinds&&!kinds.includes(q.kind)?'':`<option value="${i}" ${i===S.query?'selected':''}>${esc(q.kind+' · '+q.name)}</option>`).join('')}</select>`;
}
function wordControl(){return `<label class="sub-label" for="word-select">Inspect a source word</label><select class="query-selector" id="word-select">${DATA.words.map((w,i)=>`<option value="${i}" ${i===S.word?'selected':''}>${i} · ${esc(w.text)}</option>`).join('')}</select>`;}
function anchorQuestionContent(numbers=false){
  const d=describeQuestion(DATA,S.query);if(!d)return '';
  const {q,capture:a,context,prompt,next}=d;
  let html=queryControl();
  if(a){
    html+=`<div class="question-example" style="--q:${queryColor(q)}" data-question="${S.query}"><div class="question-inputs"><div><small>1 · Task context</small><b>${esc(context)}</b><span>parent anchor</span></div><span class="question-plus">+</span><div><small>2 · Label to find</small><b>${esc(q.name)}</b><span>${esc(q.kind==='class'?'[CLASS]':q.kind==='field'?'[FIELD]':'[ENTITY]')} marker</span></div></div><div class="question-output"><small>↓ 3 · Combine their numbers</small><b>${esc(prompt)}</b><span>prepared question vector</span></div></div><p class="help">The question above is a plain-language paraphrase. The model combines numerical vectors; it does not generate that sentence.</p>`;
    if(numbers)html+=`<h3>1 · Task context · ${esc(context)}</h3>${strip(a.anchor)}<h3>2 · Label · ${esc(q.name)}</h3>${strip(a.label_vector)}<h3>3 · Prepared question · ${esc(q.name)}</h3>${strip(a.fused)}<p>${esc(next)}.</p>${note('These are actual inputs and output of this label’s fusion. The numbers are features, not probabilities. Changing labels switches to that label’s captured row.')}<details><summary>Tensor location</summary><p><code>${esc(a.head)}</code> head · ${esc(a.task)} task · group ${esc(a.group)}</p><code>${esc(a.shape.join(' × '))}</code><p class="help">Axes: groups × parent anchors × labels × dimensions.<br>Selected row: [${a.indices.join(', ')}]. Only 32 of 1024 dimensions are displayed.</p></details>`;
  }else if(q.kind==='relation'){
    html+=`<h3>${esc(prompt)}</h3><p>This relation question follows a separate route. Its contextualized <b>[RELATION]</b> marker will be compared with directed entity pairs, such as person → organization.</p>${numbers?`<h3>Relation marker · ${esc(q.name)}</h3>${strip(DATA.layers.at(-1).strip[q.token])}`:''}${note('This checkpoint does not apply the parent–label linear fusion to relation labels. Select an entity, class or field to inspect that operation.')}`;
  }else if(q.kind==='schema'){
    html+=`<h3>Task heading · ${esc(q.name)}</h3><p>This marker supplies the shared context for the labels in its group. Choose one of those labels to see how the two are combined.</p>${numbers?strip(DATA.layers.at(-1).strip[q.token]):''}`;
  }else html+=empty('No captured fusion is available for this marker.');
  if(a)html+=`<div class="mini-nav"><button data-jump="${q.kind==='class'?'classification':'scorer'}">${q.kind==='class'?'Use this question to classify the text':'Use this question on the words'} →</button></div>`;
  return html;
}
function scorerContent(numbers=false){
  const d=wordQuestion(DATA,S.query);if(!d)return empty('No captured word-scoring route in this run.');
  const word=DATA.words[S.word],values=d.probabilities[S.word];
  return `${queryControl(['entity','field'])}${wordControl()}<div class="scorer-pair" data-question="${d.index}" data-word="${S.word}"><div><small>Prepared question · from the previous stage</small><b>${esc(d.q.name)}</b></div><span>+</span><div><small>Contextualized word · from the LSTM</small><b>${esc(word.text)}</b></div><p>↓ Learned comparison network + sigmoid</p></div><div class="scorer-scores">${['Start','End','Inside'].map((name,i)=>`<div><span>${name}</span><b data-score="${i}">${fmt(values[i])}</b><small>${['Could it begin here?','Could it finish here?','Does this word belong?'][i]}</small></div>`).join('')}</div><p>These are the actual scores for <b>“${esc(word.text)}”</b> as <b>“${esc(d.q.name)}”</b>. Select another word to reuse the same question; select another label to ask a different question.</p>${numbers?`<h3>Question vector · after task + label fusion</h3>${strip(d.capture.fused)}<h3>Word vector · after the LSTM</h3>${strip(DATA.word_vectors[S.word])}${note('The diagram’s comparison block is schematic. Intermediate projections are not saved; the inputs and the three output scores above come from this run.')}`:''}<div class="mini-nav"><button data-jump="anchors">← Prepared question</button><button data-jump="${d.destination}">See scores across the text →</button></div>`;
}
function entityEvidenceContent(){
  const q=DATA.queries[S.query],bio=selectedBio();
  const entity=(DATA.result.ner?.[0]||[]).find(e=>e.label===q?.name);
  if(!entity||!bio)return `<p>No final mention of <b>${esc(q?.name||'the selected type')}</b> was returned for this run. Inspect the word scores to see the available evidence.</p>`;
  const label=bio.labels.indexOf(entity.label),ids=DATA.words.flatMap((w,i)=>w.start>=entity.start&&w.end<=entity.end?[i]:[]);
  if(label<0||!ids.length)return '';
  return `<div class="span-evidence"><small>From word scores to a returned mention · ${esc(entity.label)}</small><h3>${esc(entity.text)}</h3>${matrix(ids.map(i=>DATA.words[i].text),['start','end','inside'],ids.map(i=>bio.probs[i][label]))}<p>Start at <b>${esc(DATA.words[ids[0]].text)}</b>, end at <b>${esc(DATA.words[ids.at(-1)].text)}</b>, with inside evidence across the whole mention.</p><p>Threshold: ${fmt(DATA.input.threshold,2)} · returned span score: <b>${fmt(entity.score,5)}</b>.</p><p class="help">The decoder also uses inside evidence immediately outside the span to rank its boundaries, then resolves overlaps. The score above is the actual decoder result.</p></div><div class="mini-nav"><button data-jump="bio">← Inspect all word scores</button></div>`;
}
function lstmWordContent(){
  const word=DATA.words[S.word],before=DATA.words.slice(0,S.word),after=DATA.words.slice(S.word+1);
  const context=words=>words.length?(words.length>8?'… ':'')+esc(words.slice(-8).map(w=>w.text).join(' ')):'<em>no earlier words in this reading direction</em>';
  return `${wordControl()}<p>Follow what happens at <b>“${esc(word.text)}”</b>.</p><div class="rnn-context"><div><b>→ Left-to-right pass</b><p>Most recently visited before this word:</p><span>${context(before)}</span></div><div><b>← Right-to-left pass</b><p>Most recently visited before this word:</p><span>${context([...after].reverse())}</span></div></div>${note('These lists show reading order, not the contents of the numerical memory. Long routes are shortened with “…”. The blue and teal drawing is schematic.')}<h3>The real numbers for this word</h3><p>A <b>vector</b> is a list of numbers representing the word. These strips show actual values entering and leaving the LSTM; they are not confidence scores.</p><h3>Before · from the Transformer</h3>${strip(DATA.rnn.before[S.word])}<h3>After · from the LSTM</h3>${strip(DATA.rnn.after[S.word])}<p class="help">The complete output joins 512 numbers from each direction. This saved output strip shows its first 32 dimensions, within the left-to-right half.</p>`;
}
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
  for(const e of sorted){if(e.start<end)continue;html+=esc(text.slice(end,e.start))+`<span class="mention" style="--c:${labelColor(e.label)}">${esc(text.slice(e.start,e.end))}<small>${esc(e.label)}</small></span>`;end=e.end;}
  html+=esc(text.slice(end));
  return `<div class="sentence">${html}</div><div class="entity-list">${sorted.map(e=>`<div class="entity-item" style="--c:${labelColor(e.label)}"><b>${esc(e.text)}</b><span>${esc(e.label)} · [${e.start}, ${e.end})</span><strong>${fmt(e.score)}</strong></div>`).join('')}</div>`;
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
    case 'rnn':return lstmWordContent();
    case 'anchors':return anchorQuestionContent(true);
    case 'scorer':return scorerContent(true);
    case 'bio': {
      const bio=selectedBio();if(!bio)return empty('This run has no standalone entity BIO scores.');
      const i=clamp(S.bioLabel,0,bio.labels.length-1);
      return `${bioControl(bio.labels)}${matrix(DATA.words.map(w=>w.text),['start','end','inside'],bio.probs.map(row=>row[i]))}<p>The same word can be a plausible boundary for one type and implausible for another.</p>`;
    }
    case 'entities':return entityResult();
    case 'classification':return (DATA.stages.classes||[]).map((group,gi)=>`<h3>${esc(group.group)}</h3>${bars(group.labels.map((name,i)=>({name,value:group.probs[i],chosen:(DATA.result.classification?.[0]?.[gi]||[]).some(p=>p.class_name===name),color:'#5B57A8'})))}<div class="help">Sigmoid scores. Threshold ${fmt(DATA.input.threshold,2)}. ${DATA.input.multi_label?'Multiple labels allowed.':'Highest label only.'}</div>`).join('');
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
function meaningContent(){
  const layer=DATA.layers[S.layer],q=DATA.queries[S.query];
  if(S.tab==='what')return `<p>Each point is one piece of your input. The model represents every piece with <b>${INFO.hidden} numbers</b>; this view projects them into three dimensions.</p><p>Move the layer slider to watch context change those representations. Follow a colored schema marker and see which source words become similar to it.</p><p>The line connects the selected question to its most similar source word. The comparison uses all ${INFO.hidden} dimensions, even though the map can only show three.</p>${note('Distances on this PCA map are approximate. A nearby point is not an extracted entity or a confidence score. Turn trails on to follow movement across layers.')}`;
  if(S.tab==='tech')return `<p>The server L2-normalizes the real hidden states, centers them, and applies a 3D PCA projection. Orthogonal Procrustes alignment matches each layer to the previous one so the axes move smoothly.</p><p>Query-to-word similarities use cosine similarity in the full hidden space, without PCA. Word points use their first subword’s hidden state.</p><dl class="tech"><dt>Layer</dt><dd>${S.layer===0?'Input embeddings':S.layer+' of '+INFO.layers}</dd><dt>Hidden vectors</dt><dd>[${DATA.tokens.length}, ${INFO.hidden}]</dd><dt>Display coordinates</dt><dd>[${DATA.tokens.length}, 3]</dd></dl>`;
  return `${queryControl()}<p>Layer <b>${S.layer}</b> of ${INFO.layers}.</p>${q?`<h3>Words most similar to “${esc(q.name)}”</h3>${bars(DATA.words.map((w,i)=>({name:w.text,value:layer.similarity[S.query][i],color:queryColor(q)})).sort((a,b)=>b.value-a.value),true)}${note('Numbers are full-vector cosine similarities, not attention or probabilities. Bar widths map −1…1 into the available space.')}`:note('This prompt-free run has no schema markers. Click a point to inspect that token and move the slider to follow it.')}<h3>Selected piece</h3>${tokenInfo()}${strip(layer.strip[S.focus])}`;
}
function renderPanel() {
  if(!DATA)return;
  const st=selectedStage();
  $('#stage-number').textContent=S.overview?STEPS.length+' steps · '+(STEPS.length-INFO.layers+1)+' stages':`Step ${S.step+1} of ${STEPS.length}`;
  $('#stage-title').textContent=S.overview?'A sentence travels through the model':st.title;
  $('#stage-subtitle').textContent=S.overview?TASKS[S.task].short:st.short;
  $$('#panel-tabs button').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===S.tab)));
  let html;
  if(S.view==='map'){
    $('#stage-number').textContent='Alternative view';$('#stage-title').textContent='Meaning map';$('#stage-subtitle').textContent='Where the model places each piece, layer by layer.';html=meaningContent();
  } else if(S.overview) {
    html=`<p>This is <b>GLiFormer Large v1</b> by Knowledgator. Follow your input through its shared encoder, then into the ${esc(TASKS[S.task].title.toLowerCase())} head.</p><p>Pick a plate in the tower or a stage in the list. Use the three tabs to move from the plain-language idea to the real values and the source code.</p>${stats([[INFO.layers,'Transformer layers'],[nf(INFO.hidden),'dimensions'],[(INFO.params/1e6).toFixed(1)+'M','parameters']])}<div class="mini-nav"><button data-jump="input">Start at the input →</button><button data-jump="result">See the answers →</button></div>${note(DATA.document?'This run follows a page through text extraction and 2D layout. Click Document to see the boxes.':'Every attention weight, vector strip and task score comes from this sentence’s real forward pass.')}<h3>This run</h3><p class="sentence">${esc(DATA.input.text)}</p>`;
  } else if(S.tab==='what')html=(st.key==='anchors'?anchorQuestionContent():st.key==='scorer'?scorerContent():st.key==='entities'?entityEvidenceContent():'')+st.what;
  else if(S.tab==='data')html=dataContent(st.key);
  else html=st.tech+`<dl class="tech"><dt>Checkpoint</dt><dd>${esc(INFO.name)}@${INFO.revision?.slice(0,8)||'local'}</dd><dt>Framework</dt><dd>GLiFormer ${esc(INFO.versions.gliformer)}</dd><dt>Device</dt><dd>${esc(INFO.device)}</dd></dl><p><a href="${INFO.sources[st.source]||INFO.sources.encoder}" target="_blank" rel="noopener">Read the exact source revision ↗</a></p>`;
  $('#panel-content').innerHTML=html;
  $('#step-count').innerHTML=S.overview?'<b>Full view</b> · press ▶ to start':`Step ${S.step+1} of ${STEPS.length} · <b>${esc(st.title)}</b>`;
  const kinds=!S.overview&&S.view==='tower'?(st.key==='scorer'?['entity','field']:['bio','entities'].includes(st.key)?['entity']:null):null;
  $('#follow').innerHTML='<span>Following:</span>'+DATA.queries.map((q,i)=>q.kind==='schema'||kinds&&!kinds.includes(q.kind)?'':`<button type="button" class="lab ${i===S.query?'on':''}" style="--c:${queryColor(q)}" data-query="${i}">${esc(q.name)}</button>`).join('');
  $('#prev').disabled=S.step===0;$('#next').disabled=S.step===STEPS.length-1;
}

// Use the original visualizer's plate geometry, word alignment, camera and fading.
const canvas=$('#scene');
let engine=null;
function heat(value,signed=false){return '#'+new THREE.Color('#F1F5FA').lerp(new THREE.Color(signed&&value<0?color.warm:color.violet),clamp(Math.abs(value)*(signed?.28:1),0,1)).getHexString();}
function initScene(){
  try{engine=createWalkthrough(canvas,{state:S,data:()=>DATA,info:()=>INFO,steps:()=>STEPS,
    pick:(item,stage)=>{
      if(stage!==undefined&&(S.overview||S.step!==stage)){selectStep(stage);return;}
      if(item.query!==undefined){followQuery(item.query);return;}
      if(item.token!==undefined){S.focus=item.token;const t=DATA.tokens[S.focus];if(t.query!==null)S.query=t.query;if(t.word!==null)S.word=t.word;}
      if(item.word!==undefined){S.word=item.word;S.focus=tokenForWord(S.word);}
      if(item.slot!==undefined)S.slot=item.slot;
      S.tab='data';renderPanel();refreshFocus();updateMap();renderDocument();
      if(item.word!==undefined&&selectedStage().key==='scorer'&&S.view==='tower')focusStage();
    },tooltip:(item,event)=>{
      if(!item){$('#tooltip').hidden=true;return;}
      $('#tooltip').innerHTML=`<b>${esc(item.name||'')}</b>${item.caption?'<span>'+esc(item.caption)+'</span>':''}${item.value!==undefined?'<span>'+fmt(item.value)+'</span>':''}`;
      $('#tooltip').hidden=false;$('#tooltip').style.opacity='1';$('#tooltip').style.left=clamp(event.clientX+12,8,innerWidth-300)+'px';$('#tooltip').style.top=clamp(event.clientY+12,8,innerHeight-110)+'px';
    }});
  }catch(error){$('#scene-hint').textContent='3D needs WebGL. The explanation and real model values remain available in the panel.';}
}
const buildTower=()=>engine?.buildTower(),buildMap=()=>{engine?.buildMap();engine?.setTrails($('#trails').checked)},refreshFocus=()=>engine?.refreshFocus(),resize=()=>engine?.resize(),towerCamera=()=>engine?.towerCamera(),focusStage=()=>engine?.focusStage(),fly=(p,t)=>engine?.fly(p,t),pickAt=(event,click)=>engine?.pickAt(event,click);
function introCamera(){engine?.setView();resize();engine?.introCamera();}
function updateMap(immediate=false){engine?.updateMap(immediate);$('#map-layer').value=S.layer;$('#map-value').textContent=S.layer===0?'embeddings':S.layer+' / '+INFO.layers;}
function followQuery(index){
  S.query=index;S.focus=DATA.queries[index].token;const label=selectedBio()?.labels.indexOf(DATA.queries[index].name);if(label>=0)S.bioLabel=label;
  const field=DATA.stages.anchors?.questions?.find(a=>a.query===index&&a.task==='structuring');if(field)S.bioLabel=field.indices[2];
  renderPanel();refreshFocus();updateMap();if(S.view==='document')updateView();else if(!S.overview&&S.view==='tower')focusStage();
}
function selectStep(index){
  if(!DATA)return;const previous=S.overview?null:S.step;S.step=clamp(index,0,STEPS.length-1);S.overview=false;
  const st=selectedStage();if(st.key==='layer')S.layer=st.layer;else if(st.key==='embed')S.layer=0;
  if(st.key==='scorer'||['bio','entities'].includes(st.key)){
    const d=st.key==='scorer'?wordQuestion(DATA,S.query):null;
    const index=d?.index??(DATA.queries[S.query]?.kind==='entity'?S.query:DATA.queries.findIndex(q=>q.kind==='entity'));
    if(index>=0){S.query=index;S.focus=DATA.queries[index].token;S.bioLabel=d?.capture.indices[2]??Math.max(0,selectedBio()?.labels.indexOf(DATA.queries[index].name)||0);}
  }
  renderRail();renderPanel();updateView();refreshFocus();$('#scene-hint').style.opacity='0';
  if(S.view==='tower'){focusStage();if(previous!==null&&S.step===previous+1)engine?.transition(previous,S.step);}if(S.view==='map')updateMap();
}
function setView(view){
  if(view==='document'&&!DATA?.document)return;S.view=view;stop();
  if(view==='tower'&&!S.overview&&['scorer','bio','entities'].includes(selectedStage().key)){selectStep(S.step);return;}
  updateView();
  if(view==='map'){updateMap(true);fly(new THREE.Vector3(3,6,21),new THREE.Vector3());}
  else if(view==='tower'){S.overview?towerCamera():focusStage();}
}
function updateView(){
  if(!DATA)return;const doc=S.view==='document',mp=S.view==='map';$('#doc-view').hidden=!doc;canvas.style.visibility=doc?'hidden':'visible';
  $('#map-control').hidden=!mp;$('#flow-controls').hidden=mp;$('#view-switch [data-view="document"]').hidden=!DATA.document;
  $$('#view-switch button').forEach(b=>b.classList.toggle('on',b.dataset.view===S.view));$('#scene-tools').hidden=doc;
  $('#scene-subtitle').textContent=DATA.provenance.layout_used?'Words and 2D positions entered the model.':'Word positions were disabled for this run.';
  if(doc&&selectedStage().key==='layer')$('#scene-subtitle').textContent=`Layer ${selectedStage().layer} · attention over page words${DATA.provenance.layout_used?'':' · positions disabled'}`;
  engine?.setView();refreshFocus();if(doc)renderDocument();
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

function stop(){S.playing=false;clearInterval(timer);timer=null;$('#play').textContent='▶';}
function play(){if(S.playing){stop();return;}S.playing=true;$('#play').textContent='Ⅱ';if(S.overview||S.step===STEPS.length-1)selectStep(0);timer=setInterval(()=>{if(S.step>=STEPS.length-1){stop();return;}selectStep(S.step+1);},2200);}

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
  if(event.target.closest('[data-rnn-replay]')){if(S.view!=='tower')setView('tower');engine?.replayLSTM();return;}
  const following=event.target.closest('[data-query]');if(following){followQuery(Number(following.dataset.query));return;}
  if(event.target.closest('[data-open-about]')){$('#about-dialog').showModal();return;}
  const task=event.target.closest('[data-task]');if(task){await chooseTask(task.dataset.task,true);return;}
  const start=event.target.closest('[data-start-task]');if(start){await chooseTask(start.dataset.startTask,true);return;}
  const ex=event.target.closest('[data-example]');if(ex&&!S.busy){await chooseExample(Number(ex.dataset.example));return;}
  const step=event.target.closest('[data-step]');if(step){stop();selectStep(Number(step.dataset.step));return;}
  const tab=event.target.closest('[data-tab]');if(tab){const wasOverview=S.overview;S.tab=tab.dataset.tab;S.overview=false;renderRail();renderPanel();refreshFocus();if(wasOverview&&S.view==='tower')focusStage();return;}
  const view=event.target.closest('[data-view]');if(view){setView(view.dataset.view);return;}
  const jump=event.target.closest('[data-jump]');if(jump){const at=STEPS.findIndex(s=>s.key===jump.dataset.jump);selectStep(at>=0?at:STEPS.length-1);return;}
  const token=event.target.closest('[data-token]');if(token){S.focus=Number(token.dataset.token);const t=DATA.tokens[S.focus];if(t.query!==null)S.query=t.query;if(t.word!==null)S.word=t.word;renderPanel();refreshFocus();updateMap();return;}
  const word=event.target.closest('#doc-boxes [data-word]');if(word){S.word=Number(word.dataset.word);S.focus=tokenForWord(S.word);S.tab='data';S.overview=false;const idx=STEPS.findIndex(s=>s.key==='document');if(idx>=0)S.step=idx;renderPanel();renderRail();renderDocument();}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='query-select')followQuery(Number(el.value));
  if(el.id==='head-select'){S.head=Number(el.value);renderPanel();refreshFocus();if(S.view==='document')renderDocument();}
  if(el.id==='word-select'){S.word=Number(el.value);S.focus=tokenForWord(S.word);renderPanel();refreshFocus();renderDocument();if(['rnn','scorer'].includes(selectedStage().key)&&S.view==='tower')focusStage();}
  if(el.id==='slot-select'){S.slot=Number(el.value);renderPanel();refreshFocus();}
  if(el.id==='bio-select'){
    S.bioLabel=Number(el.value);const isField=selectedStage().key==='fields',group=isField?selectedRecord():selectedBio(),name=isField?group?.fields[S.bioLabel]:group?.labels[S.bioLabel];
    const capture=DATA.stages.anchors?.questions?.find(a=>a.task===(isField?'structuring':'ner')&&a.label===name&&a.group===(isField?group?.name:group?.group));
    if(capture)followQuery(capture.query);else{renderPanel();refreshFocus();}
  }
  if(el.id==='upload'){uploadedFile=el.files[0];uploadDocument();}
  if(el.id==='document-page')uploadDocument(Number(el.value));
  if(el.id==='trails')engine?.setTrails(el.checked);
});
$('#analyze-form').addEventListener('submit',event=>{event.preventDefault();runAnalysis();});
$('#threshold').addEventListener('input',()=>{$('#threshold-value').value=fmt($('#threshold').value,2);});
$('#prev').onclick=()=>{stop();selectStep(S.step-1);};$('#next').onclick=()=>{stop();selectStep(S.step+1);};
$('#start').onclick=startExploring;$('#brand').onclick=()=>{stop();S.intro=true;$('#landing').hidden=false;document.body.classList.add('intro-mode');requestAnimationFrame(()=>{resize();introCamera();});};
$('#about').onclick=()=>$('#about-dialog').showModal();$('#landing-about').onclick=()=>$('#about-dialog').showModal();$('#close-about').onclick=()=>$('#about-dialog').close();
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
document.addEventListener('keydown',event=>{if(event.target.matches('#rail .dots [data-step]')&&['Enter',' '].includes(event.key)){event.preventDefault();selectStep(Number(event.target.dataset.step));return;}if(event.target.matches('input,textarea,select')||$('#about-dialog').open||S.intro)return;if(event.key==='ArrowRight'){event.preventDefault();selectStep(S.step+1);}if(event.key==='ArrowLeft'){event.preventDefault();selectStep(S.step-1);}if(event.key==='Escape'){stop();clearInterval(mapTimer);mapTimer=null;}});

async function boot() {
  renderTasks();initScene();buildTower();introCamera();
  try {
    try{[INFO,EXAMPLES]=await Promise.all([fetchJSON('/api/info'),fetchJSON('/api/examples')]);}
    catch{manifest=await fetchJSON('./static/manifest.json');INFO=manifest.info;EXAMPLES=manifest.examples;STATIC=true;}
    document.body.classList.toggle('static',STATIC);$('#mode').textContent=INFO.name+' · '+(STATIC?'precomputed':INFO.device);$('#land-meta').textContent=`${INFO.layers} layers · ${INFO.heads} heads · ${INFO.hidden} dimensions · real model values`; $('#mode').classList.toggle('live',!STATIC);
    $('#model-spec').textContent=`${INFO.layers} layers · ${nf(INFO.hidden)} dimensions · ${(INFO.params/1e6).toFixed(1)}M parameters`;
    $('#map-layer').max=INFO.layers;await document.fonts.ready;await chooseExample(0);
  }catch(error){$('#mode').textContent='Model unavailable';showError(error.message+' Start the app with “uv run server.py”, or generate the static examples with bake.py.');$('#busy').hidden=true;}
}
boot();
