import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import {describeQuestion, wordQuestion} from './lessons.js';

// The original GLiNER2 plate, text, camera and fading conventions, with GLiFormer-specific builders.
export function createWalkthrough(canvas, options) {
  const S=options.state;
  let DATA,INFO,STEPS,plates=[],WL;
  const sync=()=>{DATA=options.data();INFO=options.info();STEPS=options.steps();};
  const C={bg:'#EEF3F8',paper:'#F8FAFD',plate:'#E2EAF3',ink:'#1F2D3D',muted:'#5E6E82',word:'#AFC3D9',word2:'#CBD8E6',terra:'#3D6FB0',slate:'#4A9AA6',olive:'#86A86E',cls:'#5B57A8',warm:'#C99A55'};
  const PALETTE=['#3D6FB0','#4A9AA6','#86A86E','#C99A55','#C27C7C','#9B84C2','#5E96CF','#6FA595','#B0896A','#8495AD','#B07FA0','#A3A35C'];
  const LC=i=>PALETTE[((i%PALETTE.length)+PALETTE.length)%PALETTE.length];
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const mix=(a,b,t)=>'#'+new THREE.Color(a).lerp(new THREE.Color(b),clamp(t,0,1)).getHexString();
  const mat=c=>new THREE.MeshStandardMaterial({color:c,roughness:.84,metalness:0,transparent:true});
  const BOX=new THREE.BoxGeometry(1,1,1),TOP=.08,PART_GEO=new THREE.SphereGeometry(.085,10,6);
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  const scene=new THREE.Scene();scene.background=new THREE.Color(C.bg);scene.fog=new THREE.Fog(C.bg,60,170);
  const camera=new THREE.PerspectiveCamera(36,1,.1,500);camera.position.set(20,20,40);
  const controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.dampingFactor=.08;controls.autoRotateSpeed=.5;
  scene.add(new THREE.HemisphereLight('#F7FAFF','#C9D5E3',1.6));
  const sun=new THREE.DirectionalLight('#FFFFFF',1.8);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.bias=-.0004;sun.shadow.radius=3;scene.add(sun,sun.target);
  const ground=new THREE.Mesh(new THREE.CircleGeometry(40,48),new THREE.ShadowMaterial({opacity:.07}));ground.rotation.x=-Math.PI/2;ground.position.y=-1.2;ground.receiveShadow=true;scene.add(ground);
  const tower=new THREE.Group(),map=new THREE.Group();scene.add(tower,map);map.visible=false;
  const cache=new Map();
  function textTex(str,font='500 52px Inter, sans-serif',color=C.ink){
    const key=font+color+str;if(cache.has(key))return cache.get(key);
    const c=document.createElement('canvas'),g=c.getContext('2d');g.font=font;
    const px=parseInt(font.match(/(\d+)px/)[1]),h=Math.ceil(px*1.4),w=Math.ceil(g.measureText(str).width)+16;c.width=w;c.height=h;
    g.font=font;g.fillStyle=color;g.textBaseline='middle';g.fillText(str,8,h/2+1);
    const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=8;
    const value={tex,aspect:w/h,mat:new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false})};cache.set(key,value);return value;
  }
  function flatText(parent,str,x,z,h,maxW,color,font){
    const t=textTex(str,font,color);if(maxW)h=Math.min(h,(maxW+.1)/t.aspect);
    const m=new THREE.Mesh(new THREE.PlaneGeometry(h*t.aspect,h),t.mat);m.rotation.x=-Math.PI/4;m.position.set(x,TOP+.02+h*.36,z);m.renderOrder=2;parent.add(m);return m;
  }
  function sprite(str,h=.3,color=C.ink,font='600 46px Inter, sans-serif'){
    const t=textTex(str,font,color),s=new THREE.Sprite(new THREE.SpriteMaterial({map:t.tex,transparent:true,depthWrite:false}));s.scale.set(h*t.aspect,h,1);s.renderOrder=3;return s;
  }
  function dispose(group){group.traverse(o=>{if(o.geometry&&o.geometry!==BOX&&o.geometry!==PART_GEO)o.geometry.dispose();if(o.material&&!o.material.map)o.material.dispose();if(o.isSprite)o.material.dispose();});group.clear();}
  function row(items,widthOf,gap){const ws=items.map(widthOf),total=ws.reduce((a,b)=>a+b,0)+gap*Math.max(0,ws.length-1);let x=-total/2;const xs=ws.map(w=>{const c=x+w/2;x+=w+gap;return c;});return{xs,ws,total};}
  const wordW=w=>clamp(.3+.12*w.text.length,.5,2.8),tokW=t=>clamp(.28+.1*t.piece.length,.42,1.6);
  const qColor=q=>q.kind==='class'?C.cls:q.kind==='entity'?labelColor(q.name):LC(DATA.input.entities.length+Math.max(0,DATA.queries.filter(a=>a.kind===q.kind).indexOf(q)));
  const labelColor=name=>LC((DATA.input.entities||[]).indexOf(name)>=0?DATA.input.entities.indexOf(name):Math.max(0,DATA.queries.filter(q=>q.kind!=='schema').findIndex(q=>q.name===name)));
  const topAttn=layer=>{
    if(S.head>=0&&DATA.queries[S.query]?.token===S.focus){const a=DATA.layers[layer].heads[S.head][S.query];return DATA.tokens.map((t,i)=>[t.word!==null&&DATA.tokens.findIndex(x=>x.word===t.word)===i?a[t.word]:0,i]);}
    return DATA.layers[layer].attention[S.focus].map((v,i)=>[v,i]);
  };
  function makePlate(st,idx,y,width,depth,cz=0){
    const group=new THREE.Group();group.position.y=y;
    const base=new THREE.Mesh(new RoundedBoxGeometry(width,.16,depth,3,.07),mat(C.plate));base.position.z=cz;base.receiveShadow=true;base.userData={stage:idx};group.add(base);
    const p={idx,st,y,width,depth,cz,group,base,tiles:[],labels:new THREE.Group(),extra:new THREE.Group(),tok:[],word:[],anchors:[],op:1,target:1};group.add(p.labels,p.extra);
    const title=sprite(st.title,st.key==='layer'?.34:.46,C.ink,`600 ${st.key==='layer'?44:58}px "Playfair Display", serif`);title.center.set(1,.5);title.position.set(-width/2-.35,.15,0);group.add(title);p.title=title;tower.add(group);return p;
  }
  function tile(p,x,z,w,d,h,color,info){
    const m=new THREE.Mesh(BOX,mat(color));m.scale.set(w,h,d);m.position.set(x,TOP+h/2,z);m.userData={stage:p.idx,item:info,h,target:h,color};m.castShadow=true;p.group.add(m);p.tiles.push(m);return m;
  }
  function tag(p,text,x,y,z,color=C.ink,size=.3){const t=sprite(text,size,color);t.position.set(x,y,z);p.labels.add(t);return t;}
  function wordPlate(st,i,y,{depth=3,wz=.55,wh=.18,questions=false,back=0,minWidth=0}={}){
    const queries=DATA.queries.filter(q=>q.kind!=='schema'),Q=row(queries,q=>clamp(.4+.12*q.name.length,.8,2.6),.3);
    const p=makePlate(st,i,y,Math.max(minWidth,Math.max(WL.total,questions?Q.total:0)+1.6),depth+back+(questions?.6:0),-back/2);
    DATA.words.forEach((word,j)=>{p.word[j]=tile(p,WL.xs[j],wz,WL.ws[j],.5,wh,C.word,{word:j,name:word.text});flatText(p.labels,word.text,WL.xs[j],wz+.54,.3,WL.ws[j]);});
    if(questions)queries.forEach((q,j)=>{const index=DATA.queries.indexOf(q),c=qColor(q);p.anchors[index]=tile(p,Q.xs[j],-.75,Q.ws[j],.5,index===S.query?.5:.18,c,{query:index,name:q.name});flatText(p.labels,q.name,Q.xs[j],-.2,.28,Q.ws[j],c);});
    return p;
  }
  function tokenPlate(st,i,y){
    const source=DATA.tokens.findIndex(t=>t.word!==null),rows=[];let current=[];
    DATA.tokens.forEach((t,k)=>{if((k===source||t.kind==='schema')&&current.length){rows.push(current);current=[];}current.push(k);});if(current.length)rows.push(current);
    const layouts=rows.map(ids=>row(ids.map(i=>DATA.tokens[i]),tokW,.08)),extra=1.35*(rows.length-1);
    const p=makePlate(st,i,y,Math.max(...layouts.map(l=>l.total))+1.4,2.3+extra,-extra/2);
    const attention=st.key==='layer'?topAttn(st.layer):null,mx=attention?Math.max(.00001,...attention.filter(([,j])=>j!==S.focus).map(([v])=>v)):1;
    rows.forEach((ids,r)=>{const z=.1-1.35*(rows.length-1-r);ids.forEach((k,j)=>{const t=DATA.tokens[k],q=t.query!==null?DATA.queries[t.query]:null,c=q?qColor(q):t.word!==null?(DATA.tokens.findIndex(a=>a.word===t.word)===k?C.word:C.word2):'#D5DEE8';
      const probability=attention?.find(([,n])=>n===k)?.[0]||0,h=attention?(k===S.focus?.72:.04+.66*clamp(probability/mx,0,1)):.12;
      p.tok[k]=tile(p,layouts[r].xs[j],z,layouts[r].ws[j],.5,h,k===S.focus&&attention?C.ink:c,{token:k,name:t.piece,value:probability,caption:st.key==='layer'?'Attention':'Vocabulary ID '+t.id});flatText(p.labels,t.piece,layouts[r].xs[j],z+.62,.3,layouts[r].ws[j]);
    });});
    if(st.key==='layer'){
      const from=p.tok[S.focus];attention.filter(([v,j])=>j!==S.focus&&v>0).sort((a,b)=>b[0]-a[0]).slice(0,6).forEach(([value,j])=>{
        const to=p.tok[j],a=new THREE.Vector3(from.position.x,TOP+from.userData.target,from.position.z),b=new THREE.Vector3(to.position.x,TOP+to.userData.target,to.position.z),mid=a.clone().lerp(b,.5);mid.y=Math.max(a.y,b.y)+.35+.1*Math.abs(b.x-a.x);
        const tube=new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a,mid,b),32,.012+.03*value/mx,6,false),mat(C.terra));tube.material.opacity=tube.userData.bo=.35+.6*value/mx;p.extra.add(tube);
      });
    }
    return p;
  }
  function paintEntity(p,e){
    const js=DATA.words.flatMap((w,j)=>w.start>=e.start&&w.end<=e.end?[j]:[]);if(!js.length)return;
    const c=labelColor(e.label);js.forEach(j=>{const m=p.word[j];m.material.color.set(c);m.userData.target=.5;m.userData.item={word:j,name:e.text,caption:e.label,value:e.score};});
    const x=(WL.xs[js[0]]-WL.ws[js[0]]/2+WL.xs[js.at(-1)]+WL.ws[js.at(-1)]/2)/2;tag(p,`${e.label} · ${e.score.toFixed(2)}`,x,TOP+1.05,p.word[js[0]].position.z,c,.34);
  }
  function arcBetween(p,a,b,z,height,color,score,label,solid=true,info={}){
    const curve=new THREE.QuadraticBezierCurve3(new THREE.Vector3(a,TOP,z),new THREE.Vector3((a+b)/2,TOP+2*height,z),new THREE.Vector3(b,TOP,z));
    const object=solid?new THREE.Mesh(new THREE.TubeGeometry(curve,40,.035,8,false),mat(color)):new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(28)),new THREE.LineBasicMaterial({color,transparent:true}));
    object.userData={stage:p.idx,item:{name:label,value:score,...info},bo:solid?1:.22};p.extra.add(object);
    if(solid){const m=curve.getPoint(.5);tag(p,`${label} · ${score.toFixed(2)}`,m.x,m.y+.3,z,color);}
    return curve;
  }
  function vectorRows(p,rows,z=-1){
    rows.forEach((r,ri)=>{const n=r.values.length,x=r.x||0,cell=r.cell||.25;
      if(r.floating){const t=tag(p,r.name,x,TOP+1.2,z-ri*.8,C.muted,r.labelSize||.3);if(r.maxWidth&&t.scale.x>r.maxWidth)t.scale.multiplyScalar(r.maxWidth/t.scale.x);}
      else flatText(p.labels,r.name,x,z-ri*.8-.4,r.labelSize||.25,r.maxWidth||null,C.muted);
      r.values.forEach((v,j)=>tile(p,x+(j-(n-1)/2)*cell,z-ri*.8,cell*.76,.32,.04+.35*Math.min(2,Math.abs(v)),v<0?C.warm:C.terra,{name:r.name+' · dimension '+j,value:v,caption:'Activation'}));});
  }
  function routeArrow(p,x,z,tx,tz,color){
    const from=new THREE.Vector3(x,TOP+.17,z),to=new THREE.Vector3(tx,TOP+.17,tz),direction=to.clone().sub(from).normalize();
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([from,to]),new THREE.LineBasicMaterial({color,transparent:true,opacity:.8}));line.userData.bo=.8;p.extra.add(line);
    const tip=new THREE.Mesh(new THREE.ConeGeometry(.08,.22,8),mat(color));tip.position.copy(to);tip.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction);p.extra.add(tip);
  }
  function scorerPlate(st,i,y){
    const d=wordQuestion(DATA,S.query),long=DATA.words.length>12,x=long?WL.xs[S.word]:0;
    const p=wordPlate(st,i,y,{depth:10.8,wz:3.1,wh:.14,minWidth:long?WL.total+16:18});
    if(!d)return p;
    const word=DATA.words[S.word],values=d.probabilities[S.word],c=qColor(d.q);
    vectorRows(p,[{name:'1 · Prepared question · '+d.q.name,values:d.capture.fused,x:x-4.1,cell:.14,labelSize:.34,maxWidth:6,floating:true}],-3.6);
    vectorRows(p,[{name:'2 · Word vector · '+word.text,values:DATA.word_vectors[S.word],x:x+4.1,cell:.14,labelSize:.34,maxWidth:6,floating:true}],-3.6);
    flatText(p.labels,'Same question',x-4.1,-2.9,.29,6,c);flatText(p.labels,'Changes with the word',x+4.1,-2.9,.29,6,C.muted);
    routeArrow(p,x-4.1,-2.5,x-1.4,-2,C.word);routeArrow(p,x+4.1,-2.5,x+1.4,-2,C.word);
    tile(p,x,-1.45,6,.7,.35,C.word2,{name:'Learned comparison network',caption:'Schematic: learned projections, feature interaction, MLP, then sigmoid. Hidden activations are not captured.'});
    tag(p,'3 · Learned scorer + sigmoid',x,TOP+.7,-1.45,C.ink,.36);
    ['start','end','inside'].forEach((name,j)=>{
      const bx=x+(j-1)*2.7,color=[C.terra,C.slate,C.olive][j],prob=values[j];
      routeArrow(p,x,-.85,bx,-.15,color);
      tile(p,bx,.5,1.25,.6,.04+prob*.9,color,{word:S.word,name:word.text+' · '+name+' · '+d.q.name,value:prob,caption:'Captured sigmoid probability'});
      tag(p,prob.toFixed(3),bx,TOP+1.4,.5,color,.4);flatText(p.labels,name,bx,1.15,.37,2,color);
    });
    p.word[S.word].material.color.set(C.ink);p.word[S.word].userData.target=.3;
    tag(p,'Selected word · '+word.text,WL.xs[S.word],TOP+.8,3.1,C.ink,.3);
    flatText(p.labels,'Repeat for every word · click a word to inspect it',x,4.2,.3,16,C.ink);
    flatText(p.labels,'Network and arrows: schematic · input bars and output scores: real',x,4.9,.25,16,C.muted);
    return p;
  }
  function lstmPlate(st,i,y){
    const p=wordPlate(st,i,y,{depth:5.8,wz:1.45,wh:.16,back:1.2});
    const lanes=[{z:-1.45,color:C.terra,direction:1,name:'left → right'},{z:-.05,color:C.slate,direction:-1,name:'right → left'}];
    lanes.forEach(lane=>{
      flatText(p.labels,lane.name,WL.xs[S.word],lane.z-.55,.29,null,lane.color);
      DATA.words.forEach((word,j)=>{
        const chosen=j===S.word;
        tile(p,WL.xs[j],lane.z,WL.ws[j]*.7,.36,chosen?.3:.12,chosen?lane.color:mix(lane.color,C.paper,.55),{word:j,name:word.text+' · '+lane.name,caption:'A numerical summary is carried along this route. Schematic; gate and memory values are not measured here.'});
        const next=j+lane.direction;if(next<0||next>=DATA.words.length)return;
        const a=new THREE.Vector3(WL.xs[j]+lane.direction*WL.ws[j]*.36,TOP+.2,lane.z),b=new THREE.Vector3(WL.xs[next]-lane.direction*WL.ws[next]*.36,TOP+.2,lane.z);
        const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([a,b]),new THREE.LineBasicMaterial({color:lane.color,transparent:true,opacity:.7}));line.userData.bo=.7;p.extra.add(line);
        const arrow=new THREE.Mesh(new THREE.ConeGeometry(.06,.17,8),mat(lane.color));arrow.position.copy(b);arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(lane.direction,0,0));p.extra.add(arrow);
      });
      const dot=new THREE.Mesh(new THREE.SphereGeometry(.14,16,12),mat(lane.color));dot.visible=false;p.extra.add(dot);(p.readers??=[]).push({dot,z:lane.z,direction:lane.direction});
    });
    const x=WL.xs[S.word];
    lanes.forEach(lane=>{
      const a=new THREE.Vector3(x,TOP+.4,lane.z),b=new THREE.Vector3(x,TOP+.28,1.45),mid=a.clone().lerp(b,.5);mid.y+=.65;
      p.extra.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a,mid,b),24,.023,6,false),mat(lane.color)));
    });
    p.word[S.word].material.color.set(C.ink);p.word[S.word].userData.item.caption='This word receives the two directional summaries. See With your sentence for the real before/after numbers.';
    tag(p,DATA.words[S.word].text+' · join both summaries',x,TOP+1.15,1.45,C.ink,.3);
    flatText(p.labels,'Two reading paths · schematic',x,2.4,.27,null,C.muted);
    return p;
  }
  function anchorPlate(st,i,y){
    const d=describeQuestion(DATA,S.query),p=wordPlate(st,i,y,{depth:8.8,wz:2.45,wh:.16,minWidth:16});
    if(!d)return p;
    const {q,capture:a,context,next}=d,c=qColor(q);
    // Connections illustrate the operation; only the bars encode measured tensor values.
    const arrow=(...args)=>routeArrow(p,...args);
    if(a){
      p.anchors[a.parent]=tile(p,-3.1,-3,3.5,.62,.25,C.word,{query:a.parent,name:context,caption:'Parent anchor: contextualized task-group marker.'});
      p.anchors[S.query]=tile(p,3.1,-3,3.5,.62,.4,c,{query:S.query,name:q.name,caption:'Contextualized label marker, before fusion.'});
      flatText(p.labels,'1 · Task context',-3.1,-3.8,.38,4,C.muted);
      flatText(p.labels,'2 · Label to find',3.1,-3.8,.38,4,c);
      flatText(p.labels,context,-3.1,-2.4,.38,4,C.ink);
      flatText(p.labels,q.name,3.1,-2.4,.4,4,c);
      flatText(p.labels,'+',0,-3,.45,null,C.muted);
      arrow(-3.1,-1.95,-1.2,-.8,C.word);arrow(3.1,-1.95,1.2,-.8,c);
      vectorRows(p,[{name:'3 · Prepared question · '+q.name,values:a.fused,labelSize:.36,maxWidth:12}],-.05);
      flatText(p.labels,'Combine both vectors · learned linear layer',0,1,.29,13,C.muted);
      arrow(0,1.45,0,1.95,c);
    }else{
      const text=q.kind==='relation'?'Relation marker · '+q.name:'Task context · '+q.name;
      vectorRows(p,[{name:text,values:DATA.layers.at(-1).strip[q.token]}],-1.3);
      flatText(p.labels,q.kind==='relation'?'Relation labels follow the separate pair-scoring route':'Choose a label to combine it with this context',0,0,.3,14,C.muted);
    }
    flatText(p.labels,next,0,3.4,.28,Math.max(14,WL.total),C.ink);
    flatText(p.labels,'Arrows: schematic · bars: 32 real vector dimensions',0,4,.24,14,C.muted);
    return p;
  }
  function pagePlate(st,i,y){
    const ratio=DATA.document.width/DATA.document.height,depth=11,width=depth*ratio,p=makePlate(st,i,y,width+1,depth+1);
    const texture=new THREE.TextureLoader().load(DATA.document.image);texture.colorSpace=THREE.SRGBColorSpace;
    const page=new THREE.Mesh(new THREE.PlaneGeometry(width,depth),new THREE.MeshBasicMaterial({map:texture}));page.rotation.x=-Math.PI/2;page.position.y=TOP+.005;p.extra.add(page);p.imageTexture=texture;
    DATA.words.forEach((word,j)=>{const b=word.bbox;if(!b)return;const x=((b[0]+b[2])/2/1000-.5)*width,z=((b[1]+b[3])/2/1000-.5)*depth,values=DATA.spatial?.strip[DATA.tokens.findIndex(t=>t.word===j)]||[];
      const value=Math.sqrt(values.reduce((a,v)=>a+v*v,0));p.word[j]=tile(p,x,z,Math.max(.035,(b[2]-b[0])/1000*width),Math.max(.03,(b[3]-b[1])/1000*depth),st.key==='spatial'?.03+.15*value:.025,C.slate,{word:j,name:word.text,caption:st.key==='spatial'?'Norm of 32 displayed spatial dimensions':'Document box',value:st.key==='spatial'?value:undefined});p.word[j].material.opacity=.55;
    });return p;
  }
  function recordPlate(st,i,y){
    const d=wordQuestion(DATA,S.query),rec=DATA.stages.records[d?.capture.task==='structuring'?d.capture.indices[0]:0];
    if(st.key==='slots'){
      const p=makePlate(st,i,y,14,9.4);rec.objectness.forEach((prob,id)=>{const x=(id%10-4.5)*1.22,z=(Math.floor(id/10)-4.5)*.8;tile(p,x,z,1,.4,.03+1.3*prob,id===S.slot?C.terra:mix(C.slate,C.paper,.2),{slot:id,name:'Record slot '+id,value:prob});flatText(p.labels,String(id),x,z+.32,.2,1,C.muted);if(prob>DATA.input.threshold)tag(p,prob.toFixed(2),x,TOP+1.3*prob+.35,z,C.terra,.24);});return p;
    }
    if(st.key==='hierarchy'){
      const ids=rec.slot_order.filter(id=>rec.objectness[id]>.05).slice(0,12),p=makePlate(st,i,y,Math.max(10,ids.length*1.7),7);
      ids.forEach((id,j)=>{const x=(j-(ids.length-1)/2)*1.7;tile(p,x,0,1,.6,.05+rec.objectness[id],id===S.slot?C.terra:C.slate,{slot:id,name:'Slot '+id,value:rec.objectness[id]});tag(p,'Slot '+id,x,1.5,0,C.ink);});
      const links=[];ids.forEach((a,j)=>ids.forEach((b,k)=>{const value=rec.anchor_relations?.[a]?.[b]||0;if(j!==k&&value>DATA.input.threshold)links.push({j,k,value});}));links.sort((a,b)=>b.value-a.value).slice(0,12).forEach(({j,k,value},n)=>arcBetween(p,(j-(ids.length-1)/2)*1.7,(k-(ids.length-1)/2)*1.7,-.5-n*.25,.65,C.terra,value,'anchor link',true));return p;
    }
    const p=wordPlate(st,i,y,{wz:.9,wh:.06,back:2.5});
    if(st.key==='fields')rec.spans.slice(0,60).forEach((span,n)=>{const probs=rec.field_probs[n],best=probs.indexOf(Math.max(...probs)),a=WL.xs[span.s]-WL.ws[span.s]/2,b=WL.xs[span.e]+WL.ws[span.e]/2;arcBetween(p,a,b,-.25-(n%4)*.45,.3+.12*(span.e-span.s),LC(best),probs[best],rec.fields[best],probs[best]>DATA.input.threshold,{span});});
    else{
      const obj=rec.objectness[S.slot];tile(p,0,-2,2,.7,.1+obj,LC(S.slot),{slot:S.slot,name:'Record slot '+S.slot,value:obj});tag(p,`Record slot ${S.slot} · ${obj.toFixed(2)}`,0,TOP+obj+.65,-2,LC(S.slot));
      rec.spans.forEach((span,n)=>{const prob=rec.memberships[S.slot][n],best=rec.field_probs[n].indexOf(Math.max(...rec.field_probs[n]));if(prob<.01)return;const x=(WL.xs[span.s]+WL.xs[span.e])/2;
        const a=new THREE.Vector3(0,TOP+.1+obj,-2),b=new THREE.Vector3(x,TOP+.12,.9),m=a.clone().lerp(b,.5);m.y+=.7+prob;
        const curve=new THREE.QuadraticBezierCurve3(a,m,b),line=new THREE.Mesh(new THREE.TubeGeometry(curve,30,prob>DATA.input.threshold?.035:.01,6,false),mat(LC(best)));line.userData.bo=prob>DATA.input.threshold?1:.2;p.extra.add(line);if(prob>DATA.input.threshold)tag(p,`${rec.fields[best]} · ${prob.toFixed(2)}`,x,TOP+.8,.9,LC(best),.26);
      });
    }return p;
  }
  function buildPlate(st,i,y){
    const key=st.key;
    if(['tokens','embed','layer'].includes(key))return tokenPlate(st,i,y);
    if(['document','spatial'].includes(key))return pagePlate(st,i,y);
    if(['fields','slots','membership','hierarchy'].includes(key))return recordPlate(st,i,y);
    if(key==='rnn')return lstmPlate(st,i,y);
    if(key==='anchors')return anchorPlate(st,i,y);
    if(key==='scorer')return scorerPlate(st,i,y);
    if(key==='classification'){
      const groups=DATA.stages.classes,layouts=groups.map(g=>row(g.labels,l=>clamp(.6+.13*l.length,1.2,3),.5)),p=makePlate(st,i,y,Math.max(8,...layouts.map(l=>l.total))+2,1.9*groups.length+1.2,-.95*(groups.length-1));
      groups.forEach((g,k)=>g.labels.forEach((label,j)=>{const prob=g.probs[j],chosen=(DATA.result.classification?.[0]?.[k]||[]).some(p=>p.class_name===label),x=layouts[k].xs[j],z=.2-1.9*k,h=.05+1.5*prob;tile(p,x,z,layouts[k].ws[j],.6,h,chosen?C.cls:mix(C.cls,C.paper,.62),{name:g.group+': '+label,value:prob});flatText(p.labels,label,x,z+.65,.3,layouts[k].ws[j],C.cls);if(chosen)tag(p,`${g.group}: ${label} · ${prob.toFixed(2)}`,x,TOP+h+.35,z,C.cls);}));return p;
    }
    if(key==='embedding'||key==='result'&&DATA.embeddings){
      const em=DATA.embeddings,p=makePlate(st,i,y,16,2+em.texts.length*1.5,-.75*(em.texts.length-1));em.texts.forEach((text,j)=>{const z=-j*1.5,prob=em.similarities[0][j];tile(p,0,z,Math.max(.1,Math.abs(prob)*5),.5,.15,prob<0?C.warm:C.terra,{name:text,value:prob,caption:'Cosine similarity'});flatText(p.labels,text,0,z+.6,.3,14,C.ink);tag(p,prob.toFixed(3),4,TOP+.5,z,C.terra);});return p;
    }
    const p=wordPlate(st,i,y,{questions:['input','words'].includes(key),wz:['pairs','relations','result'].includes(key)?.9:.55,wh:['entities','result','bio'].includes(key)?.06:.18,back:key==='bio'?1.3:['pairs','relations'].includes(key)?1.5:0});
    if(key==='entities'||key==='result')(DATA.result.ner?.[0]||[]).forEach(e=>paintEntity(p,e));
    if(key==='bio'){
      const d=wordQuestion(DATA,S.query),bio=DATA.stages.bio[d?.capture.task==='ner'?d.capture.indices[0]:0],q=Math.min(S.bioLabel,bio.labels.length-1);DATA.words.forEach((w,j)=>{const values=bio.probs[j][q];p.word[j].userData.target=.04+.8*values[2];p.word[j].material.color.set(mix(C.word2,C.olive,values[2]));tile(p,WL.xs[j],-.1,.23,.28,.03+1.3*values[0],C.terra,{word:j,name:w.text+' · start',value:values[0]});tile(p,WL.xs[j],-.65,.23,.28,.03+1.3*values[1],C.slate,{word:j,name:w.text+' · end',value:values[1]});});flatText(p.labels,'start',WL.xs[0]-1.2,-.1,.25,null,C.terra);flatText(p.labels,'end',WL.xs[0]-1.2,-.65,.25,null,C.slate);flatText(p.labels,'inside = word height',0,1.8,.28,null,C.olive);flatText(p.labels,'Prepared question · '+bio.labels[q],0,-1.35,.38,14,labelColor(bio.labels[q]));
    }
    if(key==='words'){
      const sim=DATA.layers.at(-1).similarity[S.query];if(sim){const min=Math.min(...sim),max=Math.max(...sim);p.word.forEach((m,j)=>m.userData.target=.06+.62*(sim[j]-min)/(max-min||1));}
    }
    if(['pairs','relations','result'].includes(key)){
      const pairs=DATA.stages.pairs||[];pairs.slice(0,50).forEach((pair,n)=>{const kept=pair.score>DATA.input.threshold;if(key==='result'&&!kept)return;const a=(WL.xs[pair.head.s]+WL.xs[pair.head.e])/2,b=(WL.xs[pair.tail.s]+WL.xs[pair.tail.e])/2,z=.2-.75*DATA.input.relations.indexOf(pair.relation),c=LC(DATA.input.relations.indexOf(pair.relation));const curve=arcBetween(p,a,b,z,.3+.08*Math.abs(b-a)+(kept?.5*pair.score:0),c,pair.score,pair.relation,key!=='pairs'&&kept,{pair});if(kept&&key!=='pairs'){const tip=new THREE.Mesh(new THREE.ConeGeometry(.11,.26,12),mat(c));tip.rotation.x=Math.PI;tip.position.set(b,TOP+.14,z);p.extra.add(tip);} });
    }
    return p;
  }
  const RAISED=new Set(['scorer','bio','entities','classification','pairs','relations','fields','slots','membership','hierarchy','result','rnn','anchors','embedding']);
  function buildTower(){
    sync();if(!DATA)return;dispose(tower);dispose(map);cache.forEach(v=>{v.tex.dispose();v.mat.dispose();});cache.clear();plates=[];
    WL=row(DATA.words,wordW,.34);let y=0;
    STEPS.forEach((st,i)=>{if(i)y+=st.key==='layer'?1.1:RAISED.has(STEPS[i-1].key)?3.2:2.6;plates.push(buildPlate(st,i,y));});
    plates.forEach(p=>p.tiles.forEach(m=>{m.scale.y=m.userData.h=m.userData.target;m.position.y=TOP+m.userData.h/2;}));refreshFocus(false);
  }
  let focusKey='';
  function refreshFocus(rebuild=true){
    sync();if(!DATA||!plates.length)return;
    const signature=[S.step,S.focus,S.query,S.head,S.word,S.slot,S.bioLabel].join(':'),index=S.step;
    if(rebuild&&signature!==focusKey&&plates[index]){const old=plates[index];tower.remove(old.group);old.imageTexture?.dispose();dispose(old.group);plates[index]=buildPlate(old.st,index,old.y);plates[index].op=old.op;}
    focusKey=signature;
    plates.forEach((p,j)=>{const on=S.overview||S.intro||j===index;p.target=on?1:j>index?0:.07;p.labels.visible=S.overview||S.intro?p.st.key==='input'||j===plates.length-1:on;p.title.visible=S.overview||S.intro;p.tiles.forEach(m=>m.castShadow=!S.overview&&!S.intro&&on);});
  }
  let tween=null;
  function fly(position,target,duration=950){if(matchMedia('(prefers-reduced-motion: reduce)').matches)duration=0;tween={p0:camera.position.clone(),t0:controls.target.clone(),p1:position,t1:target,start:performance.now(),duration};}
  function fitDistance(w,h){const fv=THREE.MathUtils.degToRad(camera.fov/2);return Math.max(w/2/(Math.tan(fv)*camera.aspect),h/2/Math.tan(fv));}
  function aimSun(tgt,w){sun.target.position.copy(tgt);sun.position.copy(tgt).add(new THREE.Vector3(-8,22,12));const sc=sun.shadow.camera,r=w/2+3;sc.left=-r;sc.right=r;sc.top=r;sc.bottom=-r;sc.near=1;sc.far=180;sc.updateProjectionMatrix();}
  function focusStage(){sync();const p=plates[S.step];if(!p)return;let span=p.width+3,x=0;
    if(p.st.key==='anchors')span=Math.min(span,22);
    if(p.st.key==='scorer'){span=20;x=DATA.words.length>12?WL.xs[S.word]:0;}
    if(p.st.key==='rnn'&&DATA.words.length>12){const left=Math.max(0,S.word-3),right=Math.min(DATA.words.length-1,S.word+3);x=WL.xs[S.word];span=Math.max(15,WL.xs[right]-WL.xs[left]+5);}
    if(p.tok.length){const xs=[p.tok[S.focus].position.x];if(p.st.key==='layer')topAttn(p.st.layer).filter(([,j])=>j!==S.focus).sort((a,b)=>b[0]-a[0]).slice(0,6).forEach(([,j])=>xs.push(p.tok[j].position.x));x=(Math.min(...xs)+Math.max(...xs))/2;span=Math.max(Math.max(...xs)-Math.min(...xs)+5,12);}
    const raised=RAISED.has(p.st.key),dist=clamp(fitDistance(span,p.st.key==='scorer'?9.5:raised?7:Math.max(5,p.depth+1.5)),8,60),visW=2*dist*Math.tan(THREE.MathUtils.degToRad(camera.fov/2))*camera.aspect,half=Math.max(0,p.width/2-visW/2+1.5),target=new THREE.Vector3(clamp(x,-half,half),p.y+(raised?.8:.3),.2+p.cz);
    fly(target.clone().addScaledVector(new THREE.Vector3(0,1,1).normalize(),dist),target);aimSun(target,Math.max(visW,p.width));
  }
  function towerCamera(){if(!plates.length)return;const h=plates.at(-1).y,w=Math.max(...plates.map(p=>p.width)),target=new THREE.Vector3(0,h/2,0),dist=clamp(fitDistance(w*1.05,h+8)*1.2,12,180);fly(target.clone().addScaledVector(new THREE.Vector3(.62,.32,1).normalize(),dist),target,1200);aimSun(target,Math.max(w,h));}
  function resize(){const r=canvas.parentElement.getBoundingClientRect();if(!r.width||!r.height)return;renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;if(S.intro&&r.width>760)camera.setViewOffset(r.width,r.height,-r.width*.2,0,r.width,r.height);else camera.clearViewOffset();camera.updateProjectionMatrix();}
  let mapPoints=[],mapTrails=[],nearest=null;
  function buildMap(){sync();if(!DATA)return;dispose(map);mapPoints=[];mapTrails=[];nearest=null;DATA.tokens.forEach((t,i)=>{const q=t.query!==null?DATA.queries[t.query]:null,c=q?qColor(q):t.word!==null?C.word:C.muted,r=q?.2:t.word!==null?.13:.08,m=new THREE.Mesh(new THREE.SphereGeometry(r,16,12),mat(c));m.userData={item:{token:i,name:t.piece}};map.add(m);mapPoints.push(m);if(q||t.word!==null&&DATA.tokens.findIndex(a=>a.word===t.word)===i){const label=sprite(q?q.name:DATA.words[t.word].text,q?.32:.27,q?qColor(q):C.ink);map.add(label);m.userData.tag=label;}});updateMap(true);}
  function setTrails(enabled){
    if(!DATA)return;
    if(enabled&&!mapTrails.length)DATA.tokens.forEach((token,i)=>{const points=DATA.layers.map(l=>new THREE.Vector3(...l.pos[i]).multiplyScalar(3.6)),line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(new THREE.CatmullRomCurve3(points).getPoints(70)),new THREE.LineBasicMaterial({color:token.word!==null?C.slate:C.terra,transparent:true,opacity:token.word!==null?.3:.12}));map.add(line);mapTrails.push(line);});
    mapTrails.forEach(t=>t.visible=enabled);
  }
  function updateMap(immediate=false){sync();if(!DATA)return;mapPoints.forEach((m,i)=>{m.userData.target=new THREE.Vector3(...DATA.layers[S.layer].pos[i]).multiplyScalar(3.6);if(immediate)m.position.copy(m.userData.target);m.scale.setScalar(i===S.focus?1.4:1);});if(DATA.queries[S.query]){const scores=DATA.layers[S.layer].similarity[S.query],j=scores.indexOf(Math.max(...scores)),a=DATA.queries[S.query].token,b=DATA.tokens.findIndex(t=>t.word===j);if(!nearest){nearest=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),new THREE.LineBasicMaterial({color:C.ink}));map.add(nearest);}nearest.userData.pair=[a,b];}}
  function setView(){sync();tower.visible=S.view==='tower';map.visible=S.view==='map';particles.visible=S.view==='tower';controls.autoRotate=S.intro&&!matchMedia('(prefers-reduced-motion: reduce)').matches;ground.position.y=S.view==='map'?-6:-1.2;}
  const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();
  function pickAt(event,click=false){if(!DATA||S.intro||S.view==='document')return;const r=canvas.getBoundingClientRect();pointer.set((event.clientX-r.left)/r.width*2-1,-(event.clientY-r.top)/r.height*2+1);ray.setFromCamera(pointer,camera);const candidates=S.view==='map'?map.children:plates.filter(p=>p.target===1).map(p=>p.group);const hit=ray.intersectObjects(candidates,true).find(h=>h.object.userData.item||h.object.userData.stage!==undefined);
    if(!hit){options.tooltip(null);return;}const {item,stage}=hit.object.userData;if(click){options.pick(item||{},stage);return;}options.tooltip(item||{name:STEPS[stage].title},event);
  }
  // Small particles carry the same word/token identity to the next plate, as in the reference.
  const particles=new THREE.InstancedMesh(PART_GEO,mat(C.terra),400);particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);particles.count=0;particles.frustumCulled=false;scene.add(particles);let flow=[],flowStart=0;
  function transition(from,to){const a=plates[from],b=plates[to];if(!a||!b)return;flow=[];const first=a.tok.length?a.tok:a.word,last=b.tok.length?b.tok:b.word;
    last.forEach((target,i)=>{if(!target)return;let origin=first[i];if(a.tok.length&&!b.tok.length){const k=DATA.tokens.findIndex(t=>t.word===i);origin=a.tok[k];}if(!origin)return;const start=a.group.localToWorld(new THREE.Vector3(origin.position.x,TOP+origin.userData.target,origin.position.z)),end=b.group.localToWorld(new THREE.Vector3(target.position.x,TOP+target.userData.target,target.position.z));flow.push({start,end,color:target.userData.color});});flow=flow.slice(0,400);flowStart=performance.now();particles.count=flow.length;
  }
  function replayLSTM(){const p=plates[S.step];if(p?.st.key!=='rnn')return;p.readStart=performance.now();p.readers.forEach(r=>r.dot.visible=true);}
  const transform=new THREE.Object3D(),tint=new THREE.Color();
  function frame(now){requestAnimationFrame(frame);if(tween){const t=tween.duration?clamp((now-tween.start)/tween.duration,0,1):1,e=1-(1-t)**3;camera.position.lerpVectors(tween.p0,tween.p1,e);controls.target.lerpVectors(tween.t0,tween.t1,e);if(t===1)tween=null;}controls.update();const dist=camera.position.distanceTo(controls.target);scene.fog.near=dist+30;scene.fog.far=dist*2.5+110;
    plates.forEach(p=>{p.op+=(p.target-p.op)*.14;p.group.visible=p.op>.01;p.base.material.opacity=.15+.85*p.op;p.title.material.opacity=p.op<.05?0:.3+.7*p.op;p.tiles.forEach(m=>{m.material.opacity=p.op;m.userData.h+=(m.userData.target-m.userData.h)*.13;m.scale.y=m.userData.h;m.position.y=TOP+m.userData.h/2;});p.extra.children.forEach(o=>{if(o.material)o.material.opacity=(o.userData.bo??1)*p.op;});});
    plates.forEach(p=>{if(p.readStart===undefined)return;const duration=clamp(DATA.words.length*400,2800,8000),t=(now-p.readStart)/duration;const active=S.view==='tower'&&!S.intro&&!S.overview&&S.step===p.idx;
      p.readers.forEach(reader=>{reader.dot.visible=active&&t<=1;if(!reader.dot.visible)return;const f=reader.direction===1?clamp(t,0,1):1-clamp(t,0,1),position=f*(WL.xs.length-1),j=Math.floor(position),k=Math.min(j+1,WL.xs.length-1);reader.dot.position.set(THREE.MathUtils.lerp(WL.xs[j],WL.xs[k],position-j),TOP+.55,reader.z);});if(!active||t>1)delete p.readStart;
    });
    if(S.view==='map'){mapPoints.forEach(m=>{m.position.lerp(m.userData.target,.08);if(m.userData.tag)m.userData.tag.position.copy(m.position).add(new THREE.Vector3(0,.38,0));});if(nearest?.userData.pair){const [a,b]=nearest.userData.pair,pos=nearest.geometry.attributes.position;pos.setXYZ(0,...mapPoints[a].position.toArray());pos.setXYZ(1,...mapPoints[b].position.toArray());pos.needsUpdate=true;nearest.geometry.computeBoundingSphere();}}
    if(particles.count){const t=(now-flowStart)/1100;if(t>1.3)particles.count=0;else{flow.forEach((p,i)=>{const f=clamp(t-i*.0015,0,1);transform.position.lerpVectors(p.start,p.end,f);transform.scale.setScalar(Math.sin(Math.PI*f)*.9);transform.updateMatrix();particles.setMatrixAt(i,transform.matrix);particles.setColorAt(i,tint.set(p.color));});particles.instanceMatrix.needsUpdate=true;if(particles.instanceColor)particles.instanceColor.needsUpdate=true;}}
    renderer.render(scene,camera);
  }
  resize();requestAnimationFrame(frame);
  return{buildTower,refreshFocus,buildMap,updateMap,resize,towerCamera,introCamera:towerCamera,focusStage,fly,pickAt,setView,setTrails,transition,replayLSTM};
}
