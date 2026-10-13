/* RamenRouter browser-native grid router. GPL-3.0. No Java or external runtime. */
function createRamenRouter(geometry, optimizer, fanout, yieldTask) {
  'use strict';
  const G=geometry, SQRT2=Math.SQRT2, EPS=1e-7;
  const copy=o=>JSON.parse(JSON.stringify(o));
  const yieldNow=typeof yieldTask==='function'?yieldTask:()=>new Promise(r=>setTimeout(r,0));
  const flexibleFinisher=typeof globalThis.createRamenFlexibleFinisher==='function'?globalThis.createRamenFlexibleFinisher(G,yieldTask):null;
  const length=t=>t.points.slice(1).reduce((s,p,i)=>s+Math.hypot(p[0]-t.points[i][0],p[1]-t.points[i][1]),0);
  function rng(seed){return()=>{seed|=0;seed=seed+0x6D2B79F5|0;let x=Math.imul(seed^seed>>>15,1|seed);x=x+Math.imul(x^x>>>7,61|x)^x;return((x^x>>>14)>>>0)/4294967296;};}
  function shuffled(a,random){a=a.slice();for(let i=a.length-1;i>0;i--){let j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
  function netRules(board){return new Map(board.nets.map(n=>[n.id,n]));}
  function bboxPoints(points){let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const p of points){minX=Math.min(minX,p[0]);minY=Math.min(minY,p[1]);maxX=Math.max(maxX,p[0]);maxY=Math.max(maxY,p[1]);}return{minX,minY,maxX,maxY};}
  function overlap(a,b){return a.minX<=b.maxX&&a.maxX>=b.minX&&a.minY<=b.maxY&&a.maxY>=b.minY;}
  function expanded(b,r){return{minX:b.minX-r,minY:b.minY-r,maxX:b.maxX+r,maxY:b.maxY+r};}
  function segmentDistance(x,y,a,b){let dx=b[0]-a[0],dy=b[1]-a[1],v=dx*dx+dy*dy,t=v?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/v)):0;return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);}
  function simplify(points){if(points.length<3)return points;let out=[points[0]];for(let i=1;i<points.length-1;i++){let a=out[out.length-1],b=points[i],c=points[i+1],cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);if(Math.abs(cross)>1e-8)out.push(b);}out.push(points[points.length-1]);return out;}
  function layerDirections(layers){
    // EasyEDA's known numeric sequence lists Bottom before the inner layers.
    // Keep routing IDs untouched; alternate using the physical stack order.
    const easyeda=layers.length>2&&layers.every((layer,i)=>String(layer.name)===String(i<2?i+1:i+19));
    const stack=easyeda?[layers[0],...layers.slice(2),layers[1]]:layers;
    return new Map(stack.map((layer,i)=>[layer.index??layer.id,layers.length<2?null:i%2?'horizontal':'vertical']));
  }
  class Heap {
    constructor(){this.nodes=[];this.costs=[];}
    push(node,cost){let i=this.nodes.length;this.nodes.push(node);this.costs.push(cost);while(i){let p=(i-1)>>1;if(this.costs[p]<=cost)break;this.nodes[i]=this.nodes[p];this.costs[i]=this.costs[p];i=p;}this.nodes[i]=node;this.costs[i]=cost;}
    pop(){if(!this.nodes.length)return null;let n=this.nodes[0],f=this.costs[0],last=this.nodes.pop(),cost=this.costs.pop();if(this.nodes.length){let i=0;while(true){let l=i*2+1;if(l>=this.nodes.length)break;let r=l+1,c=r<this.nodes.length&&this.costs[r]<this.costs[l]?r:l;if(this.costs[c]>=cost)break;this.nodes[i]=this.nodes[c];this.costs[i]=this.costs[c];i=c;}this.nodes[i]=last;this.costs[i]=cost;}return[n,f];}
  }
  const checkedRuleKeys=['totalViolations','clearanceViolations','viaInPadViolations','outlineViolations','keepoutViolations','belowNominalWidthTraceCount'];
  const noRuleRegression=(candidate,reference)=>checkedRuleKeys.every(key=>candidate[key]<=reference[key]);
  const missingPadLinks=connection=>connection.components.reduce((sum,component)=>sum+Math.max(0,component.groups.filter(group=>group.pads.length>0).length-1),0);
  function preservesPadPartitions(before,after){
    const groups=new Map();
    for(const component of after.components)for(const group of component.groups)for(const pad of group.pads)groups.set(String(component.net)+'\0'+pad,group);
    for(const component of before.components)for(const group of component.groups){
      const connected=group.pads.map(pad=>groups.get(String(component.net)+'\0'+pad));
      if(connected.some(group=>!group)||connected.some(group=>group!==connected[0]))return false;
    }
    return true;
  }
  function preservesModelRules(candidate,reference){
    return ['pads','nets','layers','units','bounds','boundary','outlines','fills','copperFills','keepouts','viaKeepouts','viaDefs','viaAtSmd','viaInPadApplied','viaInPadOverride','defaultWidth','defaultClearance','defaultViaName','classClearances','crossClassClearance','clearanceMode','structureClearance','edgeClearance','boardEdgeClearanceMm'].every(key=>JSON.stringify(candidate[key])===JSON.stringify(reference[key]));
  }
  const protectedCopper=item=>item.fixed||item.protected||item.locked||item.preserve||item.fanout||item.attachment||['fix','fixed','protect','protected'].includes(item.type)||['fix','protect'].includes(item._dsnType);
  function preservesProtectedCopper(candidate,reference){
    for(const key of ['traces','vias']){
      const counts=new Map();for(const item of candidate[key]||[]){const signature=JSON.stringify(item);counts.set(signature,(counts.get(signature)||0)+1);}
      for(const item of (reference[key]||[]).filter(protectedCopper)){const signature=JSON.stringify(item),count=counts.get(signature)||0;if(!count)return false;counts.set(signature,count-1);}
    }
    return true;
  }
  function copperIdentity(board,kind,index){const key={pad:'pads',trace:'traces',via:'vias',fill:'copperFills'}[kind];return JSON.stringify([kind,key&&board[key]?.[index]]);}
  function preservesProtectedConnections(reference,before,candidate,after){
    const members=(board,group)=>new Set([...group.pads.map(id=>'pad:'+id),...group.items.filter(item=>{const key={trace:'traces',via:'vias',fill:'copperFills'}[item.kind];return key&&protectedCopper(board[key]?.[item.index]||{});}).map(item=>copperIdentity(board,item.kind,item.index))]);
    const groups=new Map(after.components.map(component=>[String(component.net),component.groups.map(group=>members(candidate,group))]));
    for(const component of before.components)for(const group of component.groups){
      const required=members(reference,group);if(![...required].some(id=>!id.startsWith('pad:')))continue;
      if(!groups.get(String(component.net))?.some(next=>[...required].every(id=>next.has(id))))return false;
    }
    return true;
  }
  // Geometric identities survive deletion/reindexing. A moved object with a
  // remaining violation must be checked afresh, rather than inheriting an
  // unrelated input conflict merely because the violation count stayed equal.
  function noNewRuleViolations(reference,before,candidate,after){
    const issueKey=(issue,board,width=false)=>{
      const pair=issue.a&&issue.b?[copperIdentity(board,issue.a.kind,issue.a.index),copperIdentity(board,issue.b.kind,issue.b.index)].sort():null;
      const kind=width?'trace':issue.kind||(issue.index!==undefined?'via':null),object=kind&&issue.index!==undefined?copperIdentity(board,kind,issue.index):null;
      return JSON.stringify([width?'width':issue.type,issue.layer,issue.net,issue.pad,issue.padstack,issue.keepout,pair,object,issue.via===undefined?null:copperIdentity(board,'via',issue.via)]);
    };
    const match=(oldIssues,newIssues,width)=>{
      const known=new Map();for(const issue of oldIssues||[]){const key=issueKey(issue,reference,width);if(!known.has(key))known.set(key,[]);known.get(key).push(issue);}
      for(const issue of newIssues||[]){const old=known.get(issueKey(issue,candidate,width))?.pop();if(!old)return false;
        if(Number.isFinite(issue.actual)&&Number.isFinite(old.actual)&&issue.actual<old.actual-EPS)return false;
        if(Number.isFinite(issue.required)&&Number.isFinite(old.required)&&issue.required>old.required+EPS)return false;
      }
      return true;
    };
    return match(before.violations,after.violations,false)&&match(before.widthDeviations,after.widthDeviations,true);
  }
  // Explicit refinement works directly on a checked model. It never starts
  // the full-board routing loop or reparses an export into a new input prefix.
  async function refineCurrentBest(input,options={},emit=()=>{},isCancelled=()=>false){
    const measurement=yieldTask?.measurement,finish=measurement?.begin('refining'),log=[];
    const mode=options.refinementMode==='flexible'?'flexible':'refine',phase=mode==='flexible'?'finishing':'optimizing';
    const counters={attempt:{current:0,limit:0,completed:0,status:'skipped'},refinement:{current:0,limit:mode==='refine'?1:0,completed:0,status:mode==='refine'?'pending':'skipped'},repair:{current:0,limit:mode==='flexible'?1:0,completed:0,status:mode==='flexible'?'pending':'skipped'},work:null};
    const counterSnapshot=()=>copy(counters),reportWork=work=>{if(isCancelled())return;counters.work={...work};emit({type:'progress',phase,log:false,counters:counterSnapshot()});};
    const reports=new WeakMap();
    function check(board){const done=measurement?.begin('checking');try{
      const connection=G.connectivity(board,{airwires:false}),validation=G.validate(board),short=new Set(board.nets.filter(n=>n.preferShort===true).map(n=>n.id));
      const stats={unrouted:connection.unrouted,viaCount:board.vias.length,traceCount:board.traces.length,traceLengthMm:board.traces.reduce((sum,t)=>sum+length(t),0)*(board.units.mmPerUnit||1),...(short.size?{preferredTraceLengthMm:board.traces.reduce((sum,t)=>sum+(short.has(t.net)?length(t):0),0)*(board.units.mmPerUnit||1)}:{}),clearanceViolations:validation.clearanceViolations,totalViolations:validation.totalViolations,viaInPadViolations:validation.viaInPadViolations,outlineViolations:validation.outlineViolations,keepoutViolations:validation.keepoutViolations,drcChecked:true,belowNominalWidthTraceCount:validation.belowNominalWidthTraceCount||0,widthRulesChecked:true,netCount:board.nets.length,componentCount:new Set(board.pads.map(p=>p.component)).size,layerCount:board.layers.length};
      reports.set(stats,validation);measurement?.observeChecked?.(stats);return{stats,connection};
    }finally{done?.();}}
    let best,bestStats,bestConnection;
    const checkpoint=()=>emit({type:'checkpoint',phase,pass:0,board:copy(best),stats:bestStats,validation:copy(reports.get(bestStats)),counters:counterSnapshot()});
    try{
      best=copy(input);best.traces=best.traces||[];best.vias=best.vias||[];G.applyBoardEdgeClearance(best,options.boardEdgeClearanceMm);
      const baseline=check(best),initialStats=baseline.stats;bestStats=initialStats;bestConnection=baseline.connection;
      const retain=candidate=>{
        if(!candidate)return false;
        const checked=check(candidate),s=checked.stats;
        const keys=initialStats.preferredTraceLengthMm===undefined?['unrouted','totalViolations','belowNominalWidthTraceCount','viaCount','traceLengthMm','traceCount']:['unrouted','totalViolations','belowNominalWidthTraceCount','preferredTraceLengthMm','viaCount','traceLengthMm','traceCount'];
        let better=false;for(const key of keys){if(s[key]<bestStats[key]-EPS){better=true;break;}if(s[key]>bestStats[key]+EPS)break;}
        const safe=noRuleRegression(s,bestStats)&&preservesModelRules(candidate,best)&&preservesProtectedCopper(candidate,best)&&preservesPadPartitions(bestConnection,checked.connection)&&preservesProtectedConnections(best,bestConnection,candidate,checked.connection)&&noNewRuleViolations(best,reports.get(bestStats),candidate,reports.get(s));
        if(better&&safe){best=copy(candidate);bestStats=s;bestConnection=checked.connection;return true;}
        if(!safe){const message='The refinement didn’t pass all the checks. Keeping the previous best.';log.push(message);emit({type:'progress',phase:'checking',message});}
        return false;
      };
      let pendingCheckpoint=Promise.resolve();
      const checkedEmit=message=>{
        if(message?.type!=='checkpoint')return emit(message);
        if(!retain(message.board||message.model))return;
        const saved={type:'checkpoint',phase,pass:0,board:copy(best),stats:bestStats,validation:copy(reports.get(bestStats)),counters:counterSnapshot()};
        pendingCheckpoint=pendingCheckpoint.then(()=>emit(saved));pendingCheckpoint.catch(()=>{});return pendingCheckpoint;
      };
      // This checked fallback exists before any mutable refinement work begins.
      await checkpoint();await yieldNow();
      const item=counters[mode==='flexible'?'repair':'refinement'];
      const remainingLinks=missingPadLinks(baseline.connection);
      const available=mode==='flexible'?flexibleFinisher&&remainingLinks>0&&remainingLinks<=4:optimizer;
      if(!isCancelled()&&available){
        item.current=1;item.status='running';emit({type:'progress',phase,message:mode==='flexible'?'Making room for the last few connections':'Refining the best checked route',counters:counterSnapshot()});
        const result=mode==='flexible'?await flexibleFinisher.improveRoutingBest(copy(best),{...options,preserveTraceCount:0,preserveViaCount:0},checkedEmit,isCancelled,reportWork):await optimizer.optimize(copy(best),options,checkedEmit,isCancelled,reportWork);
        const candidate=result?.model||result?.board||result;
        await pendingCheckpoint;if(retain(candidate))await checkpoint();
        if(!isCancelled())item.completed=1;
      }else if(!isCancelled()&&mode==='flexible'){const message=remainingLinks>4?'Flexible finishing is for the last four connections.':remainingLinks===0?'All required connections are already routed.':'Flexible finishing isn’t available. Reload RamenRouter and try again.';log.push(message);emit({type:'progress',phase:'checking',message});}
      item.status=isCancelled()?'stopped':item.current?'done':'skipped';counters.work=null;
      emit({type:'progress',phase:'checking',board:copy(best),stats:bestStats,counters:counterSnapshot(),message:bestStats.unrouted+' connections left.'});
      return{board:best,stats:bestStats,initialStats,log,counters:counterSnapshot(),stopped:isCancelled()};
    }finally{finish?.();}
  }
  async function route(input,options={},emit=()=>{},isCancelled=()=>false){
    const measurement=yieldTask?.measurement,finishRoute=measurement?.begin('routing');
    // Reports belong to checked statistics from this route only. A retained
    // snapshot can reuse its report without trusting anything from a file.
    const validationReports=new WeakMap();
    const connectivity=board=>{const finish=measurement?.begin('checking');try{return G.connectivity(board,{airwires:false});}finally{finish?.();}};
    try{
    const started=Date.now(),timeout=(options.timeoutMinutes||30)*60000,log=[];let deadline=started+timeout;
    const stopped=()=>isCancelled()||(!yieldTask?.managesBudget&&Date.now()>=deadline);
    let attemptLimit=options.fanoutOnly?0:options.deepSearch===false?1:Math.max(1,Math.min(options.maxPasses||12,100));
    // A larger attempt budget adds later stages; it must not postpone repair
    // of a promising layout reached by the ordinary twelve-attempt search.
    let stageCount=Math.max(1,Math.ceil(attemptLimit/12));
    let refinementLimit=options.fanoutOnly||options.optimize===false||!optimizer?0:(options.deepSearch===false?1:2)*stageCount;
    let repairLimit=options.fanoutOnly||options.deepSearch===false?0:18*stageCount;
    const counter=(limit,conditional)=>({current:0,limit,completed:0,status:limit?'pending':'skipped',...(conditional===undefined?{}:{conditional})});
    const counters={attempt:counter(attemptLimit),refinement:counter(refinementLimit,refinementLimit>1),repair:counter(repairLimit,true),work:null};
    const counterSnapshot=()=>({attempt:{...counters.attempt},refinement:{...counters.refinement},repair:{...counters.repair},work:counters.work?{...counters.work}:null});
    const reportCounters=(phase='routing')=>emit({type:'progress',phase,log:false,counters:counterSnapshot()});
    const finishCounter=(name,phase)=>{if(stopped())return;const item=counters[name],status=item.current?'done':'skipped';if(item.status===status&&counters.work===null)return;item.status=status;counters.work=null;reportCounters(phase);};
    const refinementWork=work=>{if(stopped())return;counters.work={...work};reportCounters('optimizing');};
    reportCounters(options.fanoutOnly?'fanout':'checking');

    const say=(message,extra={})=>{log.push(message);emit({type:'progress',message,...extra});};
    // Detail updates carry counters only. Board copies and geometric checks are
    // reserved for previews/checkpoints, keeping a busy worker cheap to observe.
    let lastDetail=0,lastPreview=0,routeActivity={};
    let lastSpatial=0,hasSpatial=false;
    const spatial=(message,activity,makeVisual,phase='routing')=>{
      const now=Date.now();if(now-lastSpatial<175)return;lastSpatial=now;hasSpatial=true;
      emit({type:'activity',phase,message,activity:{...routeActivity,...activity,visual:makeVisual()}});
    };
    const clearSpatial=(stage,phase='checking')=>{if(!hasSpatial)return;hasSpatial=false;lastSpatial=0;emit({type:'activity',phase,activity:{stage,visual:null}});};
    // Prefixes retain consecutive real vertices; never join sampled points with
    // invented shortcuts when the display budget truncates a long path.
    const traceVisual=(traces,points=[],kind='candidate',label='Candidate route')=>{
      let remaining=512;const paths=[];
      for(const trace of traces){if(remaining<2)break;const part=trace.points.slice(0,remaining).map(p=>p.slice(0,2));if(part.length>1){paths.push({layer:trace.layer,points:part});remaining-=part.length;}}
      return {kind,label,paths,points:points.slice(0,64).map(p=>p.slice(0,3))};
    };

    const detail=(message,activity={},phase='routing',force=false)=>{
      const now=Date.now();if(!force&&now-lastDetail<1200)return;lastDetail=now;
      emit({type:'progress',phase,pass:routeActivity.pass||0,message,activity:{...routeActivity,...activity}});return true;
    };
    let original=copy(input);original.traces=original.traces||[];original.vias=original.vias||[];G.applyBoardEdgeClearance(original,options.boardEdgeClearanceMm);
    if(typeof options.viaInPad==='boolean'){original.viaAtSmd=options.viaInPad;original.viaInPadApplied=options.viaInPad;original.viaInPadOverride=options.viaInPad;for(const v of original.viaDefs)v.attachAllowed=options.viaInPad;}
    const rules=netRules(original),padCounts=new Map(original.nets.map(n=>[n.id,original.pads.filter(p=>p.net===n.id).length])), nets=original.nets.filter(n=>original.pads.filter(p=>p.net===n.id).length>1);
    const shortNets=new Set(nets.filter(n=>n.preferShort===true).map(n=>n.id));
    const preferShort=net=>shortNets.has(net.id);
    const directions=options.preferredDirections===true&&original.layers.length>1?layerDirections(original.layers):null;
    const prioritizeShort=order=>{if(shortNets.size)order.sort((a,b)=>Number(preferShort(b))-Number(preferShort(a)));return order;};
    // Trace length leads for selected nets. A small physical-length surcharge
    // breaks via ties without making long surface detours artificially cheap.
    const searchViaCost=net=>preferShort(net)?Math.min(options.viaCost||net.width*5,net.width*.1):(options.viaCost||net.width*5);
    function stats(board,checked=true,connection=null){const finish=measurement?.begin('checking');try{clearSpatial('connectivity-check');detail('Checking connected copper',{stage:'connectivity-check'},'checking');const refining=counters.refinement.status==='running',checks=checked?2:1;if(refining)refinementWork({kind:'checking',processed:0,total:checks});let conn=connection||connectivity(board);if(refining)refinementWork({kind:'checking',processed:1,total:checks});if(checked)detail('Checking copper clearances and routing rules',{stage:'rule-check'},'checking');let v=checked?G.validate(board):null;if(refining&&checked)refinementWork({kind:'checking',processed:2,total:checks});const result={unrouted:conn.unrouted,viaCount:board.vias.length,traceCount:board.traces.length,traceLengthMm:board.traces.reduce((a,t)=>a+length(t),0)*(board.units.mmPerUnit||1),...(shortNets.size?{preferredTraceLengthMm:board.traces.reduce((a,t)=>a+(shortNets.has(t.net)?length(t):0),0)*(board.units.mmPerUnit||1)}:{}),clearanceViolations:v?v.clearanceViolations:null,totalViolations:v?v.totalViolations:null,viaInPadViolations:v?v.viaInPadViolations:null,outlineViolations:v?v.outlineViolations:null,keepoutViolations:v?v.keepoutViolations:null,drcChecked:!!v,belowNominalWidthTraceCount:v?v.belowNominalWidthTraceCount:0,widthRulesChecked:!!v,netCount:board.nets.length,componentCount:new Set(board.pads.map(p=>p.component)).size,layerCount:board.layers.length};if(checked){validationReports.set(result,v);measurement?.observeChecked?.(result);}return result;}finally{finish?.();}}
    detail('Checking input clearances and connectivity',{stage:'input-check'},'checking',true);await yieldNow();
    const initialStats=stats(original),baseViolation=initialStats.clearanceViolations,baseWidth=initialStats.belowNominalWidthTraceCount,baseTotal=initialStats.totalViolations;
    if(options.viaInPad===false&&initialStats.viaInPadViolations){const error=new Error('Existing vias overlap SMD pads while vias in SMD pads are disabled. Clear routing & start over, or enable vias in SMD pads before routing.');error.code='VIA_IN_PAD_CONFLICT';throw error;}
    let originalStats=initialStats;
    if(options.cleanupDangling===true&&optimizer?.cleanup&&!stopped()){
      const before=connectivity(original);
      say('Checking unused traces before routing',{phase:'checking'});
      const cleaned=await optimizer.cleanup(copy(original),options,emit,stopped),candidate=cleaned?.board||cleaned;
      if(candidate){const checked=stats(candidate),after=connectivity(candidate);
        if(checked.unrouted<=originalStats.unrouted&&noRuleRegression(checked,originalStats)&&preservesModelRules(candidate,original)&&preservesProtectedCopper(candidate,original)&&preservesPadPartitions(before,after)&&preservesProtectedConnections(original,before,candidate,after)&&noNewRuleViolations(original,validationReports.get(originalStats),candidate,validationReports.get(checked))){original=candidate;originalStats=checked;if(cleaned.changed)say('Removed unused copper while keeping the existing connections.',{phase:'checking',board:copy(original),stats:checked});}
        else say('Keeping your imported copper. The cleanup didn’t pass all the checks.',{phase:'checking'});
      }
    }
    const needsLayerAccess=original.pads.some(p=>{const net=rules.get(p.net);return net&&new Set(p.shapes.map(s=>s.layer)).size===1&&net.useLayers&&!net.useLayers.includes(p.shapes[0].layer);});
    if((options.fanout!==false||options.fanoutOnly||needsLayerAccess)&&fanout&&!stopped()){
      const accessOnly=options.fanout===false&&!options.fanoutOnly;
      say(accessOnly?"Finding short fanouts to your selected routing layers.":"Finding fanouts from SMD pads and checking they fit.",{phase:'fanout',stats:initialStats});
      const prepared=await fanout.fanout(copy(original),accessOnly?{...options,layerAccessOnly:true}:options,emit,stopped),candidate=prepared.board||prepared,candidateStats=stats(candidate);
      if(candidateStats.totalViolations<=baseTotal&&candidateStats.belowNominalWidthTraceCount<=baseWidth&&candidateStats.unrouted<=initialStats.unrouted){original=candidate;originalStats=candidateStats;for(const line of prepared.log||[])log.push(line);say('Fanout added '+(prepared.addedVias||0)+' vias and '+(prepared.addedTraces||0)+' full-width escapes.',{phase:'fanout',board:copy(original),stats:candidateStats});}
      else say("The fanout didn’t pass all the checks. Keeping your imported board.",{phase:'checking'});
    }
    let best=copy(original),bestStats=originalStats;
    const checkpoint=(pass=counters.attempt.current,phase='routing')=>{
      const validation=validationReports.get(bestStats);
      return emit({type:'checkpoint',phase,pass,counters:counterSnapshot(),board:copy(best),stats:bestStats,...(validation?{validation:copy(validation)}:{})});
    };
    // Only fully checked best boards become interruption-safe snapshots. Live
    // progress may contain a worse rip-up attempt and is never a checkpoint.
    await checkpoint();
    if(options.fanoutOnly){if(!fanout)throw new Error("Fanout isn’t ready. Reload RamenRouter and try again.");return{board:best,stats:bestStats,initialStats,log,counters:counterSnapshot(),stopped:stopped()};}
    // Fanout is now immutable input to the main route search. An isolated
    // group with no selected-layer copper and no allowed pad-centred via
    // cannot gain an attachment through rip-up on selected layers. Report it
    // once and continue with other nets instead of rebuilding the same raster.
    const inaccessibleNets=new Set(),inaccessibleGroups=new Map();
    const hasLayerAccess=(group,net)=>{
      const layers=net?.useLayers||original.layers.map(l=>l.index),def=original.viaDefs.find(v=>v.name===net?.viaName);
      return group.points.some(p=>layers.includes(p[2]))||group.points.some(p=>original.viaAtSmd&&def&&def.attachAllowed!==false&&p[2]>=def.fromLayer&&p[2]<=def.toLayer&&layers.some(l=>l>=def.fromLayer&&l<=def.toLayer));
    };
    const hasRoutableGap=component=>(inaccessibleGroups.has(component.net)?component.groups.filter(group=>hasLayerAccess(group,rules.get(component.net))).length:component.groups.length)>1;
    for(const component of (nets.some(net=>net.useLayers&&net.useLayers.length<original.layers.length)?connectivity(original).components:[])){
      if(component.groups.length<2)continue;
      const net=rules.get(component.net),missing=component.groups.filter(group=>!hasLayerAccess(group,net));
      if(!missing.length)continue;
      inaccessibleGroups.set(component.net,missing.length);
      if(component.groups.length-missing.length<=1)inaccessibleNets.add(component.net);
      const pads=missing.flatMap(group=>group.pads),label=pads.slice(0,4).join(', ')+(pads.length>4?' and '+(pads.length-4)+' more':'');
      const action="No short fanout fits the rules here. Try another main layer, move nearby copper, or allow vias in SMD pads.";
      say("Can’t reach the selected main layers for "+net.name+(label?' at '+label:'')+'. '+action+" Skipping more tries at this connection until something changes.",{phase:'routing',activity:{stage:'layer-access-blocked',netId:net.id,netName:net.name,padIds:pads}});
    }
    const routingNets=nets.filter(net=>!inaccessibleNets.has(net.id));
    if(nets.length&&!routingNets.length){
      finishCounter('attempt','routing');finishCounter('repair','finishing');finishCounter('refinement','optimizing');
      say(bestStats.unrouted+" connections left. These pads need a fanout that reaches a selected layer.",{phase:'checking',board:copy(best),stats:bestStats});
      return{board:best,stats:bestStats,initialStats,log,counters:counterSnapshot(),stopped:stopped()};
    }
    const span=Math.max(original.bounds.maxX-original.bounds.minX,original.bounds.maxY-original.bounds.minY);
    const widths=original.nets.map(n=>n.width).filter(w=>w>0);
    const narrowest=widths.length?Math.min(...widths):Math.max(span/900,1e-5);
    let step=Number(options.gridStep)||Math.max(narrowest/5,span/900);step=Math.max(step,span/1500,1e-5);
    const bx=original.bounds.minX,by=original.bounds.minY,nx=Math.ceil((original.bounds.maxX-bx)/step)+1,ny=Math.ceil((original.bounds.maxY-by)/step)+1,plane=nx*ny,total=plane*original.layers.length;
    if(total>6000000)throw new Error("This board’s routing grid is too large for the browser. Use a coarser grid.");
    const layerCount=original.layers.length;
    measurement?.grid({width:nx,height:ny,layers:layerCount,step,units:original.units.name,positions:total});
    const traceLayers=net=>net.useLayers||original.layers.map(l=>l.index);
    const idx=(x,y,l)=>l*plane+y*nx+x, xy=id=>{let q=id%plane;return[bx+(q%nx)*step,by+Math.floor(q/nx)*step,Math.floor(id/plane)];};
    const boundaryEdges=G.boundaryEdges(original);
    const padShapes=[];for(const p of original.pads)for(const shape of p.shapes)padShapes.push({pad:p,shape,box:G.shapeBounds(shape)});
    const bases=new Map(),maxRasterCaches=Math.max(1,Math.min(4,Math.floor(96000000/(total*6*4))));
    const clearanceOf=n=>n?.routingClearance??n?.clearance??original.defaultClearance??0;
    const maxClearance=Math.max(original.defaultClearance||0,...original.nets.map(clearanceOf),...(original.keepouts||[]).map(k=>k.clearance||0));
    const indexSize=Math.max(narrowest*4,span/60,1e-5);
    // Physical copper imported from the DSN remains fixed throughout routing.
    const immutable=G.copper(original).primitives.map(p=>({...p,clearance:clearanceOf(rules.get(p.net))}));
    const fixedFills=immutable.filter(p=>p.object.kind==='fill');
    for(const k of original.keepouts||[])if(k.kind!=='via')for(const layer of k.layers||original.layers.map(l=>l.index))immutable.push({shape:{...k.shape,layer},layer,net:null,clearance:k.clearance??null,keepout:true,bounds:G.shapeBounds(k.shape)});
    const staticIndex=Array.from({length:layerCount},(_,l)=>G.spatialIndex(immutable.filter(p=>p.layer===l),indexSize));
    let dynamicIndex=null,indexGeneration=-1;
    function getDynamicIndex(){if(indexGeneration!==generation){const p=G.copper(board).primitives.filter(p=>(p.object.kind==='trace'&&p.object.index>=original.traces.length)||(p.object.kind==='via'&&p.object.index>=original.vias.length));dynamicIndex=Array.from({length:layerCount},(_,l)=>G.spatialIndex(p.filter(p=>p.layer===l),indexSize));indexGeneration=generation;}return dynamicIndex;}
    function exactEdgeClear(a,b,layer,net,soft){
      if(!traceLayers(net).includes(layer))return false;
      const half=net.width/2,box=expanded(bboxPoints([a,b]),half+maxClearance);
      if(!G.shapeInsideBoard({type:'capsule',a,b,r:half,layer},original,boundaryEdges))return false;
      for(const p of staticIndex[layer].query(box)){if(!p.keepout&&p.net===net.id)continue;const clear=p.keepout?(p.clearance??clearanceOf(net)):Math.max(clearanceOf(net),p.clearance||0);if(G.distanceSegmentShape(a[0],a[1],b[0],b[1],p.shape)<half+clear-EPS)return false;}
      if(!soft)for(const p of getDynamicIndex()[layer].query(box)){if(p.net===net.id)continue;const clear=Math.max(clearanceOf(net),clearanceOf(rules.get(p.net)));if(G.distanceSegmentShape(a[0],a[1],b[0],b[1],p.shape)<half+clear-EPS)return false;}
      return true;
    }
    let generation=0,board=copy(original),cache=null,finishing=false,repairRound=0,congestionHistory=null;const ripHistory=new Map();
    const gCost=new Float64Array(total),visited=new Uint32Array(total),closed=new Uint32Array(total),parent=new Int32Array(total);let searchId=0;
    const viaHeads=layerCount>1?new Uint32Array(total):null;
    function eachCell(box,layer,fn){let x0=Math.max(0,Math.floor((box.minX-bx)/step)),x1=Math.min(nx-1,Math.ceil((box.maxX-bx)/step)),y0=Math.max(0,Math.floor((box.minY-by)/step)),y1=Math.min(ny-1,Math.ceil((box.maxY-by)/step));for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)fn(idx(x,y,layer),bx+x*step,by+y*step);}
    function put(arr,i,owner){owner=owner>0?owner:-1;if(!arr[i])arr[i]=owner;else if(arr[i]!==owner)arr[i]=-1;}
    function drawShape(arr,shape,r,owner){eachCell(expanded(G.shapeBounds(shape),r),shape.layer,(i,x,y)=>{if(G.distancePointShape(x,y,shape)<r+EPS)put(arr,i,owner);});}
    function drawSegment(arr,a,b,layer,r,owner){eachCell(expanded(bboxPoints([a,b]),r),layer,(i,x,y)=>{if(segmentDistance(x,y,a,b)<r+EPS)put(arr,i,owner);});}
    function drawTrace(arr,t,r,owner){spatial('Preparing trace clearance · '+(rules.get(t.net)?.name||'unconnected trace'),{stage:'trace-clearances',netId:t.net,netName:rules.get(t.net)?.name},()=>traceVisual([t],[],'trace','Current trace clearance'),finishing?'finishing':'rasterizing');for(let i=1;i<t.points.length;i++)drawSegment(arr,t.points[i-1],t.points[i],t.layer,r,owner);}
    function drawVia(arr,v,r,owner){spatial('Preparing via clearance · '+(rules.get(v.net)?.name||'unconnected via'),{stage:'via-clearances',netId:v.net,netName:rules.get(v.net)?.name},()=>({kind:'via',points:v.layers.slice(0,64).map(l=>[v.x,v.y,l]),label:'Current via clearance'}),finishing?'finishing':'rasterizing');for(const l of v.layers)eachCell({minX:v.x-r,minY:v.y-r,maxX:v.x+r,maxY:v.y+r},l,(i,x,y)=>{if(Math.hypot(x-v.x,y-v.y)<r+EPS)put(arr,i,owner);});}
    async function rememberCongestion(blocked,net){
      if(!congestionHistory)congestionHistory=new Uint8Array(total);
      const mark=id=>{if(congestionHistory[id]<8)congestionHistory[id]++;};
      let cells=0;
      const region=async(box,layer,contains)=>{
        const x0=Math.max(0,Math.floor((box.minX-bx)/step)),x1=Math.min(nx-1,Math.ceil((box.maxX-bx)/step)),y0=Math.max(0,Math.floor((box.minY-by)/step)),y1=Math.min(ny-1,Math.ceil((box.maxY-by)/step));
        for(let y=y0;y<=y1;y++){
          for(let x=x0;x<=x1;x++){if(contains(bx+x*step,by+y*step))mark(idx(x,y,layer));cells++;}
          if(cells>=4096){cells=0;await yieldNow();if(stopped())return false;}
        }
        return !stopped();
      };
      for(const t of blocked.traces){const r=t.width/2+net.width/2+Math.max(clearanceOf(net),clearanceOf(rules.get(t.net)))+step;
        for(let k=1;k<t.points.length;k++){const a=t.points[k-1],b=t.points[k];if(!await region(expanded(bboxPoints([a,b]),r),t.layer,(x,y)=>segmentDistance(x,y,a,b)<r+EPS))return false;}}
      for(const v of blocked.vias){const r=v.diameter/2+net.width/2+Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)))+step;
        for(const layer of v.layers)if(!await region({minX:v.x-r,minY:v.y-r,maxX:v.x+r,maxY:v.y+r},layer,(x,y)=>Math.hypot(x-v.x,y-v.y)<r+EPS))return false;}
      return !stopped();
    }
    function allowed(arr,id,net){return arr[id]===0||arr[id]===net;}
    function inside(x,y,r){r+=G.boardEdgeClearance(original);if(x<original.bounds.minX+r||x>original.bounds.maxX-r||y<original.bounds.minY+r||y>original.bounds.maxY-r)return false;if(original.outlines.length&&!original.outlines.some(p=>G.pointInPolygon(x,y,p)))return false;for(const hole of original.holes||[])if(G.pointInPolygon(x,y,hole))return false;for(const p of [...original.outlines,...(original.holes||[])])for(let k=0;k<p.length;k++)if(segmentDistance(x,y,p[k],p[(k+1)%p.length])<r-EPS)return false;return true;}
    async function getRaster(net){
      const finish=measurement?.begin('preparing');try{
      let lastRasterYield=Date.now();
      const via=original.viaDefs.find(v=>v.name===net.viaName)||original.viaDefs[0]||{name:'no-layer-transition',diameter:net.width,fromLayer:0,toLayer:0,attachAllowed:false,disabled:true};
      const key=[net.width,clearanceOf(net),via.name,original.viaAtSmd&&via.attachAllowed].join('|');
      let c=bases.get(key);
      if(!c){
        // Bound cached rule-class rasters so multi-class boards cannot accumulate gigabytes.
        while(bases.size>=maxRasterCaches)bases.delete(bases.keys().next().value);
        detail('Preparing copper and clearance grid for '+net.name,{stage:'grid',netId:net.id,netName:net.name,processed:0,total:layerCount*ny},'rasterizing');
        await yieldNow();
        c={base:new Int32Array(total),thickBase:new Int32Array(total),viaBase:new Int32Array(total),dyn:new Int32Array(total),thickDyn:new Int32Array(total),viaDyn:new Int32Array(total),via,generation:-1};
        const guard=step*0.72,half=net.width/2;
        for(let l=0;l<layerCount;l++)for(let y=0;y<ny;y++){for(let x=0;x<nx;x++){let id=idx(x,y,l),px=bx+x*step,py=by+y*step;if(!inside(px,py,half))c.base[id]=-1;if(!inside(px,py,half+guard))c.thickBase[id]=-1;if(!inside(px,py,via.diameter/2))c.viaBase[id]=-1;}if(y%32===0){detail('Preparing grid · '+net.name+' · layer '+(l+1)+'/'+layerCount+' · row '+(y+1)+'/'+ny,{stage:'grid',netId:net.id,netName:net.name,layer:l,processed:l*ny+y+1,total:layerCount*ny},'rasterizing');}if(y%8===0)spatial('Preparing clearance grid for '+net.name,{stage:'grid',netId:net.id,netName:net.name},()=>({kind:'grid',layer:l,bounds:[bx,by+y*step,bx+(nx-1)*step,by+(y+1)*step],label:'Current clearance grid row'}),'rasterizing');if(y%32===0){if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        let rasterItems=0;
        for(const {pad,shape} of padShapes){spatial('Preparing pad clearance · '+(rules.get(pad.net)?.name||'unconnected pad'),{stage:'pad-clearances',netId:pad.net,netName:rules.get(pad.net)?.name},()=>{const b=G.shapeBounds(shape);return{kind:'pad',points:[[pad.x,pad.y,shape.layer]],layer:shape.layer,bounds:[b.minX,b.minY,b.maxX,b.maxY],label:'Current pad clearance'};},'rasterizing');let clearance=Math.max(clearanceOf(net),clearanceOf(rules.get(pad.net)));drawShape(c.base,shape,half+clearance,pad.net);drawShape(c.thickBase,shape,half+clearance+guard,pad.net);drawShape(c.viaBase,shape,via.diameter/2+clearance,pad.net);if(++rasterItems%32===0){detail('Preparing pad clearances · '+rasterItems+'/'+padShapes.length,{stage:'pad-clearances',processed:rasterItems,total:padShapes.length},'rasterizing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        // Same-net pad attachment is independently forbidden unless imported or explicitly enabled.
        if(!(original.viaAtSmd&&via.attachAllowed))for(const {pad,shape} of padShapes)if(new Set(pad.shapes.map(s=>s.layer)).size===1)drawShape(c.viaBase,shape,via.diameter/2,-1);
        for(const ko of original.keepouts||[]){for(const l of ko.layers||original.layers.map(l=>l.index)){let sh={...ko.shape,layer:l};if(ko.kind!=='via'){drawShape(c.base,sh,half+(ko.clearance??clearanceOf(net)),-1);drawShape(c.thickBase,sh,half+(ko.clearance??clearanceOf(net))+guard,-1);}drawShape(c.viaBase,sh,via.diameter/2+(ko.clearance??clearanceOf(net)),-1);}}
        rasterItems=0;
        for(const t of original.traces){let clearance=Math.max(clearanceOf(net),clearanceOf(rules.get(t.net)));drawTrace(c.base,t,half+t.width/2+clearance,t.net);drawTrace(c.thickBase,t,half+t.width/2+clearance+guard,t.net);drawTrace(c.viaBase,t,via.diameter/2+t.width/2+clearance,t.net);if(++rasterItems%16===0){detail('Preparing imported trace clearances · '+rasterItems+'/'+original.traces.length,{stage:'trace-clearances',processed:rasterItems,total:original.traces.length},'rasterizing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        rasterItems=0;
        for(const v of original.vias){let clearance=Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)));drawVia(c.base,v,half+v.diameter/2+clearance,v.net);drawVia(c.thickBase,v,half+v.diameter/2+clearance+guard,v.net);drawVia(c.viaBase,v,via.diameter/2+v.diameter/2+clearance,-1);if(++rasterItems%32===0){detail('Preparing imported via clearances · '+rasterItems+'/'+original.vias.length,{stage:'via-clearances',processed:rasterItems,total:original.vias.length},'rasterizing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        for(const fill of fixedFills){const clearance=G.clearance(original,net,fill.net);drawShape(c.base,fill.shape,half+clearance,fill.net);drawShape(c.thickBase,fill.shape,half+clearance+guard,fill.net);drawShape(c.viaBase,fill.shape,via.diameter/2+clearance,fill.net);await yieldNow();if(stopped())return c;}
        bases.set(key,c);
      }
      if(c.generation!==generation){
        c.dyn.fill(0);c.thickDyn.fill(0);c.viaDyn.fill(0);const guard=step*0.72;
        const traces=board.traces.slice(original.traces.length),vias=board.vias.slice(original.vias.length);let drawn=0;
        for(const t of traces){let clear=Math.max(clearanceOf(net),clearanceOf(rules.get(t.net)));drawTrace(c.dyn,t,net.width/2+t.width/2+clear,t.net);drawTrace(c.thickDyn,t,net.width/2+t.width/2+clear+guard,t.net);drawTrace(c.viaDyn,t,c.via.diameter/2+t.width/2+clear,t.net);if(++drawn%24===0){detail('Updating route clearances · '+net.name+' · '+drawn+'/'+(traces.length+vias.length)+' items',{stage:'route-clearances',processed:drawn,total:traces.length+vias.length},finishing?'finishing':'routing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        for(const v of vias){let clear=Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)));drawVia(c.dyn,v,net.width/2+v.diameter/2+clear,v.net);drawVia(c.thickDyn,v,net.width/2+v.diameter/2+clear+guard,v.net);drawVia(c.viaDyn,v,c.via.diameter/2+v.diameter/2+clear,v.net);if(++drawn%24===0){detail('Updating route clearances · '+net.name+' · '+drawn+'/'+(traces.length+vias.length)+' items',{stage:'route-clearances',processed:drawn,total:traces.length+vias.length},finishing?'finishing':'routing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
        c.generation=generation;
      }
      return c;
      }finally{finish?.();}
    }
    function staticSegmentClear(a,b,layer,net,soft=false){
      if(!traceLayers(net).includes(layer))return false;
      const half=net.width/2,segmentBox=bboxPoints([a,b]);
      if(!G.shapeInsideBoard({type:'capsule',a:[a[0],a[1]],b:[b[0],b[1]],r:half,layer},original,boundaryEdges))return false;
      for(const o of padShapes)if(o.shape.layer===layer&&o.pad.net!==net.id){let r=half+Math.max(clearanceOf(net),clearanceOf(rules.get(o.pad.net)));if(overlap(expanded(o.box,r),segmentBox)&&G.distanceSegmentShape(a[0],a[1],b[0],b[1],o.shape)<r-EPS)return false;}
      for(let i=0;i<board.traces.length;i++){const t=board.traces[i];if(t.net!==net.id&&t.layer===layer&&(!soft||i<original.traces.length)){let r=half+t.width/2+Math.max(clearanceOf(net),clearanceOf(rules.get(t.net)));if(overlap(expanded(bboxPoints(t.points),r),segmentBox))for(let j=1;j<t.points.length;j++)if(G.distanceSegments(a,b,t.points[j-1],t.points[j])<r-EPS)return false;}}
      for(let i=0;i<board.vias.length;i++){const v=board.vias[i];if(v.net!==net.id&&v.layers.includes(layer)&&(!soft||i<original.vias.length)){let r=half+v.diameter/2+Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)));if(segmentDistance(v.x,v.y,a,b)<r-EPS)return false;}}
      for(const fill of fixedFills)if(fill.layer===layer&&fill.net!==net.id){const r=half+G.clearance(original,net,fill.net);if(overlap(expanded(fill.bounds,r),segmentBox)&&G.distanceSegmentShape(a[0],a[1],b[0],b[1],fill.shape)<r-EPS)return false;}
      for(const k of original.keepouts||[])if(k.kind!=='via'&&(!k.layers||k.layers.includes(layer))){let r=half+(k.clearance??clearanceOf(net));if(overlap(expanded(G.shapeBounds(k.shape),r),segmentBox)&&G.distanceSegmentShape(a[0],a[1],b[0],b[1],k.shape)<r-EPS)return false;}
      return true;
    }
    function existingViaClear(candidate,soft=false,reuse=true){
      const bounds={minX:candidate.x-candidate.diameter/2,minY:candidate.y-candidate.diameter/2,maxX:candidate.x+candidate.diameter/2,maxY:candidate.y+candidate.diameter/2},seen=new Set();
      for(const layer of candidate.layers){
        for(const p of staticIndex[layer].query(bounds,maxClearance))if(p.object?.kind==='via'&&!seen.has(p.object.item)){
          const other=p.object.item;seen.add(other);
          if(reuse&&G.samePhysicalVia(original,candidate,other))continue;
          if(G.viaSpacing(original,candidate,other)?.violates)return false;
        }
        for(const p of getDynamicIndex()[layer].query(bounds,maxClearance))if(p.object.kind==='via'&&!seen.has(p.object.item)){
          const other=p.object.item;seen.add(other);
          if(reuse&&G.samePhysicalVia(original,candidate,other))continue;
          if((!soft||other.net===candidate.net)&&G.viaSpacing(original,candidate,other)?.violates)return false;
        }
      }
      return true;
    }
    function candidateViasClear(copper){
      const vias=[];
      for(const via of copper.vias){
        if(board.vias.some(other=>G.samePhysicalVia(original,via,other))||vias.some(other=>G.samePhysicalVia(original,via,other)))continue;
        if(!existingViaClear(via,true,false)||vias.some(other=>G.viaSpacing(original,via,other)?.violates))return false;
        vias.push(via);
      }
      return true;
    }
    function endpointVia(p,net,c,soft){
      const def=c.via,l=p[2]??0;
      if(def.disabled||def.name!==net.viaName||!original.viaAtSmd||def.attachAllowed===false||l<def.fromLayer||l>def.toLayer)return null;
      const pad=original.pads.find(a=>a.net===net.id&&Math.hypot(a.x-p[0],a.y-p[1])<EPS&&a.shapes.some(s=>s.layer===l));
      if(!pad||new Set(pad.shapes.map(s=>s.layer)).size!==1)return null;
      const layers=Array.from({length:def.toLayer-def.fromLayer+1},(_,i)=>def.fromLayer+i);
      const candidate={net:net.id,x:p[0],y:p[1],diameter:def.diameter,padstack:def.name,layers,fixed:false};
      if(!existingViaClear(candidate,soft))return null;
      // The via retains its entire physical span, including excluded trace
      // layers. Check all of its copper before using it as a routing endpoint.
      for(const layer of layers){
        if(!staticIndex[layer])return null;
        const shape={type:'circle',cx:p[0],cy:p[1],r:def.diameter/2,layer},bounds=G.shapeBounds(shape);
        if(!G.shapeInsideBoard(shape,original,boundaryEdges))return null;
        for(const q of staticIndex[layer].query(bounds,maxClearance)){
          if(!q.keepout&&q.net===net.id)continue;
          const clearance=q.keepout?(q.clearance??clearanceOf(net)):Math.max(clearanceOf(net),q.clearance||0),distance=G.distanceShapes(shape,q.shape);
          if(distance+EPS<clearance||distance<EPS)return null;
        }
        if(!soft)for(const q of getDynamicIndex()[layer].query(bounds,maxClearance)){
          if(q.net===net.id)continue;
          const distance=G.distanceShapes(shape,q.shape);
          if(distance+EPS<Math.max(clearanceOf(net),clearanceOf(rules.get(q.net)))||distance<EPS)return null;
        }
        for(const k of original.keepouts||[]){
          if(k.layers&&!k.layers.includes(layer))continue;
          const distance=G.distanceShapes(shape,k.shape);
          if(distance+EPS<(k.clearance??clearanceOf(net))||distance<EPS)return null;
        }
      }
      return candidate;
    }
    function crossingWeight(owner){return (1+Math.min(10,(padCounts.get(owner)||6)/3))*(finishing?1+(ripHistory.get(owner)||0)*.4:1);}
    function bridgePenalty(points,layer,net,c,softPenalty){
      let cost=0;
      for(let k=1;k<points.length;k++){
        const a=points[k-1],b=points[k],distance=Math.hypot(b[0]-a[0],b[1]-a[1]);
        if(distance<EPS)continue;
        const samples=Math.max(1,Math.ceil(distance/(step*.5))),covered=distance/samples;
        // Integrate occupied length, rather than charging each sample as a
        // whole grid step. Shared long anchors are evaluated once below.
        for(let i=0;i<samples;i++){
          const fraction=(i+.5)/samples,x=Math.round((a[0]+(b[0]-a[0])*fraction-bx)/step),y=Math.round((a[1]+(b[1]-a[1])*fraction-by)/step);
          if(x<0||x>=nx||y<0||y>=ny)continue;
          const id=idx(x,y,layer),owner=c.dyn[id];
          if(!allowed(c.dyn,id,net.id))cost+=covered*softPenalty*crossingWeight(owner);
          if(finishing&&!preferShort(net)&&congestionHistory)cost+=covered*congestionHistory[id]*.35;
        }
      }
      return cost;
    }
    function endpointViaPenalty(via,net,softPenalty){
      if(!via)return 0;
      for(const layer of via.layers){
        const shape={type:'circle',cx:via.x,cy:via.y,r:via.diameter/2,layer};
        for(const p of getDynamicIndex()[layer].query(G.shapeBounds(shape),maxClearance)){
          if(p.net===net.id)continue;
          const distance=G.distanceShapes(shape,p.shape),clearance=Math.max(clearanceOf(net),clearanceOf(rules.get(p.net)));
          if(distance+EPS<clearance||distance<EPS)return 4*softPenalty*step;
        }
      }
      return 0;
    }
    function groupSeeds(group,net,c,soft=false,softPenalty=80){
      const fillItems=(group.items||[]).filter(item=>item.kind==='fill').map(item=>board.copperFills?.[item.index]).filter(Boolean);
      // The boundary can have thousands of vertices. Attach near the pads
      // being connected, rather than rasterising the entire plane as goals.
      let seeds=new Map(),points=fillItems.length?(group.items||[]).filter(item=>item.kind!=='fill').flatMap(item=>item.points||[]):group.points||[],layers=traceLayers(net);
      for(const p of points){spatial("Finding where to connect · "+net.name,{stage:'route-attachment',netId:net.id,netName:net.name},()=>({kind:'check',points:[p.slice(0,3)],label:"Connection point being checked"}),finishing?'finishing':'routing');const padLayer=p[2]??0,via=layers.includes(padLayer)?null:endpointVia(p,net,c,soft);
        const sourceLayers=layers.includes(padLayer)?[padLayer]:via?layers.filter(l=>via.layers.includes(l)):[];
        const viaCost=via?searchViaCost(net)+(soft?endpointViaPenalty(via,net,softPenalty):0):0;
        for(const l of sourceLayers){
        let anchors=[{at:[p[0],p[1],l],bridge:[[p[0],p[1]]]}];
        // Exact pad-axis bridges are part of finding a full-width terminal
        // attachment. They remain available when preparatory fanout is off.
        {
          const pad=original.pads.find(a=>a.net===net.id&&Math.hypot(a.x-p[0],a.y-p[1])<EPS);
          if(pad){let shape=pad.shapes.find(s=>s.layer===l),box=shape?G.shapeBounds(shape):null;
            let directions=box&&box.maxX-box.minX>box.maxY-box.minY?[[1,0],[-1,0],[0,1],[0,-1]]:[[0,1],[0,-1],[1,0],[-1,0]];
            // Exact pad-axis escapes precede the grid, so narrow pad pitch is not
            // quantized to a coarse global raster. Every bridge is checked at full width.
            for(const d of directions)for(const distance of [1,2,3,4,6].map(a=>a*net.width)){
              const end=[p[0]+d[0]*distance,p[1]+d[1]*distance,l];
              if(staticSegmentClear(p,end,l,net,soft))anchors.push({at:end,bridge:[[p[0],p[1]],[end[0],end[1]]]});
            }
          }
        }
        for(const anchor of anchors){let at=anchor.at,gx=Math.round((at[0]-bx)/step),gy=Math.round((at[1]-by)/step),anchorCost=length({points:anchor.bridge})+viaCost+(soft?bridgePenalty(anchor.bridge,l,net,c,softPenalty):0);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){let x=gx+dx,y=gy+dy;if(x<0||x>=nx||y<0||y>=ny)continue;let id=idx(x,y,l),v=xy(id);if(allowed(c.base,id,net.id)&&(soft||allowed(c.dyn,id,net.id))&&staticSegmentClear(at,v,l,net,soft)){let connector=[[at[0],at[1]],[v[0],v[1]]],bridge=anchor.bridge.concat([[v[0],v[1]]]),cost=anchorCost+length({points:connector})+(soft?bridgePenalty(connector,l,net,c,softPenalty):0);let old=seeds.get(id);if(!old||cost<old.cost)seeds.set(id,{point:p,bridge,cost,via});}}}
        }
      }
      for(const fill of fillItems){
        if(!layers.includes(fill.layer))continue;
        const shape={type:'polygon',points:fill.points,holes:fill.holes||[],layer:fill.layer};
        const pads=original.pads.filter(pad=>pad.net===net.id),origins=[];
        for(const pad of pads){const nearest=G.nearestPointOnShape(pad.x,pad.y,shape);origins.push(nearest);if(G.pointInShape(pad.x,pad.y,shape))origins.push([pad.x,pad.y]);}
        for(const origin of origins){const gx=Math.round((origin[0]-bx)/step),gy=Math.round((origin[1]-by)/step);
          for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const x=gx+dx,y=gy+dy;if(x<0||x>=nx||y<0||y>=ny)continue;const id=idx(x,y,fill.layer),p=xy(id);
            if(!G.pointInShape(p[0],p[1],shape)||!allowed(c.base,id,net.id)||!soft&&!allowed(c.dyn,id,net.id))continue;
            // A zero-length attachment represents existing conductive copper,
            // not an invented path across a pour's holes or exclusions.
            seeds.set(id,{point:p,bridge:[[p[0],p[1]]],cost:0});
          }
        }
      }
      // A legal pad can be narrower than the nominal trace, or nearby copper
      // can block its centre while leaving another part of the pad accessible.
      // Try a small, finite set of actual interior attachment points only when
      // the ordinary centre and axis bridges supplied no usable grid seeds.
      if(!seeds.size)for(const padId of group.pads||[]){
        const pad=original.pads.find(item=>item.id===padId&&item.net===net.id);if(!pad)continue;
        for(const shape of pad.shapes||[]){
          const l=shape.layer;if(!layers.includes(l))continue;
          const box=G.shapeBounds(shape),reach=Math.hypot(box.maxX-box.minX,box.maxY-box.minY)*2+net.width,origins=[];
          for(const d of [[1,0],[-1,0],[0,1],[0,-1],[SQRT2/2,SQRT2/2],[-SQRT2/2,SQRT2/2],[SQRT2/2,-SQRT2/2],[-SQRT2/2,-SQRT2/2]]){
            const edge=G.nearestPointOnShape(pad.x+d[0]*reach,pad.y+d[1]*reach,shape);
            for(const fraction of [.5,.8]){const origin=[pad.x+(edge[0]-pad.x)*fraction,pad.y+(edge[1]-pad.y)*fraction];if(G.pointInShape(origin[0],origin[1],shape))origins.push(origin);}
          }
          for(const origin of origins){const gx=Math.round((origin[0]-bx)/step),gy=Math.round((origin[1]-by)/step);
            for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const x=gx+dx,y=gy+dy;if(x<0||x>=nx||y<0||y>=ny)continue;
              const id=idx(x,y,l),v=xy(id);if(!allowed(c.base,id,net.id)||!soft&&!allowed(c.dyn,id,net.id)||!staticSegmentClear(origin,v,l,net,soft))continue;
              const bridge=[origin.slice(),v.slice(0,2)],cost=length({points:bridge})+(soft?bridgePenalty(bridge,l,net,c,softPenalty):0),old=seeds.get(id);if(!old||cost<old.cost)seeds.set(id,{point:[origin[0],origin[1],l],bridge,cost});
            }
          }
        }
      }return seeds;
    }
    async function search(seeds,targets,net,c,soft=false,softPenalty=80){
      if(!seeds.size||!targets.size)return null;
      const finish=measurement?.begin('searching',net.id);
      measurement?.count('searches',1,net.id);
      // Count each newly closed grid state, including the reached goal. Flush
      // only at existing task boundaries, never per-node messages or hooks.
      let expanded=0,reported=0;
      const flush=()=>{if(expanded!==reported){measurement?.count('gridPositions',expanded-reported,net.id);reported=expanded;}};
      try{
      let tag=++searchId;if(!tag){visited.fill(0);closed.fill(0);tag=++searchId;}
      const evaluateGoal=soft||preferShort(net);
      let goalPoints=[...targets.keys()].map(xy),startPoint=xy(seeds.keys().next().value);
      if(!soft)goalPoints.sort((a,b)=>Math.hypot(a[0]-startPoint[0],a[1]-startPoint[1])-Math.hypot(b[0]-startPoint[0],b[1]-startPoint[1]));if(!evaluateGoal)goalPoints=goalPoints.slice(0,12);
      let goalBox=bboxPoints(goalPoints),heap=new Heap(),visitedCount=0,recentNodes=[],recentIndex=0;
      const heuristic=id=>{let p=xy(id),dx=Math.max(goalBox.minX-p[0],0,p[0]-goalBox.maxX)/step,dy=Math.max(goalBox.minY-p[1],0,p[1]-goalBox.maxY)/step;return Math.max(dx,dy)+(SQRT2-1)*Math.min(dx,dy);};
      const layers=traceLayers(net),viaCost=searchViaCost(net)/step;
      let bestGoal=null,bestGoalCost=Infinity;
      const viaHistory=[null],seedViaHeads=new Map();
      const definition=c.via,makeVia=p=>({net:net.id,x:p[0],y:p[1],diameter:definition.diameter,padstack:definition.name,layers:Array.from({length:definition.toLayer-definition.fromLayer+1},(_,i)=>definition.fromLayer+i)});
      function pathViaClear(id,via){
        for(let head=viaHeads?.[id]||0;head;head=viaHistory[head].previous){const other=viaHistory[head].via;if(!G.samePhysicalVia(original,via,other)&&G.viaSpacing(original,via,other)?.violates)return false;}
        return true;
      }
      function addViaHistory(head,via){
        if(head&&G.samePhysicalVia(original,via,viaHistory[head].via))return head;
        viaHistory.push({via,previous:head});return viaHistory.length-1;
      }
      const foundPath=id=>{let path=[];for(let p=id;p>=0;p=parent[p])path.push(p);path.reverse();return{path,seeds,targets};};
      for(const [id,seed]of seeds){visited[id]=tag;gCost[id]=(seed.cost||0)/step;parent[id]=-1;if(viaHeads){viaHeads[id]=0;if(seed.via){let head=seedViaHeads.get(seed.via);if(!head){head=addViaHistory(0,seed.via);seedViaHeads.set(seed.via,head);}viaHeads[id]=head;}}heap.push(id,gCost[id]+heuristic(id));}
      function relax(from,to,cost,via=null){if(closed[to]===tag)return;let g=gCost[from]+cost;if(visited[to]!==tag||g<gCost[to]){visited[to]=tag;gCost[to]=g;parent[to]=from;if(viaHeads)viaHeads[to]=via?addViaHistory(viaHeads[from],via):viaHeads[from];heap.push(to,g+heuristic(to));}}
      while(heap.nodes.length){let entry=heap.pop(),id=entry[0];if(evaluateGoal&&bestGoal!==null&&entry[1]>=bestGoalCost-EPS)return foundPath(bestGoal);if(closed[id]===tag)continue;closed[id]=tag;expanded++;recentNodes[recentIndex++%64]=id;
        if(targets.has(id)&&(!targets.get(id).via||pathViaClear(id,targets.get(id).via))){if(!evaluateGoal)return foundPath(id);const fullCost=gCost[id]+(targets.get(id).cost||0)/step;if(fullCost<bestGoalCost){bestGoal=id;bestGoalCost=fullCost;}}
        if(++visitedCount%4096===0){flush();detail((soft?"Looking for a repair path for ":"Looking for a path for ")+net.name+' · '+visitedCount.toLocaleString('en-US')+' grid positions explored',{stage:'search',netId:net.id,netName:net.name,expanded:visitedCount,repair:soft},finishing?'finishing':'routing');await yieldNow();if(stopped())return null;}
        if(visitedCount%256===0)spatial((soft?"Looking for a repair path for ":"Looking for a path for ")+net.name,{stage:'search',netId:net.id,netName:net.name,expanded:visitedCount,repair:soft,searchId:tag},()=>{
          const branch=[];let node=id;for(;node>=0&&branch.length<2048;node=parent[node])branch.push(xy(node));branch.reverse();
          const traces=[];let segment=null;
          for(const p of branch){
            if(!segment||segment.layer!==p[2]){segment={layer:p[2],points:[]};traces.push(segment);}
            const points=segment.points,at=p.slice(0,2);
            if(points.length>1){const a=points[points.length-2],b=points[points.length-1];if(Math.sign(b[0]-a[0])===Math.sign(at[0]-b[0])&&Math.sign(b[1]-a[1])===Math.sign(at[1]-b[1]))points.pop();}
            points.push(at);
          }
          let remaining=512;const visible=[];
          for(let i=traces.length-1;i>=0&&remaining>0;i--){const trace=traces[i],points=trace.points.slice(-remaining);if(points.length>1){visible.unshift({layer:trace.layer,points});remaining-=points.length;}}
          const truncated=node>=0||traces.reduce((sum,t)=>sum+t.points.length,0)>512;
          return traceVisual(visible,recentNodes.map(xy),'search',truncated?"Grid points explored and the recent path":"Grid points explored and the current path");
        },finishing?'finishing':'routing');
        let l=Math.floor(id/plane),q=id%plane,x=q%nx,y=Math.floor(q/nx);
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;let xx=x+dx,yy=y+dy;if(xx<0||xx>=nx||yy<0||yy>=ny)continue;let next=idx(xx,yy,l);if(!allowed(c.base,next,net.id))continue;let occupied=!allowed(c.dyn,next,net.id);if(occupied&&!soft)continue;const near=!allowed(c.thickBase,id,net.id)||!allowed(c.thickBase,next,net.id)||(!soft&&(!allowed(c.thickDyn,id,net.id)||!allowed(c.thickDyn,next,net.id)));if(near&&!exactEdgeClear(xy(id).slice(0,2),xy(next).slice(0,2),l,net,soft))continue;let bend=0;if(!preferShort(net)&&parent[id]>=0&&Math.floor(parent[id]/plane)===l){let prev=xy(parent[id]),cur=xy(id);if(Math.abs((cur[0]-prev[0])*dy-(cur[1]-prev[1])*dx)>EPS)bend=0.035;}
          // A soft off-axis cost leaves diagonal escapes and obstacle detours
          // available. Selected shorter-route nets keep pure length priority;
          // turning this option off preserves the original search cost.
          let preferred=0;
          if(!preferShort(net))preferred=directions
            ?((directions.get(l)==='vertical'?dx!==0:dy!==0)?0.35:0)
            :((l%2===0?dy!==0:dx!==0)?0.05:0);
          const historical=finishing&&!preferShort(net)&&congestionHistory?congestionHistory[next]*.35:0;
          relax(id,next,(dx&&dy?SQRT2:1)+bend+preferred+historical+(occupied?softPenalty*crossingWeight(c.dyn[next]):0));}
        if(layerCount>1&&!c.via.disabled&&l>=c.via.fromLayer&&l<=c.via.toLayer){let safe=true,occupied=false,history=0;for(let z=c.via.fromLayer;z<=c.via.toLayer;z++){let vi=idx(x,y,z);if(!allowed(c.viaBase,vi,net.id)){safe=false;break;}if(!allowed(c.viaDyn,vi,net.id))occupied=true;if(finishing&&!preferShort(net)&&congestionHistory)history=Math.max(history,congestionHistory[vi]);}if(safe&&(!occupied||soft)){const candidate=makeVia(xy(id));if(existingViaClear(candidate,soft)&&pathViaClear(id,candidate))for(const z of layers)if(z!==l&&z>=c.via.fromLayer&&z<=c.via.toLayer){let next=idx(x,y,z);if(allowed(c.base,next,net.id))relax(id,next,viaCost+history*.35*Math.max(1,viaCost)+(occupied?softPenalty*4:0),candidate);}}}
      }
      return bestGoal===null?null:foundPath(bestGoal);
      }finally{flush();finish?.();}
    }
    function convertPath(found,net){
      let p=found.path,segments=[],vias=[],first=xy(p[0]),last=xy(p[p.length-1]);
      let start=found.seeds.get(p[0])||first,end=found.targets.get(p[p.length-1])||last;
      for(const via of [start.via,end.via])if(via&&!vias.some(v=>Math.hypot(v.x-via.x,v.y-via.y)<EPS))vias.push(via);
      let points=start.bridge?start.bridge.map(p=>p.slice()):[[start[0],start[1]],[first[0],first[1]]],layer=first[2];
      for(let i=1;i<p.length;i++){let v=xy(p[i]);if(v[2]!==layer){if(points.length>1)segments.push({net:net.id,layer,width:net.width,points:simplify(points),fixed:false});let def=original.viaDefs.find(v=>v.name===net.viaName)||original.viaDefs[0];if(!vias.some(a=>Math.hypot(a.x-v[0],a.y-v[1])<EPS))vias.push({net:net.id,x:v[0],y:v[1],diameter:def.diameter,padstack:def.name,layers:Array.from({length:def.toLayer-def.fromLayer+1},(_,k)=>k+def.fromLayer),fixed:false});layer=v[2];points=[[v[0],v[1]]];}else points.push([v[0],v[1]]);}
      if(end.bridge)points.push(...end.bridge.slice().reverse().map(p=>p.slice()));else points.push([end[0],end[1]]);
      segments.push({net:net.id,layer,width:net.width,points:simplify(points),fixed:false});return{traces:segments.filter(t=>length(t)>EPS),vias};
    }
    function blockers(copper,net){let out=new Set();out.traces=new Set();out.vias=new Set();for(const t of board.traces.slice(original.traces.length)){if(t.net===net.id)continue;let clear=Math.max(clearanceOf(net),clearanceOf(rules.get(t.net)));for(const a of copper.traces)if(a.layer===t.layer&&overlap(expanded(bboxPoints(a.points),a.width/2+t.width/2+clear+EPS),bboxPoints(t.points))){outer:for(let i=1;i<a.points.length;i++)for(let j=1;j<t.points.length;j++)if(G.distanceSegments(a.points[i-1],a.points[i],t.points[j-1],t.points[j])<a.width/2+t.width/2+clear+EPS){{out.add(t.net);out.traces.add(t);}break outer;}}
        for(const v of copper.vias)if(v.layers.includes(t.layer)&&t.points.some((p,i)=>i&&segmentDistance(v.x,v.y,t.points[i-1],p)<v.diameter/2+t.width/2+clear+EPS)){out.add(t.net);out.traces.add(t);}}
      for(const v of board.vias.slice(original.vias.length)){if(v.net===net.id)continue;let clear=Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)));for(const t of copper.traces)if(v.layers.includes(t.layer)&&t.points.some((p,i)=>i&&segmentDistance(v.x,v.y,t.points[i-1],p)<v.diameter/2+t.width/2+clear+EPS)){out.add(v.net);out.vias.add(v);}for(const w of copper.vias)if(v.layers.some(l=>w.layers.includes(l))&&Math.hypot(v.x-w.x,v.y-w.y)<v.diameter/2+w.diameter/2+clear+EPS){out.add(v.net);out.vias.add(v);}}return out;}
    function pruneGeneratedIslands(connections){
      const traces=new Set(),vias=new Set();
      for(const component of connections.components)for(const group of component.groups){
        if(group.pads.length||!group.items.length)continue;
        // An imported or protected item preserves its entire copper group.
        // Removing a padless all-generated group cannot disconnect any pads.
        if(!group.items.every(item=>{
          const list=item.kind==='trace'?board.traces:item.kind==='via'?board.vias:null;
          const prefix=item.kind==='trace'?original.traces.length:original.vias.length;
          const object=list?.[item.index];return object&&item.index>=prefix&&!object.fixed&&!object.fanout;
        }))continue;
        for(const item of group.items)(item.kind==='trace'?traces:vias).add((item.kind==='trace'?board.traces:board.vias)[item.index]);
      }
      if(!traces.size&&!vias.size)return false;
      spatial("Removing new traces and vias that became disconnected",{stage:'repair-cleanup',traces:traces.size,vias:vias.size},()=>traceVisual([...traces],[...vias].flatMap(v=>v.layers.map(l=>[v.x,v.y,l])),'check',"Disconnected new copper being removed"),'finishing');
      board.traces=board.traces.filter(t=>!traces.has(t));board.vias=board.vias.filter(v=>!vias.has(v));generation++;
      return true;
    }
    async function relocateBlockedVia(copper,blocked,net){
      if(!finishing||blocked.traces.size||blocked.vias.size!==1||stopped())return null;
      const via=blocked.vias.values().next().value,viaIndex=board.vias.indexOf(via),ownNet=rules.get(via.net);
      if(viaIndex<original.vias.length||via.fixed||via.fanout||!ownNet)return null;
      const center=[via.x,via.y],usedLayers=new Set();
      // Restrict this local adjustment to an ordinary generated transition.
      // Pad attachments, adjacent vias and offset trace contacts need a wider
      // contact model; retain their existing rip-up behavior.
      for(const p of original.pads)if(p.net===via.net)for(const shape of p.shapes)if(via.layers.includes(shape.layer)&&G.distancePointShape(via.x,via.y,shape)<=via.diameter/2+EPS)return null;
      for(const other of board.vias)if(other!==via&&other.net===via.net&&via.layers.some(l=>other.layers.includes(l))&&Math.hypot(other.x-via.x,other.y-via.y)<=via.diameter/2+other.diameter/2+EPS)return null;
      for(const trace of board.traces)if(trace.net===via.net&&via.layers.includes(trace.layer))for(let i=1;i<trace.points.length;i++){
        const distance=segmentDistance(via.x,via.y,trace.points[i-1],trace.points[i]);
        if(distance>via.diameter/2+trace.width/2+EPS)continue;
        if(distance>EPS||!traceLayers(ownNet).includes(trace.layer))return null;
        usedLayers.add(trace.layer);
      }
      if(usedLayers.size<2)return null;
      const before=stats(board,true);if(stopped())return null;
      const routeVias=copper.vias.filter(v=>!board.vias.some(w=>G.samePhysicalVia(original,w,v)));
      const proposal={...board,traces:board.traces.concat(copper.traces),vias:board.vias.filter(v=>v!==via).concat(routeVias)};
      const primitives=G.copper(proposal).primitives,indices=original.layers.map(l=>G.spatialIndex(primitives.filter(p=>p.layer===l.index),indexSize));
      const def=original.viaDefs.find(d=>d.name===via.padstack);
      const clearShape=(shape,isVia=false)=>{
        if(!G.shapeInsideBoard(shape,original,boundaryEdges))return false;
        for(const p of indices[shape.layer].query(G.shapeBounds(shape),maxClearance)){
          const distance=G.distanceShapes(shape,p.shape);
          if(isVia&&p.object.kind==='via'&&G.viaSpacing(original,{...via,x:shape.cx,y:shape.cy},p.object.item)?.violates)return false;
          if(p.net===via.net){
            if(isVia&&p.object.kind==='pad'&&new Set(p.object.item.shapes.map(s=>s.layer)).size===1&&distance<=EPS&&!(original.viaAtSmd&&def?.attachAllowed!==false))return false;
            continue;
          }
          const clearance=Math.max(clearanceOf(ownNet),clearanceOf(rules.get(p.net)),G.clearance(original,ownNet,rules.get(p.net)));
          if(distance+EPS<clearance||distance<=EPS)return false;
        }
        for(const k of original.keepouts||[]){
          if(k.layers&&!k.layers.includes(shape.layer)||k.kind==='via'&&!isVia)continue;
          const distance=G.distanceShapes(shape,k.shape);
          if(distance+EPS<(k.clearance??clearanceOf(ownNet))||distance<=EPS)return false;
        }
        return true;
      };
      let tested=0;
      // 128 finite candidates keep this independent of machine speed and
      // preserve a paused worker's remaining search after Extend.
      for(const factor of [.125,.25,.5,1])for(let direction=0;direction<32;direction++){
        if(stopped())return null;
        if(tested++%16===0){await yieldNow();if(stopped())return null;}
        const angle=direction*Math.PI/16,distance=ownNet.width*factor;
        const moved={...via,x:via.x+Math.cos(angle)*distance,y:via.y+Math.sin(angle)*distance,layers:via.layers.slice()};
        const bridges=[...usedLayers].map(layer=>({net:via.net,layer,width:ownNet.width,points:[center.slice(),[moved.x,moved.y]],fixed:false}));
        spatial('Testing local via adjustment · '+ownNet.name,{stage:'via-relocation',netId:ownNet.id,netName:ownNet.name,candidates:tested},()=>traceVisual(bridges,moved.layers.map(layer=>[moved.x,moved.y,layer]),'candidate',"Via position and its connecting traces being tested"),'finishing');
        if(!moved.layers.every(layer=>clearShape({type:'circle',cx:moved.x,cy:moved.y,r:moved.diameter/2,layer},true))||!bridges.every(t=>clearShape({type:'capsule',a:t.points[0],b:t.points[1],r:t.width/2,layer:t.layer})))continue;
        const candidate={...proposal,traces:proposal.traces.concat(bridges),vias:proposal.vias.concat(moved)};
        detail('Checking local via adjustment · '+ownNet.name,{stage:'via-relocation-check',netId:ownNet.id,netName:ownNet.name},'checking');await yieldNow();if(stopped())return null;
        const checked=stats(candidate,true);
        if(checked.unrouted<before.unrouted&&['totalViolations','clearanceViolations','viaInPadViolations','outlineViolations','keepoutViolations','belowNominalWidthTraceCount'].every(key=>checked[key]<=before[key])&&!stopped()){
          say("Moved a new via nearby to connect "+net.name+" while keeping "+ownNet.name+'.',{phase:'finishing'});
          return candidate;
        }
      }
      return null;
    }
    async function rerouteConflictCluster(copper,blocked,net){
      if(!finishing||!blocked.size||blocked.size>5||![1,2,7,13].includes(repairRound)||stopped())return null;
      const neighbours=[...blocked].map(id=>rules.get(id));
      if(neighbours.some(n=>!n||n.id===net.id||inaccessibleNets.has(n.id)))return null;
      const snapshot=board,savedActivity=routeActivity,before=stats(board,true);
      const issueFields=['totalViolations','clearanceViolations','viaInPadViolations','outlineViolations','keepoutViolations','belowNominalWidthTraceCount'];
      const legal=checked=>issueFields.every(key=>checked[key]<=before[key]);
      const ascending=neighbours.slice().sort((a,b)=>padCounts.get(a.id)-padCounts.get(b.id)||a.id-b.id),byId=neighbours.slice().sort((a,b)=>a.id-b.id);
      const orders=[],seen=new Set();
      for(const order of [ascending,ascending.slice().reverse(),byId,byId.slice().reverse(),shuffled(neighbours,rng(0x434C5553+net.id*131+repairRound)),shuffled(neighbours,rng(0x434C5553+net.id*131+repairRound+7919))]){
        prioritizeShort(order);const key=order.map(n=>n.id).join(',');if(!seen.has(key)){seen.add(key);orders.push(order);}
      }
      try{
        for(let orderIndex=0;orderIndex<orders.length&&!stopped();orderIndex++){
          board=copy(snapshot);generation++;
          const removable=(item,index,prefix)=>index>=prefix&&blocked.has(item.net)&&!item.fixed&&!item.fanout;
          board.traces=board.traces.filter((t,i)=>!removable(t,i,original.traces.length));
          board.vias=board.vias.filter((v,i)=>!removable(v,i,original.vias.length));
          board.traces.push(...copy(copper.traces));
          for(const v of copper.vias)if(!board.vias.some(w=>G.samePhysicalVia(original,w,v)))board.vias.push(copy(v));
          generation++;
          // The pending path stays present while neighbours reconnect using
          // hard searches only. A failed trial cannot change the working board.
          detail('Trying local reroute · '+net.name+' and '+neighbours.length+' neighbouring nets · order '+(orderIndex+1)+'/'+orders.length,{stage:'cluster-repair',netId:net.id,netName:net.name,order:orderIndex+1,total:orders.length},'finishing',true);
          spatial('Testing local reroute · '+net.name,{stage:'cluster-repair',netId:net.id,netName:net.name,order:orderIndex+1},()=>traceVisual(copper.traces,copper.vias.flatMap(v=>v.layers.map(l=>[v.x,v.y,l])),'candidate',"Proposed path kept while nearby routes are repaired"),'finishing');
          await yieldNow();if(stopped())return null;
          if(!legal(stats(board,true)))return null;
          for(const neighbour of orders[orderIndex]){
            if(stopped())return null;
            measurement?.count('ripups',1,neighbour.id);
            routeActivity={...savedActivity,netId:neighbour.id,netName:neighbour.name,stage:'cluster-repair',order:orderIndex+1};
            await routeNet(neighbour,false,true,true,false);
          }
          await yieldNow();if(stopped())return null;
          const checked=stats(board,true);
          if(checked.unrouted<before.unrouted&&legal(checked)&&!stopped()){
            say('Connected '+net.name+' by rerouting '+neighbours.length+' neighbouring nets.',{phase:'finishing'});
            return board;
          }
        }
        return null;
      }finally{
        // Preserve object identities for the caller's blocker sets and use a
        // fresh generation so rasters from a discarded trial cannot be reused.
        board=snapshot;generation++;routeActivity=savedActivity;
      }
    }
    function removeNet(net){board.traces=board.traces.filter((t,i)=>i<original.traces.length||t.net!==net);board.vias=board.vias.filter((v,i)=>i<original.vias.length||v.net!==net);generation++;}
    clearSpatial('route-groups','routing');detail("Checking which pads are already connected",{stage:'route-groups'},'routing');await yieldNow();
    const initialConnections=connectivity(original),groupsByNet=new Map(initialConnections.components.map(c=>[c.net,c.groups]));
    const densityScores=new Map();
    async function sortByDensity(order){
      clearSpatial('net-order','routing');
      let lastOrderYield=Date.now();
      // Density depends only on imported pads and net width. Compute it once
      // per net, rather than repeating the same scan in every sort comparison.
      for(let i=0;i<order.length;i++){
        const net=order[i];
        if(!densityScores.has(net.id))densityScores.set(net.id,original.pads.filter(p=>p.net===net.id).reduce((sum,p)=>sum+original.pads.filter(q=>q.net!==net.id&&Math.hypot(q.x-p.x,q.y-p.y)<net.width*5).length,0));
        if(i%8===0){detail("Choosing which crowded nets to try first · "+(i+1)+'/'+order.length,{stage:'net-order',processed:i+1,total:order.length},finishing?'finishing':'routing');if(Date.now()-lastOrderYield>=24){await yieldNow();lastOrderYield=Date.now();}if(stopped())return;}
      }
      order.sort((a,b)=>densityScores.get(b.id)-densityScores.get(a.id));
    }

    async function routeNet(net,softAllowed,keepExisting=false,localOnly=false,allowLocalTransactions=true){measurement?.count('netAttempts',1,net.id);detail('Routing '+net.name+' · attempt '+(routeActivity.attempt||1),{stage:'net',netId:net.id,netName:net.name},finishing?'finishing':'routing');if(stopped())return{failed:true,ripped:new Set()};let connections=keepExisting?connectivity(board):null;if(finishing&&connections&&pruneGeneratedIslands(connections)){await yieldNow();if(stopped())return{failed:true,ripped:new Set()};connections=connectivity(board);}let c=await getRaster(net);if(stopped())return{failed:true,ripped:new Set()};let groups=(connections?(connections.components.find(c=>c.net===net.id)?.groups||[]):(groupsByNet.get(net.id)||[])).filter(g=>g.points&&g.points.length&&(!inaccessibleGroups.has(net.id)||hasLayerAccess(g,net)));if(groups.length<=1)return{failed:false,ripped:new Set()};let ordered=groups.map(g=>({group:g,seeds:groupSeeds(g,net,c)}));ordered.sort((a,b)=>b.seeds.size-a.seeds.size);let root=ordered.shift(),targets=new Map(root.seeds),targetGroups=[root.group],remaining=ordered,ripped=new Set(),failed=false;
      // The route tree grows monotonically within this net attempt. Keep the
      // exact nearest distance and compare only newly added points after each
      // branch, rather than rescanning the full tree in every sort comparison.
      let distanceTargets=targets.size?[...targets.keys()].map(xy):targetGroups.flatMap(group=>group.points);
      for(const entry of remaining)entry.treeDistance=distanceToTree(entry.group,distanceTargets);
      while(remaining.length&&!stopped()){remaining.sort((a,b)=>a.treeDistance-b.treeDistance);let next=remaining.shift(),found=await search(next.seeds,targets,net,c,false);
        if(!found&&softAllowed){
          // Generated routes can block the attachment bridge before A* starts.
          // Let soft search reach those endpoints, then rip every crossed net
          // using the same blocker check as the body of the candidate route.
          const softPenalty=finishing?[4,12,35,90,250,.5][(repairRound-1)%6]:35,softTargets=new Map(),viaPrices=new Map();
          // Foreign copper can move between branches. Reprice old attachment
          // bridges against this generation instead of retaining a stale cost.
          for(const [id,seed]of targets){
            if(!seed.bridge){softTargets.set(id,seed);continue;}
            if(seed.via&&!viaPrices.has(seed.via))viaPrices.set(seed.via,endpointViaPenalty(seed.via,net,softPenalty));
            const cost=length({points:seed.bridge})+bridgePenalty(seed.bridge,xy(id)[2],net,c,softPenalty)+(seed.via?searchViaCost(net)+viaPrices.get(seed.via):0);
            softTargets.set(id,{...seed,cost});
          }
          for(const group of targetGroups)for(const [id,seed]of groupSeeds(group,net,c,true,softPenalty)){const old=softTargets.get(id);if(!old||(seed.cost||0)<(old.cost||0))softTargets.set(id,seed);}
          found=await search(groupSeeds(next.group,net,c,true,softPenalty),softTargets,net,c,true,softPenalty);
        }
        if(!found){failed=true;continue;}let copper=convertPath(found,net);if(!candidateViasClear(copper)){failed=true;continue;}spatial('Checking route candidate · '+net.name,{stage:'route-candidate',netId:net.id,netName:net.name},()=>traceVisual(copper.traces,copper.vias.flatMap(v=>v.layers.map(l=>[v.x,v.y,l])),'candidate',"Proposed path being checked"),finishing?'finishing':'routing');let blocked=blockers(copper,net),committed=false;
        if(finishing&&blocked.size&&allowLocalTransactions){
          let adjusted=await relocateBlockedVia(copper,blocked,net);
          // A cluster changes foreign attachments. Limit it to the last branch
          // here; later net attempts rebuild their seed maps from current copper.
          if(!adjusted&&localOnly&&!remaining.length)adjusted=await rerouteConflictCluster(copper,blocked,net);
          if(adjusted){board=adjusted;generation++;if(remaining.length)c=await getRaster(net);blocked=new Set();committed=true;}
        }
        if(localOnly&&blocked.size){failed=true;continue;}
        if(blocked.size){
          if(finishing){
            // Retain connected branches of a blocked net. Only copper actually
            // crossed by this candidate needs to be repaired.
            // A small bounded historical cost discourages cutting the same
            // region again; it never changes whether copper is legal.
            if(!await rememberCongestion(blocked,net))return{failed:true,ripped};
            board.traces=board.traces.filter(t=>!blocked.traces.has(t));
            board.vias=board.vias.filter(v=>!blocked.vias.has(v));generation++;
            for(const n of blocked){measurement?.count('ripups',1,n);ripped.add(n);ripHistory.set(n,(ripHistory.get(n)||0)+1);}
            if(pruneGeneratedIslands(connectivity(board))){await yieldNow();if(stopped())return{failed:true,ripped};}
          }else for(const n of blocked){measurement?.count('ripups',1,n);removeNet(n);ripped.add(n);}
          c=await getRaster(net);
        }
        if(!committed){board.traces.push(...copper.traces);for(const v of copper.vias)if(!board.vias.some(w=>G.samePhysicalVia(original,w,v)))board.vias.push(v);generation++;}
        const hadTargets=targets.size>0,addedTargets=[];
        targetGroups.push(next.group);for(const id of found.path){const point=xy(id);if(!targets.has(id))addedTargets.push(point);targets.set(id,point);}for(const [id,p]of next.seeds){if(!targets.has(id))addedTargets.push(xy(id));targets.set(id,p);}
        // A soft repair can create the first usable grid attachments. In that
        // case the old fallback pad points are replaced, rather than retained.
        if(!hadTargets&&targets.size){distanceTargets=[...targets.keys()].map(xy);for(const entry of remaining)entry.treeDistance=distanceToTree(entry.group,distanceTargets);}
        else if(addedTargets.length)for(const entry of remaining)entry.treeDistance=Math.min(entry.treeDistance,distanceToTree(entry.group,addedTargets));
      }return{failed,ripped};}
    function distanceToTree(group,points){let best=Infinity;for(const p of group.points)for(const q of points)best=Math.min(best,Math.hypot(p[0]-q[0],p[1]-q[1]));return best;}
    function scoreBetter(a,b){if(a.totalViolations>baseTotal||a.clearanceViolations>baseViolation||a.belowNominalWidthTraceCount>baseWidth)return false;const key=s=>shortNets.size?[s.unrouted,s.totalViolations,s.belowNominalWidthTraceCount,s.preferredTraceLengthMm,s.viaCount,s.traceLengthMm]:[s.unrouted,s.viaCount,s.traceLengthMm];let ka=key(a),kb=key(b);for(let i=0;i<ka.length;i++){if(ka[i]<kb[i]-1e-8)return true;if(ka[i]>kb[i]+1e-8)return false;}return false;}
    function safeRefinement(candidate,measured,reference=best,referenceStats=bestStats){
      const before=connectivity(reference),after=connectivity(candidate);
      return noRuleRegression(measured,referenceStats)&&preservesModelRules(candidate,reference)&&preservesProtectedCopper(candidate,reference)&&preservesPadPartitions(before,after)&&preservesProtectedConnections(reference,before,candidate,after)&&noNewRuleViolations(reference,validationReports.get(referenceStats),candidate,validationReports.get(measured));
    }
    // Bounded complete-board restarts with difficult-net-first ordering and rip-up repair.
    let failures=new Set(),passes=attemptLimit,completeWithoutImprovement=0,routingDone=false;
    const completeOrders=new Set();
    const viaKey=v=>JSON.stringify([v.net,v.padstack,v.x,v.y,v.diameter,v.layers]);
    const originalViaKeys=new Set(original.vias.map(viaKey));
    const refinementOptions=options;
    function restoreRoutingPrefix(candidate){
      const restored=copy(candidate);
      restored.traces=[...copy(original.traces),...restored.traces.slice(original.traces.length)];
      restored.vias=[...copy(original.vias),...restored.vias.filter(v=>!originalViaKeys.has(viaKey(v)))];
      return restored;
    }
    say("Routing grid: "+nx+' × '+ny+' grid, '+layerCount+' layers, '+step.toPrecision(3)+' '+original.units.name+' step.',{phase:'routing',pass:0,board:copy(best),stats:bestStats});
    let nextAttempt=1,stage=0;
    while(nextAttempt<=passes&&!stopped()){
    stage++;
    const stageStart=nextAttempt,stageEnd=Math.min(stageStart+11,passes);
    const stageHasMore=()=>stageEnd<passes&&!routingDone&&!(bestStats.unrouted===0&&(!shortNets.size||initialStats.unrouted===0));
    // Refinement may shorten imported stubs or remove an unused imported via.
    // Rebuild and check the immutable routing prefix before another stage can
    // use index-based rip-up, while leaving the better export untouched.
    const workingSource=best;let workingBest=best,workingSafe=true;
    if(stage>1){
      workingBest=restoreRoutingPrefix(best);const workingStats=stats(workingBest,true);
      workingSafe=workingStats.unrouted<=bestStats.unrouted&&['totalViolations','clearanceViolations','viaInPadViolations','outlineViolations','keepoutViolations','belowNominalWidthTraceCount'].every(key=>workingStats[key]<=bestStats[key]);
      if(!workingSafe){workingBest=original;say("Keeping the checked result. The next routing stage starts from your imported copper.",{phase:'checking'});}
    }
    for(let pass=stageStart;pass<=stageEnd&&!stopped();pass++){
      let alternateOrder=null;
      if(shortNets.size&&bestStats.unrouted===0&&initialStats.unrouted>0){
        // Once complete, only try distinct full-board orders. A single routable
        // net cannot benefit from repeatedly replaying the same search.
        for(let variant=0;variant<32;variant++){
          const candidate=prioritizeShort(shuffled(routingNets,rng(0x52414D45+pass*7919+variant*104729)));
          if(!completeOrders.has(candidate.map(n=>n.id).join(','))){alternateOrder=candidate;break;}
        }
        if(!alternateOrder){say("No new routing order left for the selected nets. Keeping the shortest checked result.",{phase:'routing'});routingDone=true;break;}
      }
      counters.attempt.current=pass;counters.attempt.status='running';counters.work=null;reportCounters('routing');
      const previousShortLength=bestStats.preferredTraceLengthMm,wasComplete=bestStats.unrouted===0;
      const useWorkingSeed=best===workingSource;
      const repairMode=pass>1&&pass%2===0&&!(shortNets.size&&wasComplete)&&(!useWorkingSeed||workingSafe);board=copy(repairMode?(useWorkingSeed?workingBest:best):original);generation++;let random=rng(0x52414D45+pass*7919),order=shuffled(routingNets,random);
      if(pass===1)await sortByDensity(order);else order.sort((a,b)=>(failures.has(b.id)?1:0)-(failures.has(a.id)?1:0));
      let queue=(alternateOrder||prioritizeShort(order)).filter(n=>!repairMode||failures.has(n.id)),attempts=new Map(),currentFailures=new Set(),processed=0,maxWork=nets.length*(pass===1?2:3);
      if(shortNets.size&&!repairMode)completeOrders.add(queue.map(n=>n.id).join(','));
      routeActivity={pass,processed:0,total:maxWork};detail("Starting attempt "+pass+'/'+passes+' · '+queue.length+' nets queued',{stage:'pass',queued:queue.length},'routing',true);await yieldNow();
      while(queue.length&&processed<maxWork&&!stopped()){
        let net=queue.shift(),count=(attempts.get(net.id)||0)+1;routeActivity={pass,netId:net.id,netName:net.name,processed,total:maxWork,attempt:count};attempts.set(net.id,count);if(count>3){currentFailures.add(net.id);continue;}if(!repairMode)removeNet(net.id);let result=await routeNet(net,pass>1&&count<3,repairMode);processed++;if(result.failed)currentFailures.add(net.id);else currentFailures.delete(net.id);for(const id of result.ripped){let n=rules.get(id);if(n&&!queue.some(x=>x.id===id))queue.push(n);currentFailures.add(id);}prioritizeShort(queue);
        const candidateConnection=connectivity(board);
        if(candidateConnection.unrouted<bestStats.unrouted){if(detail('Checking improved route · '+net.name,{stage:'candidate-check'},'checking'))await yieldNow();let candidateStats=stats(board,true,candidateConnection);if(scoreBetter(candidateStats,bestStats)){best=copy(board);bestStats=candidateStats;await checkpoint(pass);}}
        if(processed%3===0){if(Date.now()-lastPreview>=1200){lastPreview=Date.now();emit({type:'progress',phase:'routing',pass,message:"Attempt "+pass+' · '+processed+' net attempts · '+queue.length+' queued · last '+net.name,activity:{...routeActivity,processed,queued:queue.length,stage:'net-complete'},board:copy(board),stats:stats(board,false,candidateConnection)});}await yieldNow();}
      }
      emit({type:'progress',phase:'checking',pass,message:"Checking all clearances and connections"});await yieldNow();let measured=stats(board,true);if(scoreBetter(measured,bestStats)){best=copy(board);bestStats=measured;await checkpoint(pass);}failures=new Set(connectivity(best).components.filter(hasRoutableGap).map(c=>c.net));say("Attempt "+pass+': '+measured.unrouted+' remaining, '+measured.viaCount+' vias; best '+bestStats.unrouted+' remaining.',{phase:'routing',pass,board:copy(best),stats:bestStats});if(!stopped()){counters.attempt.completed++;reportCounters('routing');}if(bestStats.unrouted===0){
        if(!shortNets.size||initialStats.unrouted===0){routingDone=true;break;}
        completeWithoutImprovement=wasComplete&&bestStats.preferredTraceLengthMm>=previousShortLength-EPS?completeWithoutImprovement+1:0;
        if(completeWithoutImprovement>=3){say("The selected nets didn’t get shorter in 3 complete-board attempts. Keeping the shortest checked result.",{phase:'routing'});routingDone=true;break;}
        if(pass<passes&&!stopped())say("All connections routed. Trying another order to shorten the selected nets.",{phase:'routing'});
      }
      nextAttempt=pass+1;
      if(inaccessibleGroups.size&&!failures.size){routingDone=true;break;}
    }
    if(stageEnd>=passes||routingDone)finishCounter('attempt','routing');
    else if(!stopped()){counters.attempt.status='pending';counters.work=null;reportCounters('routing');}
    if(stageCount>1&&!stopped())say('Checking routing stage '+stage+'/'+stageCount+' after '+counters.attempt.completed+' attempts.',{phase:'checking'});
    if(options.optimize!==false&&optimizer&&!stopped()){
      counters.refinement.current++;counters.refinement.status='running';counters.work=null;reportCounters('optimizing');
      emit({type:'progress',phase:'optimizing',message:'Refining the checked route'});
      const optimized=await optimizer.optimize(copy(best),refinementOptions,emit,stopped,refinementWork);let candidate=stats(optimized,true);
      if(scoreBetter(candidate,bestStats)&&safeRefinement(optimized,candidate)){best=optimized;bestStats=candidate;await checkpoint();}
      if(!stopped()){counters.refinement.completed++;counters.refinement.status=refinementLimit>1?'pending':'done';counters.work=null;reportCounters('optimizing');}
    }
    // A nearly complete large board can still have more than six local gaps.
    // Scale eligibility with its starting work, capped at twelve connections;
    // the existing eighteen-round repair budget and full checks stay unchanged.
    const finishingGapLimit=Math.min(12,Math.max(6,Math.floor(initialStats.unrouted*.1)));
    if(options.deepSearch!==false&&bestStats.unrouted>0&&bestStats.unrouted<=finishingGapLimit&&(!inaccessibleGroups.size||failures.size)&&!stopped()){
      const beforeFinishing=bestStats.unrouted;
      // Refinement can reshape escape stubs and remove unused escape vias.
      // Rebuild the immutable prefix before the router indexes generated copper.
      const restored=restoreRoutingPrefix(best);
      const restoredStats=stats(restored,true);
      const safe=restoredStats.unrouted<=bestStats.unrouted&&restoredStats.totalViolations<=bestStats.totalViolations&&restoredStats.clearanceViolations<=bestStats.clearanceViolations&&restoredStats.belowNominalWidthTraceCount<=bestStats.belowNominalWidthTraceCount;
      if(safe&&!stopped()){
        // The working seed may contain extra escape vias. Keep it separate from
        // the best exportable result, which must never get worse during repair.
        let repairBest=restored,repairStats=restoredStats,repairSeed=restored;
        // Keep the safest export separate from the layout used for exploration.
        // Moving one congested branch can temporarily expose a few other gaps;
        // restarting every round from the same best layout loses that progress.
        const repairSignature=candidate=>{
          const text=JSON.stringify([candidate.traces,candidate.vias]);let a=2166136261,b=2246822507;
          for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,3266489909);}
          return text.length+':'+(a>>>0)+':'+(b>>>0);
        };
        const repairSeen=new Set([repairSignature(restored)]);
        const legalRepair=(candidate,reference)=>['totalViolations','clearanceViolations','viaInPadViolations','outlineViolations','keepoutViolations','belowNominalWidthTraceCount'].every(key=>candidate[key]<=reference[key]);
        let repairFailures=new Set(connectivity(repairBest).components.filter(hasRoutableGap).map(c=>c.net));
        finishing=true;congestionHistory=null;ripHistory.clear();
        const retain=async(measured)=>{
          if(scoreBetter(measured,repairStats)){repairBest=copy(board);repairStats=measured;}
          if(scoreBetter(measured,bestStats)){best=copy(board);bestStats=measured;await checkpoint(counters.attempt.current,'finishing');}
        };
        for(repairRound=1;repairRound<=18&&!stopped()&&bestStats.unrouted>0&&(!inaccessibleGroups.size||repairFailures.size);repairRound++){
          counters.repair.current=counters.repair.completed+1;counters.repair.status='running';counters.work=null;reportCounters('finishing');
          board=copy(repairSeed);generation++;
          let random=rng(0x52414D45+repairRound*7919),order=shuffled(routingNets,random);
          if(repairRound===1)await sortByDensity(order);else order.sort((a,b)=>(repairFailures.has(b.id)?1:0)-(repairFailures.has(a.id)?1:0));
          const queue=prioritizeShort(order).filter(n=>repairFailures.has(n.id)),attempts=new Map();
          let processed=0,maxWork=nets.length*(repairRound===1?2:3);
          let trialSeed=null,trialStats=null,trialSignature=null;
          const rememberTrial=measured=>{
            if(!legalRepair(measured,repairStats)||measured.unrouted>repairStats.unrouted+3||trialStats&&measured.unrouted>=trialStats.unrouted)return;
            const signature=repairSignature(board);if(repairSeen.has(signature))return;
            trialSeed=copy(board);trialStats=measured;trialSignature=signature;
          };
          emit({type:'progress',phase:'finishing',pass:counters.attempt.current,message:'Finishing remaining connections · repair '+repairRound});
          // Try non-destructive connections and local via moves before a
          // broader repair changes the neighbouring routes they can preserve.
          for(const net of queue.slice()){
            if(stopped())break;
            routeActivity={pass:counters.attempt.current,repairRound,netId:net.id,netName:net.name,stage:'local-repair'};
            await routeNet(net,true,true,true);
            const measured=stats(board,true);await retain(measured);rememberTrial(measured);
            if(bestStats.unrouted===0)break;
          }
          while(queue.length&&processed<maxWork&&!stopped()&&bestStats.unrouted>0){
            const net=queue.shift(),count=(attempts.get(net.id)||0)+1;routeActivity={pass:counters.attempt.current,repairRound,netId:net.id,netName:net.name,processed,total:maxWork,attempt:count};attempts.set(net.id,count);if(count>3)continue;
            const result=await routeNet(net,repairRound>1&&count<3,true);processed++;
            for(const id of result.ripped){const n=rules.get(id);if(n&&!queue.some(x=>x.id===id))queue.push(n);}prioritizeShort(queue);
            const candidateConnection=connectivity(board);
            if(candidateConnection.unrouted<=repairStats.unrouted+3){if(detail('Checking repaired route · '+net.name,{stage:'candidate-check'},'checking'))await yieldNow();const measured=stats(board,true,candidateConnection);await retain(measured);rememberTrial(measured);}
            if(processed%3===0){if(Date.now()-lastPreview>=1200){lastPreview=Date.now();emit({type:'progress',phase:'finishing',pass:counters.attempt.current,message:'Finishing repair '+repairRound+' · '+processed+' net attempts · '+queue.length+' queued · last '+net.name,activity:{...routeActivity,processed,queued:queue.length,stage:'net-complete'},board:copy(board),stats:stats(board,false,candidateConnection)});}await yieldNow();}
          }
          emit({type:'progress',phase:'checking',pass:counters.attempt.current,message:'Checking the repaired connections'});await yieldNow();
          const measured=stats(board,true);await retain(measured);rememberTrial(measured);
          if(trialSeed&&legalRepair(trialStats,repairStats)&&trialStats.unrouted<=repairStats.unrouted+3){
            repairSeen.add(trialSignature);repairSeed=trialSeed;
            if(trialStats.unrouted>=repairStats.unrouted)say("Trying a checked alternative to make room · "+trialStats.unrouted+' connections remaining.',{phase:'finishing'});
          }else repairSeed=copy(repairBest);
          repairFailures=new Set(connectivity(repairSeed).components.filter(hasRoutableGap).map(c=>c.net));
          say('Finishing repair '+repairRound+': '+measured.unrouted+' remaining; best '+bestStats.unrouted+' remaining.',{phase:'finishing',pass:counters.attempt.current,board:copy(best),stats:bestStats});
          if(!stopped()){counters.repair.completed++;reportCounters('finishing');}
        }
        finishing=false;
        if(!stageHasMore())finishCounter('repair','finishing');
        else if(!stopped()){counters.repair.status='pending';counters.work=null;reportCounters('finishing');}
        if(bestStats.unrouted<beforeFinishing&&options.optimize!==false&&optimizer&&!stopped()){
          counters.refinement.current++;counters.refinement.status='running';counters.work=null;reportCounters('optimizing');
          emit({type:'progress',phase:'optimizing',message:'Refining the repaired route'});
          const optimized=await optimizer.optimize(copy(best),refinementOptions,emit,stopped,refinementWork),measured=stats(optimized,true);
          if(scoreBetter(measured,bestStats)&&safeRefinement(optimized,measured)){best=optimized;bestStats=measured;await checkpoint();}
          if(!stopped()){counters.refinement.completed++;counters.refinement.status=stageHasMore()?'pending':'done';counters.work=null;reportCounters('optimizing');}
        }
      }else if(!safe)say("Keeping the checked route. Restoring the fanouts didn’t pass all the rule checks.",{phase:'checking'});
    }
    if(options.flexibleFinishing===true&&flexibleFinisher&&bestStats.unrouted>0&&!stopped()){
      const before=connectivity(best),remainingLinks=missingPadLinks(before);
      if(remainingLinks>0&&remainingLinks<=4){
        counters.repair.limit=Math.max(counters.repair.limit,counters.repair.completed+1);counters.repair.current=counters.repair.completed+1;counters.repair.status='running';counters.work=null;reportCounters('finishing');
        const retain=candidate=>{if(!candidate)return false;const measured=stats(candidate,true);if(scoreBetter(measured,bestStats)&&safeRefinement(candidate,measured)){best=copy(candidate);bestStats=measured;return true;}return false;};
        let pendingCheckpoint=Promise.resolve();
        const checkedEmit=message=>{if(message?.type!=='checkpoint')return emit(message);if(!retain(message.board||message.model))return;const saved={type:'checkpoint',phase:'finishing',pass:counters.attempt.current,board:copy(best),stats:bestStats,validation:copy(validationReports.get(bestStats)),counters:counterSnapshot()};pendingCheckpoint=pendingCheckpoint.then(()=>emit(saved));pendingCheckpoint.catch(()=>{});return pendingCheckpoint;};
        const result=await flexibleFinisher.improveRoutingBest(copy(best),{...options,preserveTraceCount:0,preserveViaCount:0},checkedEmit,stopped,work=>{if(stopped())return;counters.work={...work};reportCounters('finishing');}),candidate=result?.model||result?.board||result;
        await pendingCheckpoint;if(retain(candidate))await checkpoint(counters.attempt.current,'finishing');
        if(!stopped()){counters.repair.completed++;counters.repair.status='done';counters.work=null;reportCounters('finishing');}
      }
    }
    finishing=false;repairRound=0;congestionHistory=null;ripHistory.clear();
    let continuationAccepted=false;
    if(nextAttempt>passes&&bestStats.unrouted>0&&!stopped()&&typeof yieldTask?.requestContinuation==='function'){
      await checkpoint(counters.attempt.current,'checking');
      const remainingLinks=missingPadLinks(connectivity(best));
      const askedAt=Date.now();
      const choice=await yieldTask.requestContinuation({reason:'attempts',stats:copy(bestStats),initialStats:copy(initialStats),counters:counterSnapshot(),nextAttempt,remainingPadLinks:remainingLinks,canRefine:!!optimizer,canFlexibleFinish:!!flexibleFinisher&&remainingLinks>0&&remainingLinks<=4});
      if(!yieldTask.managesBudget)deadline+=Date.now()-askedAt;
      if(isCancelled())break;
      if(choice?.action!=='continue')break;
      const requested=Number(choice.extraAttempts);
      if(!Number.isFinite(requested)||requested<1){say('No extra attempts added. Keeping the best checked result.',{phase:'checking'});break;}
      const added=Math.min(100,Math.floor(requested));
      passes+=added;attemptLimit=passes;stageCount=stage+Math.ceil(added/12);counters.attempt.limit=passes;
      routingDone=false;continuationAccepted=true;
      refinementLimit=Math.max(counters.refinement.limit,options.optimize===false||!optimizer?0:counters.refinement.completed+(options.deepSearch===false?1:2)*Math.ceil(added/12));
      repairLimit=Math.max(counters.repair.limit,options.deepSearch===false?0:counters.repair.completed+18*Math.ceil(added/12));
      counters.refinement.limit=refinementLimit;counters.refinement.conditional=refinementLimit>1;counters.repair.limit=repairLimit;counters.attempt.status='pending';
      const extraTimeMs=Number(choice.extraTimeMs);if(!yieldTask.managesBudget&&Number.isFinite(extraTimeMs)&&extraTimeMs>0)deadline=Math.max(deadline,Date.now())+extraTimeMs;
      say('Added '+added+' routing attempts. Continuing with attempt '+nextAttempt+'/'+passes+'.',{phase:'routing',counters:counterSnapshot()});
    }
    if(routingDone||bestStats.unrouted===0&&(!shortNets.size||initialStats.unrouted===0))break;
    if(stageEnd<passes&&!stopped()){
      failures=new Set(connectivity(best).components.filter(hasRoutableGap).map(c=>c.net));
      if(inaccessibleGroups.size&&!failures.size&&!continuationAccepted)break;
      for(const name of ['repair','refinement'])if(counters[name].limit)counters[name].status='pending';
      counters.work=null;reportCounters('routing');
      say('Continuing with routing attempt '+(stageEnd+1)+'/'+passes+" after checking the result kept so far.",{phase:'routing'});
    }
    }
    finishCounter('attempt','routing');
    finishCounter('repair','finishing');finishCounter('refinement','optimizing');
    clearSpatial('route-finished');emit({type:'progress',phase:'checking',board:copy(best),stats:bestStats,message:bestStats.unrouted+" connections left."});
    return{board:best,stats:bestStats,initialStats,log,counters:counterSnapshot(),stopped:stopped()};
    }finally{finishRoute?.();}
  }
  return{route,refineCurrentBest,layerDirections};
}
if(typeof globalThis!=='undefined')globalThis.createRamenRouter=createRamenRouter;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenRouter};
