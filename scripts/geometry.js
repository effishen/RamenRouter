'use strict';

/** Dependency-free copper geometry. The factory is self-contained for Blob workers. */
function createRamenGeometry(onActivity=null) {
  const EPS = 1e-8;
  const observesActivity=typeof onActivity==='function';
  let lastActivityAt=-Infinity;
  function activityContext(stage){return {stage,startedAt:Date.now(),ticks:0,emitted:false};}
  function notifyActivity(event){try{onActivity(event);}catch{/* Display diagnostics must not affect copper checks. */}}
  function activityAt(context,p,q,processed,total,label) {
    if((context.ticks++&63)!==0)return;
    const now=Date.now();if(now-context.startedAt<200||now-lastActivityAt<200)return;
    const points=[],paths=[];
    for(const primitive of q?[p,q]:[p]) {
      const shape=primitive.shape,layer=primitive.layer;
      if(shape.type==='circle')points.push([shape.cx,shape.cy,layer]);
      else if(shape.type==='capsule')paths.push({layer,points:[shape.a.slice(),shape.b.slice()]});
      else if(shape.points?.length){const vertices=shape.points.slice(0,255).map(point=>point.slice());if(shape.points.length<=255)vertices.push(shape.points[0].slice());paths.push({layer,points:vertices});}
      if(primitive.object?.kind==='pad')points.push([primitive.object.item.x,primitive.object.item.y,layer]);
    }
    const visual={kind:q?'check':p.object?.kind||'check',points,paths,label};
    if(!q||p.layer===q.layer)visual.layer=p.layer;
    lastActivityAt=now;context.emitted=true;
    notifyActivity({stage:context.stage,netId:p.net,processed,total,visual});
  }
  function activityDone(context){if(context?.emitted)notifyActivity({stage:context.stage,visual:null,complete:true});}
  const sq = x => x * x;
  const point = p => Array.isArray(p) ? p : [p.x, p.y];
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  function closestPointOnSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], den = dx * dx + dy * dy;
    const t = den ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / den)) : 0;
    return [a[0] + t * dx, a[1] + t * dy];
  }
  function distancePointSegment(x,y,a,b) {
    const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/den)):0;
    return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);
  }
  function pointOnSegment(p, a, b) {
    // A boundary hit must lie inside the segment's bounds. Reject far-away
    // polygon edges before projecting and taking a square root; a pour can
    // contain thousands of edges. Keep a generous rounding margin so large
    // coordinates retain the existing distance calculation near a boundary.
    const margin=EPS+64*Number.EPSILON*Math.max(1,Math.abs(p[0]),Math.abs(p[1]),Math.abs(a[0]),Math.abs(a[1]),Math.abs(b[0]),Math.abs(b[1]));
    if(p[0]<Math.min(a[0],b[0])-margin||p[0]>Math.max(a[0],b[0])+margin||p[1]<Math.min(a[1],b[1])-margin||p[1]>Math.max(a[1],b[1])+margin)return false;
    return distancePointSegment(p[0],p[1],a,b)<=EPS;
  }
  function segmentIntersection(a, b, c, d) {
    const abC = cross(a,b,c), abD = cross(a,b,d), cdA = cross(c,d,a), cdB = cross(c,d,b);
    if (((abC > EPS && abD < -EPS) || (abC < -EPS && abD > EPS)) &&
        ((cdA > EPS && cdB < -EPS) || (cdA < -EPS && cdB > EPS))) return true;
    return pointOnSegment(a,c,d) || pointOnSegment(b,c,d) || pointOnSegment(c,a,b) || pointOnSegment(d,a,b);
  }
  function closestSegmentPoints(a, b, c, d) {
    const dx = b[0]-a[0], dy = b[1]-a[1], ex = d[0]-c[0], ey = d[1]-c[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) > EPS * EPS) {
      const t = ((c[0]-a[0]) * ey - (c[1]-a[1]) * ex) / den;
      const u = ((c[0]-a[0]) * dy - (c[1]-a[1]) * dx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        const p = [a[0]+t*dx,a[1]+t*dy]; return {distance:0, a:p, b:p};
      }
    }
    const candidates = [[a,closestPointOnSegment(a,c,d)],[b,closestPointOnSegment(b,c,d)],
      [closestPointOnSegment(c,a,b),c],[closestPointOnSegment(d,a,b),d]];
    let best = null;
    for (const [p,q] of candidates) { const length=distance(p,q); if (!best || length < best.distance) best={distance:length,a:p,b:q}; }
    return best;
  }
  // Distance-only checks do not need closest-point arrays. Preserve the exact
  // projection arithmetic of closestSegmentPoints, including intersection EPS,
  // so this fast path cannot change contact/clearance decisions.
  function scalarEndpointDistance(x,y,ax,ay,dx,dy,den) {
    const t=den?Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/den)):0;
    return Math.hypot(x-(ax+t*dx),y-(ay+t*dy));
  }
  function distanceSegments(a,b,c,d) {
    a=point(a);b=point(b);c=point(c);d=point(d);
    const dx=b[0]-a[0],dy=b[1]-a[1],ex=d[0]-c[0],ey=d[1]-c[1],den=dx*ey-dy*ex;
    if(Math.abs(den)>EPS*EPS){
      const t=((c[0]-a[0])*ey-(c[1]-a[1])*ex)/den,u=((c[0]-a[0])*dy-(c[1]-a[1])*dx)/den;
      if(t>=0&&t<=1&&u>=0&&u<=1)return 0;
    }
    const ab=dx*dx+dy*dy,cd=ex*ex+ey*ey;
    let best=scalarEndpointDistance(a[0],a[1],c[0],c[1],ex,ey,cd);
    let candidate=scalarEndpointDistance(b[0],b[1],c[0],c[1],ex,ey,cd);if(candidate<best)best=candidate;
    candidate=scalarEndpointDistance(c[0],c[1],a[0],a[1],dx,dy,ab);if(candidate<best)best=candidate;
    candidate=scalarEndpointDistance(d[0],d[1],a[0],a[1],dx,dy,ab);if(candidate<best)best=candidate;
    return best;
  }
  function pointInPolygon(x, y, polygon) {
    const p=[x,y]; let result=false;
    for (let i=0,j=polygon.length-1;i<polygon.length;j=i++) {
      const a=polygon[j], b=polygon[i];
      if (pointOnSegment(p,a,b)) return true;
      if ((a[1]>y)!==(b[1]>y) && x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]) result=!result;
    }
    return result;
  }
  function shapeBounds(shape) {
    if (shape.type==='circle') return {minX:shape.cx-shape.r,minY:shape.cy-shape.r,maxX:shape.cx+shape.r,maxY:shape.cy+shape.r};
    const points=shape.type==='capsule' ? [shape.a,shape.b] : shape.points;
    const radius=shape.type==='capsule' ? shape.r : 0;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of points){minX=Math.min(minX,p[0]);minY=Math.min(minY,p[1]);maxX=Math.max(maxX,p[0]);maxY=Math.max(maxY,p[1]);}
    return {minX:minX-radius,minY:minY-radius,maxX:maxX+radius,maxY:maxY+radius};
  }
  function pointInShape(x,y,shape) {
    if (shape.type==='circle') return Math.hypot(x-shape.cx,y-shape.cy)<=shape.r+EPS;
    if (shape.type==='capsule') return distance([x,y],closestPointOnSegment([x,y],shape.a,shape.b))<=shape.r+EPS;
    if(!pointInPolygon(x,y,shape.points))return false;
    for(const hole of shape.holes||[])if(pointInPolygon(x,y,hole)&&!hole.some((p,i)=>pointOnSegment([x,y],p,hole[(i+1)%hole.length])))return false;
    return true;
  }
  function polygonRings(shape){return [shape.points,...(shape.holes||[])];}
  function shapeCore(shape) {
    if (shape.type==='circle') { const p=[shape.cx,shape.cy]; return {points:[p],edges:[[p,p]],radius:shape.r,polygon:false}; }
    if (shape.type==='capsule') return {points:[shape.a,shape.b],edges:[[shape.a,shape.b]],radius:shape.r,polygon:false};
    const rings=polygonRings(shape);
    return {points:rings.flat(),edges:rings.flatMap(ring=>ring.map((p,i)=>[p,ring[(i+1)%ring.length]])),radius:0,polygon:true};
  }
  function closestShapePoints(a,b) {
    const ac=shapeCore(a),bc=shapeCore(b);
    if (ac.polygon) for (const p of bc.points) if (pointInShape(p[0],p[1],a)) return {distance:0,a:p,b:p};
    if (bc.polygon) for (const p of ac.points) if (pointInShape(p[0],p[1],b)) return {distance:0,a:p,b:p};
    let best={distance:Infinity,a:ac.points[0],b:bc.points[0]};
    for (const ae of ac.edges) for (const be of bc.edges) {
      const pair=closestSegmentPoints(ae[0],ae[1],be[0],be[1]);
      if (pair.distance<best.distance) best=pair;
      if (best.distance===0) break;
    }
    if (best.distance<=ac.radius+bc.radius+EPS) {
      const p=best.distance ? [best.a[0]+(best.b[0]-best.a[0])*Math.min(1,ac.radius/best.distance),best.a[1]+(best.b[1]-best.a[1])*Math.min(1,ac.radius/best.distance)] : best.a;
      return {distance:0,a:p,b:p};
    }
    const dx=(best.b[0]-best.a[0])/best.distance,dy=(best.b[1]-best.a[1])/best.distance;
    return {distance:best.distance-ac.radius-bc.radius,a:[best.a[0]+dx*ac.radius,best.a[1]+dy*ac.radius],b:[best.b[0]-dx*bc.radius,best.b[1]-dy*bc.radius]};
  }
  function distanceShapes(a,b) {
    if(a.type==='circle')return Math.max(0,distancePointShape(a.cx,a.cy,b)-a.r);
    if(b.type==='circle')return Math.max(0,distancePointShape(b.cx,b.cy,a)-b.r);
    if(a.type==='capsule')return Math.max(0,distanceSegmentShape(a.a[0],a.a[1],a.b[0],a.b[1],b)-a.r);
    if(b.type==='capsule')return Math.max(0,distanceSegmentShape(b.a[0],b.a[1],b.b[0],b.b[1],a)-b.r);
    return closestShapePoints(a,b).distance;
  }
  function distancePointShape(x,y,shape) {
    if(shape.type==='circle')return Math.max(0,Math.hypot(x-shape.cx,y-shape.cy)-shape.r);
    if(shape.type==='capsule')return Math.max(0,distancePointSegment(x,y,shape.a,shape.b)-shape.r);
    if(pointInShape(x,y,shape))return 0;
    let best=Infinity;for(const ring of polygonRings(shape))for(let i=0;i<ring.length;i++)best=Math.min(best,distancePointSegment(x,y,ring[i],ring[(i+1)%ring.length]));return best;
  }
  function distanceSegmentShape(ax,ay,bx,by,shape) {
    const a=[ax,ay],b=[bx,by];
    if(shape.type==='circle')return Math.max(0,distancePointSegment(shape.cx,shape.cy,a,b)-shape.r);
    if(shape.type==='capsule')return Math.max(0,distanceSegments(a,b,shape.a,shape.b)-shape.r);
    if(pointInShape(ax,ay,shape)||pointInShape(bx,by,shape))return 0;
    let best=Infinity;for(const ring of polygonRings(shape))for(let i=0;i<ring.length;i++){best=Math.min(best,distanceSegments(a,b,ring[i],ring[(i+1)%ring.length]));if(best<=EPS)return 0;}return best;
  }
  function nearestPointOnShape(x,y,shape) { return closestShapePoints({type:'circle',cx:x,cy:y,r:0},shape).b; }
  function boxesOverlap(a,b,pad=0) { return a.minX<=b.maxX+pad && a.maxX+pad>=b.minX && a.minY<=b.maxY+pad && a.maxY+pad>=b.minY; }
  function spatialIndex(items=[],cellSize=5,getBounds=x=>x.bounds||shapeBounds(x.shape||x)) {
    cellSize=Math.max(EPS,cellSize);
    const cells=new Map(),entries=new Map(),large=new Set();
    function keys(bounds) {
      const result=[];
      if(![bounds.minX,bounds.minY,bounds.maxX,bounds.maxY].every(Number.isFinite))return null;
      const minX=Math.floor(bounds.minX/cellSize),maxX=Math.floor(bounds.maxX/cellSize),minY=Math.floor(bounds.minY/cellSize),maxY=Math.floor(bounds.maxY/cellSize);
      if((maxX-minX+1)*(maxY-minY+1)>20000)return null;
      for (let x=minX;x<=maxX;x++) for (let y=minY;y<=maxY;y++) result.push(x+','+y);
      return result;
    }
    function insert(item) { const bounds=getBounds(item);entries.set(item,bounds);const itemKeys=keys(bounds);if(itemKeys===null)large.add(item);else for (const key of itemKeys) { if(!cells.has(key))cells.set(key,new Set());cells.get(key).add(item); } return item; }
    function remove(item) { const bounds=entries.get(item);if(!bounds)return;large.delete(item);for(const key of keys(bounds)||[]){const bucket=cells.get(key);bucket?.delete(item);if(bucket?.size===0)cells.delete(key);}entries.delete(item); }
    function query(bounds,pad=0) {
      const expanded={minX:bounds.minX-pad,minY:bounds.minY-pad,maxX:bounds.maxX+pad,maxY:bounds.maxY+pad};
      const found=new Set(),queryKeys=keys(expanded);
      if(queryKeys===null){for(const [item,b] of entries)if(boxesOverlap(b,expanded))found.add(item);}
      else{for(const key of queryKeys)for(const item of cells.get(key)||[])if(boxesOverlap(entries.get(item),expanded))found.add(item);for(const item of large)if(boxesOverlap(entries.get(item),expanded))found.add(item);}
      return [...found];
    }
    for (const item of items) insert(item);
    return {insert,remove,query,clear(){cells.clear();entries.clear();large.clear();},size:()=>entries.size};
  }
  function netKey(net) { return net===null || net===undefined || net===0 || net==='' ? null : String(net); }
  // Specctra's class rule supplies a matrix diagonal. It does not reduce the
  // global distance between copper in two different clearance classes.
  // Accept net objects as well as IDs so collision loops can avoid lookups.
  function clearance(board,netA,netB) {
    const resolve=net=>net&&typeof net==='object'?net:(board.nets||[]).find(n=>netKey(n.id)===netKey(net));
    const a=resolve(netA),b=resolve(netB),base=Math.max(0,board.crossClassClearance??board.defaultClearance??0);
    if(board.clearanceMode!=='specctra-class-matrix')return Math.max(0,a?.clearance??base,b?.clearance??base);
    if(!a||!b)return base;
    const ca=a.clearanceClass??'default',cb=b.clearanceClass??'default';
    const value=c=>Math.max(0,board.classClearances?.[c]??(c===ca?a.clearance:b.clearance)??base);
    return ca===cb?value(ca):Math.max(base,value(ca),value(cb));
  }
  function unionFind(count) {
    const parent=Array.from({length:count},(_,i)=>i),rank=new Uint8Array(count);
    function find(i){while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;}
    function union(a,b){a=find(a);b=find(b);if(a===b)return;if(rank[a]<rank[b])[a,b]=[b,a];parent[b]=a;if(rank[a]===rank[b])rank[a]++;}
    return {find,union};
  }
  function copper(board) {
    const objects=[],primitives=[];
    function add(kind,index,item,shapes,points,id) {
      const object={uid:objects.length,kind,index,id:id??kind+':'+index,net:item.net,item,points,primitives:[]};objects.push(object);
      for (const shape of shapes) {const primitive={object,shape,layer:shape.layer,net:item.net,bounds:shapeBounds(shape)};object.primitives.push(primitive);primitives.push(primitive);}
    }
    (board.pads||[]).forEach((p,i)=>add('pad',i,p,p.shapes||[],(p.shapes||[]).map(s=>[p.x,p.y,s.layer]),p.id));
    (board.traces||[]).forEach((t,i)=>{
      const shapes=[];for(let n=1;n<t.points.length;n++)shapes.push({type:'capsule',a:t.points[n-1],b:t.points[n],r:t.width/2,layer:t.layer});
      if(t.points.length===1)shapes.push({type:'circle',cx:t.points[0][0],cy:t.points[0][1],r:t.width/2,layer:t.layer});
      add('trace',i,t,shapes,t.points.map(p=>[p[0],p[1],t.layer]));
    });
    (board.vias||[]).forEach((v,i)=>{
      const def=(board.viaDefs||[]).find(d=>d.name===v.padstack);
      const layers=v.layers||Array.from({length:(def?.toLayer??0)-(def?.fromLayer??0)+1},(_,n)=>n+(def?.fromLayer??0));
      add('via',i,v,layers.map(layer=>({type:'circle',cx:v.x,cy:v.y,r:(v.diameter??def?.diameter??0)/2,layer})),layers.map(layer=>[v.x,v.y,layer]));
    });
    (board.copperFills||[]).forEach((fill,i)=>{
      const shape={type:'polygon',points:fill.points,holes:fill.holes||[],layer:fill.layer};
      add('fill',i,fill,[shape],fill.points.map(p=>[p[0],p[1],fill.layer]),fill.zoneId+':'+i);
    });
    return {objects,primitives};
  }
  function indexing(board,primitives) {
    const bounds=board.bounds||{minX:0,minY:0,maxX:100,maxY:100};
    const span=Math.max(bounds.maxX-bounds.minX,bounds.maxY-bounds.minY,1);
    const cellSize=Math.max(span/Math.max(8,Math.sqrt(primitives.length)),EPS*100);
    const layers=new Map();
    for(const p of primitives){if(!layers.has(p.layer))layers.set(p.layer,spatialIndex([],cellSize));layers.get(p.layer).insert(p);}
    return layers;
  }
  function connectivity(board,options={}) {
    const activity=observesActivity?activityContext('connectivity'):null;
    const {objects,primitives}=copper(board),uf=unionFind(objects.length),layers=indexing(board,primitives);
    let primitiveCount=0;
    for(const p of primitives){primitiveCount++;if(netKey(p.net)===null)continue;for(const q of layers.get(p.layer).query(p.bounds,EPS)){
      if(q.object.uid<=p.object.uid || netKey(q.net)!==netKey(p.net) || uf.find(q.object.uid)===uf.find(p.object.uid))continue;
      if(observesActivity)activityAt(activity,p,q,primitiveCount,primitives.length,'Checking where copper touches');
      if(distanceShapes(p.shape,q.shape)<=EPS)uf.union(p.object.uid,q.object.uid);
    }if(observesActivity)activityAt(activity,p,null,primitiveCount,primitives.length,'Checking which copper is connected');}
    const byNet=new Map();
    for(const object of objects){const key=netKey(object.net);if(key===null || !object.primitives.length)continue;
      if(!byNet.has(key))byNet.set(key,new Map());const groups=byNet.get(key),id=uf.find(object.uid);
      if(!groups.has(id))groups.set(id,{id,net:object.net,items:[],pads:[],points:[],_primitives:[]});
      const group=groups.get(id);group.items.push({kind:object.kind,index:object.index,id:object.id,points:object.points});
      if(object.kind==='pad')group.pads.push(object.id);group.points.push(...object.points);group._primitives.push(...object.primitives);
    }
    const components=[],airwires=[];let unrouted=0;
    for(const [key,groupMap] of byNet){
      // Unattached pour islands are optional copper, not terminals that must
      // be routed. Separate islands touching different pads remain separate.
      const groups=[...groupMap.values()].filter(group=>group.items.some(item=>item.kind!=='fill'));unrouted+=Math.max(0,groups.length-1);
      // Internal checks need the exact copper groups and connection count,
      // but do not need the visual minimum-spanning tree of airwires.
      if(groups.length>1&&options.airwires!==false){
        const used=new Set([0]),best=new Array(groups.length).fill(null);
        function groupDistance(a,b){let closest={distance:Infinity,from:a.points[0]?.slice(0,2),to:b.points[0]?.slice(0,2)};
          for(const ap of a._primitives)for(const bp of b._primitives){
            if(observesActivity)activityAt(activity,ap,bp,undefined,undefined,'Checking the gap between disconnected copper');
            const dx=Math.max(0,ap.bounds.minX-bp.bounds.maxX,bp.bounds.minX-ap.bounds.maxX),dy=Math.max(0,ap.bounds.minY-bp.bounds.maxY,bp.bounds.minY-ap.bounds.maxY);
            if(Math.hypot(dx,dy)>=closest.distance)continue;
            const pair=closestShapePoints(ap.shape,bp.shape);
            if(pair.distance<closest.distance)closest={distance:pair.distance,from:pair.a,to:pair.b,fromLayer:ap.layer,toLayer:bp.layer};
          }return closest;}
        let last=0;
        while(used.size<groups.length){for(let j=0;j<groups.length;j++)if(!used.has(j)){
          const pair=groupDistance(groups[last],groups[j]);if(!best[j]||pair.distance<best[j].distance)best[j]={...pair,fromGroup:groups[last].id,toGroup:groups[j].id};
        }
          let next=-1;for(let j=0;j<groups.length;j++)if(!used.has(j)&&best[j]&&(next<0||best[j].distance<best[next].distance))next=j;
          if(next<0)break;airwires.push({net:groups[next].net,...best[next]});used.add(next);last=next;
        }
      }
      for(const group of groups)delete group._primitives;
      components.push({net:groups[0]?.net??key,groups});
    }
    activityDone(activity);return {unrouted,components,airwires};
  }
  function pointInBoard(x,y,board) {
    const outlines=board.outlines||[];
    if(!outlines.length){const b=board.bounds;if(b&&(x<b.minX-EPS||x>b.maxX+EPS||y<b.minY-EPS||y>b.maxY+EPS))return false;}
    else if(!outlines.some(p=>pointInPolygon(x,y,p)))return false;
    return !(board.holes||[]).some(h=>pointInPolygon(x,y,h.points||h));
  }
  function boundaryEdges(board) {
    const polygons=[...(board.outlines||[]),...(board.holes||[]).map(h=>h.points||h)];
    if(!polygons.length&&board.bounds){const b=board.bounds;polygons.push([[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]]);}
    const edges=polygons.flatMap(poly=>poly.map((p,i)=>[p,poly[(i+1)%poly.length]]));
    // Split boundaries where polygons overlap; only exposed union boundaries count.
    const result=[];
    for(const [a,b] of edges){const ts=[0,1],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);if(length<=EPS)continue;
      for(const [c,d] of edges){const ex=d[0]-c[0],ey=d[1]-c[1],den=dx*ey-dy*ex;if(Math.abs(den)<=EPS*EPS)continue;
        const t=((c[0]-a[0])*ey-(c[1]-a[1])*ex)/den,u=((c[0]-a[0])*dy-(c[1]-a[1])*dx)/den;
        if(t>EPS&&t<1-EPS&&u>=0&&u<=1)ts.push(t);
      }
      ts.sort((x,y)=>x-y);
      for(let i=1;i<ts.length;i++){const t=(ts[i]+ts[i-1])/2,m=[a[0]+dx*t,a[1]+dy*t],n=[-dy/length*EPS*20,dx/length*EPS*20];
        if(pointInBoard(m[0]+n[0],m[1]+n[1],board)!==pointInBoard(m[0]-n[0],m[1]-n[1],board))
          result.push([[a[0]+dx*ts[i-1],a[1]+dy*ts[i-1]],[a[0]+dx*ts[i],a[1]+dy*ts[i]]]);
      }
    }return result;
  }
  function shapeInsideBoard(shape,board,edges=boundaryEdges(board),edgeClearance=board.edgeClearance||0) {
    const core=shapeCore(shape);
    if(core.points.some(p=>!pointInBoard(p[0],p[1],board)))return false;
    for(const [a,b] of core.edges){const ts=[0,1],dx=b[0]-a[0],dy=b[1]-a[1];
      for(const [c,d] of edges){
        const dist=distanceSegments(a,b,c,d);
        if(dist+EPS<core.radius+edgeClearance)return false;
        // Collect ALL crossings before sampling intervals, including narrow notches.
        const ex=d[0]-c[0],ey=d[1]-c[1],den=dx*ey-dy*ex;
        if(Math.abs(den)>EPS*EPS){const t=((c[0]-a[0])*ey-(c[1]-a[1])*ex)/den,u=((c[0]-a[0])*dy-(c[1]-a[1])*dx)/den;if(t>0&&t<1&&u>=0&&u<=1)ts.push(t);}
      }
      ts.sort((x,y)=>x-y);for(let j=1;j<ts.length;j++){const t=(ts[j-1]+ts[j])/2;if(!pointInBoard(a[0]+dx*t,a[1]+dy*t,board))return false;}
    }
    // A polygon can entirely enclose a hole without its edges crossing the hole.
    if(core.polygon)for(const hole of board.holes||[])for(const p of hole.points||hole)if(pointInShape(p[0],p[1],shape))return false;
    return true;
  }
  // This is a bounded terminal-access exception, not another routing layer.
  // Geometry establishes the exception; generated/imported trace flags do not.
  function padEscapeLimit(board,pad,net,viaDefinition) {
    const shapes=pad?.shapes||[],scale=board.units?.mmPerUnit;
    if(!shapes.length||!Number.isFinite(scale)||scale<=0||!Number.isFinite(net?.width)||net.width<=0||!Number.isFinite(viaDefinition?.diameter)||viaDefinition.diameter<=0)return 0;
    const bounds=shapes.map(shapeBounds),minX=Math.min(...bounds.map(b=>b.minX)),minY=Math.min(...bounds.map(b=>b.minY)),maxX=Math.max(...bounds.map(b=>b.maxX)),maxY=Math.max(...bounds.map(b=>b.maxY));
    const localClearance=Math.max(0,net.routingClearance??net.clearance??board.defaultClearance??0);
    const limit=Math.hypot(maxX-minX,maxY-minY)+Math.max(net.width*6,viaDefinition.diameter*2,localClearance*2,1/scale);
    return Number.isFinite(limit)?limit:0;
  }
  function isPermittedLayerEscape(board,trace,net=null) {
    if(!board||!trace)return false;
    net=net||(board.nets||[]).find(item=>netKey(item.id)===netKey(trace.net));
    const layerIds=new Set((board.layers||[]).map((layer,i)=>layer.index??i)),selected=net?.useLayers||[...layerIds];
    if(!net||netKey(net.id)===null||netKey(net.id)!==netKey(trace.net)||!layerIds.has(trace.layer)||selected.includes(trace.layer)||!selected.some(layer=>layerIds.has(layer)))return false;
    if(!Number.isFinite(trace.width)||trace.width<=0||Math.abs(trace.width-net.width)>EPS||!Array.isArray(trace.points)||trace.points.length<2||trace.points.some(p=>!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])))return false;
    let length=0;for(let i=1;i<trace.points.length;i++)length+=distance(trace.points[i-1],trace.points[i]);
    if(!Number.isFinite(length)||length<=EPS)return false;
    const endpoints=[trace.points[0],trace.points.at(-1)],key=netKey(net.id);
    const pads=(board.pads||[]).filter(pad=>netKey(pad.net)===key&&pad.shapes?.length&&new Set(pad.shapes.map(shape=>shape.layer)).size===1&&pad.shapes[0].layer===trace.layer);
    const vias=(board.vias||[]).filter(via=>netKey(via.net)===key&&Number.isFinite(via.x)&&Number.isFinite(via.y));
    for(const via of vias) {
      const def=(board.viaDefs||[]).find(item=>item.name===via.padstack);
      if(!def||net.viaName&&net.viaName!==def.name||!Number.isInteger(def.fromLayer)||!Number.isInteger(def.toLayer)||def.fromLayer>=def.toLayer||trace.layer<def.fromLayer||trace.layer>def.toLayer||!selected.some(layer=>layerIds.has(layer)&&layer>=def.fromLayer&&layer<=def.toLayer))continue;
      const expected=[...layerIds].filter(layer=>layer>=def.fromLayer&&layer<=def.toLayer),actual=via.layers||expected,diameter=via.diameter??def.diameter;
      if(!Number.isFinite(diameter)||diameter<=0||Math.abs(diameter-def.diameter)>EPS||!Array.isArray(actual)||actual.length!==expected.length||new Set(actual).size!==actual.length||expected.some(layer=>!actual.includes(layer)))continue;
      const viaShape={type:'circle',cx:via.x,cy:via.y,r:diameter/2};
      for(let end=0;end<2;end++) {
        if(distance(endpoints[end],[via.x,via.y])>EPS)continue;
        const from=endpoints[1-end];
        for(const pad of pads) {
          if(!pad.shapes.some(shape=>pointInShape(from[0],from[1],shape))||pad.shapes.some(shape=>distanceShapes(viaShape,shape)<=EPS))continue;
          if(length<=padEscapeLimit(board,pad,net,def)+EPS)return true;
        }
      }
    }
    return false;
  }
  function validate(board) {
    const activity=observesActivity?activityContext('checking'):null;
    const {objects,primitives}=copper(board),layers=indexing(board,primitives);
    const nets=new Map((board.nets||[]).map(n=>[netKey(n.id),n]));
    const allowedLayers=new Set((board.layers||[]).map((l,i)=>l.index??i));
    const netClearance=net=>Math.max(0,nets.get(netKey(net))?.routingClearance??nets.get(netKey(net))?.clearance??board.defaultClearance??0);
    const zoneRules=new Map((board.copperZones||[]).map(zone=>[zone.id,zone]));
    const fillRule=(object,key)=>object.kind==='fill'?Math.max(0,...(object.item.zoneIds||[object.item.zoneId]).map(id=>zoneRules.get(id)?.[key]||0)):0;
    const maxClearance=Math.max(board.crossClassClearance||0,board.defaultClearance||0,...(board.nets||[]).map(n=>n.routingClearance??n.clearance??0),...Object.values(board.classClearances||{}),...(board.copperZones||[]).map(z=>z.clearance||0));
    const violations=[],widthDeviations=[],seen=new Set();
    // A poured polygon can have thousands of edges. Check only the nearby
    // edges when proving a circle or trace has enough clearance; keep the
    // exact distance calculation for every possible violation.
    const polygonChecks=new WeakMap();
    function polygonCheck(shape){
      if(polygonChecks.has(shape))return polygonChecks.get(shape);
      const rings=polygonRings(shape);
      if(rings.reduce((sum,ring)=>sum+ring.length,0)<64||rings.some(ring=>ring.length<3||ring.some(p=>!Array.isArray(p)||p.length<2||!p.every(Number.isFinite)))){polygonChecks.set(shape,null);return null;}
      const bounds=shapeBounds(shape),span=Math.max(bounds.maxX-bounds.minX,bounds.maxY-bounds.minY,EPS*100);
      let magnitude=1;for(const ring of rings)for(const p of ring)magnitude=Math.max(magnitude,Math.abs(p[0]),Math.abs(p[1]));
      if(magnitude>1e9){polygonChecks.set(shape,null);return null;}
      const count=rings.reduce((sum,ring)=>sum+ring.length,0),cell=span/Math.min(128,Math.max(16,Math.sqrt(count)));
      const edges=rings.flatMap(ring=>ring.map((a,i)=>{const b=ring[(i+1)%ring.length];return{a,b,bounds:{minX:Math.min(a[0],b[0]),minY:Math.min(a[1],b[1]),maxX:Math.max(a[0],b[0]),maxY:Math.max(a[1],b[1])}};}));
      const holes=(shape.holes||[]).map(ring=>({ring,bounds:shapeBounds({type:'polygon',points:ring})}));
      const result={edges:spatialIndex(edges,cell),allEdges:edges,holes:spatialIndex(holes,cell),bounds,magnitude};polygonChecks.set(shape,result);return result;
    }
    function separatedPolygon(a,b,required){
      const polygon=a.type==='polygon'?a:b.type==='polygon'?b:null,other=polygon===a?b:a;
      if(!polygon||!['circle','capsule'].includes(other.type)||!Number.isFinite(other.r)||other.r<0||!Number.isFinite(required))return false;
      const prepared=polygonCheck(polygon);if(!prepared)return false;
      const box=shapeBounds(other);if(!Object.values(box).every(Number.isFinite))return false;
      const scale=Math.max(prepared.magnitude,...Object.values(box).map(Math.abs));
      const margin=EPS*8+256*Number.EPSILON*scale,threshold=Math.max(required,EPS)+margin;
      const points=other.type==='circle'?[[other.cx,other.cy]]:[other.a,other.b];
      for(const p of points){
        if(!pointInPolygon(p[0],p[1],polygon.points))continue;
        const holes=prepared.holes.query({minX:p[0],minY:p[1],maxX:p[0],maxY:p[1]},margin);
        if(!holes.some(({ring})=>pointInPolygon(p[0],p[1],ring)&&!ring.some((a,i)=>pointOnSegment(p,a,ring[(i+1)%ring.length]))))return false;
      }
      if(other.type==='capsule'){
        // Preserve the existing intersection arithmetic even for nearly
        // parallel, mixed-scale edges outside the query rectangle.
        const a=other.a,b=other.b,dx=b[0]-a[0],dy=b[1]-a[1];
        for(const edge of prepared.allEdges){const ex=edge.b[0]-edge.a[0],ey=edge.b[1]-edge.a[1],den=dx*ey-dy*ex;
          if(Math.abs(den)>EPS*EPS){const t=((edge.a[0]-a[0])*ey-(edge.a[1]-a[1])*ex)/den,u=((edge.a[0]-a[0])*dy-(edge.a[1]-a[1])*dx)/den;if(t>=0&&t<=1&&u>=0&&u<=1)return false;}
        }
      }
      const reach=other.r+threshold;
      for(const edge of prepared.edges.query(box,threshold)){
        const gap=other.type==='circle'?distancePointSegment(other.cx,other.cy,edge.a,edge.b):distanceSegments(other.a,other.b,edge.a,edge.b);
        if(gap<=reach)return false;
      }
      return true;
    }
    function violation(type,key,detail){if(seen.has(key))return;seen.add(key);violations.push({type,...detail});}
    for(const net of board.nets||[])if(!Number.isFinite(net.width)||net.width<=0||!Number.isFinite(net.clearance)||net.clearance<0)violation('invalid_rule',`nrule:${net.id}`,{net:net.id,width:net.width,clearance:net.clearance});
    for(const object of objects)if((netKey(object.net)!==null&&!nets.has(netKey(object.net)))||(object.kind!=='pad'&&netKey(object.net)===null))violation('unknown_net',`n:${object.uid}`,{kind:object.kind,index:object.index,net:object.net});
    for(const p of primitives)if(!allowedLayers.has(p.layer))violation('unknown_layer',`l:${p.object.uid}:${p.layer}`,{kind:p.object.kind,index:p.object.index,layer:p.layer});
    for(const p of primitives)for(const q of layers.get(p.layer).query(p.bounds,maxClearance+EPS)){
      if(q.object.uid<=p.object.uid)continue;
      if(observesActivity)activityAt(activity,p,q,undefined,undefined,'Checking the space between copper');
      const same=netKey(p.net)!==null&&netKey(p.net)===netKey(q.net);
      if(!same){const required=Math.max(clearance(board,nets.get(netKey(p.net)),nets.get(netKey(q.net))),fillRule(p.object,'clearance'),fillRule(q.object,'clearance'));if(separatedPolygon(p.shape,q.shape,required))continue;const actual=distanceShapes(p.shape,q.shape);if(actual+EPS<required||actual<=EPS)
        violation(actual<=EPS?'short':'clearance',`c:${p.object.uid}:${q.object.uid}:${p.layer}`,{layer:p.layer,a:{kind:p.object.kind,index:p.object.index,id:p.object.id,net:p.net},b:{kind:q.object.kind,index:q.object.index,id:q.object.id,net:q.net},actual,required});
      }else{
        const via=p.object.kind==='via'?p.object:q.object.kind==='via'?q.object:null;
        const pad=p.object.kind==='pad'?p.object:q.object.kind==='pad'?q.object:null;
        if(via&&pad&&new Set(pad.item.shapes.map(s=>s.layer)).size===1){
          const def=(board.viaDefs||[]).find(d=>d.name===via.item.padstack);
          if(!(board.viaAtSmd&&def?.attachAllowed!==false)&&distanceShapes(p.shape,q.shape)<=EPS)violation('via_in_pad',`a:${via.uid}:${pad.uid}`,{via:via.index,pad:pad.id,net:via.net,layer:p.layer});
        }
      }
    }
    for(const [index,t] of (board.traces||[]).entries()){
      const net=nets.get(netKey(t.net));
      if(net&&t.width+EPS<net.width)widthDeviations.push({index,net:t.net,layer:t.layer,actual:t.width,required:net.width});
      if(net?.useLayers&&!net.useLayers.includes(t.layer)&&!isPermittedLayerEscape(board,t,net))violation('inactive_layer',`l:t:${index}`,{kind:'trace',index,layer:t.layer,net:t.net});
      if(!Number.isFinite(t.width)||t.width<=0||t.points.length<2||t.points.some(p=>p.length<2||!p.every(Number.isFinite)))violation('invalid_geometry',`i:t:${index}`,{kind:'trace',index});
    }
    for(const [index,v] of (board.vias||[]).entries()){
      const net=nets.get(netKey(v.net)),def=(board.viaDefs||[]).find(d=>d.name===v.padstack);
      if(!Number.isFinite(v.x)||!Number.isFinite(v.y)||!Number.isFinite(v.diameter??def?.diameter)||(v.diameter??def?.diameter)<=0)violation('invalid_geometry',`i:v:${index}`,{kind:'via',index});
      if(!def)violation('unknown_via',`u:v:${index}`,{index,padstack:v.padstack});
      else if(Math.abs((v.diameter??def.diameter)-def.diameter)>EPS)violation('via_size',`s:v:${index}`,{index,actual:v.diameter,required:def.diameter});
      if(def&&v.layers){const expected=Array.from({length:def.toLayer-def.fromLayer+1},(_,i)=>i+def.fromLayer);if(expected.length!==v.layers.length||expected.some(l=>!v.layers.includes(l)))violation('via_span',`p:v:${index}`,{index,actual:v.layers,required:expected});}
      if(net?.viaName&&v.padstack!==net.viaName)violation('via_rule',`r:v:${index}`,{index,padstack:v.padstack,required:net.viaName});
    }
    for(const [index,fill] of (board.copperFills||[]).entries()){
      const net=nets.get(netKey(fill.net));
      if(net?.useLayers&&!net.useLayers.includes(fill.layer))violation('inactive_layer',`l:f:${index}`,{kind:'fill',index,layer:fill.layer,net:fill.net});
      const rings=[fill.points,...(fill.holes||[])];
      if(rings.some(ring=>!Array.isArray(ring)||ring.length<3||ring.some(p=>!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1]))))violation('invalid_geometry',`i:f:${index}`,{kind:'fill',index});
    }
    const edges=boundaryEdges(board);
    let outlineCount=0;
    for(const p of primitives){
      if(observesActivity)activityAt(activity,p,null,++outlineCount,primitives.length,'Checking clearance from the board edge');
      if(!shapeInsideBoard(p.shape,board,edges,Math.max(board.edgeClearance||0,fillRule(p.object,'edgeClearance'))))violation('outline',`o:${p.object.uid}:${p.layer}`,{kind:p.object.kind,index:p.object.index,id:p.object.id,net:p.net,layer:p.layer});
      for(const [index,k] of (board.keepouts||[]).entries()){
        if(k.layers&&!k.layers.includes(p.layer)||k.kind==='via'&&p.object.kind!=='via')continue;
        if(observesActivity)activityAt(activity,p,{shape:k.shape,layer:p.layer},outlineCount,primitives.length,'Checking clearance from a keepout');
        const required=Math.max(k.clearance??netClearance(p.net),fillRule(p.object,'clearance')),actual=distanceShapes(p.shape,k.shape);
        if(actual+EPS<required||actual<=EPS)violation('keepout',`k:${p.object.uid}:${index}:${p.layer}`,{kind:p.object.kind,index:p.object.index,keepout:index,net:p.net,layer:p.layer,actual,required});
      }
    }
    const count=type=>violations.filter(v=>type.includes(v.type)).length;
    activityDone(activity);
    return {clearanceViolations:count(['clearance','short']),belowNominalWidthTraceCount:widthDeviations.length,
      viaInPadViolations:count(['via_in_pad']),outlineViolations:count(['outline']),keepoutViolations:count(['keepout']),
      totalViolations:violations.length+widthDeviations.length,violations,widthDeviations};
  }
  function stats(board,validation=validate(board),connections=connectivity(board)) {
    let traceLength=0;for(const t of board.traces||[])for(let i=1;i<t.points.length;i++)traceLength+=distance(t.points[i-1],t.points[i]);
    return {unrouted:connections.unrouted,viaCount:(board.vias||[]).length,traceCount:(board.traces||[]).length,
      traceLengthMm:traceLength*(board.units?.mmPerUnit??1),clearanceViolations:validation.clearanceViolations,drcChecked:true,
      belowNominalWidthTraceCount:validation.belowNominalWidthTraceCount,widthRulesChecked:true,
      totalViolations:validation.totalViolations,viaInPadViolations:validation.viaInPadViolations,outlineViolations:validation.outlineViolations,keepoutViolations:validation.keepoutViolations,
      copperZoneCount:(board.copperZones||[]).length,copperFillCount:(board.copperFills||[]).length,
      netCount:(board.nets||[]).length,componentCount:new Set((board.pads||[]).map(p=>p.component)).size,layerCount:(board.layers||[]).length};
  }
  return {EPS,distance,distancePointSegment,pointInPolygon,pointInShape,pointInBoard,pointOnSegment,segmentIntersection,closestPointOnSegment,
    closestSegmentPoints,distanceSegments,closestShapePoints,distanceShapes,distancePointShape,distanceSegmentShape,nearestPointOnShape,
    shapeBounds,boxesOverlap,spatialIndex,unionFind,copper,connectivity,boundaryEdges,shapeInsideBoard,clearance,padEscapeLimit,isPermittedLayerEscape,validate,stats};
}
globalThis.createRamenGeometry=createRamenGeometry;
if(typeof module!=='undefined'&&module.exports)module.exports={createRamenGeometry};
