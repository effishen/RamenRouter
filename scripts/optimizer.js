/* RamenRouter checked path refinement. GPL-3.0-or-later. */
function createRamenOptimizer(geometry, yieldTask, copper) {
  'use strict';
  const G=geometry,EPS=1e-8;
  const clone=x=>JSON.parse(JSON.stringify(x));
  const length=points=>points.slice(1).reduce((sum,p,i)=>sum+G.distance(points[i],p),0);
  const wait=typeof yieldTask==='function'?yieldTask:()=>new Promise(resolve=>setTimeout(resolve,0));
  function compact(points){return points.filter((p,i)=>i===0||G.distance(p,points[i-1])>EPS);}
  function shortcuts(a,b){
    const dx=b[0]-a[0],dy=b[1]-a[1],x=Math.abs(dx),y=Math.abs(dy),sx=Math.sign(dx),sy=Math.sign(dy);
    if(x<EPS||y<EPS||Math.abs(x-y)<EPS)return [[a,b]];
    const first=x>y?[a[0]+sx*(x-y),a[1]]:[a[0],a[1]+sy*(y-x)];
    const second=x>y?[a[0]+sx*y,b[1]]:[b[0],a[1]+sy*x];
    return [[a,first,b],[a,second,b]];
  }
  async function optimize(input,options={},emit=()=>{},isCancelled=()=>false,reportWork=()=>{}){
    const measurement=yieldTask?.measurement,finishRefinement=measurement?.begin('refining');
    measurement?.count('refinementRounds');
    let candidateNet=null,pendingCandidates=0;
    const flush=()=>{if(pendingCandidates){measurement?.count('refinementCandidates',pendingCandidates,candidateNet);pendingCandidates=0;}};
    const pause=()=>{flush();return wait();};
    const fillSignatures=new WeakMap(),fillCache=new Map();
    const hasZones=board=>(board.copperZones||[]).length>0;
    function refreshFills(board){if(!hasZones(board))return;if(!copper?.build)throw new Error('Copper-fill refinement support is not loaded.');const signature=JSON.stringify([board.copperZones,board.traces,board.vias]);if(fillSignatures.get(board)===signature)return;if(fillCache.has(signature)){board.copperFills=clone(fillCache.get(signature));fillCache.delete(signature);fillCache.set(signature,board.copperFills);}else{board.copperFills=copper.build(board,options);fillCache.set(signature,board.copperFills);while(fillCache.size>4)fillCache.delete(fillCache.keys().next().value);}fillSignatures.set(board,signature);}
    const validate=board=>{const finish=measurement?.begin('checking');try{refreshFills(board);return G.validate(board);}finally{finish?.();}};
    const connectivity=board=>{const finish=measurement?.begin('checking');try{refreshFills(board);return G.connectivity(board,{airwires:false});}finally{finish?.();}};
    try{
    let lastDetail=0;
    let lastWork=0,workKind=null;
    const work=(kind,processed,total,force=false)=>{
      if(isCancelled())return;const now=Date.now();if(!force&&kind===workKind&&now-lastWork<1200)return;lastWork=now;workKind=kind;reportWork({kind,processed,total});
    };

    let lastSpatial=0,hasSpatial=false,visualCandidateId=0;
    const spatial=(message,activity,makeVisual)=>{const now=Date.now();if(now-lastSpatial<175)return;lastSpatial=now;hasSpatial=true;emit({type:'activity',phase:'optimizing',message,activity:{...activity,visual:makeVisual()}});};
    const clearSpatial=stage=>{if(!hasSpatial)return;hasSpatial=false;lastSpatial=0;emit({type:'activity',phase:'optimizing',activity:{stage,visual:null}});};

    const detail=(message,activity={},force=false)=>{const now=Date.now();if(!force&&now-lastDetail<1200)return;lastDetail=now;emit({type:'progress',phase:'optimizing',message,activity});};
    detail('Checking the route before refinement',{stage:'refinement-check'},true);await pause();
    let board=clone(input);work('checking',0,2,true);const base=validate(board);work('checking',1,2,true);let unrouted=connectivity(board).unrouted;work('checking',2,2,true);
    const nets=new Map(board.nets.map(n=>[n.id,n])),edges=G.boundaryEdges(board);
    let changed=0,removed=0;
    const originalLength=board.traces.reduce((s,t)=>s+length(t.points),0);
    const maxClearance=Math.max(board.defaultClearance||0,...board.nets.map(n=>n.clearance||0));
    let candidatesChecked=0,lastShortcutYield=Date.now(),processedTraces=0;const totalTraces=board.traces.length;work('traces',0,totalTraces,true);
    // Review selected nets first without reordering the copper array: the
    // router relies on its imported-copper prefix during finishing repairs.
    const traceOrder=board.traces.map((_,index)=>index);
    if(board.nets.some(n=>n.preferShort===true))traceOrder.sort((a,b)=>Number(nets.get(board.traces[b].net)?.preferShort===true)-Number(nets.get(board.traces[a].net)?.preferShort===true));
    for(let ordinal=0;ordinal<traceOrder.length&&!isCancelled();ordinal++){
      const index=traceOrder[ordinal];
      const trace=board.traces[index];
      flush();candidateNet=trace.net;
      detail('Refining paths · '+(ordinal+1)+'/'+board.traces.length+' · '+(nets.get(trace.net)?.name||'unnamed net'),{stage:'refinement-traces',processed:ordinal+1,total:board.traces.length,netId:trace.net,netName:nets.get(trace.net)?.name});
      spatial('Inspecting trace · '+(nets.get(trace.net)?.name||'unnamed net'),{stage:'refinement-trace',netId:trace.net,netName:nets.get(trace.net)?.name},()=>({kind:'trace',paths:[{layer:trace.layer,points:trace.points.slice(0,512).map(p=>p.slice(0,2))}],label:trace.points.length>512?'Current trace · first section':'Current trace for refinement'}));
      if(ordinal%6===0){await pause();if(isCancelled())break;}
      if(trace.fixed||index<(options.preserveTraceCount||0)||trace.points.length<3){processedTraces++;work('traces',processedTraces,totalTraces);continue;}
      const net=nets.get(trace.net),ownClear=net?.routingClearance??net?.clearance??0;
      const primitives=G.copper(board).primitives.filter(p=>p.layer===trace.layer&&p.net!==trace.net);
      const obstacleIndex=G.spatialIndex(primitives,Math.max((board.bounds.maxX-board.bounds.minX)/40,trace.width*4));
      function safe(a,b){
        const shape={type:'capsule',a,b,r:trace.width/2,layer:trace.layer};
        if(!G.shapeInsideBoard(shape,board,edges))return false;
        for(const other of obstacleIndex.query(G.shapeBounds(shape),maxClearance+EPS)){
          const clearance=G.clearance(board,trace.net,other.net);
          if(G.distanceShapes(shape,other.shape)+EPS<clearance)return false;
        }
        for(const k of board.keepouts||[]){
          if(k.kind==='via'||(k.layers&&!k.layers.includes(trace.layer)))continue;
          if(G.distanceShapes(shape,k.shape)+EPS<(k.clearance??ownClear))return false;
        }
        return true;
      }
      const previous=trace.points,proposed=[previous[0]];
      let i=0;
      refineTrace:while(i<previous.length-1){
        let chosen=null,end=i+1;
        for(let j=previous.length-1;j>i+1;j--){
          const old=length(previous.slice(i,j+1));
          for(const candidate of shortcuts(previous[i],previous[j])){
            pendingCandidates++;
            if(++candidatesChecked%128===0){work('traces',processedTraces,totalTraces);detail('Trying shorter paths · '+(net?.name||'unnamed net')+' · trace '+(ordinal+1)+'/'+board.traces.length+' · '+candidatesChecked+' shortcuts checked',{stage:'refinement-shortcuts',netId:trace.net,netName:net?.name,processed:ordinal+1,total:board.traces.length,candidates:candidatesChecked});if(Date.now()-lastShortcutYield>=24){await pause();lastShortcutYield=Date.now();}if(isCancelled())break refineTrace;}
            const candidateId=++visualCandidateId;spatial('Testing shortcut · '+(net?.name||'unnamed net'),{stage:'refinement-shortcut',netId:trace.net,netName:net?.name,candidateId},()=>({kind:'candidate',paths:[{layer:trace.layer,points:candidate.map(p=>p.slice(0,2))}],label:'Actual shortcut candidate · being checked'}));
            if(length(candidate)>=old-EPS)continue;
            if(candidate.slice(1).every((p,k)=>safe(candidate[k],p))){chosen=candidate;end=j;break;}
          }
          if(chosen)break;
        }
        if(chosen)proposed.push(...chosen.slice(1));else proposed.push(previous[end]);
        i=end;
      }
      if(isCancelled())break;
      const candidate=compact(proposed);
      if(length(candidate)<length(previous)-EPS){
        trace.points=candidate;
        // Shortcutting a trunk must not disconnect branches that join its interior.
        const next=connectivity(board).unrouted;
        if(next<=unrouted){changed++;unrouted=next;}else trace.points=previous;
      }
      processedTraces++;work('traces',processedTraces,totalTraces);
    }
    flush();
    work('traces',processedTraces,totalTraces,true);
    // A real plane can replace generated point-to-point trunks. Delete only
    // after rebuilding the pour and checking the complete conductive graph.
    let removedTraces=0;
    if(hasZones(board)){
      const planeNets=new Set((board.copperZones||[]).filter(zone=>zone.enabled!==false).map(zone=>zone.net));
      for(let index=board.traces.length-1;index>=(options.preserveTraceCount||0)&&!isCancelled();index--){
        const trace=board.traces[index];if(trace.fixed||trace.fanout||!planeNets.has(trace.net))continue;
        if(index%8===0){await pause();if(isCancelled())break;}
        board.traces.splice(index,1);
        const next=connectivity(board).unrouted,checked=validate(board);
        if(next<=unrouted&&checked.totalViolations<=base.totalViolations&&checked.belowNominalWidthTraceCount<=base.belowNominalWidthTraceCount){removedTraces++;unrouted=next;}
        else board.traces.splice(index,0,trace);
      }
    }
    // Remove electrically redundant generated vias, checking the complete copper graph.
    // A local off-layer escape must still terminate in a real transition even
    // if another same-net path makes that via electrically redundant.
    const escapeVias=new Set();
    for(const trace of board.traces){const net=nets.get(trace.net);if(!net?.useLayers||net.useLayers.includes(trace.layer)||!G.isPermittedLayerEscape(board,trace,net))continue;for(const via of board.vias)if(via.net===trace.net&&[trace.points[0],trace.points[trace.points.length-1]].some(p=>Math.hypot(p[0]-via.x,p[1]-via.y)<EPS))escapeVias.add(via);}
    const totalVias=board.vias.length;let processedVias=0;work('vias',0,totalVias,true);
    detail('Checking redundant vias · '+totalVias+' vias',{stage:'refinement-vias',processed:0,total:totalVias},true);
    for(let index=board.vias.length-1;index>=0&&!isCancelled();index--){
      detail('Checking redundant vias · '+(totalVias-index)+'/'+totalVias+' · '+removed+' removed',{stage:'refinement-vias',processed:totalVias-index,total:totalVias,removed});
      if(index%8===0){await pause();if(isCancelled())break;}
      if(board.vias[index].fixed||index<(options.preserveViaCount||0)||escapeVias.has(board.vias[index])){processedVias++;work('vias',processedVias,totalVias);continue;}
      const via=board.vias[index];measurement?.count('redundantViaChecks',1,via.net);spatial('Testing redundant via · '+(nets.get(via.net)?.name||'unnamed net'),{stage:'refinement-via',netId:via.net,netName:nets.get(via.net)?.name},()=>({kind:'via',points:via.layers.slice(0,64).map(layer=>[via.x,via.y,layer]),label:'Current via · testing whether it is needed'}));board.vias.splice(index,1);
      const next=connectivity(board).unrouted;
      if(next<=unrouted){removed++;unrouted=next;}else board.vias.splice(index,0,via);
      processedVias++;work('vias',processedVias,totalVias);
    }
    work('vias',processedVias,totalVias,true);
    clearSpatial('refinement-final-check');detail('Checking refined route clearances and connectivity',{stage:'refinement-final-check',changed,removed},true);await pause();
    work('checking',0,2,true);const checked=validate(board);work('checking',1,2,true);const beforeConnections=connectivity(input).unrouted;work('checking',2,2,true);
    if(checked.totalViolations>base.totalViolations||checked.clearanceViolations>base.clearanceViolations||checked.belowNominalWidthTraceCount>base.belowNominalWidthTraceCount||unrouted>beforeConnections){
      emit({type:'progress',phase:'optimizing',message:'Refinement rejected by final rule/connectivity check; original checked board retained.'});return input;
    }
    const savings=(originalLength-board.traces.reduce((s,t)=>s+length(t.points),0))*board.units.mmPerUnit;
    emit({type:'progress',phase:'optimizing',message:'Refinement: '+changed+' paths shortened, '+removed+' redundant vias removed'+(removedTraces?', '+removedTraces+' plane-redundant traces removed':'')+', '+savings.toFixed(4)+' mm saved.',board});
    return board;
    }finally{flush();finishRefinement?.();}
  }
  return {optimize};
}
if(typeof globalThis!=='undefined')globalThis.createRamenOptimizer=createRamenOptimizer;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenOptimizer};
