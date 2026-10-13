/* RamenRouter bounded, checked flexible finishing. GPL-3.0-or-later. */
function createRamenFlexibleFinisher(geometry, yieldTask) {
  'use strict';
  const G=geometry, EPS=1e-8;
  const copy=value=>JSON.parse(JSON.stringify(value));
  const wait=typeof yieldTask==='function'?yieldTask:()=>new Promise(resolve=>setTimeout(resolve,0));
  const key=value=>String(value);
  const length=points=>points.slice(1).reduce((sum,p,i)=>sum+G.distance(points[i],p),0);
  const compact=points=>points.filter((p,i)=>!i||G.distance(p,points[i-1])>EPS).map(p=>p.slice(0,2));
  const clamp=(value,fallback,min,max)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Math.floor(Number(value)))):fallback;

  function padPartitions(connection) {
    return connection.components.map(component=>({net:key(component.net),groups:component.groups.filter(g=>g.pads.length).map(g=>g.pads.map(key))}));
  }
  function preservesPadPartitions(before,connection) {
    const after=new Map(padPartitions(connection).map(c=>[c.net,c.groups.map(g=>new Set(g))]));
    return before.every(component=>component.groups.every(group=>after.get(component.net)?.some(next=>group.every(id=>next.has(id)))));
  }
  function violationKey(v) {
    return JSON.stringify([v.type,v.layer,v.kind,v.index,v.id,v.net,v.pad,v.via,v.keepout,v.padstack,
      v.a&&[v.a.kind,v.a.index,v.a.id,v.a.net],v.b&&[v.b.kind,v.b.index,v.b.id,v.b.net]]);
  }
  function noNewViolations(before,after) {
    const existing=new Map(before.violations.map(v=>[violationKey(v),v]));
    for(const v of after.violations) {
      const old=existing.get(violationKey(v));
      if(!old||Number.isFinite(v.actual)&&Number.isFinite(old.actual)&&v.actual<old.actual-EPS)return false;
    }
    const widths=new Map(before.widthDeviations.map(v=>[JSON.stringify([v.index,v.net,v.layer,v.required]),v]));
    return after.widthDeviations.every(v=>{const old=widths.get(JSON.stringify([v.index,v.net,v.layer,v.required]));return old&&v.actual>=old.actual-EPS;});
  }
  function unfinished(connection) {
    return connection.components.map(c=>({...c,groups:c.groups.filter(g=>g.pads.length)})).filter(c=>c.groups.length>1);
  }
  const physicalRemaining=connection=>unfinished(connection).reduce((sum,c)=>sum+c.groups.length-1,0);
  const objectKey=item=>item.kind==='pad'?'pad:'+key(item.id):item.kind+':'+item.index;
  function protectedAttachments(board,connection,options) {
    const protectedKeys=new Set();
    board.traces.forEach((trace,i)=>{if(protectedTrace(board,trace,i,options))protectedKeys.add('trace:'+i);});
    for(const kind of ['via','fill'])for(const [i,item] of (kind==='via'?board.vias:board.copperFills||[]).entries())
      if(item.fixed||item.protected||item.locked||item.fanout||item.attachment||item.preserve)protectedKeys.add(kind+':'+i);
    return connection.components.flatMap(c=>c.groups.filter(g=>g.items.some(item=>protectedKeys.has(objectKey(item))))
      .map(g=>g.items.filter(item=>item.kind==='pad'||protectedKeys.has(objectKey(item))).map(objectKey)));
  }
  function preservesProtectedAttachments(before,connection) {
    const memberships=new Map();let groupId=0;
    for(const c of connection.components)for(const g of c.groups){for(const item of g.items)memberships.set(objectKey(item),groupId);groupId++;}
    return before.every(group=>group.every(item=>memberships.has(item)&&memberships.get(item)===memberships.get(group[0])));
  }
  function protectedTrace(board,trace,index,options) {
    if(!Array.isArray(trace.points)||trace.points.length<2||trace.points.length>2048)return true;
    if(trace.fixed||trace.protected||trace.locked||trace.fanout||trace.attachment||trace.preserve||trace._dsnType==='protect'||trace._dsnType==='fix')return true;
    if((options.protectedTraceIndexes||[]).includes(index))return true;
    const net=board.nets.find(n=>key(n.id)===key(trace.net));
    if(!net||net.useLayers&&!net.useLayers.includes(trace.layer)||G.isPermittedLayerEscape(board,trace,net))return true;
    // Preserve short original pad-to-via attachments even without a fanout flag.
    const ends=[trace.points[0],trace.points.at(-1)];
    for(const via of board.vias||[]) {
      if(key(via.net)!==key(trace.net)||!G.viaLayers(board,via).includes(trace.layer))continue;
      const def=(board.viaDefs||[]).find(d=>d.name===via.padstack);
      if(!def)continue;
      for(let end=0;end<2;end++)if(G.distance(ends[end],[via.x,via.y])<=EPS) {
        const pad=(board.pads||[]).find(p=>key(p.net)===key(trace.net)&&p.shapes.some(s=>s.layer===trace.layer&&G.pointInShape(ends[1-end][0],ends[1-end][1],s)));
        if(pad&&length(trace.points)<=G.padEscapeLimit(board,pad,net,def)+EPS)return true;
      }
    }
    return false;
  }

  async function improveRoutingBest(input, options={}, emit=()=>{}, isCancelled=()=>false, reportWork=()=>{}) {
    const limits={maxMillis:clamp(options.maxMillis,15000,1,120000),maxTrials:clamp(options.maxTrials,180,1,1200),
      maxNudges:clamp(options.maxNudges,32,0,256),maxSearchNodes:clamp(options.maxSearchNodes,160,12,320),
      maxEdges:clamp(options.maxEdges,40000,32,200000),maxRemainingLinks:clamp(options.maxRemainingLinks,4,1,4),
      beamWidth:clamp(options.beamWidth,4,1,4),maxNudgeDepth:clamp(options.maxNudgeDepth,3,1,3)};
    const hasHostClock=typeof yieldTask?.now==='function',clock=hasHostClock?()=>yieldTask.now():()=>Date.now();
    const started=clock(),measurement=yieldTask?.measurement,finishMeasurement=measurement?.begin('refining');
    let board=G.applyBoardEdgeClearance(copy(input),options.boardEdgeClearanceMm),attempts=0,nudges=0,edgeChecks=0,commits=0,lastYield=Date.now(),lastProgress=-Infinity,pausedMillis=0,lastPathFrontier=1,lastConnectFrontier=1;
    board.traces=board.traces||[];board.vias=board.vias||[];
    const diagnostics={stage:'flexible-finishing',limits,accepted:0,rejected:0,nudgesTried:0,edgeChecks:0,reason:null};
    const activeElapsed=()=>Math.max(0,clock()-started-(hasHostClock?0:pausedMillis));
    const halted=()=>isCancelled()||activeElapsed()>=limits.maxMillis||edgeChecks>=limits.maxEdges;
    const stopped=()=>halted()||attempts>=limits.maxTrials;
    if(isCancelled()){diagnostics.reason='cancelled';finishMeasurement?.();return {board,model:board,attempts,diagnostics,changed:false,stopped:true};}
    const progress=(message,detail={},force=false)=>{
      if(!force&&Date.now()-lastProgress<200)return;
      lastProgress=Date.now();const work={kind:'flexible-finishing',processed:attempts,total:limits.maxTrials,nudges,edgeChecks,...detail};
      reportWork(work);emit({type:'progress',phase:'flexible-finishing',message,activity:{stage:'flexible-finishing',...work}});
    };
    async function pause(force=false) {if(force||Date.now()-lastYield>=16){const at=Date.now();await wait();pausedMillis+=Date.now()-at;lastYield=Date.now();}return !halted();}
    function checkedConnection(candidate){return G.connectivity(candidate,{airwires:false});}
    function exactContext(candidate,net,layer) {
      const primitives=G.copper(candidate).primitives.filter(p=>p.layer===layer&&key(p.net)!==key(net.id));
      const span=Math.max(candidate.bounds.maxX-candidate.bounds.minX,candidate.bounds.maxY-candidate.bounds.minY,net.width);
      const index=G.spatialIndex(primitives,Math.max(span/40,net.width*4)),edges=G.boundaryEdges(candidate);
      const maxClear=Math.max(candidate.defaultClearance||0,candidate.crossClassClearance||0,...candidate.nets.map(n=>n.clearance||0));
      const half=net.width/2,ownClear=net.routingClearance??net.clearance??candidate.defaultClearance??0;
      function blockers(a,b) {
        const shape={type:'capsule',a,b,r:half,layer},out=[];
        if(!G.shapeInsideBoard(shape,candidate,edges))return [{boundary:true}];
        for(const other of index.query(G.shapeBounds(shape),maxClear+EPS))if(G.distanceShapes(shape,other.shape)+EPS<G.clearance(candidate,net.id,other.net)||G.distanceShapes(shape,other.shape)<=EPS)out.push(other);
        for(const k of candidate.keepouts||[])if(k.kind!=='via'&&(!k.layers||k.layers.includes(layer))) {
          const gap=G.distanceShapes(shape,k.shape);if(gap+EPS<(k.clearance??ownClear)||gap<=EPS)out.push({keepout:true,shape:k.shape,net:null,clearance:k.clearance??ownClear});
        }
        return out;
      }
      return {primitives,index,edges,half,ownClear,maxClear,blockers,safe:(a,b)=>!blockers(a,b).length};
    }
    function nearestPairs(component,net,candidate) {
      const layers=new Set(net.useLayers||candidate.layers.map((l,i)=>l.index??i)),pairs=[];
      for(let i=0;i<component.groups.length;i++)for(let j=i+1;j<component.groups.length;j++) {
        const sample=group=>group.points.filter(p=>layers.has(p[2])).slice(0,48);
        for(const a of sample(component.groups[i]))for(const b of sample(component.groups[j]))if(a[2]===b[2])pairs.push({a:a.slice(0,2),b:b.slice(0,2),layer:a[2],distance:G.distance(a,b)});
      }
      pairs.sort((a,b)=>a.distance-b.distance);const result=[],seen=new Set();
      for(const pair of pairs){const tag=JSON.stringify([pair.a,pair.b,pair.layer]);if(!seen.has(tag)){result.push(pair);seen.add(tag);}if(result.length===12)break;}
      return result;
    }
    async function pathFor(candidate,net,pair) {
      lastPathFrontier=1;
      const ctx=exactContext(candidate,net,pair.layer),a=pair.a,b=pair.b;
      if(ctx.safe(a,b)){lastPathFrontier=0;return [a,b];}
      const nodes=[],seen=new Set(),margin=Math.max(net.width*1e-4,EPS*100);
      const add=p=>{if(nodes.length>=limits.maxSearchNodes||!p.every(Number.isFinite))return;const tag=p.map(v=>v.toPrecision(12)).join(',');if(seen.has(tag)||!ctx.safe(p,p))return;seen.add(tag);nodes.push(p);};
      add(a);add(b);if(nodes.length<2||G.distance(nodes[0],a)>EPS||G.distance(nodes[1],b)>EPS)return null;
      // Exact-clearance visibility vertices allow arbitrary bends and snakes;
      // no raster snapping or eight-direction restriction is used here.
      const box=G.shapeBounds({type:'capsule',a,b,r:Math.max(pair.distance*.35,net.width*8)});
      const obstacles=ctx.index.query(box,ctx.maxClear+ctx.half).map(p=>({shape:p.shape,gap:G.clearance(candidate,net.id,p.net)}));
      for(const k of candidate.keepouts||[])if(k.kind!=='via'&&(!k.layers||k.layers.includes(pair.layer)))obstacles.push({shape:k.shape,gap:k.clearance??ctx.ownClear});
      obstacles.sort((x,y)=>G.distanceSegmentShape(...a,...b,x.shape)-G.distanceSegmentShape(...a,...b,y.shape));
      for(const {shape,gap} of obstacles) {
        const d=ctx.half+gap+margin;
        if(shape.type==='circle'||shape.type==='capsule') {
          const centers=shape.type==='circle'?[[shape.cx,shape.cy]]:[shape.a,shape.b];
          const radius=(shape.r+d)/Math.cos(Math.PI/8);
          for(const p of centers)for(let i=0;i<8;i++){const t=i*Math.PI/4;add([p[0]+Math.cos(t)*radius,p[1]+Math.sin(t)*radius]);}
          if(shape.type==='capsule') {
            const dx=shape.b[0]-shape.a[0],dy=shape.b[1]-shape.a[1],len=Math.hypot(dx,dy),offset=shape.r+d;
            if(len>EPS)for(const t of [.25,.5,.75])for(const sign of [-1,1])add([shape.a[0]+dx*t-sign*dy/len*offset,shape.a[1]+dy*t+sign*dx/len*offset]);
          }
        } else {
          const bounds=G.shapeBounds(shape);
          for(const x of [bounds.minX-d,bounds.maxX+d])for(const y of [bounds.minY-d,bounds.maxY+d])add([x,y]);
        }
        if(!await pause())return null;
      }
      const dist=new Float64Array(nodes.length);dist.fill(Infinity);dist[0]=0;
      const previous=new Int32Array(nodes.length);previous.fill(-1);const closed=new Uint8Array(nodes.length);
      for(let count=0;count<nodes.length&&!stopped();count++) {
        let at=-1;for(let i=0;i<nodes.length;i++)if(!closed[i]&&Number.isFinite(dist[i])&&(at<0||dist[i]<dist[at]))at=i;
        if(at<0)break;lastPathFrontier=Math.min(lastPathFrontier,G.distance(nodes[at],b)/Math.max(pair.distance,EPS));
        if(at===1){const path=[];for(let n=1;n>=0;n=previous[n])path.push(nodes[n]);return compact(path.reverse());}
        closed[at]=1;
        for(let j=0;j<nodes.length&&!stopped();j++)if(!closed[j]) {
          const next=dist[at]+G.distance(nodes[at],nodes[j]);if(next>=dist[j])continue;
          edgeChecks++;if(ctx.safe(nodes[at],nodes[j])){dist[j]=next;previous[j]=at;}
          if((edgeChecks&31)===0){progress('Trying flexible paths',{netId:net.id,netName:net.name});if(!await pause())return null;}
        }
      }
      return null;
    }
    const geometrySignature=JSON.stringify([board.pads,board.outlines,board.holes,board.keepouts,board.layers,board.nets,board.viaDefs,board.units,board.bounds,board.edgeClearance,board.boardEdgeClearanceMm]);
    const originalConnection=checkedConnection(board),originalPartitions=padPartitions(originalConnection),originalAnchors=protectedAttachments(board,originalConnection,options),originalValidation=G.validate(board);
    let connection=originalConnection,validation=originalValidation,requiredPartitions=originalPartitions,requiredAnchors=originalAnchors;
    async function consider(candidate,previousConnection) {
      if(stopped())return false;attempts++;measurement?.count('refinementCandidates');
      if(JSON.stringify([candidate.pads,candidate.outlines,candidate.holes,candidate.keepouts,candidate.layers,candidate.nets,candidate.viaDefs,candidate.units,candidate.bounds,candidate.edgeClearance,candidate.boardEdgeClearanceMm])!==geometrySignature)return false;
      if(!await pause())return false;
      const next=checkedConnection(candidate);
      if(halted())return false;
      if(next.unrouted>=previousConnection.unrouted||physicalRemaining(next)>=physicalRemaining(previousConnection)||!preservesPadPartitions(requiredPartitions,next)||!preservesProtectedAttachments(requiredAnchors,next)){diagnostics.rejected++;return false;}
      const checked=G.validate(candidate);
      if(!noNewViolations(validation,checked)){diagnostics.rejected++;return false;}
      if(halted())return false;
      board=candidate;connection=next;validation=checked;commits++;diagnostics.accepted++;
      requiredPartitions=padPartitions(next);requiredAnchors=protectedAttachments(board,next,options);
      progress('Flexible finishing connected another gap',{remaining:physicalRemaining(next)},true);
      emit({type:'checkpoint',phase:'flexible-finishing',board:copy(board),stats:G.stats(board,checked,next),validation:copy(checked)});
      await pause(true);return true;
    }
    async function connect(candidate,component,net,baseConnection) {
      lastConnectFrontier=1;
      for(const pair of nearestPairs(component,net,candidate)) {
        if(stopped())return false;const path=await pathFor(candidate,net,pair);
        lastConnectFrontier=Math.min(lastConnectFrontier,lastPathFrontier);
        if(path&&path.length>1) {
          const proposed=copy(candidate);proposed.traces.push({net:net.id,layer:pair.layer,width:net.width,points:path,fixed:false,flexibleFinish:true});
          if(await consider(proposed,baseConnection))return true;
        }
      }
      return false;
    }
    function nudgeCandidates(trace,pair,net) {
      const result=[],maxDistance=Math.max(trace.width,net.width)*1.5;
      // Keep both physical attachment endpoints. A two-point imported route
      // gains a shallow dogleg instead of being shifted away from its pads.
      for(let i=1;i<trace.points.length&&result.length<20;i++) {
        const a=trace.points[i-1],b=trace.points[i],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);if(len<=EPS)continue;
        if(G.distanceSegments(a,b,pair.a,pair.b)>maxDistance+trace.width/2+net.width/2+net.clearance)continue;
        for(const scale of [.25,.5,.75,1,1.5])for(const sign of [-1,1]) {
          const amount=Math.max(trace.width,net.width)*scale,offset=[-dy/len*amount*sign,dx/len*amount*sign];
          const p=[a[0]+offset[0],a[1]+offset[1]],q=[b[0]+offset[0],b[1]+offset[1]];
          result.push({points:compact([...trace.points.slice(0,i),p,q,...trace.points.slice(i)]),distance:amount});
        }
      }
      return result;
    }
    try {
      const eligible=unfinished(connection),remainingLinks=physicalRemaining(connection);
      if(!eligible.length||remainingLinks>limits.maxRemainingLinks){diagnostics.reason=eligible.length?'too-many-remaining-links':'no-disconnected-pad-groups';diagnostics.remainingLinks=remainingLinks;progress(eligible.length?'Flexible finishing needs four or fewer remaining connections. This board has '+remainingLinks+'.':'Every pad is already connected. There are no remaining pad connections to finish.',{remaining:remainingLinks},true);return {board,model:board,attempts,diagnostics,changed:false,stopped:false};}
      progress('Trying flexible finishing for '+eligible.length+' unfinished '+(eligible.length===1?'net':'nets'),{},true);
      await pause(true);
      while(!stopped()) {
        let improved=false;
        for(const component of unfinished(connection)) {
          const net=board.nets.find(n=>key(n.id)===key(component.net));if(!net)continue;
          if(await connect(board,component,net,connection)){improved=true;break;}
          if(stopped()||nudges>=limits.maxNudges)continue;
          let beam=[{board,connection,component,moved:[],frontier:lastConnectFrontier,shift:0}];
          for(let depth=1;depth<=limits.maxNudgeDepth&&!improved&&!stopped()&&nudges<limits.maxNudges;depth++) {
            const next=[];
            for(const state of beam) {
              const pairs=nearestPairs(state.component,net,state.board).slice(0,3),indices=[];
              const meaningfulFrontier=Math.max(.1,Math.min(.25,net.width*2/Math.max(pairs[0]?.distance||net.width,EPS)));
              const promising=()=>next.filter(s=>s.frontier<state.frontier-meaningfulFrontier).length>=limits.beamWidth;
              for(const pair of pairs)for(const blocker of exactContext(state.board,net,pair.layer).blockers(pair.a,pair.b)) {
                const object=blocker.object;
                if(object?.kind==='trace'&&!indices.includes(object.index)&&!state.moved.includes(object.index)&&!protectedTrace(state.board,state.board.traces[object.index],object.index,options))indices.push(object.index);
              }
              // Each retained state can move another distinct blocking trace.
              // Only checked states with the same connection count enter this
              // small beam; none is published until a real pad link improves.
              for(const index of indices.slice(0,2)) {
                const trace=state.board.traces[index];
                for(const move of nudgeCandidates(trace,pairs[0],net)) {
                  const points=move.points;
                  if(stopped()||nudges>=limits.maxNudges)break;attempts++;nudges++;diagnostics.nudgesTried++;
                  measurement?.count('refinementCandidates');
                  progress('Checking a small move in blocking copper',{netId:net.id,netName:net.name,blockingNetId:trace.net,depth},nudges===1);
                  if(!await pause())break;
                  const trial=copy(state.board);trial.traces[index].points=points;
                  const trialConnection=checkedConnection(trial);if(halted())break;
                  const trialValidation=G.validate(trial);
                  if(trialConnection.unrouted!==connection.unrouted||physicalRemaining(trialConnection)!==physicalRemaining(connection)||!preservesPadPartitions(requiredPartitions,trialConnection)||!preservesProtectedAttachments(requiredAnchors,trialConnection)||!noNewViolations(validation,trialValidation)){diagnostics.rejected++;continue;}
                  const changedComponent=unfinished(trialConnection).find(c=>key(c.net)===key(net.id));
                  if(changedComponent&&await connect(trial,changedComponent,net,connection)){improved=true;diagnostics.coordinatedDepth=Math.max(diagnostics.coordinatedDepth||0,depth);break;}
                  if(stopped())break;
                  next.push({board:trial,connection:trialConnection,component:changedComponent,moved:[...state.moved,index],frontier:lastConnectFrontier,shift:state.shift+move.distance});
                  diagnostics.temporaryStates=(diagnostics.temporaryStates||0)+1;
                  if(promising())break;
                }
                if(improved||stopped()||nudges>=limits.maxNudges||promising())break;
              }
              if(improved||stopped()||nudges>=limits.maxNudges)break;
            }
            next.sort((a,b)=>a.frontier-b.frontier||a.shift-b.shift);beam=next.slice(0,limits.beamWidth);
            if(!beam.length)break;
          }
          if(improved)break;
        }
        if(!improved||!unfinished(connection).length)break;
      }
      diagnostics.reason=isCancelled()?'cancelled':activeElapsed()>=limits.maxMillis?'time-limit':attempts>=limits.maxTrials?'trial-limit':edgeChecks>=limits.maxEdges?'edge-limit':commits?'improved':'no-checked-improvement';
      diagnostics.edgeChecks=edgeChecks;
      diagnostics.activeMillis=activeElapsed();diagnostics.pausedMillis=pausedMillis;
      const remaining=physicalRemaining(connection);
      progress(commits?'Flexible finishing kept '+remaining+' remaining '+(remaining===1?'gap':'gaps'):'Flexible finishing kept your checked best result',{remaining},true);
      return {board,model:board,attempts,diagnostics,changed:commits>0,stopped:isCancelled()||activeElapsed()>=limits.maxMillis,validation,connection};
    } finally {finishMeasurement?.();}
  }
  return {finish:improveRoutingBest,improveRoutingBest,preservesPadPartitions,preservesProtectedAttachments};
}
globalThis.createRamenFlexibleFinisher=createRamenFlexibleFinisher;
globalThis.RamenFlexibleFinisher={createRamenFlexibleFinisher};
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenFlexibleFinisher};
