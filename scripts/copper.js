'use strict';

/** Physical polygon pours. The self-contained factory is shared with Blob workers. */
function createRamenCopper(G, C, yieldTask=()=>Promise.resolve()) {
  if(!G||!C?.Clipper||!C?.ClipperOffset)throw new Error('The copper-fill tools did not load. Reload RamenRouter with all its files together.');
  const EPS=G.EPS||1e-8,cache=new WeakMap(),sharedCache=new Map(),derivedCache=new Map(),MAX_VERTICES=2048,MAX_ZONES=64,MAX_HATCH_LINES=4000;
  const MAX_SHARED_BYTES=6*1024*1024,MAX_DERIVED_BYTES=12*1024*1024;
  let sharedBytes=0,derivedBytes=0,derivedToken=0;
  const key=net=>G.netKey?G.netKey(net):String(net);
  const fail=message=>{throw new Error('Copper fill: '+message);};
  const area=points=>points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1];},0)/2;
  function ring(input,label) {
    if(!Array.isArray(input)||input.length<3||input.length>MAX_VERTICES)fail(label+' needs between 3 and '+MAX_VERTICES+' points.');
    let points=input.map(p=>{
      if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p.some(n=>Math.abs(n)>1e9))fail(label+' has an invalid point. Redraw that boundary.');
      return p.slice();
    });
    if(G.distance(points[0],points.at(-1))<=EPS)points.pop();
    if(points.length<3||Math.abs(area(points))<=EPS)fail(label+' has no area. Place at least three points around some space.');
    for(let i=0;i<points.length;i++) {
      if(G.distance(points[i],points[(i+1)%points.length])<=EPS)fail(label+' repeats a point. Remove the duplicate point.');
      for(let j=i+1;j<points.length;j++) {
        if(j===i+1||i===0&&j===points.length-1)continue;
        if(G.segmentIntersection(points[i],points[(i+1)%points.length],points[j],points[(j+1)%points.length]))fail(label+' crosses itself. Move the points so its boundary does not cross.');
      }
    }
    return points;
  }
  function normalizeZones(board,zones=board.copperZones||[]) {
    if(!Array.isArray(zones)||zones.length>MAX_ZONES)fail('Use no more than '+MAX_ZONES+' copper areas.');
    const layers=new Set((board.layers||[]).map((l,i)=>l.index??i)),nets=new Map((board.nets||[]).map(net=>[key(net.id),net])),ids=new Set();
    const defaults=Math.max(0,board.defaultClearance||0),scale=board.units?.mmPerUnit||1;
    return zones.map((input,i)=>{
      if(!input||typeof input!=='object')fail('A copper area has invalid settings.');
      const id=String(input.id||'copper-'+(i+1));if(id.length>100||ids.has(id))fail('Each copper area needs its own ID, no longer than 100 characters.');ids.add(id);
      const net=nets.get(key(input.net));if(!net||!Number.isInteger(net.id)||net.id<=0)fail('Choose a net from this board for each copper area.');
      const layer=Number(input.layer);if(!Number.isInteger(layer)||!layers.has(layer))fail('Choose a copper layer from this board.');
      if(net.useLayers&&!net.useLayers.includes(layer))fail('Your net rules do not allow this net on that layer. Change the layer or the net rule.');
      const style=input.style||'solid';if(!['solid','grid45','grid90'].includes(style))fail('Choose Solid, Grid · 45° or Grid · 90° for the fill style.');
      const padConnection=input.padConnection||'spoke';if(!['spoke','direct'].includes(padConnection))fail('Choose Direct or Spokes for the pad connection.');
      function number(field,fallback,positive=false){const value=input[field]===undefined?fallback:Number(input[field]);if(!Number.isFinite(value)||value<0||positive&&value<=0||value>1e9)fail(field+' is invalid. Check its value.');return value;}
      const spokeWidth=number('spokeWidth',Math.max(net.width||0,0.25/scale),true),gridWidth=number('gridWidth',Math.max(net.width||0,0.25/scale),true),gridPitch=number('gridPitch',Math.max(gridWidth*4,1/scale),true);
      if(spokeWidth+EPS<(net.width||0))fail('Spokes need to be at least as wide as this net’s traces.');
      if(style!=='solid'&&(gridWidth+EPS<(net.width||0)||gridPitch<=gridWidth+EPS))fail('Keep grid spacing wider than the copper lines, and the lines at least as wide as this net’s traces.');
      if(input.keepIslands!==undefined&&typeof input.keepIslands!=='boolean'||input.enabled!==undefined&&typeof input.enabled!=='boolean')fail('Each copper-area switch needs an on or off setting.');
      const points=ring(input.points,'Copper area '+(i+1)),cutouts=(input.cutouts||[]).map((p,n)=>ring(p,'Cutout '+(n+1)));
      if(cutouts.length>64)fail('Use no more than 64 cutouts per copper area.');
      return {id,name:String(input.name||'Copper '+(i+1)).slice(0,100),net:net.id,layer,points,cutouts,style,
        keepIslands:input.keepIslands===true,padConnection,clearance:number('clearance',Math.max(defaults,net.clearance||0)),
        edgeClearance:number('edgeClearance',Math.max(board.edgeClearance||0,defaults)),thermalGap:number('thermalGap',Math.max(defaults,net.clearance||0)),
        spokeWidth,gridPitch,gridWidth,enabled:input.enabled!==false};
    });
  }
  function aborted(cancel){if(cancel?.()){const error=new Error('Copper fill stopped.');error.name='AbortError';throw error;}}
  function signature(board,zones,options){
    const active=zones.filter(zone=>zone.enabled),onlyNet=active[0]?.net;
    const ignoreOwn=active.length&&active.every(zone=>zone.net===onlyNet)&&(options.keepUnanchored||active.every(zone=>zone.keepIslands));
    // Own-net routed copper cannot alter a one-net pour while all islands are
    // retained. Avoid re-clipping unchanged geometry during pad-via placement.
    const traces=ignoreOwn?(board.traces||[]).filter(t=>t.net!==onlyNet):board.traces,vias=ignoreOwn?(board.vias||[]).filter(v=>v.net!==onlyNet):board.vias;
    return JSON.stringify([zones,!!options.keepUnanchored,board.outlines,board.holes,board.bounds,board.edgeClearance,board.defaultClearance,board.classClearances,board.clearanceMode,board.crossClassClearance,board.keepouts,board.nets,board.pads,traces,vias,board.viaDefs,(board.copperFills||[]).filter(fill=>fill.imported===true||fill.fixed===true&&!fill.zoneId)]);
  }
  const copy=value=>typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));
  function remember(board,sig,fills){
    cache.set(board,{signature:sig,fills});
    const points=fills.reduce((sum,fill)=>sum+fill.points.length+(fill.holes||[]).reduce((n,h)=>n+h.length,0),0),bytes=sig.length*2+JSON.stringify(fills).length*2+points*64,old=sharedCache.get(sig);
    if(old){sharedBytes-=old.bytes;sharedCache.delete(sig);}
    if(bytes<=MAX_SHARED_BYTES){sharedCache.set(sig,{fills:copy(fills),bytes});sharedBytes+=bytes;}
    while(sharedCache.size>8||sharedBytes>MAX_SHARED_BYTES){const first=sharedCache.keys().next().value;sharedBytes-=sharedCache.get(first).bytes;sharedCache.delete(first);}
    return fills;
  }
  function recalled(board,sig){const old=cache.get(board);if(old?.signature===sig&&old.fills===board.copperFills)return old.fills;const stored=sharedCache.get(sig);if(stored){const fills=copy(stored.fills);cache.set(board,{signature:sig,fills});return fills;}return null;}
  // Cache only private derived geometry, never a published mutable fill. Each
  // zone depends on foreign copper on its layer; its own routed copper affects
  // island anchoring below, rather than requiring another polygon clip.
  function derived(sig,entries){
    const old=derivedCache.get(sig);
    if(old){derivedCache.delete(sig);derivedCache.set(sig,old);return old;}
    if(entries===undefined)return null;
    const points=entries.reduce((sum,fill)=>sum+fill.points.length+(fill.holes||[]).reduce((n,h)=>n+h.length,0),0),bytes=sig.length*2+points*64+entries.length*256;
    const record={entries,token:++derivedToken,bytes};
    if(bytes<=MAX_DERIVED_BYTES){derivedCache.set(sig,record);derivedBytes+=bytes;}
    while(derivedCache.size>160||derivedBytes>MAX_DERIVED_BYTES){const first=derivedCache.keys().next().value;derivedBytes-=derivedCache.get(first).bytes;derivedCache.delete(first);}
    return record;
  }
  function* generate(board,zones,options,emit,cancel) {
    aborted(cancel);
    const immutableFills=(board.copperFills||[]).filter(fill=>fill.imported===true||fill.fixed===true&&!fill.zoneId);
    if(!zones.some(zone=>zone.enabled))return immutableFills.slice();
    const bounds=board.bounds||G.shapeBounds({type:'polygon',points:zones.flatMap(zone=>zone.points)});
    let maximum=1;for(const value of Object.values(bounds))maximum=Math.max(maximum,Math.abs(value));
    for(const zone of zones)for(const p of zone.points)maximum=Math.max(maximum,Math.abs(p[0]),Math.abs(p[1]));
    const S=Math.max(10,Math.min(1000000,Math.floor(1e13/maximum))),unit=1/S,guard=Math.max(EPS*32,unit*8);
    const cv=p=>({X:Math.round(p[0]*S),Y:Math.round(p[1]*S)}),dc=p=>[p.X/S,p.Y/S];
    function path(points,positive=true){const result=points.map(cv);if(C.Clipper.Orientation(result)!==positive)result.reverse();return result;}
    function execute(subject,clip=[],type=C.ClipType.ctUnion,tree=false) {
      const engine=new C.Clipper();engine.StrictlySimple=true;engine.PreserveCollinear=false;
      if(subject.length)engine.AddPaths(subject,C.PolyType.ptSubject,true);
      if(clip.length)engine.AddPaths(clip,C.PolyType.ptClip,true);
      const solution=tree?new C.PolyTree():[];
      engine.Execute(type,solution,C.PolyFillType.pftNonZero,C.PolyFillType.pftNonZero);return solution;
    }
    const unite=paths=>paths.length?execute(paths):[],difference=(subject,clip)=>clip.length?execute(subject,clip,C.ClipType.ctDifference):subject;
    const intersection=(subject,clip)=>subject.length&&clip.length?execute(subject,clip,C.ClipType.ctIntersection):[];
    function offset(paths,amount) {
      if(!paths.length)return [];
      if(Math.abs(amount)<=EPS)return unite(paths);
      // Round joins are chords. Bound the arc error relative to clearance,
      // then add that error and integer guard to the expansion (or inset).
      // This preserves clearance without thousands of vertices per pad corner.
      const tolerance=Math.max(0.25,Math.abs(amount)*S*0.0004),delta=(Math.abs(amount)+tolerance/S+guard)*Math.sign(amount);
      const engine=new C.ClipperOffset(2,tolerance),result=[];
      engine.AddPaths(paths,C.JoinType.jtRound,C.EndType.etClosedPolygon);
      engine.Execute(result,delta*S);return result;
    }
    function filledPaths(shape){return [path(shape.points),...(shape.holes||[]).map(h=>path(h,false))];}
    function circle(cx,cy,r) {
      const count=48,radius=(r+guard)/Math.cos(Math.PI/count),points=[];
      for(let i=0;i<count;i++){const a=(i+0.5)*Math.PI*2/count;points.push([cx+Math.cos(a)*radius,cy+Math.sin(a)*radius]);}return path(points);
    }
    function capsule(a,b,r) {
      if(G.distance(a,b)<=EPS)return [circle(a[0],a[1],r)];
      const count=24,angle=Math.atan2(b[1]-a[1],b[0]-a[0]),radius=(r+guard)/Math.cos(Math.PI/(count*2)),points=[];
      for(let i=0;i<=count;i++){const t=angle-Math.PI/2+Math.PI*i/count;points.push([b[0]+Math.cos(t)*radius,b[1]+Math.sin(t)*radius]);}
      for(let i=0;i<=count;i++){const t=angle+Math.PI/2+Math.PI*i/count;points.push([a[0]+Math.cos(t)*radius,a[1]+Math.sin(t)*radius]);}return [path(points)];
    }
    function expanded(shape,clearance) {
      if(shape.type==='circle')return [circle(shape.cx,shape.cy,shape.r+clearance)];
      if(shape.type==='capsule')return capsule(shape.a,shape.b,shape.r+clearance);
      return offset(filledPaths(shape),clearance+guard);
    }
    function components(paths) {
      if(!paths.length)return [];
      const tree=execute(paths,[],C.ClipType.ctUnion,true),result=[];
      const children=node=>typeof node.Childs==='function'?node.Childs():node.m_Childs||[];
      const contour=node=>typeof node.Contour==='function'?node.Contour():node.m_polygon||[];
      const hole=node=>typeof node.IsHole==='function'?node.IsHole():false;
      function visit(node){for(const child of children(node)){if(!hole(child)){const outer=contour(child);if(outer.length>=3)result.push({points:outer.map(dc),holes:children(child).filter(hole).map(h=>contour(h).map(dc)).filter(p=>p.length>=3)});}visit(child);}}
      visit(tree);return result;
    }
    function hatch(paths,zone) {
      if(zone.style==='solid')return paths;
      const b=G.shapeBounds({type:'polygon',points:zone.points}),cx=(b.minX+b.maxX)/2,cy=(b.minY+b.maxY)/2,reach=Math.hypot(b.maxX-b.minX,b.maxY-b.minY)+zone.gridPitch*2;
      const angles=zone.style==='grid45'?[Math.PI/4,-Math.PI/4]:[0,Math.PI/2],strips=[];
      for(const angle of angles){const ux=Math.cos(angle),uy=Math.sin(angle),vx=-uy,vy=ux;
        const centreProjection=cx*vx+cy*vy,low=Math.floor((centreProjection-reach)/zone.gridPitch),high=Math.ceil((centreProjection+reach)/zone.gridPitch);
        if(high-low>MAX_HATCH_LINES/angles.length)fail('This grid has too many lines. Increase the grid spacing and try again.');
        for(let n=low;n<=high;n++){const shift=n*zone.gridPitch-centreProjection,x=cx+vx*shift,y=cy+vy*shift,w=zone.gridWidth/2;
          strips.push(path([[x-ux*reach-vx*w,y-uy*reach-vy*w],[x+ux*reach-vx*w,y+uy*reach-vy*w],[x+ux*reach+vx*w,y+uy*reach+vy*w],[x-ux*reach+vx*w,y-uy*reach+vy*w]]));}
      }
      return intersection(paths,unite(strips));
    }
    let boundary=null;
    const getBoundary=()=>boundary||(boundary=board.outlines?.length?unite(board.outlines.map(poly=>path(poly))):[path([[bounds.minX,bounds.minY],[bounds.maxX,bounds.minY],[bounds.maxX,bounds.maxY],[bounds.minX,bounds.maxY]])]);
    const boardHoles=(board.holes||[]).map(h=>path(h.points||h)),baseCopper=G.copper({...board,copperFills:immutableFills}).primitives;
    const produced=[],sameNet=new Map(),hasPotentialAnchor=new Map();
    for(let zi=0;zi<zones.length;zi++) {
      const zone=zones[zi];aborted(cancel);
      if(!zone.enabled){emit?.({stage:'copper-fill',message:zone.name+' is switched off',processed:zi+1,total:zones.length,layer:zone.layer,netId:zone.net});yield;continue;}
      emit?.({stage:'copper-fill',message:'Filling '+zone.name,processed:zi,total:zones.length,layer:zone.layer,netId:zone.net});yield;
      // A joined same-net pour is one physical object; apply its most
      // restrictive source clearance throughout rather than weakening any
      // section when separate zones meet.
      const siblings=zones.filter(other=>other.enabled&&other.net===zone.net&&other.layer===zone.layer),effectiveClearance=Math.max(...siblings.map(other=>other.clearance));
      const siblingKey=key(zone.net)+':'+zone.layer;
      if(!hasPotentialAnchor.has(siblingKey))hasPotentialAnchor.set(siblingKey,options.keepUnanchored||siblings.some(other=>other.keepIslands)||baseCopper.some(p=>p.layer===zone.layer&&key(p.net)===key(zone.net)&&siblings.some(other=>{const shape={type:'polygon',points:other.points,holes:other.cutouts};return G.boxesOverlap(p.bounds,G.shapeBounds(shape))&&G.distanceShapes(p.shape,shape)<=EPS;})));
      // Entirely unanchored groups will be removed. Avoid reserving phantom
      // priority against later foreign-net zones for these empty groups.
      if(!hasPotentialAnchor.get(siblingKey)){emit?.({stage:'copper-fill',message:zone.name+' has no pad or route to connect to',processed:zi+1,total:zones.length,layer:zone.layer,netId:zone.net});yield;continue;}
      const edge=Math.max(board.edgeClearance||0,...siblings.map(other=>other.edgeClearance))+guard;
      const foreign=baseCopper.filter(p=>p.layer===zone.layer&&key(p.net)!==key(zone.net));
      const net=(board.nets||[]).find(n=>key(n.id)===key(zone.net)),keepouts=(board.keepouts||[]).filter(item=>item.kind!=='via'&&(!item.layers||item.layers.includes(zone.layer)));
      const priority=produced.filter(other=>other.layer===zone.layer&&key(other.net)!==key(zone.net));
      const pads=(board.pads||[]).filter(pad=>key(pad.net)===key(zone.net)).map(pad=>[pad.x,pad.y,(pad.shapes||[]).filter(shape=>shape.layer===zone.layer)]).filter(pad=>pad[2].length);
      const zoneSignature=JSON.stringify(['zone',S,zone,effectiveClearance,edge,board.outlines,board.bounds,board.holes,
        foreign.map(p=>[p.shape,Math.max(effectiveClearance,G.clearance(board,zone.net,p.net))]),
        keepouts.map(item=>[item.shape,Math.max(effectiveClearance,item.clearance??net?.routingClearance??net?.clearance??board.defaultClearance??0)]),
        priority.map(other=>[other.points,other.holes,Math.max(effectiveClearance,other.clearance,G.clearance(board,zone.net,other.net))]),pads]);
      let zoneRecord=derived(zoneSignature),entries;
      if(zoneRecord)entries=zoneRecord.entries;
      else {
        let safe=intersection([path(zone.points)],offset(getBoundary(),-edge));
        const cuts=[...boardHoles.map(p=>offset([p],edge)).flat(),...zone.cutouts.map(p=>offset([path(p)],guard)).flat()];
        safe=difference(safe,unite(cuts));
        const obstacles=[];
        for(let pi=0;pi<foreign.length;pi++){const p=foreign[pi];
          obstacles.push(...expanded(p.shape,Math.max(effectiveClearance,G.clearance(board,zone.net,p.net))));
          if((pi&63)===63){aborted(cancel);yield;}
        }
        for(const keepout of keepouts){obstacles.push(...expanded(keepout.shape,Math.max(effectiveClearance,keepout.clearance??net?.routingClearance??net?.clearance??board.defaultClearance??0)));
        }
        for(const other of priority){
          obstacles.push(...expanded({type:'polygon',points:other.points,holes:other.holes},Math.max(effectiveClearance,other.clearance,G.clearance(board,zone.net,other.net))));
        }
        safe=difference(safe,unite(obstacles));aborted(cancel);yield;
        let copper=hatch(safe,zone);
        if(zone.padConnection==='direct'&&zone.style!=='solid'){
          const collars=[];
          for(const pad of board.pads||[]){if(key(pad.net)!==key(zone.net))continue;for(const shape of pad.shapes||[]){if(shape.layer!==zone.layer)continue;
            const b=G.shapeBounds(shape),w=zone.gridWidth/2,length=Math.max(pad.x-b.minX,b.maxX-pad.x,pad.y-b.minY,b.maxY-pad.y)+zone.gridPitch*Math.SQRT2*2;
            collars.push(...expanded(shape,0),path([[pad.x-length,pad.y-w],[pad.x+length,pad.y-w],[pad.x+length,pad.y+w],[pad.x-length,pad.y+w]]),path([[pad.x-w,pad.y-length],[pad.x+w,pad.y-length],[pad.x+w,pad.y+length],[pad.x-w,pad.y+length]]));
          }}
          copper=unite([...copper,...intersection(safe,unite(collars))]);
        }
        if(zone.padConnection==='spoke') {
          const thermalCuts=[],spokes=[];
          for(const pad of board.pads||[]){if(key(pad.net)!==key(zone.net))continue;
            for(const shape of pad.shapes||[]){if(shape.layer!==zone.layer)continue;
              if(!G.boxesOverlap(G.shapeBounds(shape),G.shapeBounds({type:'polygon',points:zone.points}),zone.thermalGap))continue;
              thermalCuts.push(...expanded(shape,zone.thermalGap));
              const b=G.shapeBounds(shape),w=zone.spokeWidth/2,length=Math.max(pad.x-b.minX,b.maxX-pad.x,pad.y-b.minY,b.maxY-pad.y)+zone.thermalGap+zone.spokeWidth+guard*4+(zone.style==='solid'?0:zone.gridPitch*Math.SQRT2*2);
              spokes.push(path([[pad.x-length,pad.y-w],[pad.x+length,pad.y-w],[pad.x+length,pad.y+w],[pad.x-length,pad.y+w]]),path([[pad.x-w,pad.y-length],[pad.x+w,pad.y-length],[pad.x+w,pad.y+length],[pad.x-w,pad.y+length]]));
            }
          }
          copper=unite([...difference(copper,unite(thermalCuts)),...intersection(safe,unite(spokes))]);
        }
        // Filter islands only after adjacent same-net zones have been joined.
        // A region without its own pad can still connect through its neighbour.
        entries=components(copper);zoneRecord=derived(zoneSignature,entries);
      }
      for(const fill of entries){produced.push({...fill,net:zone.net,layer:zone.layer,zoneId:zone.id,clearance:effectiveClearance});}
      const groupKey=key(zone.net)+':'+zone.layer;if(!sameNet.has(groupKey))sameNet.set(groupKey,{net:zone.net,layer:zone.layer,zones:[],parts:[],entries:[]});
      const group=sameNet.get(groupKey);group.zones.push(zone.id);group.parts.push(zoneRecord.token);group.entries.push(...entries);
      emit?.({stage:'copper-fill',message:zone.name+' filled',processed:zi+1,total:zones.length,layer:zone.layer,netId:zone.net});yield;
    }
    const fills=immutableFills.slice();
    for(const group of sameNet.values()){
      aborted(cancel);
      const groupSignature=JSON.stringify(['group',S,group.net,group.layer,group.zones,group.parts]);
      let groupRecord=derived(groupSignature);
      if(!groupRecord){const entries=components(unite(group.entries.flatMap(filledPaths))).map(fill=>{
        const shape={type:'polygon',points:fill.points,holes:fill.holes};
        const zoneIds=[...new Set(produced.filter(p=>p.net===group.net&&p.layer===group.layer&&G.boxesOverlap(G.shapeBounds(shape),G.shapeBounds({type:'polygon',points:p.points}))&&G.distanceShapes(shape,{type:'polygon',points:p.points,holes:p.holes})<=EPS).map(p=>p.zoneId))];
        return {zoneId:zoneIds[0]||group.zones[0],zoneIds,net:group.net,layer:group.layer,points:fill.points,holes:fill.holes};
      });groupRecord=derived(groupSignature,entries);}
      const contacts=baseCopper.filter(p=>p.layer===group.layer&&key(p.net)===key(group.net));
      for(const fill of groupRecord.entries){
        const shape={type:'polygon',points:fill.points,holes:fill.holes};
        const anchored=options.keepUnanchored||fill.zoneIds.some(id=>zones.find(zone=>zone.id===id)?.keepIslands)||contacts.some(p=>G.boxesOverlap(p.bounds,G.shapeBounds(shape))&&G.distanceShapes(p.shape,shape)<=EPS);
        if(anchored)fills.push(copy(fill));
      }
      yield;
    }
    return fills;
  }
  function build(board,options={},emit=null,cancel=null) {
    const zones=normalizeZones(board),sig=signature(board,zones,options);aborted(cancel);
    const reused=recalled(board,sig);if(reused)return reused;
    const iterator=generate(board,zones,options,emit,cancel);let step;
    do{step=iterator.next();}while(!step.done);return remember(board,sig,step.value);
  }
  async function rebuild(board,options={},emit=null,cancel=null) {
    const zones=normalizeZones(board),sig=signature(board,zones,options);aborted(cancel);
    const reused=recalled(board,sig);if(reused){board.copperZones=zones;board.copperFills=reused;return reused;}
    const iterator=generate(board,zones,options,emit,cancel);let step;
    do{step=iterator.next();if(!step.done){await yieldTask();aborted(cancel);}}while(!step.done);
    board.copperZones=zones;board.copperFills=step.value;return remember(board,sig,step.value);
  }
  return {normalizeZones,build,rebuild};
}
globalThis.createRamenCopper=createRamenCopper;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenCopper};
