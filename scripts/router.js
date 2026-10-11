/* RamenRouter browser-native grid router. GPL-3.0. No Java or external runtime. */
function createRamenRouter(geometry, optimizer, fanout, yieldTask, copper) {
  'use strict';
  const G=geometry, SQRT2=Math.SQRT2, EPS=1e-7;
  const copy=o=>JSON.parse(JSON.stringify(o));
  const yieldNow=typeof yieldTask==='function'?yieldTask:()=>new Promise(r=>setTimeout(r,0));
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
  async function route(input,options={},emit=()=>{},isCancelled=()=>false){
    const measurement=yieldTask?.measurement,finishRoute=measurement?.begin('routing');
    const fillSignatures=new WeakMap(),fillCache=new Map();
    const hasZones=board=>(board.copperZones||[]).length>0;
    const fillProgress=activity=>emit({type:'progress',phase:'copper_fill',message:activity.message,activity});
    // A pour is derived from the current tracks and vias. Never check a route
    // against yesterday's copper: a new foreign track can split a plane.
    function refreshFills(board){
      if(!hasZones(board))return;
      if(!copper?.build)throw new Error("Copper fills aren’t ready for routing. Reload RamenRouter and try again.");
      const signature=JSON.stringify([board.copperZones,board.traces,board.vias]);
      if(fillSignatures.get(board)===signature)return;
      if(fillCache.has(signature)){board.copperFills=copy(fillCache.get(signature));fillCache.delete(signature);fillCache.set(signature,board.copperFills);}
      else{board.copperFills=copper.build(board,options,fillProgress);fillCache.set(signature,board.copperFills);while(fillCache.size>4)fillCache.delete(fillCache.keys().next().value);}
      fillSignatures.set(board,signature);
    }
    const connectivity=board=>{const finish=measurement?.begin('checking');try{refreshFills(board);return G.connectivity(board,{airwires:false});}finally{finish?.();}};
    try{
    const started=Date.now(),timeout=(options.timeoutMinutes||30)*60000,log=[];
    const stopped=()=>isCancelled()||(!yieldTask?.managesBudget&&Date.now()-started>=timeout);
    const attemptLimit=options.fanoutOnly?0:options.deepSearch===false?1:Math.max(1,Math.min(options.maxPasses||12,100));
    // A larger attempt budget adds later stages; it must not postpone repair
    // of a promising layout reached by the ordinary twelve-attempt search.
    const stageCount=Math.max(1,Math.ceil(attemptLimit/12));
    const refinementLimit=options.fanoutOnly||options.optimize===false||!optimizer?0:(options.deepSearch===false?1:2)*stageCount;
    const repairLimit=options.fanoutOnly||options.deepSearch===false?0:18*stageCount;
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
    let original=copy(input);original.traces=original.traces||[];original.vias=original.vias||[];
    if(typeof options.viaInPad==='boolean'){original.viaAtSmd=options.viaInPad;original.viaInPadApplied=options.viaInPad;original.viaInPadOverride=options.viaInPad;for(const v of original.viaDefs)v.attachAllowed=options.viaInPad;}
    const rules=netRules(original),padCounts=new Map(original.nets.map(n=>[n.id,original.pads.filter(p=>p.net===n.id).length])), nets=original.nets.filter(n=>original.pads.filter(p=>p.net===n.id).length>1);
    const shortNets=new Set(nets.filter(n=>n.preferShort===true).map(n=>n.id));
    const preferShort=net=>shortNets.has(net.id);
    const directions=options.preferredDirections===true&&original.layers.length>1?layerDirections(original.layers):null;
    const prioritizeShort=order=>{if(shortNets.size)order.sort((a,b)=>Number(preferShort(b))-Number(preferShort(a)));return order;};
    async function attachPadsToPlanes(prepared){
      const tracesBefore=prepared.traces.length,viasBefore=prepared.vias.length;
      say("Finding short connections from pads to copper fills.",{phase:'fanout'});
      // Unanchored islands are temporary placement candidates only. The
      // ordinary rebuild below removes any island still without an anchor.
      await copper.rebuild(prepared,{...options,keepUnanchored:true},fillProgress,stopped);
      const edges=G.boundaryEdges(prepared),defs=new Map(prepared.viaDefs.map(def=>[def.name,def]));
      const isMutable=primitive=>primitive.object.kind==='fill'&&primitive.object.item.zoneId!=null&&!primitive.object.item.fixed&&!primitive.object.item.imported;
      const maxClear=Math.max(prepared.crossClassClearance||0,prepared.defaultClearance||0,...Object.values(prepared.classClearances||{}),...prepared.nets.map(net=>net.routingClearance??net.clearance??0));
      const span=Math.max(prepared.bounds.maxX-prepared.bounds.minX,prepared.bounds.maxY-prepared.bounds.minY);
      const indices=prepared.layers.map(layer=>G.spatialIndex(G.copper(prepared).primitives.filter(p=>p.layer===layer.index&&!isMutable(p)),Math.max(span/60,1e-5)));
      function legal(shape,net,isVia,def){
        if(!G.shapeInsideBoard(shape,prepared,edges))return false;
        for(const other of indices[shape.layer]?.query(G.shapeBounds(shape),maxClear)||[]){
          const distance=G.distanceShapes(shape,other.shape);
          if(other.net!==net.id){if(distance<=EPS||distance+EPS<G.clearance(prepared,net,other.net))return false;}
          else if(isVia&&other.object.kind==='pad'&&new Set(other.object.item.shapes.map(s=>s.layer)).size===1&&distance<=EPS&&!(prepared.viaAtSmd&&def.attachAllowed!==false))return false;
        }
        for(const keepout of prepared.keepouts||[]){if(keepout.layers&&!keepout.layers.includes(shape.layer)||keepout.kind==='via'&&!isVia)continue;const distance=G.distanceShapes(shape,keepout.shape);if(distance<=EPS||distance+EPS<(keepout.clearance??net.routingClearance??net.clearance??prepared.defaultClearance??0))return false;}
        return true;
      }
      let processed=0;
      for(const pad of prepared.pads){
        if(stopped())break;
        if(processed++%16===0){await yieldNow();if(stopped())break;detail('Connecting pads to copper fills · '+processed+'/'+prepared.pads.length,{stage:'plane-access',processed,total:prepared.pads.length},'fanout');}
        const net=rules.get(pad.net),def=net&&defs.get(net.viaName);if(!net||!def)continue;
        const allowedLayers=net.useLayers||prepared.layers.map(layer=>layer.index);
        const fills=(prepared.copperFills||[]).filter(fill=>fill.net===net.id&&allowedLayers.includes(fill.layer)&&fill.layer>=def.fromLayer&&fill.layer<=def.toLayer);
        if(!fills.length)continue;
        const groups=G.connectivity(prepared,{airwires:false}).components.find(component=>component.net===net.id)?.groups||[];
        if(groups.some(group=>group.pads.includes(pad.id)&&group.items.some(item=>item.kind==='fill')))continue;
        const padLayers=[...new Set(pad.shapes.map(shape=>shape.layer))];
        const sourceLayer=padLayers.find(layer=>layer>=def.fromLayer&&layer<=def.toLayer);if(sourceLayer===undefined)continue;
        const shape=pad.shapes.find(shape=>shape.layer===sourceLayer),box=G.shapeBounds(shape),r=def.diameter/2,gap=Math.max(net.width*.05,EPS*10);
        const candidates=[];
        if(prepared.viaAtSmd&&def.attachAllowed!==false)candidates.push({x:pad.x,y:pad.y,distance:0});
        const rays=[[1,0],[-1,0],[0,1],[0,-1],[Math.SQRT1_2,Math.SQRT1_2],[-Math.SQRT1_2,Math.SQRT1_2],[Math.SQRT1_2,-Math.SQRT1_2],[-Math.SQRT1_2,-Math.SQRT1_2]];
        const vertices=shape.type==='polygon'?shape.points:[[box.minX,box.minY],[box.minX,box.maxY],[box.maxX,box.minY],[box.maxX,box.maxY]];
        for(const ray of rays){const extent=Math.max(...vertices.map(point=>(point[0]-pad.x)*ray[0]+(point[1]-pad.y)*ray[1]));for(const extra of [0,1,2,4]){const distance=Math.max(0,extent)+r+gap+extra*net.width;candidates.push({x:pad.x+ray[0]*distance,y:pad.y+ray[1]*distance,distance});}}
        const preferred=directions?.get(sourceLayer);
        candidates.sort((a,b)=>{const cost=p=>p.distance*(preferred?(preferred==='vertical'?1+Math.abs(p.x-pad.x)/Math.max(p.distance,EPS)*.12:1+Math.abs(p.y-pad.y)/Math.max(p.distance,EPS)*.12):1);return cost(a)-cost(b);});
        for(const candidate of candidates){
          if(stopped())break;
          const layers=Array.from({length:def.toLayer-def.fromLayer+1},(_,i)=>def.fromLayer+i);
          const via={net:net.id,x:candidate.x,y:candidate.y,diameter:def.diameter,padstack:def.name,layers,fixed:false,fanout:true,planeAccess:true};
          if(!fills.some(fill=>G.distanceShapes({type:'circle',cx:via.x,cy:via.y,r,layer:fill.layer},{type:'polygon',points:fill.points,holes:fill.holes||[],layer:fill.layer})<=EPS))continue;
          if(!layers.every(layer=>legal({type:'circle',cx:via.x,cy:via.y,r,layer},net,true,def)))continue;
          const trace=candidate.distance>EPS?{net:net.id,layer:sourceLayer,width:net.width,points:[[pad.x,pad.y],[via.x,via.y]],fixed:false,fanout:true,planeAccess:true}:null;
          const trial={...prepared,vias:prepared.vias.concat(via),traces:trace?prepared.traces.concat(trace):prepared.traces};
          if(trace&&(!allowedLayers.includes(sourceLayer)&&!G.isPermittedLayerEscape(trial,trace,net)||!legal({type:'capsule',a:trace.points[0],b:trace.points[1],r:trace.width/2,layer:sourceLayer},net,false,def)))continue;
          await copper.rebuild(trial,{...options,keepUnanchored:true},fillProgress,stopped);
          const connected=G.connectivity(trial,{airwires:false}).components.find(component=>component.net===net.id)?.groups.some(group=>group.pads.includes(pad.id)&&group.items.some(item=>item.kind==='via'&&item.index===trial.vias.length-1)&&group.items.some(item=>item.kind==='fill'));
          if(!connected)continue;
          prepared=trial;
          const added=G.copper({ ...prepared,pads:[],traces:trace?[trace]:[],vias:[via],copperFills:[] }).primitives;
          for(const primitive of added)indices[primitive.layer]?.insert(primitive);
          spatial('Connecting '+net.name+' to its copper fill',{stage:'plane-access',netId:net.id,netName:net.name,padId:pad.id},()=>({kind:'via',points:layers.map(layer=>[via.x,via.y,layer]),paths:trace?[{layer:trace.layer,points:trace.points}]:[],label:"Short connection from pad to copper fill"}),'fanout');
          break;
        }
      }
      await copper.rebuild(prepared,options,fillProgress,stopped);
      const signature=JSON.stringify([prepared.copperZones,prepared.traces,prepared.vias]);
      fillSignatures.set(prepared,signature);fillCache.set(signature,prepared.copperFills);while(fillCache.size>4)fillCache.delete(fillCache.keys().next().value);
      say("Connected pads to copper fills with "+(prepared.vias.length-viasBefore)+' vias and '+(prepared.traces.length-tracesBefore)+' short pad escapes.',{phase:'fanout'});
      return prepared;
    }
    // Trace length leads for selected nets. A small physical-length surcharge
    // breaks via ties without making long surface detours artificially cheap.
    const searchViaCost=net=>preferShort(net)?Math.min(options.viaCost||net.width*5,net.width*.1):(options.viaCost||net.width*5);
    function stats(board,checked=true){const finish=measurement?.begin('checking');try{clearSpatial('connectivity-check');detail('Checking connected copper',{stage:'connectivity-check'},'checking');const refining=counters.refinement.status==='running',checks=checked?2:1;if(refining)refinementWork({kind:'checking',processed:0,total:checks});let conn=connectivity(board);if(refining)refinementWork({kind:'checking',processed:1,total:checks});if(checked)detail('Checking copper clearances and routing rules',{stage:'rule-check'},'checking');let v=checked?G.validate(board):null;if(refining&&checked)refinementWork({kind:'checking',processed:2,total:checks});const result={unrouted:conn.unrouted,viaCount:board.vias.length,traceCount:board.traces.length,traceLengthMm:board.traces.reduce((a,t)=>a+length(t),0)*(board.units.mmPerUnit||1),...(shortNets.size?{preferredTraceLengthMm:board.traces.reduce((a,t)=>a+(shortNets.has(t.net)?length(t):0),0)*(board.units.mmPerUnit||1)}:{}),clearanceViolations:v?v.clearanceViolations:null,totalViolations:v?v.totalViolations:null,viaInPadViolations:v?v.viaInPadViolations:null,outlineViolations:v?v.outlineViolations:null,keepoutViolations:v?v.keepoutViolations:null,drcChecked:!!v,belowNominalWidthTraceCount:v?v.belowNominalWidthTraceCount:0,widthRulesChecked:!!v,netCount:board.nets.length,componentCount:new Set(board.pads.map(p=>p.component)).size,layerCount:board.layers.length};if(checked)measurement?.observeChecked?.(result);return result;}finally{finish?.();}}
    detail('Checking input clearances and connectivity',{stage:'input-check'},'checking',true);await yieldNow();
    const initialStats=stats(original),baseViolation=initialStats.clearanceViolations,baseWidth=initialStats.belowNominalWidthTraceCount,baseTotal=initialStats.totalViolations;
    if(options.viaInPad===false&&initialStats.viaInPadViolations){const error=new Error('Existing vias overlap SMD pads while vias in SMD pads are disabled. Clear routing & start over, or enable vias in SMD pads before routing.');error.code='VIA_IN_PAD_CONFLICT';throw error;}
    let originalStats=initialStats;
    if(hasZones(original)&&!stopped()){
      try{
        const prepared=await attachPadsToPlanes(copy(original));
        const candidateStats=stats(prepared);
        if(candidateStats.totalViolations<=baseTotal&&candidateStats.belowNominalWidthTraceCount<=baseWidth&&candidateStats.unrouted<=initialStats.unrouted){original=prepared;originalStats=candidateStats;}
        else say("Keeping your imported copper. The new fill connections didn’t pass all the rule checks.",{phase:'checking'});
      }catch(error){if(error.name!=='AbortError'||!stopped())throw error;}
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
    const checkpoint=(pass=counters.attempt.current,phase='routing')=>emit({type:'checkpoint',phase,pass,counters:counterSnapshot(),board:copy(best),stats:bestStats});
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
    // User pours are rebuilt around new routing. Imported fixed copper regions
    // stay immutable obstacles, exactly like imported tracks and pads.
    const mutableFill=p=>p.object.kind==='fill'&&p.object.item.zoneId!=null&&!p.object.item.fixed&&!p.object.item.imported;
    const immutable=G.copper(original).primitives.filter(p=>!mutableFill(p)).map(p=>({...p,clearance:clearanceOf(rules.get(p.net))}));
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
    function inside(x,y,r){r+=original.edgeClearance||0;if(x<original.bounds.minX+r||x>original.bounds.maxX-r||y<original.bounds.minY+r||y>original.bounds.maxY-r)return false;if(original.outlines.length&&!original.outlines.some(p=>G.pointInPolygon(x,y,p)))return false;for(const hole of original.holes||[])if(G.pointInPolygon(x,y,hole))return false;for(const p of [...original.outlines,...(original.holes||[])])for(let k=0;k<p.length;k++)if(segmentDistance(x,y,p[k],p[(k+1)%p.length])<r-EPS)return false;return true;}
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
        for(const v of original.vias){let clearance=Math.max(clearanceOf(net),clearanceOf(rules.get(v.net)));drawVia(c.base,v,half+v.diameter/2+clearance,v.net);drawVia(c.thickBase,v,half+v.diameter/2+clearance+guard,v.net);drawVia(c.viaBase,v,via.diameter/2+v.diameter/2+clearance,v.net);if(++rasterItems%32===0){detail('Preparing imported via clearances · '+rasterItems+'/'+original.vias.length,{stage:'via-clearances',processed:rasterItems,total:original.vias.length},'rasterizing');if(Date.now()-lastRasterYield>=24){await yieldNow();lastRasterYield=Date.now();}if(stopped())return c;}}
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
    function endpointVia(p,net,c,soft){
      const def=c.via,l=p[2]??0;
      if(def.disabled||def.name!==net.viaName||!original.viaAtSmd||def.attachAllowed===false||l<def.fromLayer||l>def.toLayer)return null;
      const pad=original.pads.find(a=>a.net===net.id&&Math.hypot(a.x-p[0],a.y-p[1])<EPS&&a.shapes.some(s=>s.layer===l));
      if(!pad||new Set(pad.shapes.map(s=>s.layer)).size!==1)return null;
      const layers=Array.from({length:def.toLayer-def.fromLayer+1},(_,i)=>def.fromLayer+i);
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
      return {net:net.id,x:p[0],y:p[1],diameter:def.diameter,padstack:def.name,layers,fixed:false};
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
      const foundPath=id=>{let path=[];for(let p=id;p>=0;p=parent[p])path.push(p);path.reverse();return{path,seeds,targets};};
      for(const [id,seed]of seeds){visited[id]=tag;gCost[id]=(seed.cost||0)/step;parent[id]=-1;heap.push(id,gCost[id]+heuristic(id));}
      function relax(from,to,cost){if(closed[to]===tag)return;let g=gCost[from]+cost;if(visited[to]!==tag||g<gCost[to]){visited[to]=tag;gCost[to]=g;parent[to]=from;heap.push(to,g+heuristic(to));}}
      while(heap.nodes.length){let entry=heap.pop(),id=entry[0];if(evaluateGoal&&bestGoal!==null&&entry[1]>=bestGoalCost-EPS)return foundPath(bestGoal);if(closed[id]===tag)continue;closed[id]=tag;expanded++;recentNodes[recentIndex++%64]=id;
        if(targets.has(id)){if(!evaluateGoal)return foundPath(id);const fullCost=gCost[id]+(targets.get(id).cost||0)/step;if(fullCost<bestGoalCost){bestGoal=id;bestGoalCost=fullCost;}}
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
        if(layerCount>1&&!c.via.disabled&&l>=c.via.fromLayer&&l<=c.via.toLayer){let safe=true,occupied=false,history=0;for(let z=c.via.fromLayer;z<=c.via.toLayer;z++){let vi=idx(x,y,z);if(!allowed(c.viaBase,vi,net.id)){safe=false;break;}if(!allowed(c.viaDyn,vi,net.id))occupied=true;if(finishing&&!preferShort(net)&&congestionHistory)history=Math.max(history,congestionHistory[vi]);}if(safe&&(!occupied||soft))for(const z of layers)if(z!==l&&z>=c.via.fromLayer&&z<=c.via.toLayer){let next=idx(x,y,z);if(allowed(c.base,next,net.id))relax(id,next,viaCost+history*.35*Math.max(1,viaCost)+(occupied?softPenalty*4:0));}}
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
      const routeVias=copper.vias.filter(v=>!board.vias.some(w=>w.net===v.net&&Math.hypot(w.x-v.x,w.y-v.y)<EPS));
      const proposal={...board,traces:board.traces.concat(copper.traces),vias:board.vias.filter(v=>v!==via).concat(routeVias)};
      const primitives=G.copper(proposal).primitives.filter(p=>!mutableFill(p)),indices=original.layers.map(l=>G.spatialIndex(primitives.filter(p=>p.layer===l.index),indexSize));
      const def=original.viaDefs.find(d=>d.name===via.padstack);
      const clearShape=(shape,isVia=false)=>{
        if(!G.shapeInsideBoard(shape,original,boundaryEdges))return false;
        for(const p of indices[shape.layer].query(G.shapeBounds(shape),maxClearance)){
          const distance=G.distanceShapes(shape,p.shape);
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
          for(const v of copper.vias)if(!board.vias.some(w=>w.net===v.net&&Math.hypot(w.x-v.x,w.y-v.y)<EPS))board.vias.push(copy(v));
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

    async function routeNet(net,softAllowed,keepExisting=false,localOnly=false,allowLocalTransactions=true){measurement?.count('netAttempts',1,net.id);detail('Routing '+net.name+' · attempt '+(routeActivity.attempt||1),{stage:'net',netId:net.id,netName:net.name},finishing?'finishing':'routing');if(stopped())return{failed:true,ripped:new Set()};let connections=keepExisting||hasZones(board)?connectivity(board):null;if(finishing&&connections&&pruneGeneratedIslands(connections)){await yieldNow();if(stopped())return{failed:true,ripped:new Set()};connections=connectivity(board);}let c=await getRaster(net);if(stopped())return{failed:true,ripped:new Set()};let groups=(connections?(connections.components.find(c=>c.net===net.id)?.groups||[]):(groupsByNet.get(net.id)||[])).filter(g=>g.points&&g.points.length&&(!inaccessibleGroups.has(net.id)||hasLayerAccess(g,net)));if(groups.length<=1)return{failed:false,ripped:new Set()};let ordered=groups.map(g=>({group:g,seeds:groupSeeds(g,net,c)}));ordered.sort((a,b)=>b.seeds.size-a.seeds.size);let root=ordered.shift(),targets=new Map(root.seeds),targetGroups=[root.group],remaining=ordered,ripped=new Set(),failed=false;
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
        if(!found){failed=true;continue;}let copper=convertPath(found,net);spatial('Checking route candidate · '+net.name,{stage:'route-candidate',netId:net.id,netName:net.name},()=>traceVisual(copper.traces,copper.vias.flatMap(v=>v.layers.map(l=>[v.x,v.y,l])),'candidate',"Proposed path being checked"),finishing?'finishing':'routing');let blocked=blockers(copper,net),committed=false;
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
        if(!committed){board.traces.push(...copper.traces);for(const v of copper.vias)if(!board.vias.some(w=>w.net===v.net&&Math.hypot(w.x-v.x,w.y-v.y)<EPS))board.vias.push(v);generation++;}
        const hadTargets=targets.size>0,addedTargets=[];
        targetGroups.push(next.group);for(const id of found.path){const point=xy(id);if(!targets.has(id))addedTargets.push(point);targets.set(id,point);}for(const [id,p]of next.seeds){if(!targets.has(id))addedTargets.push(xy(id));targets.set(id,p);}
        // A soft repair can create the first usable grid attachments. In that
        // case the old fallback pad points are replaced, rather than retained.
        if(!hadTargets&&targets.size){distanceTargets=[...targets.keys()].map(xy);for(const entry of remaining)entry.treeDistance=distanceToTree(entry.group,distanceTargets);}
        else if(addedTargets.length)for(const entry of remaining)entry.treeDistance=Math.min(entry.treeDistance,distanceToTree(entry.group,addedTargets));
      }return{failed,ripped};}
    function distanceToTree(group,points){let best=Infinity;for(const p of group.points)for(const q of points)best=Math.min(best,Math.hypot(p[0]-q[0],p[1]-q[1]));return best;}
    function scoreBetter(a,b){if(a.totalViolations>baseTotal||a.clearanceViolations>baseViolation||a.belowNominalWidthTraceCount>baseWidth)return false;const key=s=>shortNets.size?[s.unrouted,s.totalViolations,s.belowNominalWidthTraceCount,s.preferredTraceLengthMm,s.viaCount,s.traceLengthMm]:[s.unrouted,s.viaCount,s.traceLengthMm];let ka=key(a),kb=key(b);for(let i=0;i<ka.length;i++){if(ka[i]<kb[i]-1e-8)return true;if(ka[i]>kb[i]+1e-8)return false;}return false;}
    // Bounded complete-board restarts with difficult-net-first ordering and rip-up repair.
    let failures=new Set(),passes=attemptLimit,completeWithoutImprovement=0,routingDone=false;
    const completeOrders=new Set();
    const viaKey=v=>JSON.stringify([v.net,v.padstack,v.x,v.y,v.diameter,v.layers]);
    const originalViaKeys=new Set(original.vias.map(viaKey));
    const refinementOptions=hasZones(original)?{...options,preserveTraceCount:original.traces.length,preserveViaCount:original.vias.length}:options;
    function restoreRoutingPrefix(candidate){
      const restored=copy(candidate);
      restored.traces=[...copy(original.traces),...restored.traces.slice(original.traces.length)];
      restored.vias=[...copy(original.vias),...restored.vias.filter(v=>!originalViaKeys.has(viaKey(v)))];
      return restored;
    }
    say("Routing grid: "+nx+' × '+ny+' grid, '+layerCount+' layers, '+step.toPrecision(3)+' '+original.units.name+' step.',{phase:'routing',pass:0,board:copy(best),stats:bestStats});
    // The candidate is opt-in until its schedule is compared with the same
    // board and budget. Fixed-work mode uses round counts, never slice time.
    const adaptiveSchedule=options.adaptiveSchedule===true;
    const activeNow=typeof yieldTask?.now==='function'?()=>yieldTask.now():()=>Date.now();
    const finishingGapLimit=Math.min(12,Math.max(6,Math.floor(initialStats.unrouted*.1)));
    let repairState=null;
    async function finishingSlice(stageHasMore,early=false){
    // A nearly complete large board can still have more than six local gaps.
    // Scale eligibility with its starting work, capped at twelve connections;
    // the existing eighteen-round repair budget and full checks stay unchanged.
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
        let repairBest=adaptiveSchedule&&repairState?repairState.best:restored;
        let repairStats=adaptiveSchedule&&repairState?repairState.stats:restoredStats;
        let repairSeed=adaptiveSchedule&&repairState?repairState.seed:restored;
        if(scoreBetter(restoredStats,repairStats)){repairBest=restored;repairStats=restoredStats;}
        // Keep the safest export separate from the layout used for exploration.
        // Moving one congested branch can temporarily expose a few other gaps;
        // restarting every round from the same best layout loses that progress.
        const repairSignature=candidate=>{
          const text=JSON.stringify([candidate.traces,candidate.vias]);let a=2166136261,b=2246822507;
          for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);a=Math.imul(a^c,16777619);b=Math.imul(b^c,3266489909);}
          return text.length+':'+(a>>>0)+':'+(b>>>0);
        };
        const repairSeen=adaptiveSchedule&&repairState?repairState.seen:new Set([repairSignature(restored)]);
        const state=adaptiveSchedule?(repairState||{nextRound:1,roundState:null,frontiers:[],stalled:0,history:null,rips:[]}):null;
        if(state)repairState=state;
        const legalRepair=(candidate,reference)=>['totalViolations','clearanceViolations','viaInPadViolations','outlineViolations','keepoutViolations','belowNominalWidthTraceCount'].every(key=>candidate[key]<=reference[key]);
        const gapCounts=connections=>new Map(connections.components.map(component=>[component.net,Math.max(0,component.groups.length-1)]));
        let repairGaps=gapCounts(connectivity(repairBest));
        const repairDisplacedNets=new Set(state?.displacedNets||[]);
        let repairSeedEvidence=state?.seedEvidence||null;
        const describeTrial=(connections,pendingGaps,displacedNets=repairDisplacedNets)=>{
          const gaps=gapCounts(connections);let displaced=0,unexplained=0,progress=0;
          for(const [net,count]of gaps){const increase=count-(repairGaps.get(net)||0);if(increase>0){if(displacedNets.has(net))displaced+=increase;else unexplained+=increase;}}
          for(const [net,count]of pendingGaps)progress+=Math.max(0,count-(gaps.get(net)||0));
          // Wider swaps must gain a pending connection. All extra gaps must
          // come from generated copper actually displaced by these repairs.
          const allowance=progress>0&&!unexplained?Math.min(6,Math.max(3,displaced)):3;
          return{allowance,progress,displaced};
        };
        const eligibleSeed=(candidate,measured,evidence)=>{
          if(!legalRepair(measured,repairStats))return false;
          if(measured.unrouted<=repairStats.unrouted+3)return true;
          if(!evidence)return false;
          return measured.unrouted<=repairStats.unrouted+describeTrial(connectivity(candidate),new Map(evidence.pendingGaps),new Set(evidence.displacedNets)).allowance;
        };
        const addFrontier=(candidate,measured,evidence=null)=>{
          if(!state)return;
          state.frontiers=state.frontiers.filter(seed=>eligibleSeed(seed.board,seed.stats,seed.evidence));
          if(!eligibleSeed(candidate,measured,evidence))return;
          const signature=repairSignature(candidate);if(state.frontiers.some(seed=>seed.signature===signature))return;
          state.frontiers.push({board:copy(candidate),stats:{...measured},signature,lastUsed:-1,evidence});
          if(state.frontiers.length>3){
            // Retain the earlier layout, the newest alternative and the best
            // of the middle layouts. A smaller gap count can still be a trap.
            const middle=state.frontiers.slice(1,-1).sort((a,b)=>a.stats.unrouted-b.stats.unrouted||b.lastUsed-a.lastUsed);
            state.frontiers=[state.frontiers[0],middle[0],state.frontiers[state.frontiers.length-1]];
          }
        };
        if(state&&!state.roundState){
          const seedStats=stats(repairSeed,true);
          if(!eligibleSeed(repairSeed,seedStats,repairSeedEvidence)){repairSeed=copy(repairBest);repairSeedEvidence=null;}
        }
        let repairFailures=new Set(connectivity(adaptiveSchedule?repairSeed:repairBest).components.filter(hasRoutableGap).map(c=>c.net));
        addFrontier(restored,restoredStats);
        finishing=true;congestionHistory=state?state.history:null;ripHistory.clear();
        for(const [id,count]of state?.rips||[])ripHistory.set(id,count);
        const sliceStarted=activeNow(),completedBefore=counters.repair.completed;
        const roundEnd=early?9:18;
        const sliceExpired=()=>early&&(counters.repair.completed-completedBefore>=2||!options.benchmarkMode&&activeNow()-sliceStarted>=90000);
        const saveState=()=>{
          if(!state)return;
          state.best=repairBest;state.stats=repairStats;state.seed=repairSeed;state.seen=repairSeen;state.seedEvidence=repairSeedEvidence;state.displacedNets=[...repairDisplacedNets];
          state.history=congestionHistory;state.rips=[...ripHistory];
        };
        const retain=async(measured)=>{
          if(scoreBetter(measured,repairStats)){repairBest=copy(board);repairStats=measured;repairGaps=gapCounts(connectivity(board));}
          if(scoreBetter(measured,bestStats)){best=copy(board);bestStats=measured;await checkpoint(counters.attempt.current,'finishing');}
        };
        for(repairRound=state?state.nextRound:1;repairRound<=roundEnd&&!stopped()&&bestStats.unrouted>0&&(!inaccessibleGroups.size||repairFailures.size);repairRound++){
          if(sliceExpired())break;
          if(state&&!state.roundState&&state.stalled>=2){
            const signature=repairSignature(repairSeed),alternatives=state.frontiers.filter(seed=>seed.signature!==signature&&eligibleSeed(seed.board,seed.stats,seed.evidence)).sort((a,b)=>a.lastUsed-b.lastUsed||a.stats.unrouted-b.stats.unrouted);
            if(alternatives.length){repairSeed=copy(alternatives[0].board);repairSeedEvidence=alternatives[0].evidence;state.stalled=0;repairFailures=new Set(connectivity(repairSeed).components.filter(hasRoutableGap).map(c=>c.net));}
          }
          const resumed=state?.roundState?.round===repairRound?state.roundState:null;
          const beforeRound=resumed?.beforeRound??bestStats.unrouted;
          const activeFrontier=state?.frontiers.find(seed=>seed.signature===repairSignature(repairSeed));if(activeFrontier)activeFrontier.lastUsed=repairRound;
          counters.repair.current=counters.repair.completed+1;counters.repair.status='running';counters.work=null;reportCounters('finishing');
          board=copy(repairSeed);generation++;
          if(resumed){board=copy(resumed.board);generation++;}
          const pendingGaps=new Map(resumed?.pendingGaps||[...gapCounts(connectivity(board))].filter(([net,gaps])=>repairFailures.has(net)&&gaps>0));
          let random=rng(0x52414D45+repairRound*7919),order=shuffled(routingNets,random);
          if(repairRound===1&&!resumed)await sortByDensity(order);else order.sort((a,b)=>(repairFailures.has(b.id)?1:0)-(repairFailures.has(a.id)?1:0));
          const queue=resumed?resumed.queue.slice():prioritizeShort(order).filter(n=>repairFailures.has(n.id));
          const attempts=new Map(resumed?.attempts||[]),preflight=resumed?resumed.preflight:queue.slice();
          let processed=resumed?.processed||0,maxWork=nets.length*(repairRound===1?2:3),preflightIndex=resumed?.preflightIndex||0;
          let trialSeed=resumed?.trialSeed||null,trialStats=resumed?.trialStats||null,trialSignature=resumed?.trialSignature||null,trialProgress=resumed?.trialProgress??-1,trialEvidence=resumed?.trialEvidence||null,suspended=false;
          const rememberTrial=(measured,connections=connectivity(board))=>{
            // A fresh checked improvement can invalidate the earlier swap.
            // Stop ranking useful candidates against that obsolete trial.
            if(trialSeed&&!eligibleSeed(trialSeed,trialStats,trialEvidence)){trialSeed=null;trialStats=null;trialSignature=null;trialProgress=-1;trialEvidence=null;}
            const candidate=describeTrial(connections,pendingGaps);
            if(!legalRepair(measured,repairStats)||measured.unrouted>repairStats.unrouted+candidate.allowance||trialStats&&(candidate.progress<trialProgress||candidate.progress===trialProgress&&measured.unrouted>=trialStats.unrouted))return;
            const signature=repairSignature(board);if(repairSeen.has(signature))return;
            trialSeed=copy(board);trialStats=measured;trialSignature=signature;trialProgress=candidate.progress;trialEvidence={pendingGaps:[...pendingGaps],displacedNets:[...repairDisplacedNets]};
          };
          const suspendRound=measured=>{
            if(!state||!sliceExpired()||stopped()||bestStats.unrouted===0)return false;
            const checked=measured?.drcChecked?measured:stats(board,true);
            if(!legalRepair(checked,repairStats))return false;
            // An in-flight round can temporarily exceed the frontier gap cap
            // while its displaced neighbours are still queued. This is working
            // state only; it is never promoted to a retained/export checkpoint.
            state.roundState={round:repairRound,beforeRound,board:copy(board),queue:queue.slice(),attempts:[...attempts],preflight:preflight.slice(),preflightIndex,processed,trialSeed,trialStats,trialSignature,trialProgress,trialEvidence,pendingGaps:[...pendingGaps]};
            state.nextRound=repairRound;suspended=true;return true;
          };
          emit({type:'progress',phase:'finishing',pass:counters.attempt.current,message:'Finishing remaining connections · repair '+repairRound+(resumed?' · continuing':'' )});
          // Try non-destructive connections and local via moves before a
          // broader repair changes the neighbouring routes they can preserve.
          for(;preflightIndex<preflight.length;preflightIndex++){
            const net=preflight[preflightIndex];if(stopped())break;
            routeActivity={pass:counters.attempt.current,repairRound,netId:net.id,netName:net.name,stage:'local-repair'};
            await routeNet(net,true,true,true);
            const measured=stats(board,true);await retain(measured);rememberTrial(measured);
            if(bestStats.unrouted===0)break;
            if(sliceExpired()){preflightIndex++;if(suspendRound(measured))break;preflightIndex--;}
          }
          while(queue.length&&processed<maxWork&&!stopped()&&bestStats.unrouted>0&&!suspended){
            const net=queue.shift(),count=(attempts.get(net.id)||0)+1;routeActivity={pass:counters.attempt.current,repairRound,netId:net.id,netName:net.name,processed,total:maxWork,attempt:count};attempts.set(net.id,count);if(count>3)continue;
            const result=await routeNet(net,repairRound>1&&count<3,true);processed++;
            for(const id of result.ripped){repairDisplacedNets.add(id);const n=rules.get(id);if(n&&!queue.some(x=>x.id===id))queue.push(n);}prioritizeShort(queue);
            const connections=connectivity(board);
            if(connections.unrouted<=repairStats.unrouted+describeTrial(connections,pendingGaps).allowance){if(detail('Checking repaired route · '+net.name,{stage:'candidate-check'},'checking'))await yieldNow();const measured=stats(board,true);await retain(measured);rememberTrial(measured,connections);}
            if(suspendRound())break;
            if(processed%3===0){if(Date.now()-lastPreview>=1200){lastPreview=Date.now();emit({type:'progress',phase:'finishing',pass:counters.attempt.current,message:'Finishing repair '+repairRound+' · '+processed+' net attempts · '+queue.length+' queued · last '+net.name,activity:{...routeActivity,processed,queued:queue.length,stage:'net-complete'},board:copy(board),stats:stats(board,false)});}await yieldNow();}
          }
          if(suspended)break;
          emit({type:'progress',phase:'checking',pass:counters.attempt.current,message:'Checking the repaired connections'});await yieldNow();
          const measured=stats(board,true);await retain(measured);rememberTrial(measured);
          if(trialSeed&&eligibleSeed(trialSeed,trialStats,trialEvidence)){
            repairSeen.add(trialSignature);repairSeed=trialSeed;repairSeedEvidence=trialEvidence;addFrontier(trialSeed,trialStats,trialEvidence);
            if(trialStats.unrouted>=repairStats.unrouted)say("Trying a checked alternative to make room · "+trialStats.unrouted+' connections remaining.',{phase:'finishing'});
          }else{repairSeed=copy(repairBest);repairSeedEvidence=null;}
          repairFailures=new Set(connectivity(repairSeed).components.filter(hasRoutableGap).map(c=>c.net));
          say('Finishing repair '+repairRound+': '+measured.unrouted+' remaining; best '+bestStats.unrouted+' remaining.',{phase:'finishing',pass:counters.attempt.current,board:copy(best),stats:bestStats});
          if(!stopped()){
            counters.repair.completed++;reportCounters('finishing');
            if(state){state.nextRound=repairRound+1;state.roundState=null;state.stalled=bestStats.unrouted<beforeRound?0:state.stalled+1;}
          }
        }
        saveState();finishing=false;
        if(state){congestionHistory=null;ripHistory.clear();}
        if(early&&!stopped()&&bestStats.unrouted>0)say("Keeping the checked result. Trying another routing order before coming back to these repairs.",{phase:'routing'});
        if(!early&&!stageHasMore())finishCounter('repair','finishing');
        else if(!stopped()){counters.repair.status='pending';counters.work=null;reportCounters('finishing');}
        if(!early&&bestStats.unrouted<beforeFinishing&&options.optimize!==false&&optimizer&&!stopped()){
          counters.refinement.current++;counters.refinement.status='running';counters.work=null;reportCounters('optimizing');
          emit({type:'progress',phase:'optimizing',message:'Refining the repaired route'});
          const optimized=await optimizer.optimize(copy(best),refinementOptions,emit,stopped,refinementWork),measured=stats(optimized,true);
          if(scoreBetter(measured,bestStats)){best=optimized;bestStats=measured;await checkpoint();}
          if(!stopped()){counters.refinement.completed++;counters.refinement.status=stageHasMore()?'pending':'done';counters.work=null;reportCounters('optimizing');}
        }
      }else if(!safe)say("Keeping the checked route. Restoring the fanouts didn’t pass all the rule checks.",{phase:'checking'});
    }
    }
    for(let stage=1;stage<=stageCount&&!stopped();stage++){
    repairState=null;
    const stageEnd=Math.min(stage*12,passes);
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
    for(let pass=(stage-1)*12+1;pass<=stageEnd&&!stopped();pass++){
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
        if(connectivity(board).unrouted<bestStats.unrouted){if(detail('Checking improved route · '+net.name,{stage:'candidate-check'},'checking'))await yieldNow();let candidateStats=stats(board,true);if(scoreBetter(candidateStats,bestStats)){best=copy(board);bestStats=candidateStats;await checkpoint(pass);}}
        if(processed%3===0){if(Date.now()-lastPreview>=1200){lastPreview=Date.now();emit({type:'progress',phase:'routing',pass,message:"Attempt "+pass+' · '+processed+' net attempts · '+queue.length+' queued · last '+net.name,activity:{...routeActivity,processed,queued:queue.length,stage:'net-complete'},board:copy(board),stats:stats(board,false)});}await yieldNow();}
      }
      emit({type:'progress',phase:'checking',pass,message:"Checking all clearances and connections"});await yieldNow();let measured=stats(board,true);if(scoreBetter(measured,bestStats)){best=copy(board);bestStats=measured;await checkpoint(pass);}failures=new Set(connectivity(best).components.filter(hasRoutableGap).map(c=>c.net));say("Attempt "+pass+': '+measured.unrouted+' remaining, '+measured.viaCount+' vias; best '+bestStats.unrouted+' remaining.',{phase:'routing',pass,board:copy(best),stats:bestStats});if(!stopped()){counters.attempt.completed++;reportCounters('routing');}
      if(adaptiveSchedule&&pass<stageEnd&&(!repairState||repairState.nextRound<=9)&&!stopped()){
        counters.attempt.status='pending';counters.work=null;reportCounters('routing');
        await finishingSlice(()=>true,true);
        failures=new Set(connectivity(best).components.filter(hasRoutableGap).map(c=>c.net));
      }
      if(bestStats.unrouted===0){
        if(!shortNets.size||initialStats.unrouted===0){routingDone=true;break;}
        completeWithoutImprovement=wasComplete&&bestStats.preferredTraceLengthMm>=previousShortLength-EPS?completeWithoutImprovement+1:0;
        if(completeWithoutImprovement>=3){say("The selected nets didn’t get shorter in 3 complete-board attempts. Keeping the shortest checked result.",{phase:'routing'});routingDone=true;break;}
        if(pass<passes&&!stopped())say("All connections routed. Trying another order to shorten the selected nets.",{phase:'routing'});
      }
      if(inaccessibleGroups.size&&!failures.size){routingDone=true;break;}
    }
    if(stageEnd>=passes||routingDone)finishCounter('attempt','routing');
    else if(!stopped()){counters.attempt.status='pending';counters.work=null;reportCounters('routing');}
    if(stageCount>1&&!stopped())say('Checking routing stage '+stage+'/'+stageCount+' after '+counters.attempt.completed+' attempts.',{phase:'checking'});
    if(options.optimize!==false&&optimizer&&!stopped()){
      counters.refinement.current++;counters.refinement.status='running';counters.work=null;reportCounters('optimizing');
      emit({type:'progress',phase:'optimizing',message:'Refining the checked route'});
      const optimized=await optimizer.optimize(copy(best),refinementOptions,emit,stopped,refinementWork);let candidate=stats(optimized,true);
      if(scoreBetter(candidate,bestStats)){best=optimized;bestStats=candidate;await checkpoint();}
      if(!stopped()){counters.refinement.completed++;counters.refinement.status=refinementLimit>1?'pending':'done';counters.work=null;reportCounters('optimizing');}
    }
    await finishingSlice(stageHasMore);
    finishing=false;repairRound=0;congestionHistory=null;ripHistory.clear();
    if(routingDone||bestStats.unrouted===0&&(!shortNets.size||initialStats.unrouted===0))break;
    if(stageEnd<passes&&!stopped()){
      failures=new Set(connectivity(best).components.filter(hasRoutableGap).map(c=>c.net));
      if(inaccessibleGroups.size&&!failures.size)break;
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
  return{route,layerDirections};
}
if(typeof globalThis!=='undefined')globalThis.createRamenRouter=createRamenRouter;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenRouter};
