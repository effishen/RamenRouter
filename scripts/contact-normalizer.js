/* RamenRouter checked copper contacts. GPL-3.0-or-later. */
function createRamenContactNormalizer(geometry, yieldTask) {
  'use strict';
  const G=geometry, EPS=1e-8, copy=value=>JSON.parse(JSON.stringify(value));
  const wait=typeof yieldTask==='function'?yieldTask:()=>new Promise(resolve=>setTimeout(resolve,0));
  const protectedCopper=item=>item.fixed||item.protected||item.locked||item.preserve||item.fanout||item.attachment||['fix','fixed','protect','protected'].includes(item.type)||['fix','protect'].includes(item._dsnType);
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const groupKey=(net,layer)=>String(net)+'\0'+layer;
  const pointKey=p=>p.map(value=>value.toFixed(8)).join(',');
  const segmentKey=(net,layer,a,b)=>[groupKey(net,layer),...[pointKey(a),pointKey(b)].sort()].join('|');
  function segments(board) {
    const result=[];
    for(let index=0;index<board.traces.length;index++) {
      const trace=board.traces[index];
      for(let part=1;part<trace.points.length;part++)result.push({trace,index,part:part-1,a:trace.points[part-1],b:trace.points[part]});
    }
    return result;
  }
  function preservesPads(before,after) {
    const groups=new Map();
    for(const component of after.components)for(const group of component.groups)for(const pad of group.pads)groups.set(String(component.net)+'\0'+pad,group);
    return before.components.every(component=>component.groups.every(group=>{
      const members=group.pads.map(pad=>groups.get(String(component.net)+'\0'+pad));
      return members.every(member=>member&&member===members[0]);
    }));
  }
  function noNewViolations(before,after) {
    const key=issue=>JSON.stringify([issue.type,issue.layer,issue.kind,issue.index,issue.id,issue.net,issue.pad,issue.via,issue.keepout,issue.padstack,issue.a,issue.b]);
    const previous=new Map(before.violations.map(issue=>[key(issue),issue]));
    if(!after.violations.every(issue=>{
      const old=previous.get(key(issue));
      return old&&(!Number.isFinite(issue.actual)||!Number.isFinite(old.actual)||issue.actual>=old.actual-EPS)&&(!Number.isFinite(issue.required)||!Number.isFinite(old.required)||issue.required<=old.required+EPS);
    }))return false;
    const widths=new Map(before.widthDeviations.map(issue=>[JSON.stringify([issue.index,issue.net,issue.layer]),issue]));
    return after.widthDeviations.every(issue=>{const old=widths.get(JSON.stringify([issue.index,issue.net,issue.layer]));return old&&issue.actual>=old.actual-EPS&&issue.required<=old.required+EPS;});
  }
  // A router can connect two copper outlines while leaving their centre lines
  // apart. Add checked, full-width bridges to make those contacts explicit for
  // CAD import. Existing traces, vias, pad positions and routing rules stay put.
  async function normalize(input,options={},emit=()=>{},isCancelled=()=>false) {
    const hasHostClock=typeof yieldTask?.now==='function',clock=hasHostClock?()=>yieldTask.now():()=>Date.now(),started=clock();
    const board=copy(input),baseline=G.validate(board),before=G.connectivity(board,{airwires:false});
    const prefix=Math.max(0,options.preserveTraceCount||0),mutable=(trace,index)=>index>=prefix&&!protectedCopper(trace);
    if(isCancelled()||!board.traces.some(mutable))return {model:board,accepted:0,rejected:0,sharedVertices:0,validation:baseline,connection:before,stopped:isCancelled(),skipped:true};
    const all=segments(board),original=all.filter(segment=>!segment.trace.contactBridge),byNetLayer=new Map(),seen=new Set(all.map(s=>segmentKey(s.trace.net,s.trace.layer,s.a,s.b)));
    for(const trace of board.traces)if(trace.contactBridge&&trace.points.length>1)seen.add(segmentKey(trace.net,trace.layer,trace.points[0],trace.points.at(-1)));
    for(const segment of original){const key=groupKey(segment.trace.net,segment.trace.layer);if(!byNetLayer.has(key))byNetLayer.set(key,new Map());const group=byNetLayer.get(key);if(!group.has(segment.index))group.set(segment.index,{trace:segment.trace,index:segment.index,segments:[]});group.get(segment.index).segments.push(segment);}
    let accepted=0,rejected=0,tested=0,sharedVertices=0,pairChecks=0,pausedMillis=0,lastYield=Date.now(),lastReport=0;
    const limit=Math.max(1,Math.min(20000,Number.isFinite(options.maxContactCandidates)?Math.floor(options.maxContactCandidates):4000));
    const pairLimit=Math.max(1,Math.min(2000000,Number.isFinite(options.maxContactPairChecks)?Math.floor(options.maxContactPairChecks):200000));
    const timeLimit=Math.max(1,Math.min(120000,Number.isFinite(options.maxContactMillis)?Math.floor(options.maxContactMillis):30000));
    const activeElapsed=()=>Math.max(0,clock()-started-(hasHostClock?0:pausedMillis));
    const stopped=()=>isCancelled()||tested>=limit||pairChecks>=pairLimit||activeElapsed()>=timeLimit;
    async function pause(force=false) {
      const now=Date.now();
      if(force||now-lastYield>=24){
        if(now-lastReport>=250||force){emit({type:'progress',phase:'checking',log:false,message:'Checking trace contacts for export',activity:{stage:'copper-contacts',processed:tested,accepted,rejected,pairChecks}});lastReport=now;}
        const at=Date.now();await wait();pausedMillis+=Date.now()-at;lastYield=Date.now();
      }
      return stopped();
    }
    function bridge(net,layer,width,a,b) {
      if(distance(a,b)<=EPS||stopped())return;
      const key=segmentKey(net,layer,a,b);if(seen.has(key))return;seen.add(key);tested++;
      board.traces.push({net,layer,width,points:[a.slice(0,2),b.slice(0,2)],fixed:false,contactBridge:true});
      if(noNewViolations(baseline,G.validate(board)))accepted++;else{board.traces.pop();rejected++;}
    }
    await pause(true);
    for(const via of board.vias||[]) {
      if(stopped())break;
      const centre=[via.x,via.y],radius=G.viaDiameter(board,via)/2;
      for(const layer of G.viaLayers(board,via))for(const item of byNetLayer.get(groupKey(via.net,layer))?.values()||[]) {
        if(stopped())break;
        if(!mutable(item.trace,item.index))continue;
        let best=null;
        for(const segment of item.segments){if(stopped())break;pairChecks++;const point=G.closestPointOnSegment(centre,segment.a,segment.b),gap=distance(point,centre);if(!best||gap<best.gap-EPS)best={point,gap};if((pairChecks&127)===0)await pause();}
        if(best&&best.gap<=radius+item.trace.width/2+EPS)bridge(via.net,layer,item.trace.width,best.point,centre);
        if(await pause())break;
      }
    }
    for(const pad of board.pads||[]) {
      if(stopped())break;
      for(const shape of pad.shapes||[])for(const item of byNetLayer.get(groupKey(pad.net,shape.layer))?.values()||[]) {
        if(stopped())break;
        if(!mutable(item.trace,item.index))continue;
        const centre=[pad.x,pad.y];let best=null;
        for(const segment of item.segments){if(stopped())break;pairChecks++;const wire={type:'capsule',a:segment.a,b:segment.b,r:segment.trace.width/2,layer:shape.layer};if(G.distanceShapes(wire,shape)<=EPS){const point=G.closestPointOnSegment(centre,segment.a,segment.b),gap=distance(point,centre);if(!best||gap<best.gap-EPS)best={point,gap};}if((pairChecks&127)===0)await pause();}
        if(best)bridge(pad.net,shape.layer,item.trace.width,best.point,centre);
        if(await pause())break;
      }
    }
    for(const members of byNetLayer.values()) {
      if(stopped())break;
      const group=[...members.values()];
      for(let i=0;i<group.length;i++) {
        if(stopped())break;
        const from=group[i];
        for(let j=0;j<i;j++) {
          if(stopped())break;
          const to=group[j];if(!mutable(from.trace,from.index)&&!mutable(to.trace,to.index))continue;
          let best=null;
          segmentPairs:for(const a of from.segments)for(const b of to.segments){if(stopped())break segmentPairs;pairChecks++;const pair=G.closestSegmentPoints(a.a,a.b,b.a,b.b);if(!best||pair.distance<best.distance-EPS)best=pair;if((pairChecks&127)===0)await pause();if(best.distance<=EPS)break segmentPairs;}
          if(best&&best.distance<=from.trace.width/2+to.trace.width/2+EPS)bridge(from.trace.net,from.trace.layer,Math.min(from.trace.width,to.trace.width),best.a,best.b);
          if(await pause())break;
        }
      }
    }
    // Insert a shared vertex at each centre-line crossing without replacing or
    // splitting protected traces. Keep trace indices stable for rule reports.
    if(!stopped()) {
      const current=segments(board),cuts=current.map(segment=>[segment.a,segment.b]),groups=new Map();
      for(let index=0;index<current.length;index++){const s=current[index],key=groupKey(s.trace.net,s.trace.layer);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(index);}
      for(const group of groups.values()) {
        if(stopped())break;
        for(let i=0;i<group.length;i++) {
          if(stopped())break;
          const ia=group[i],a=current[ia];
          for(let j=0;j<i;j++) {
            if(stopped())break;
            pairChecks++;if((pairChecks&127)===0)await pause();
            const ib=group[j],b=current[ib];if(a.index===b.index||!mutable(a.trace,a.index)&&!mutable(b.trace,b.index))continue;
            const pair=G.closestSegmentPoints(a.a,a.b,b.a,b.b);
            if(pair.distance<=EPS) {
              const point=pair.a;
              if(mutable(a.trace,a.index))cuts[ia].push(point);
              if(mutable(b.trace,b.index))cuts[ib].push(point);
            }
          }
          await pause();
        }
      }
      if(!stopped()) {
        const previous=board.traces.map(trace=>trace.points),parts=new Map();
        for(let index=0;index<current.length;index++) {
          const s=current[index];if(!mutable(s.trace,s.index))continue;
          const dx=s.b[0]-s.a[0],dy=s.b[1]-s.a[1],den=dx*dx+dy*dy;
          if(!den)continue;
          const inner=cuts[index].filter(p=>distance(p,s.a)>EPS&&distance(p,s.b)>EPS).map(p=>({p,t:((p[0]-s.a[0])*dx+(p[1]-s.a[1])*dy)/den})).filter(item=>item.t>0&&item.t<1).sort((a,b)=>a.t-b.t);
          if(!parts.has(s.index))parts.set(s.index,[]);
          const points=parts.get(s.index);
          if(!points.length)points.push(s.a.slice());
          for(const {p} of inner)if(distance(points.at(-1),p)>EPS){points.push(p.slice());sharedVertices++;}
          if(distance(points.at(-1),s.b)>EPS)points.push(s.b.slice());
        }
        for(const [index,points] of parts)board.traces[index].points=points;
        if(!noNewViolations(baseline,G.validate(board))){board.traces.forEach((trace,index)=>{trace.points=previous[index];});sharedVertices=0;}
      }
    }
    const validation=accepted||sharedVertices?G.validate(board):baseline,connection=accepted||sharedVertices?G.connectivity(board,{airwires:false}):before;
    if(!noNewViolations(baseline,validation)||connection.unrouted>before.unrouted||!preservesPads(before,connection))return {model:copy(input),accepted:0,rejected,sharedVertices:0,validation:baseline,connection:before,keptPrevious:true};
    return {model:board,accepted,rejected,sharedVertices,validation,connection,stopped:isCancelled(),candidateLimitReached:tested>=limit,pairLimitReached:pairChecks>=pairLimit,timeLimitReached:activeElapsed()>=timeLimit,pairChecks,activeMillis:activeElapsed()};
  }
  return {normalize};
}
if(typeof globalThis!=='undefined')globalThis.createRamenContactNormalizer=createRamenContactNormalizer;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenContactNormalizer};
