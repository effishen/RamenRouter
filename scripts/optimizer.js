/* RamenRouter checked path refinement. GPL-3.0-or-later. */
function createRamenOptimizer(geometry, yieldTask) {
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
  function padPartitions(connection){
    return connection.components.flatMap(component=>component.groups.filter(group=>group.pads.length).map(group=>({net:String(component.net),pads:group.pads.slice()})));
  }
  function preservesPads(connection,required){
    const membership=new Map();
    for(const component of connection.components)for(let index=0;index<component.groups.length;index++)for(const pad of component.groups[index].pads)membership.set(JSON.stringify([String(component.net),pad]),index);
    return required.every(group=>{let first;for(const pad of group.pads){const member=membership.get(JSON.stringify([group.net,pad]));if(member===undefined)return false;if(first===undefined)first=member;else if(member!==first)return false;}return true;});
  }
  const protectedCopper=item=>item.fixed||item.protected||item.fanout||item.locked||item.preserve||item.attachment||['fix','fixed','protect','protected'].includes(item.type)||['fix','fixed','protect','protected'].includes(item._dsnType);
  function copperIdentity(board,kind,index){const key={pad:'pads',trace:'traces',via:'vias',fill:'copperFills'}[kind];return JSON.stringify([kind,key&&board[key]?.[index]]);}
  function protectedMembers(board,group,options){
    const members=group.pads.map(id=>'pad:'+id);
    for(const item of group.items){const key={trace:'traces',via:'vias',fill:'copperFills'}[item.kind],object=key&&board[key]?.[item.index],prefix=item.kind==='trace'?(options.preserveTraceCount||0):item.kind==='via'?(options.preserveViaCount||0):0;if(object&&(protectedCopper(object)||item.index<prefix))members.push('copper:'+copperIdentity(board,item.kind,item.index));}
    return members;
  }
  function protectedPartitions(board,connection,options){
    return connection.components.flatMap(component=>component.groups.map(group=>({net:String(component.net),keys:protectedMembers(board,group,options)})).filter(group=>group.keys.some(key=>key.startsWith('copper:'))));
  }
  function preservesProtected(board,connection,required,options){
    const groups=new Map(connection.components.map(component=>[String(component.net),component.groups.map(group=>new Set(protectedMembers(board,group,options)))]));
    return required.every(group=>groups.get(group.net)?.some(next=>group.keys.every(key=>next.has(key))));
  }
  // Use object geometry rather than array indices: deleting a harmless island
  // reindexes later traces, but does not create a different physical conflict.
  function noNewRuleViolations(reference,before,candidate,after){
    const issueKey=(issue,board,width=false)=>{
      const pair=issue.a&&issue.b?[copperIdentity(board,issue.a.kind,issue.a.index),copperIdentity(board,issue.b.kind,issue.b.index)].sort():null;
      const kind=width?'trace':issue.kind||(issue.index!==undefined?'via':null),object=kind&&issue.index!==undefined?copperIdentity(board,kind,issue.index):null;
      return JSON.stringify([width?'width':issue.type,issue.layer,issue.net,issue.pad,issue.padstack,issue.keepout,pair,object,issue.via===undefined?null:copperIdentity(board,'via',issue.via)]);
    };
    function match(oldIssues,newIssues,width){
      const known=new Map();for(const issue of oldIssues||[]){const key=issueKey(issue,reference,width);if(!known.has(key))known.set(key,[]);known.get(key).push(issue);}
      for(const issue of newIssues||[]){const old=known.get(issueKey(issue,candidate,width))?.pop();if(!old)return false;if(Number.isFinite(issue.actual)&&Number.isFinite(old.actual)&&issue.actual<old.actual-EPS)return false;if(Number.isFinite(issue.required)&&Number.isFinite(old.required)&&issue.required>old.required+EPS)return false;}
      return true;
    }
    return match(before.violations,after.violations,false)&&match(before.widthDeviations,after.widthDeviations,true);
  }
  // Copper removal must preserve the physical groups of required pads. The
  // aggregate airwire count is insufficient: deleting an unrelated padless
  // island can hide a newly disconnected pair of pads.
  async function cleanup(input,options={},emit=()=>{},isCancelled=()=>false,reportWork=()=>{}){
    const empty={board:input,changed:false,removedTraces:0,trimmedTraces:0,removedVias:0,removedSegments:0};
    if(options.cleanupDangling===false||isCancelled())return empty;
    let board=G.applyBoardEdgeClearance(clone(input),options.boardEdgeClearanceMm),removedTraces=0,trimmedTraces=0,removedVias=0,removedSegments=0,processed=0,lastYield=Date.now();
    const measurement=yieldTask?.measurement;
    const connections=()=>{const finish=measurement?.begin('checking');try{return G.connectivity(board,{airwires:false});}finally{finish?.();}};
    const initial=connections(),required=padPartitions(initial),nets=new Map(board.nets.map(net=>[String(net.id),net]));
    const tracePrefix=Math.max(0,options.preserveTraceCount||0),viaPrefix=Math.max(0,options.preserveViaCount||0);
    const protectedTraces=new Set(board.traces.filter((trace,index)=>protectedCopper(trace)||index<tracePrefix));
    const protectedVias=new Set(board.vias.filter((via,index)=>protectedCopper(via)||index<viaPrefix));
    // Keep a selected-layer escape and its actual transition together, even
    // when an alternate route makes their electrical connection redundant.
    for(const trace of board.traces){const net=nets.get(String(trace.net));if(!net?.useLayers||net.useLayers.includes(trace.layer)||!G.isPermittedLayerEscape(board,trace,net))continue;protectedTraces.add(trace);for(const via of board.vias)if(via.net===trace.net&&G.viaLayers(board,via).includes(trace.layer)&&[trace.points[0],trace.points.at(-1)].some(point=>G.distance(point,[via.x,via.y])<EPS))protectedVias.add(via);}
    const anchors=new Map();let nextAnchor=0;
    for(const object of [...protectedTraces,...protectedVias])anchors.set(object,'protected:'+nextAnchor++);
    const itemObject=item=>item.kind==='trace'?board.traces[item.index]:item.kind==='via'?board.vias[item.index]:null;
    const anchorGroups=initial.components.flatMap(component=>component.groups.map(group=>({net:String(component.net),keys:[...group.pads.map(pad=>'pad:'+pad),...group.items.map(item=>anchors.get(itemObject(item))).filter(Boolean)]})).filter(group=>group.keys.length));
    function preserved(connection){
      if(!preservesPads(connection,required))return false;
      const membership=new Map();
      for(const component of connection.components)for(let index=0;index<component.groups.length;index++){const group=component.groups[index];for(const pad of group.pads)membership.set(JSON.stringify([String(component.net),'pad:'+pad]),index);for(const item of group.items){const key=anchors.get(itemObject(item));if(key)membership.set(JSON.stringify([String(component.net),key]),index);}}
      return anchorGroups.every(group=>{let first;for(const key of group.keys){const member=membership.get(JSON.stringify([group.net,key]));if(member===undefined)return false;if(first===undefined)first=member;else if(member!==first)return false;}return true;});
    }
    const completeNets=new Set(initial.components.filter(component=>component.groups.filter(group=>group.pads.length).length<=1).map(component=>String(component.net)));
    let total=2*(board.traces.length+board.vias.length);
    async function pause(force=false){if(force||Date.now()-lastYield>=20){reportWork({kind:'cleanup',processed,total});await wait();lastYield=Date.now();}return isCancelled();}
    function changedActivity(kind,item){emit({type:'activity',phase:'optimizing',message:"Removing copper that doesn't connect pads",activity:{stage:'refinement-cleanup',netId:item.net,traces:removedTraces,trimmed:trimmedTraces,vias:removedVias,segments:removedSegments,visual:kind==='trace'?{kind:'trace',paths:[{layer:item.layer,points:item.points.map(point=>point.slice())}],label:'Unused trace being removed'}:{kind:'via',points:G.viaLayers(board,item).map(layer=>[item.x,item.y,layer]),label:'Unused via being removed'}}});}
    async function removeIslands(){
      const traces=new Set(),vias=new Set();
      for(const component of connections().components)for(const group of component.groups){if(!completeNets.has(String(component.net))||group.pads.length||!group.items.length)continue;if(group.items.some(item=>item.kind==='fill'||anchors.has(itemObject(item))))continue;for(const item of group.items){const object=itemObject(item);if(object)(item.kind==='trace'?traces:vias).add(object);}}
      if(!traces.size&&!vias.size)return;
      const oldTraces=board.traces,oldVias=board.vias;board.traces=oldTraces.filter(trace=>!traces.has(trace));board.vias=oldVias.filter(via=>!vias.has(via));
      if(!preserved(connections())){board.traces=oldTraces;board.vias=oldVias;return;}
      removedTraces+=traces.size;removedVias+=vias.size;
      const item=traces.values().next().value||vias.values().next().value;changedActivity(traces.size?'trace':'via',item);await pause();
    }
    function terminalFree(trace,index,point){
      return !G.copper(board).primitives.some(primitive=>String(primitive.net)===String(trace.net)&&primitive.layer===trace.layer&&!(primitive.object.kind==='trace'&&primitive.object.index===index)&&G.distancePointShape(point[0],point[1],primitive.shape)<=trace.width/2+EPS);
    }
    function cutPrefix(points,amount){
      for(let index=1;index<points.length;index++){const segment=G.distance(points[index-1],points[index]);if(amount<segment-EPS){const t=amount/segment;return compact([[points[index-1][0]+t*(points[index][0]-points[index-1][0]),points[index-1][1]+t*(points[index][1]-points[index-1][1])],...points.slice(index)]);}amount-=segment;}
      return [];
    }
    emit({type:'progress',phase:'optimizing',message:'Checking unused traces and vias',activity:{stage:'refinement-cleanup'}});
    const finishCheck=measurement?.begin('checking');let baseline;try{baseline=G.validate(board);}finally{finishCheck?.();}
    await pause(true);
    if(isCancelled())return empty;
    // Two passes also handle a tail whose formerly redundant endpoint via was
    // removed during the first pass. No unconnected pad escape is shortened.
    for(let round=0;round<2&&!isCancelled();round++){
      await removeIslands();
      for(let index=board.vias.length-1;index>=0&&!isCancelled();index--){const via=board.vias[index];processed++;if(protectedVias.has(via)||!completeNets.has(String(via.net)))continue;measurement?.count('refinementCandidates',1,via.net);board.vias.splice(index,1);if(preserved(connections())){removedVias++;changedActivity('via',via);}else board.vias.splice(index,0,via);if(await pause())break;}
      for(let index=board.traces.length-1;index>=0&&!isCancelled();index--){const trace=board.traces[index];processed++;if(protectedTraces.has(trace)||!completeNets.has(String(trace.net)))continue;measurement?.count('refinementCandidates',1,trace.net);board.traces.splice(index,1);if(preserved(connections())){removedTraces++;changedActivity('trace',trace);if(await pause())break;continue;}board.traces.splice(index,0,trace);
        for(const reverse of [false,true]){if(isCancelled())break;const old=trace.points,points=reverse?old.slice().reverse():old,span=length(points);if(span<=EPS||!terminalFree(trace,index,points[0]))continue;
          let low=0,high=span;const tolerance=Math.max(trace.width*.0001,EPS*100);
          // Prefix removal is monotonic: shortening the same existing copper
          // cannot restore a physical pad connection lost by a longer cut.
          for(let attempt=0;attempt<24&&high-low>tolerance&&!isCancelled();attempt++){const middle=(low+high)/2,candidate=cutPrefix(points,middle);trace.points=reverse?candidate.slice().reverse():candidate;measurement?.count('refinementCandidates',1,trace.net);if(candidate.length>=2&&preserved(connections()))low=middle;else high=middle;trace.points=old;if(await pause())break;}
          if(isCancelled()){trace.points=old;break;}
          const amount=Math.max(0,low-Math.max(trace.width*.02,EPS*100));if(amount<=Math.max(trace.width*.05,EPS*100))continue;
          const candidate=cutPrefix(points,amount);trace.points=reverse?candidate.slice().reverse():candidate;if(candidate.length>=2&&preserved(connections())){trimmedTraces++;changedActivity('trace',trace);}else trace.points=old;
        }
        if(await pause())break;
      }
    }
    // A needed polyline may still contain a redundant branch or a detour that
    // another same-net path has replaced. Test its existing segments separately
    // without shortening any copper on a net that still needs a connection.
    if((options.segmentCleanup===true||options.reworkExistingRoutes===true)&&!isCancelled()){
      const sources=board.traces.slice(),pieces=new Map(),sourceOf=new Map();
      for(const trace of sources){
        if(protectedTraces.has(trace)||!completeNets.has(String(trace.net))||trace.points.length<3)continue;
        const segments=trace.points.slice(1).map((point,index)=>({...trace,points:[trace.points[index].slice(),point.slice()]}));
        pieces.set(trace,segments);for(let index=0;index<segments.length;index++)sourceOf.set(segments[index],{trace,index});
      }
      if(pieces.size){
        board.traces=sources.flatMap(trace=>pieces.get(trace)||[trace]);
        const splitConnection=connections();
        if(!preserved(splitConnection)||splitConnection.unrouted>initial.unrouted){board.traces=sources;}
        else{
          const rawLimit=Number(options.segmentCleanupMaxCandidates),candidateLimit=Number.isFinite(rawLimit)?Math.max(1,Math.min(16384,Math.floor(rawLimit))):4096;
          const rawTime=Number(options.segmentCleanupTimeMs),timeLimit=Number.isFinite(rawTime)?Math.max(20,Math.min(60000,rawTime)):15000,deadline=Date.now()+timeLimit;
          const targets=initial.components.filter(component=>!completeNets.has(String(component.net))).flatMap(component=>component.groups.flatMap(group=>group.pads)).map(id=>board.pads.find(pad=>pad.id===id)).filter(Boolean);
          const proximity=trace=>targets.length?Math.min(...trace.points.flatMap(point=>targets.map(pad=>Math.hypot(point[0]-pad.x,point[1]-pad.y)))):0;
          const candidates=board.traces.filter(trace=>sourceOf.has(trace)).map((trace,index)=>({trace,index,distance:proximity(trace)})).sort((a,b)=>a.distance-b.distance||a.index-b.index);
          total+=Math.min(candidateLimit,2*(candidates.length+board.vias.length));let checkedCandidates=0;
          emit({type:'progress',phase:'optimizing',message:'Checking redundant route segments',activity:{stage:'refinement-segments',total:candidates.length}});await pause(true);
          const canContinue=()=>!isCancelled()&&checkedCandidates<candidateLimit&&Date.now()<deadline;
          for(let round=0;round<2&&canContinue();round++){
            for(const {trace} of candidates){
              if(!canContinue())break;const index=board.traces.indexOf(trace);if(index<0)continue;
              checkedCandidates++;processed++;measurement?.count('refinementCandidates',1,trace.net);board.traces.splice(index,1);
              const next=connections();if(next.unrouted<=initial.unrouted&&preserved(next)){removedSegments++;changedActivity('trace',trace);}else board.traces.splice(index,0,trace);
              if(await pause())break;
            }
            // Segment removal can leave a transition redundant even when it was
            // needed during the earlier whole-trace pass.
            for(let index=board.vias.length-1;index>=0&&canContinue();index--){
              const via=board.vias[index];if(protectedVias.has(via)||!completeNets.has(String(via.net)))continue;
              checkedCandidates++;processed++;measurement?.count('refinementCandidates',1,via.net);board.vias.splice(index,1);
              const next=connections();if(next.unrouted<=initial.unrouted&&preserved(next)){removedVias++;changedActivity('via',via);}else board.vias.splice(index,0,via);
              if(await pause())break;
            }
          }
          // Rejoin surviving consecutive segments. Untouched polylines keep
          // their original representation, as do all protected routing items.
          const surviving=new Set(board.traces),merged=[];
          for(const trace of sources){
            const segments=pieces.get(trace);if(!segments){if(surviving.has(trace))merged.push(trace);continue;}
            if(segments.every(segment=>surviving.has(segment))){merged.push(trace);continue;}
            let run=null;
            for(const segment of segments){if(!surviving.has(segment)){run=null;continue;}if(run)run.points.push(segment.points[1].slice());else{run={...trace,points:segment.points.map(point=>point.slice())};merged.push(run);}}
          }
          board.traces=merged;
        }
      }
    }
    if(!isCancelled())await removeIslands();
    const finish=measurement?.begin('checking');let checked;try{checked=G.validate(board);}finally{finish?.();}
    if(!preserved(connections())||checked.totalViolations>baseline.totalViolations||checked.clearanceViolations>baseline.clearanceViolations||checked.belowNominalWidthTraceCount>baseline.belowNominalWidthTraceCount||!noNewRuleViolations(input,baseline,board,checked))return empty;
    const changed=!!(removedTraces||trimmedTraces||removedVias||removedSegments);
    if(changed)emit({type:'progress',phase:'optimizing',message:'Cleanup: '+removedTraces+' unused traces removed, '+trimmedTraces+' trace ends trimmed, '+removedVias+' unused vias removed'+(removedSegments?', '+removedSegments+' redundant segments removed':'')+'.',board});
    emit({type:'activity',phase:'optimizing',activity:{stage:'refinement-cleanup',visual:null}});
    return {board:changed?board:input,changed,removedTraces,trimmedTraces,removedVias,removedSegments};
  }
  async function optimize(input,options={},emit=()=>{},isCancelled=()=>false,reportWork=()=>{}){
    const measurement=yieldTask?.measurement,finishRefinement=measurement?.begin('refining');
    measurement?.count('refinementRounds');
    let candidateNet=null,pendingCandidates=0;
    const flush=()=>{if(pendingCandidates){measurement?.count('refinementCandidates',pendingCandidates,candidateNet);pendingCandidates=0;}};
    const pause=()=>{flush();return wait();};
    const validate=board=>{const finish=measurement?.begin('checking');try{return G.validate(board);}finally{finish?.();}};
    const connectivity=board=>{const finish=measurement?.begin('checking');try{return G.connectivity(board,{airwires:false});}finally{finish?.();}};
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
    let board=G.applyBoardEdgeClearance(clone(input),options.boardEdgeClearanceMm);work('checking',0,2,true);const base=validate(board);work('checking',1,2,true);const initialConnections=connectivity(board),requiredPads=padPartitions(initialConnections),requiredProtected=protectedPartitions(input,initialConnections,options);let unrouted=initialConnections.unrouted;work('checking',2,2,true);
    let changed=0,removed=0;
    const originalLength=board.traces.reduce((s,t)=>s+length(t.points),0);
    const cleaned=await cleanup(board,options,emit,isCancelled,reportWork);board=cleaned.board;removed+=cleaned.removedVias;unrouted=connectivity(board).unrouted;
    const nets=new Map(board.nets.map(n=>[n.id,n])),edges=G.boundaryEdges(board);
    const completeNets=new Set(initialConnections.components.filter(component=>component.groups.filter(group=>group.pads.length).length<=1).map(component=>component.net));
    const maxClearance=Math.max(board.crossClassClearance||0,board.defaultClearance||0,...board.nets.map(n=>Math.max(n.routingClearance||0,n.clearance||0)),...Object.values(board.classClearances||{}));
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
      spatial("Checking trace · "+(nets.get(trace.net)?.name||'unnamed net'),{stage:'refinement-trace',netId:trace.net,netName:nets.get(trace.net)?.name},()=>({kind:'trace',paths:[{layer:trace.layer,points:trace.points.slice(0,512).map(p=>p.slice(0,2))}],label:trace.points.length>512?'Current trace · first section':"Trace being checked for a shorter path"}));
      if(ordinal%6===0){await pause();if(isCancelled())break;}
      if(protectedCopper(trace)||index<(options.preserveTraceCount||0)||trace.points.length<3){processedTraces++;work('traces',processedTraces,totalTraces);continue;}
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
            const candidateId=++visualCandidateId;spatial("Trying a shortcut · "+(net?.name||'unnamed net'),{stage:'refinement-shortcut',netId:trace.net,netName:net?.name,candidateId},()=>({kind:'candidate',paths:[{layer:trace.layer,points:candidate.map(p=>p.slice(0,2))}],label:"Proposed shortcut being checked"}));
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
        const next=connectivity(board);
        if(next.unrouted<=unrouted&&preservesPads(next,requiredPads)&&preservesProtected(board,next,requiredProtected,options)){changed++;unrouted=next.unrouted;}else trace.points=previous;
      }
      processedTraces++;work('traces',processedTraces,totalTraces);
    }
    flush();
    work('traces',processedTraces,totalTraces,true);
    // Remove electrically redundant generated vias, checking the complete copper graph.
    // A local off-layer escape must still terminate in a real transition even
    // if another same-net path makes that via electrically redundant.
    const escapeVias=new Set();
    for(const trace of board.traces){const net=nets.get(trace.net);if(!net?.useLayers||net.useLayers.includes(trace.layer)||!G.isPermittedLayerEscape(board,trace,net))continue;for(const via of board.vias)if(via.net===trace.net&&[trace.points[0],trace.points[trace.points.length-1]].some(p=>Math.hypot(p[0]-via.x,p[1]-via.y)<EPS))escapeVias.add(via);}
    const totalVias=board.vias.length;let processedVias=0;work('vias',0,totalVias,true);
    detail("Checking which vias can be removed · "+totalVias+' vias',{stage:'refinement-vias',processed:0,total:totalVias},true);
    for(let index=board.vias.length-1;index>=0&&!isCancelled();index--){
      detail("Checking which vias can be removed · "+(totalVias-index)+'/'+totalVias+' · '+removed+' removed',{stage:'refinement-vias',processed:totalVias-index,total:totalVias,removed});
      if(index%8===0){await pause();if(isCancelled())break;}
      if(protectedCopper(board.vias[index])||index<(options.preserveViaCount||0)||escapeVias.has(board.vias[index])||!completeNets.has(board.vias[index].net)){processedVias++;work('vias',processedVias,totalVias);continue;}
      const via=board.vias[index];measurement?.count('redundantViaChecks',1,via.net);spatial("Checking whether this via is needed · "+(nets.get(via.net)?.name||'unnamed net'),{stage:'refinement-via',netId:via.net,netName:nets.get(via.net)?.name},()=>({kind:'via',points:via.layers.slice(0,64).map(layer=>[via.x,via.y,layer]),label:"Via being checked before removal"}));board.vias.splice(index,1);
      const next=connectivity(board);
      if(next.unrouted<=unrouted&&preservesPads(next,requiredPads)&&preservesProtected(board,next,requiredProtected,options)){removed++;unrouted=next.unrouted;}else board.vias.splice(index,0,via);
      processedVias++;work('vias',processedVias,totalVias);
    }
    work('vias',processedVias,totalVias,true);
    clearSpatial('refinement-final-check');detail("Checking clearances and connections after refinement",{stage:'refinement-final-check',changed,removed},true);await pause();
    work('checking',0,2,true);const checked=validate(board);work('checking',1,2,true);const beforeConnections=connectivity(input).unrouted;work('checking',2,2,true);
    const finalConnections=connectivity(board);
    if(checked.totalViolations>base.totalViolations||checked.clearanceViolations>base.clearanceViolations||checked.belowNominalWidthTraceCount>base.belowNominalWidthTraceCount||unrouted>beforeConnections||!preservesPads(finalConnections,requiredPads)||!preservesProtected(board,finalConnections,requiredProtected,options)||!noNewRuleViolations(input,base,board,checked)){
      emit({type:'progress',phase:'optimizing',message:"The refined route didn’t pass all the checks. Keeping the previous checked board."});return input;
    }
    const savings=(originalLength-board.traces.reduce((s,t)=>s+length(t.points),0))*board.units.mmPerUnit;
    emit({type:'progress',phase:'optimizing',message:'Refinement: '+changed+' paths shortened, '+removed+" unnecessary vias removed"+', '+savings.toFixed(4)+' mm saved.',board});
    return board;
    }finally{flush();finishRefinement?.();}
  }
  return {optimize,cleanup};
}
if(typeof globalThis!=='undefined')globalThis.createRamenOptimizer=createRamenOptimizer;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenOptimizer};
