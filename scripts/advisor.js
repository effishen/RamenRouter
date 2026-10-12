/* Read-only placement diagnostics. GPL-3.0-or-later. */
'use strict';
function createRamenAdvisor(geo) {
  const EPS=geo.EPS||1e-8;
  const key=value=>value===null||value===undefined||value===0||value===''?null:String(value);
  let lastActivityAt=-Infinity;
  function analyze(board,options={}) {
    const onActivity=typeof options.onActivity==='function'?options.onActivity:null;
    const activity=onActivity?{startedAt:Date.now(),ticks:0,emitted:false}:null;
    function notifyActivity(event){try{onActivity(event);}catch{/* Advice display must not alter diagnostic results. */}}
    function activityAt(shape,layer,netId,other,label,pad=null) {
      if((activity.ticks++&63)!==0)return;
      const now=Date.now();if(now-activity.startedAt<200||now-lastActivityAt<200)return;
      const points=[],paths=[];
      for(const entry of other?[{shape,layer},other]:[{shape,layer}]) {
        const s=entry.shape,l=entry.layer;
        if(s.type==='circle')points.push([s.cx,s.cy,l]);
        else if(s.type==='capsule')paths.push({layer:l,points:[s.a.slice(),s.b.slice()]});
        else if(s.points?.length){const vertices=s.points.slice(0,255).map(point=>point.slice());if(s.points.length<=255)vertices.push(s.points[0].slice());paths.push({layer:l,points:vertices});}
        if(entry.object?.kind==='pad')points.push([entry.object.item.x,entry.object.item.y,l]);
      }
      if(pad)points.push([pad.x,pad.y,layer]);
      lastActivityAt=now;activity.emitted=true;
      notifyActivity({stage:'advising',netId,visual:{kind:other?'check':'pad',points,paths,layer,label}});
    }
    function finish(result){if(activity?.emitted)notifyActivity({stage:'advising',visual:null,complete:true});return result;}
    const initial=options.initialBoard||board,scale=board.units?.mmPerUnit||1;
    const nets=new Map((board.nets||[]).map(net=>[key(net.id),net]));
    const netName=id=>nets.get(key(id))?.name||String(id??'unassigned');
    const components=new Set((board.pads||[]).map(p=>p.component).filter(Boolean));
    const limitedComponentLabels=components.size===0||(components.size===1&&(board.pads||[]).length>=8);
    const note=limitedComponentLabels?"This DSN doesn’t have separate component labels. Use the pad, net and location to find the part in your PCB editor. A net name can’t tell you which component it is.":'';
    const items=[],limit=3,round=value=>Number((value*scale).toPrecision(10));
    const minimumPadding=Math.max((board.bounds?.maxX-board.bounds?.minX)||0,(board.bounds?.maxY-board.bounds?.minY)||0,EPS*100)*.015;
    const point=p=>p.map(round),fmt=value=>Number(value.toPrecision(4)).toString();
    const component=pad=>!limitedComponentLabels&&pad?.component?String(pad.component):null;
    function label(pad) { return component(pad)?component(pad)+' pin '+String(pad.pin??pad.id):'Pad '+String(pad.pin??pad.id); }
    function area(points,padding) {
      const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
      return [Math.min(...xs)-padding,Math.min(...ys)-padding,Math.max(...xs)+padding,Math.max(...ys)+padding].map(round);
    }
    function index(primitives) {
      const bounds=board.bounds||{minX:0,minY:0,maxX:100,maxY:100};
      return geo.spatialIndex(primitives,Math.max((bounds.maxX-bounds.minX)/30,(bounds.maxY-bounds.minY)/30,EPS*100));
    }
    function describe(object) {
      const name=object.kind==='pad'?label(object.item):'Imported '+object.kind;
      return name+' ('+netName(object.net)+')';
    }
    // Inspect the input, rather than attributing a newly generated route to the
    // original placement. Only contact between two assigned nets is a short.
    const inputCopper=geo.copper(initial),inputIndex=index(inputCopper.primitives),shortPairs=new Set(),shortNets=new Set();
    // This pass only needs to know whether imported copper touches. Use the
    // same indexed contact check as routing before calculating a short's
    // exact highlight points; a detailed pour should not repeat a full
    // closest-point search against every nearby polygon pad.
    const touches=typeof geo.contactChecker==='function'?geo.contactChecker():(a,b)=>geo.distanceShapes(a,b)<=EPS;
    for(const a of inputCopper.primitives) {
      if(items.length>=limit)break;
      for(const b of inputIndex.query(a.bounds,EPS)) {
        if(a.layer!==b.layer||a.object.uid>=b.object.uid||key(a.net)===null||key(b.net)===null||key(a.net)===key(b.net))continue;
        if(onActivity)activityAt(a.shape,a.layer,a.net,b,"Checking contact in your imported copper",a.object.kind==='pad'?a.object.item:null);
        const pairKey=a.object.uid+':'+b.object.uid;
        if(shortPairs.has(pairKey)||!touches(a.shape,b.shape))continue;
        shortPairs.add(pairKey);
        shortNets.add(key(a.net));shortNets.add(key(b.net));
        const closest=geo.closestShapePoints(a.shape,b.shape),pad=a.object.kind==='pad'?a.object.item:b.object.kind==='pad'?b.object.item:null;
        const nearby=[a.object,b.object].filter(o=>o.kind==='pad').map(o=>component(o.item)).filter(Boolean);
        const position=closest.a,padding=Math.max((nets.get(key(a.net))?.width||0)*2,(nets.get(key(b.net))?.width||0)*2,minimumPadding);
        items.push({id:'short:'+pairKey,kind:'existing_short',title:"These nets already touch: "+netName(a.net)+' / '+netName(b.net),
          detail:describe(a.object)+' touches '+describe(b.object)+' on layer '+String((board.layers||[]).find(l=>l.index===a.layer)?.name??a.layer)+". They already touch in the imported board.",
          suggestion:"Fix this contact in your PCB editor, then reroute. Check the highlighted copper and pads. Routing can’t move or repair imported pads.",
          component:component(pad),pin:pad?String(pad.pin??pad.id):null,net:netName(a.net)+' / '+netName(b.net),nearbyComponents:[...new Set(nearby)],
          location:point(position),area:area([closest.a,closest.b],padding),evidence:{source:'input',distanceMm:0,layer:a.layer,nets:[netName(a.net),netName(b.net)],
            objects:[a.object,b.object].map(o=>({kind:o.kind,id:String(o.id),component:o.kind==='pad'?component(o.item):null,pin:o.kind==='pad'?String(o.item.pin??o.id):null,net:netName(o.net)}))}});
        if(items.length>=limit)break;
      }
    }
    if(options.includeIncomplete===false||items.length>=limit)return finish({items,limitedComponentLabels,units:'mm',note});
    const connectivity=options.connection||geo.connectivity(board),incomplete=connectivity.components.filter(c=>c.groups.length>1);
    if(!incomplete.length)return finish({items,limitedComponentLabels,units:'mm',note});
    const padCopper=geo.copper({pads:board.pads||[],traces:[],vias:[]}),padIndex=index(padCopper.primitives);
    const byId=new Map((board.pads||[]).map(p=>[String(p.id),p])),candidates=[];
    for(const connection of incomplete) {
      if(shortNets.has(key(connection.net)))continue;
      const net=nets.get(key(connection.net));if(!net||!(net.width>0))continue;
      // A connected copper group may already escape through another pad or a
      // trace. Local pad crowding is not a sound placement diagnosis there.
      const isolatedGroups=connection.groups.filter(group=>group.items.every(item=>item.kind==='pad')&&(group.pads||[]).length===1);
      for(const padId of new Set(isolatedGroups.flatMap(group=>group.pads||[]).map(String))) {
        const pad=byId.get(padId);if(!pad)continue;
        const allowed=(pad.shapes||[]).filter(shape=>!net.useLayers||net.useLayers.includes(shape.layer));
        if(!allowed.length)continue;
        const blockers=new Map();let tested=0,blocked=0;
        for(const shape of allowed) {
          if(onActivity)activityAt(shape,shape.layer,net.id,null,"Checking room for a pad fanout",pad);
          const bounds=geo.shapeBounds(shape),anchor=geo.pointInShape(pad.x,pad.y,shape)?[pad.x,pad.y]:geo.nearestPointOnShape(pad.x,pad.y,shape),cx=anchor[0],cy=anchor[1];
          const radius=Math.max(Math.hypot(bounds.minX-cx,bounds.minY-cy),Math.hypot(bounds.maxX-cx,bounds.maxY-cy));
          const reach=radius+2*net.width+(net.routingClearance??net.clearance??0);
          const near=padIndex.query({minX:cx-reach-net.width,maxX:cx+reach+net.width,minY:cy-reach-net.width,maxY:cy+reach+net.width},Math.max(board.crossClassClearance||0,board.defaultClearance||0,...(board.nets||[]).map(n=>n.routingClearance??n.clearance??0),...Object.values(board.classClearances||{})))
            .filter(other=>other.layer===shape.layer&&other.object.item!==pad&&key(other.net)!==key(net.id));
          for(let i=0;i<16;i++) {
            const angle=i*Math.PI/8,tip=[cx+reach*Math.cos(angle),cy+reach*Math.sin(angle)];
            const escape={type:'capsule',a:[cx,cy],b:tip,r:net.width/2};let hit=false;
            if(onActivity)activityAt(escape,shape.layer,net.id,null,"Trying a straight pad fanout",pad);
            for(const other of near) {
              if(onActivity)activityAt(escape,shape.layer,net.id,other,"Checking whether a pad fanout clears nearby copper",pad);
              const required=geo.clearance(board,net,other.net),actual=geo.distanceShapes(escape,other.shape);
              if(actual>EPS&&actual+EPS>=required)continue;
              hit=true;const old=blockers.get(other.object.uid),gap=geo.distanceShapes(shape,other.shape);
              if(!old)blockers.set(other.object.uid,{pad:other.object.item,gap,required,count:1,point:geo.closestShapePoints(shape,other.shape).b});
              else {old.count++;if(gap<old.gap){old.gap=gap;old.required=required;old.point=geo.closestShapePoints(shape,other.shape).b;}}
            }
            tested++;if(hit)blocked++;
          }
        }
        // Nearby copper alone is not evidence that placement needs changing.
        // Require several measured blocked probes and present their sampling
        // limit explicitly; curved or longer escapes may still be available.
        if(blocked<4||!blockers.size)continue;
        const ranked=[...blockers.values()].sort((a,b)=>b.count-a.count||a.gap-b.gap||String(a.pad.id).localeCompare(String(b.pad.id)));
        candidates.push({net,pad,blockers:ranked,tested,blocked,ratio:blocked/tested});
      }
    }
    candidates.sort((a,b)=>b.ratio-a.ratio||b.blockers.length-a.blockers.length||a.blockers[0].gap-b.blockers[0].gap||String(a.pad.id).localeCompare(String(b.pad.id)));
    const represented=new Set(shortNets);
    for(const candidate of candidates) {
      if(items.length>=limit)break;
      const {net,pad,blockers,tested,blocked}=candidate;if(represented.has(key(net.id)))continue;
      represented.add(key(net.id));
      const close=blockers.slice(0,3),others=[...new Set(close.map(b=>component(b.pad)).filter(c=>c&&c!==component(pad)))];
      const nearest=blockers.reduce((a,b)=>a.gap<=b.gap?a:b),position=[pad.x,pad.y],where=point(position);
      let suggestion;
      if(limitedComponentLabels)suggestion="Find these pads in your PCB editor and see whether their parts can be spaced farther apart. This DSN doesn’t identify a component to move. Reroute after changing the placement to see if it helps.";
      else if(others.length)suggestion="Try making more room by moving "+others.join(', ')+(component(pad)?' or '+component(pad):'')+" to give this pad more space. This is a suggestion, not a checked fix. Make the change in your PCB editor, then reroute to see if it helps.";
      else suggestion="These nearby blocking pads share one component label. Moving the whole part won’t change its pad spacing. Check the footprint and how the pads fan out, then reroute any changes.";
      items.push({id:'endpoint:'+String(pad.id),kind:'endpoint_congestion',title:"Not much room to fan out near "+label(pad),
        detail:net.name+" is still disconnected. Nearby pads block "+blocked+' of '+tested+" full-width straight fanouts tried here. The nearest measured pad gap is "+fmt(round(nearest.gap))+" mm. These local tries don’t rule out another path.",
        suggestion,component:component(pad),pin:String(pad.pin??pad.id),net:net.name,nearbyComponents:others,location:where,
        area:area([position,...close.map(b=>b.point)],Math.max(net.width*2,minimumPadding)),
        evidence:{source:'local-pad-geometry',sampledEscapes:tested,blockedEscapes:blocked,nearestPadGapMm:round(nearest.gap),traceWidthMm:round(net.width),
          nearbyPads:close.map(b=>({id:String(b.pad.id),component:component(b.pad),pin:String(b.pad.pin??b.pad.id),net:netName(b.pad.net),gapMm:round(b.gap),requiredClearanceMm:round(b.required),location:point([b.pad.x,b.pad.y])}))}});
    }
    for(const connection of incomplete) {
      if(items.length>=limit)break;if(represented.has(key(connection.net)))continue;
      const air=connectivity.airwires.find(a=>key(a.net)===key(connection.net));
      const from=air?.from||connection.groups[0]?.points[0]?.slice(0,2),to=air?.to||connection.groups[1]?.points[0]?.slice(0,2);
      if(!from||!to)continue;
      items.push({id:'incomplete:'+String(connection.net),kind:'incomplete_net',title:"Check the remaining "+netName(connection.net)+' connection',
        detail:"This net still has "+connection.groups.length+" separate copper groups. The pad check didn’t find a clear component to move.",
        suggestion:"Check the highlighted connection and nearby routing space in your PCB editor. If you move a component, reroute and check the edited board to see whether it helps.",
        component:null,pin:null,net:netName(connection.net),nearbyComponents:[],location:point(from),area:area([from,to],Math.max(nets.get(key(connection.net))?.width||0,minimumPadding)),evidence:{source:'connectivity',groups:connection.groups.length}});
    }
    return finish({items,limitedComponentLabels,units:'mm',note});
  }
  return {analyze};
}
globalThis.createRamenAdvisor=createRamenAdvisor;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenAdvisor};
