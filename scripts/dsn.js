/* RamenRouter native DSN/SES interchange. No Java, dependencies, or network access. */
function createRamenDSN() {
  'use strict';
  const isList = Array.isArray;
  const tag = x => isList(x) && typeof x[0] === 'string' ? x[0].toLowerCase() : '';
  const children = (x, name) => (x || []).filter(y => isList(y) && (!name || tag(y) === name));
  const first = (x, name) => children(x, name)[0];
  const atoms = x => x.filter(y => !isList(y));
  const fail = message => { throw new Error('DSN import: ' + message); };
  const n = (value, what = 'coordinate') => {
    if (typeof value !== 'string' && typeof value !== 'number') fail('Missing ' + what + '.');
    const v = Number(value);
    if (!Number.isFinite(v) || Math.abs(v) > 1e12) fail('Invalid ' + what + ': ' + value);
    return v;
  };
  const positive = (value, what) => { const v = n(value, what); if (v <= 0) fail(what + ' must be positive.'); return v; };
  const clone = x => JSON.parse(JSON.stringify(x));
  const clean = v => Math.abs(v) < 1e-10 ? 0 : v;
  function routingRulesRead(text) {
    // Only comments before the first DSN token may contain our optional
    // metadata. Never scan quoted names or comments inside the design.
    let i=0, rules=null;
    while(i<text.length) {
      if(/\s/.test(text[i])) {i++;continue;}
      if(text[i]!==';'&&!(text[i]==='#'&&(i===0||text[i-1]==='\n')))break;
      const start=++i;
      while(i<text.length&&text[i]!=='\n')i++;
      const comment=text.slice(start,i).trim();
      if(!comment.startsWith('RamenRouter routing rules'))continue;
      if(rules!==null)fail('Duplicate RamenRouter routing rules metadata.');
      const version=comment.startsWith('RamenRouter routing rules v1:')?1:comment.startsWith('RamenRouter routing rules v2:')?2:0;
      if(!version)fail('Unsupported RamenRouter routing rules metadata version.');
      const prefix='RamenRouter routing rules v'+version+':';
      try {rules=JSON.parse(comment.slice(prefix.length));}
      catch(_) {fail('Malformed RamenRouter routing rules metadata.');}
      const keys=version===1?['shorterNets']:['shorterNets','padEscapeNets'];
      if(!rules||typeof rules!=='object'||Array.isArray(rules)||Object.keys(rules).length!==keys.length||
        keys.some(key=>!Object.prototype.hasOwnProperty.call(rules,key)||!Array.isArray(rules[key])||rules[key].some(name=>typeof name!=='string')||new Set(rules[key]).size!==rules[key].length))
        fail(version===1?'Invalid RamenRouter routing rules metadata; shorterNets must contain unique net names.':'Invalid RamenRouter routing rules metadata; net lists must contain unique net names.');
    }
    return rules;
  }
  function routingRulesWrite(nets) {
    const shorterNets=nets.filter(net=>net.preferShort===true).map(net=>net.name);
    return shorterNets.length?'; RamenRouter routing rules v1: '+JSON.stringify({shorterNets})+'\n':'';
  }
  const copperPrefix = 'RamenRouter copper fills v1:';
  const copperDimensions=['clearance','edgeClearance','thermalGap','spokeWidth','gridPitch','gridWidth'];
  const copperUnitScales={mm:1,mil:0.0254,inch:25.4,um:0.001,cm:10};
  const copperAssociationValid=value=>value===null||(typeof value==='string'&&value.length>0&&value.length<=100)||(Array.isArray(value)&&value.length>0&&value.length<=64&&new Set(value).size===value.length&&value.every(id=>typeof id==='string'&&id.length>0&&id.length<=100));
  function copperMetadataRead(text) {
    let i=0, metadata=null;
    while(i<text.length) {
      if(/\s/.test(text[i])){i++;continue;}
      if(text[i]!==';'&&!(text[i]==='#'&&(i===0||text[i-1]==='\n')))break;
      const start=++i;while(i<text.length&&text[i]!=='\n')i++;
      const comment=text.slice(start,i).trim();
      if(!comment.startsWith('RamenRouter copper fills'))continue;
      if(metadata!==null)fail('Duplicate RamenRouter copper fills metadata.');
      if(!comment.startsWith(copperPrefix))fail('Unsupported RamenRouter copper fills metadata version.');
      if(comment.length>2*1024*1024)fail('Copper fills metadata exceeds 2 MiB.');
      try{metadata=JSON.parse(comment.slice(copperPrefix.length));}catch(_){fail('Malformed RamenRouter copper fills metadata.');}
      if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)||Object.keys(metadata).length!==2||!Array.isArray(metadata.zones)||!Array.isArray(metadata.fillZones)||metadata.zones.length>64||metadata.fillZones.length>100000||metadata.fillZones.some(value=>!copperAssociationValid(value)))fail('Invalid RamenRouter copper fills metadata.');
    }
    return metadata;
  }
  function copperZonesValidate(board, zones, named=false) {
    if(!Array.isArray(zones)||zones.length>64)fail('Copper zones must be a list of at most 64 zones.');
    const ids=new Set(), netByName=new Map(board.nets.map(net=>[net.name,net.id])), layerByName=new Map(board.layers.map(layer=>[layer.name,layer.index]));
    const fields=['id','name','net','layer','points','cutouts','style','keepIslands','padConnection','clearance','edgeClearance','thermalGap','spokeWidth','gridPitch','gridWidth','enabled'];
    let total=0;
    const contour=(values,what)=>{
      if(!Array.isArray(values)||values.length>2048||values.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e9)))fail('Invalid '+what+' coordinates.');
      if((total+=values.length)>100000)fail('Copper zones have more than 100,000 corners.');
      return polygon(values.map(p=>p.slice()),what);
    };
    return zones.map(zone=>{
      if(!zone||typeof zone!=='object'||Array.isArray(zone)||Object.keys(zone).some(key=>!fields.includes(key)))fail('Invalid copper zone fields.');
      if(typeof zone.id!=='string'||!zone.id||zone.id.length>100||ids.has(zone.id))fail('Copper zone IDs must be unique nonempty strings.');
      ids.add(zone.id);
      const net=named?netByName.get(zone.net):zone.net,layer=named?layerByName.get(zone.layer):zone.layer;
      if(!Number.isInteger(net)||!board.nets.some(item=>item.id===net)||!Number.isInteger(layer)||!board.layers.some(item=>item.index===layer))fail('Copper zone '+zone.id+' needs a known net and layer.');
      const netInfo=board.nets.find(item=>item.id===net),name=zone.name===undefined?zone.id:zone.name;
      if(typeof name!=='string'||name.length>100)fail('Invalid copper zone name.');
      const style=zone.style===undefined?'solid':zone.style,padConnection=zone.padConnection===undefined?'spoke':zone.padConnection;
      if(!['solid','grid45','grid90'].includes(style)||!['direct','spoke'].includes(padConnection))fail('Unsupported copper fill or pad connection style.');
      for(const key of ['enabled','keepIslands'])if(zone[key]!==undefined&&typeof zone[key]!=='boolean')fail('Copper zone '+key+' must be true or false.');
      if(zone.cutouts!==undefined&&(!Array.isArray(zone.cutouts)||zone.cutouts.length>64))fail('Invalid copper zone cutout list.');
      const out={id:zone.id,name,net,layer,points:contour(zone.points,'copper zone'),cutouts:(zone.cutouts||[]).map(poly=>contour(poly,'copper cutout')),style,keepIslands:zone.keepIslands===true,padConnection,enabled:zone.enabled!==false};
      const scale=board.units?.mmPerUnit||1,minimumWidth=Math.max(netInfo.width||0,0.25/scale),clearance=Math.max(board.defaultClearance||0,netInfo.clearance||0);
      const defaults={clearance,edgeClearance:Math.max(board.edgeClearance||0,board.defaultClearance||0),thermalGap:clearance,spokeWidth:minimumWidth,gridPitch:Math.max((zone.gridWidth===undefined?minimumWidth:zone.gridWidth)*4,1/scale),gridWidth:minimumWidth};
      for(const key of Object.keys(defaults)){
        const value=zone[key]===undefined?defaults[key]:zone[key];
        if(typeof value!=='number'||!Number.isFinite(value)||value<0||Math.abs(value)>1e9||(['spokeWidth','gridPitch','gridWidth'].includes(key)&&value<=0))fail('Invalid copper zone '+key+'.');
        out[key]=value;
      }
      if(out.gridWidth>out.gridPitch)fail('Copper grid width cannot exceed its pitch.');
      return out;
    });
  }
  function copperMetadataWrite(board) {
    const zones=copperZonesValidate(board,board.copperZones||[]),fills=(board.copperFills||[]).filter(fill=>!fill._dsnPlane);
    if(!zones.length)return '';
    const netNames=new Map(board.nets.map(net=>[net.id,net.name])),layerNames=new Map(board.layers.map(layer=>[layer.index,layer.name])),ids=new Set(zones.map(zone=>zone.id));
    const association=fill=>{
      if(fill.imported===true)return null;
      const regionIds=fill.zoneIds?.length?fill.zoneIds:fill.zoneId?[fill.zoneId]:[];
      if(!copperAssociationValid(regionIds.length?regionIds:null))fail('Invalid copper fill zone associations.');
      if(regionIds.some(id=>!ids.has(id))){if(fill.imported===true)return null;fail('Copper fill references an unknown zone.');}
      return regionIds.length>1?regionIds:regionIds[0]||null;
    };
    const metadata={zones:zones.map(zone=>({...zone,net:netNames.get(zone.net),layer:layerNames.get(zone.layer)})),fillZones:fills.map(association)};
    const text=JSON.stringify(metadata);if(text.length>2*1024*1024)fail('Copper fills metadata exceeds 2 MiB.');
    return '; '+copperPrefix+' '+text+'\n';
  }
  function boardMetadataWrite(board,nets=board.nets){return routingRulesWrite(nets)+copperMetadataWrite(board);}
  function astRead(text) {
    if (typeof text !== 'string' || !text.trim()) fail('The file is empty.');
    if (text.length > 64 * 1024 * 1024) fail('The file exceeds 64 MiB.');
    let i = 0, tokenCount = 0;
    const root = [], stack = [root];
    while (i < text.length) {
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === ';' || (c === '#' && (i === 0 || text[i - 1] === '\n'))) {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (c === '(') {
        if (stack.length >= 256) fail('Excessive nesting.');
        const node = []; stack[stack.length - 1].push(node); stack.push(node); i++; continue;
      }
      if (c === ')') {
        if (stack.length === 1) fail('Unexpected closing parenthesis near character ' + i + '.');
        stack.pop(); i++; continue;
      }
      let value = '';
      if (c === '"') {
        const current = stack[stack.length - 1];
        if (current.length === 1 && tag(current) === 'string_quote') { value = '"'; i++; }
        else {
          i++; let closed = false;
          while (i < text.length) {
            const q = text[i++];
            if (q === '\\' && i < text.length && (text[i] === '"' || text[i] === '\\')) value += text[i++];
            else if (q === '"') { closed = true; break; }
            else value += q;
          }
          if (!closed) fail('Unterminated quoted identifier.');
        }
      } else {
        const start = i;
        while (i < text.length && !/[\s()]/.test(text[i])) i++;
        value = text.slice(start, i);
      }
      stack[stack.length - 1].push(value);
      if (++tokenCount > 3000000) fail('The design contains too many tokens.');
    }
    if (stack.length !== 1) fail('Missing closing parenthesis.');
    if (root.length !== 1 || tag(root[0]) !== 'pcb') fail('Expected one (pcb ...) design.');
    return root[0];
  }
  function allowed(node, names, context) {
    for (const child of children(node)) if (!names.includes(tag(child)))
      fail('Unsupported ' + tag(child) + ' constraint in ' + context + '. Export a simpler Specctra DSN; this constraint was not ignored.');
  }
  function points(values, what) {
    if (values.length < 4 || values.length % 2) fail('Invalid coordinate list in ' + what + '.');
    const out = [];
    for (let i = 0; i < values.length; i += 2) out.push([n(values[i]), n(values[i + 1])]);
    return out;
  }
  function polygon(pts, context) {
    if (pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1e-10) pts = pts.slice(0, -1);
    if (pts.length < 3) fail(context + ' requires at least three corners.');
    if (pts.length > 10000) fail(context + ' has more than 10,000 corners.');
    let area = 0;
    for (let i=0;i<pts.length;i++) { const a=pts[i],b=pts[(i+1)%pts.length]; area+=a[0]*b[1]-a[1]*b[0]; }
    if (Math.abs(area) < 1e-16) fail(context + ' has zero area.');
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    for(let i=0;i<pts.length;i++) for(let j=i+2;j<pts.length;j++) {
      if(i===0&&j===pts.length-1)continue;
      const a=pts[i],b=pts[(i+1)%pts.length],c=pts[j],d=pts[(j+1)%pts.length];
      if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)fail(context+' is self-intersecting.');
    }
    return pts;
  }
  function rotation(point, degrees) {
    const angle = degrees * Math.PI / 180, co = Math.cos(angle), si = Math.sin(angle);
    return [clean(point[0] * co - point[1] * si), clean(point[0] * si + point[1] * co)];
  }
  function hull(pts) {
    const a = pts.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const lo = [], hi = [];
    for (const p of a) { while (lo.length > 1 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
    for (const p of a.slice().reverse()) { while (hi.length > 1 && cross(hi.at(-2), hi.at(-1), p) <= 0) hi.pop(); hi.push(p); }
    lo.pop(); hi.pop(); return lo.concat(hi);
  }
  function capsule(a, b, radius) {
    // Circumscribed approximation: this never shrinks an imported pad or keepout.
    const pts = [], sides = 32, r = radius / Math.cos(Math.PI / sides);
    for (const p of [a, b]) for (let k = 0; k < sides; k++) {
      const angle = 2 * Math.PI * k / sides;
      pts.push([p[0] + r * Math.cos(angle), p[1] + r * Math.sin(angle)]);
    }
    return hull(pts);
  }
  function inside(p, poly) {
    let yes = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
    }
    return yes;
  }
  function parse(text, filename = 'board.dsn', options = {}) {
    const ast = astRead(text);
    const routingRules = routingRulesRead(text), copperMetadata=copperMetadataRead(text);
    allowed(ast, ['parser','resolution','unit','structure','placement','library','network','wiring'], 'the design');
    const parser = first(ast, 'parser'), quote = first(parser, 'string_quote');
    if (quote && quote[1] !== '"') fail('Only the standard double-quote delimiter is supported.');
    const structure = first(ast, 'structure'), library = first(ast, 'library'), network = first(ast, 'network');
    if (!structure || !library || !network) fail('The structure, library, and network sections are required.');
    allowed(structure, ['layer','boundary','via','rule','layer_rule','control','grid','keepout','via_keepout','place_keepout','snap_angle','plane'], 'structure');
    allowed(library, ['image','padstack'], 'library');
    allowed(network, ['net','class','via','via_rule'], 'network');
    const snapAngle=first(structure,'snap_angle');
    if(snapAngle&&!['fortyfive_degree','none'].includes(snapAngle[1]))fail('Unsupported snap-angle constraint '+snapAngle[1]+'.');
    const res = first(ast, 'resolution'), unitNode = first(ast, 'unit');
    const unitName = String(unitNode ? unitNode[1] : res ? res[1] : 'mil').toLowerCase();
    const scales = { mm: 1, mil: 0.0254, inch: 25.4, um: 0.001, cm: 10 };
    if (!(unitName in scales)) fail('Unsupported unit ' + unitName + '.');
    if (res && String(res[1]).toLowerCase() !== unitName) fail('Different unit and resolution units are not supported.');
    const board = {
      name: ast[1] && ast[1] !== "''" ? ast[1] : filename, filename, originalText: text,
      units: { name: unitName, resolution: res ? positive(res[2], 'resolution') : 1000, mmPerUnit: scales[unitName] },
      layers: [], nets: [], pads: [], viaDefs: [], vias: [], traces: [], outlines: [], holes: [], keepouts: [],
      viaAtSmd: false, warnings: [], grids: {}, _ast: ast, copperZones: [], copperFills: []
    };
    for (const layer of children(structure, 'layer')) {
      allowed(layer, ['type','property'], 'layer ' + layer[1]);
      const type = first(layer, 'type');
      if (!type || tag(type) !== 'type' || String(type[1]).toLowerCase() !== 'signal') fail('Non-signal copper/plane layers require plane-aware routing and are not supported.');
      if (board.layers.some(x => x.name === layer[1])) fail('Duplicate layer ' + layer[1] + '.');
      board.layers.push({ name: layer[1], index: board.layers.length, type: 'signal' });
    }
    if (!board.layers.length) fail('No signal layers were found.');
    const layerIndex = new Map(board.layers.map(l => [l.name, l.index]));
    const everyLayer = board.layers.map(l => l.index);
    function layerNumbers(name, boundary = false) {
      if (name === 'signal' || name === 'all' || (boundary && name === 'pcb')) return everyLayer.slice();
      if (!layerIndex.has(name)) fail('Unknown or unsupported layer ' + name + '.');
      return [layerIndex.get(name)];
    }
    function shapeRead(node, boundary = false) {
      const kind = tag(node), values = atoms(node);
      if (!['circle','rect','polygon','path'].includes(kind)) fail('Unsupported shape ' + kind + '.');
      if (children(node).length) fail('Nested constraints in ' + kind + ' geometry are not supported.');
      const layers = layerNumbers(values[1], boundary), out = [];
      if (kind === 'circle') {
        if (![3,5].includes(values.length)) fail('Malformed circle.');
        const r = positive(values[2], 'circle diameter') / 2, cx = values.length > 3 ? n(values[3]) : 0, cy = values.length > 4 ? n(values[4]) : 0;
        for (const layer of layers) out.push({ layer, type: 'circle', cx, cy, r });
      } else if (kind === 'rect') {
        if (values.length !== 6) fail('Malformed rectangle.');
        const x1 = n(values[2]), y1 = n(values[3]), x2 = n(values[4]), y2 = n(values[5]);
        if (x1 === x2 || y1 === y2) fail('Zero-area rectangle.');
        for (const layer of layers) out.push({ layer, type: 'polygon', points: [[x1,y1],[x2,y1],[x2,y2],[x1,y2]] });
      } else {
        const width = n(values[2], kind + ' width');
        if (width < 0) fail('Negative shape width.');
        const pts = points(values.slice(3), kind);
        if (kind === 'polygon' || (boundary && width === 0)) {
          const poly = polygon(pts, kind);
          for (const layer of layers) out.push({ layer, type: 'polygon', points: poly });
        } else {
          if (width <= 0) fail('A pad/keepout path must have positive width.');
          if (!board.warnings.includes('Rounded path pads/keepouts use conservative 32-segment capsule outlines.')) board.warnings.push('Rounded path pads/keepouts use conservative 32-segment capsule outlines.');
          for (const layer of layers) for (let i = 1; i < pts.length; i++) out.push({ layer, type: 'polygon', points: capsule(pts[i - 1], pts[i], width / 2) });
        }
      }
      return out;
    }
    function contour(node) {
      if(tag(node)==='path'&&n(node[2],'boundary path width')!==0)fail('A boundary path must have zero stroke width; export its polygonal contour.');
      const shapes = shapeRead(node, true), s = shapes[0];
      if (s.type !== 'polygon') fail('Curved board outlines/holes are not supported; export a polygonal outline.');
      return s.points;
    }
    const contours = [];
    for (const boundary of children(structure, 'boundary')) {
      allowed(boundary, ['path','polygon','rect','window'], 'board boundary');
      for (const geometry of children(boundary).filter(x => tag(x) !== 'window')) contours.push(contour(geometry));
      for (const hole of children(boundary, 'window')) {
        if (children(hole).length !== 1) fail('A boundary hole needs one polygon.');
        board.holes.push(contour(children(hole)[0]));
      }
    }
    if (!contours.length) fail('No polygonal board outline was found.');
    for (const poly of contours) {
      const depth = contours.filter(other => other !== poly && inside(poly[0], other)).length;
      if(depth>1)fail('Nested islands inside board cutouts are not supported.');
      (depth % 2 ? board.holes : board.outlines).push(poly);
    }
    const allBoundaryPoints = board.outlines.flat();
    board.bounds = { minX: Math.min(...allBoundaryPoints.map(p => p[0])), minY: Math.min(...allBoundaryPoints.map(p => p[1])), maxX: Math.max(...allBoundaryPoints.map(p => p[0])), maxY: Math.max(...allBoundaryPoints.map(p => p[1])) };
    if (!(board.bounds.maxX > board.bounds.minX && board.bounds.maxY > board.bounds.minY)) fail('The board outline has no area.');
    const padstacks = new Map();
    for (const p of children(library, 'padstack')) {
      allowed(p, ['shape','attach','absolute'], 'padstack ' + p[1]);
      if (padstacks.has(p[1])) fail('Duplicate padstack ' + p[1] + '.');
      const shapes = [];
      for (const wrapper of children(p, 'shape')) {
        const values = children(wrapper);
        if (values.length !== 1) fail('Padstack ' + p[1] + ' has an unsupported shape scope.');
        shapes.push(...shapeRead(values[0]));
      }
      if (!shapes.length) fail('Empty padstack ' + p[1] + '.');
      padstacks.set(p[1], { name: p[1], shapes, attachAllowed: String(first(p,'attach')?.[1] || 'on').toLowerCase() !== 'off', absolute: String(first(p,'absolute')?.[1] || 'off').toLowerCase() === 'on' });
    }
    let defaultWidth = null, defaultClearance = 0;
    const globalRules = children(structure, 'rule');
    function readRules(ruleScopes, width, clearance, context) {
      for (const rules of ruleScopes) for (const rule of children(rules)) {
        if (tag(rule) === 'width') width = positive(rule[1], context + ' width');
        else if (tag(rule) === 'clearance' || tag(rule) === 'clear') {
          const value = n(rule[1], context + ' clearance');
          if (value < 0) fail('Negative clearance.');
          const type = first(rule, 'type');
          if (type) {
            const names = atoms(type).slice(1).map(String);
            if (names.includes('smd_to_turn_gap')) { board.warnings.push('The smd_to_turn_gap routing preference is retained in DSN export.'); continue; }
            if (value !== clearance || names.some(x => !['default_smd','smd_smd','wire_smd','smd_wire','wire_wire','default','smd','wire'].includes(x)))
              fail('Pair-specific clearance rule ' + names.join(' ') + ' is not supported.');
          } else clearance = value;
        } else fail('Unsupported ' + tag(rule) + ' routing rule in ' + context + '.');
      }
      return { width, clearance };
    }
    ({ width: defaultWidth, clearance: defaultClearance } = readRules(globalRules, defaultWidth, defaultClearance, 'default'));
    if (children(structure,'layer_rule').length) fail('Layer-specific width/clearance rules are not supported.');
    board.defaultWidth = defaultWidth; board.defaultClearance = defaultClearance;
    // A Specctra class rule sets that class's matrix diagonal. It must not
    // lower clearances to another class below the inherited default matrix.
    board.clearanceMode = 'specctra-class-matrix';
    board.structureClearance = defaultClearance;
    const classClearances = new Map([['default', defaultClearance]]);
    for (const grid of children(structure,'grid')) {
      if (!['wire','via','place'].includes(grid[1])) fail('Unsupported grid ' + grid[1] + '.');
      board.grids[grid[1]] = positive(grid[2], 'grid spacing');
    }
    const control = first(structure,'control');
    if (control) {
      allowed(control,['via_at_smd'],'structure control');
      board.viaAtSmd = String(first(control,'via_at_smd')?.[1] || 'off').toLowerCase() === 'on';
    }
    const viaNames = children(structure,'via').flatMap(v => atoms(v).slice(1));
    for (const name of [...new Set(viaNames)]) {
      const p = padstacks.get(name); if (!p) fail('Unknown via padstack ' + name + '.');
      if (p.shapes.some(s => s.type !== 'circle' || Math.hypot(s.cx,s.cy) > 1e-9)) fail('Via ' + name + ' needs concentric circular pads.');
      const diameters = p.shapes.map(s => s.r * 2), layers = [...new Set(p.shapes.map(s => s.layer))].sort((a,b) => a-b);
      if (Math.max(...diameters) - Math.min(...diameters) > 1e-9) fail('Via ' + name + ' has layer-dependent pad diameters.');
      if (layers.some((v,i) => v !== layers[0] + i)) fail('Via ' + name + ' spans non-contiguous copper layers.');
      board.viaDefs.push({ name, diameter: diameters[0], fromLayer: layers[0], toLayer: layers.at(-1), attachAllowed: p.attachAllowed });
    }
    const viaInfos = new Map(), viaAttachment = new Map();
    for (const v of children(network,'via')) {
      const a = atoms(v); if (a.length < 3) fail('Malformed via rule.');
      if (a.length > 3 && a[3] !== 'default') fail('Named via clearance classes are not supported.');
      if(a.length>5||(a.length===5&&a[4]!=='attach'))fail('Unsupported via rule modifiers.');
      viaInfos.set(a[1], a[2]);
      const attach=a.slice(3).includes('attach');
      if(viaAttachment.has(a[2])&&viaAttachment.get(a[2])!==attach)fail('Different per-net attachment permissions for via '+a[2]+' are not supported.');
      viaAttachment.set(a[2],attach);
    }
    for(const def of board.viaDefs)if(viaAttachment.has(def.name))def.attachAllowed=def.attachAllowed&&viaAttachment.get(def.name);
    const viaRules = new Map(children(network,'via_rule').map(v => [v[1], atoms(v).slice(2).map(x => viaInfos.get(x) || x)]));
    const netByName = new Map(), netByPin = new Map(), netLayerOverrides = new Map();
    for (const net of children(network,'net')) {
      allowed(net,['pins','circuit'],'net ' + net[1]);
      if (netByName.has(net[1])) fail('Duplicate/subnet net name ' + net[1] + ' is not supported.');
      const circuits = children(net,'circuit');
      if (circuits.length > 1) fail('Multiple circuit constraints for net ' + net[1] + '.');
      if (circuits.length) {
        allowed(circuits[0],['use_layer'],'net circuit ' + net[1]);
        const settings = children(circuits[0],'use_layer');
        if (settings.length > 1) fail('Multiple use_layer constraints for net ' + net[1] + '.');
        if (settings.length) {
          if (children(settings[0]).length) fail('Nested use_layer constraints for net ' + net[1] + ' are not supported.');
          const activeLayers = [...new Set(atoms(settings[0]).slice(1).flatMap(x => layerNumbers(x)))];
          if (!activeLayers.length) fail('Net ' + net[1] + ' has no active routing layers.');
          netLayerOverrides.set(net[1],activeLayers);
        }
      }
      const names = children(net,'pins').flatMap(p => atoms(p).slice(1));
      const item = { id: board.nets.length + 1, name: net[1], pins: names, width: defaultWidth, clearance: defaultClearance, className: 'default', clearanceClass: 'default', viaName: viaNames[0] || null, useLayers: everyLayer.slice(), preferShort: false };
      board.nets.push(item); netByName.set(item.name,item);
      for (const pin of names) {
        if (netByPin.has(pin) && netByPin.get(pin) !== item.id) fail('Pin ' + pin + ' belongs to multiple nets.');
        netByPin.set(pin,item.id);
      }
    }
    for(const name of routingRules?.shorterNets||[]) {
      const net=netByName.get(name);
      if(!net)fail('Unknown net '+name+' in RamenRouter routing rules metadata.');
      net.preferShort=true;
    }
    // Older v2 files named nets with optional pad access. Validate that legacy
    // metadata, then discard it: selected layers now always include local access.
    for(const name of routingRules?.padEscapeNets||[])if(!netByName.has(name))fail('Unknown net '+name+' in RamenRouter routing rules metadata.');
    const assigned = new Set();
    const classes=children(network,'class'), defaults=classes.filter(c=>c[1]==='default');
    if(defaults.length>1)fail('Duplicate default net class.');
    if(new Set(classes.map(c=>c[1])).size!==classes.length)fail('Duplicate net class names are not supported.');
    for (const cls of defaults.concat(classes.filter(c=>c[1]!=='default'))) {
      allowed(cls,['rule','circuit','via_rule','clearance_class','pull_tight','shove_fixed'],'net class ' + cls[1]);
      if (first(cls,'clearance_class') && first(cls,'clearance_class')[1] !== 'default') fail('Named clearance matrices are not supported; export net-class clearance values.');
      if(String(first(cls,'shove_fixed')?.[1]||'off').toLowerCase()==='on')fail('The shove_fixed net-class constraint is not supported.');
      if(String(first(cls,'pull_tight')?.[1]||'on').toLowerCase()==='off')fail('The pull_tight off net-class constraint is not supported.');
      const circuit = first(cls,'circuit'); if (circuit) allowed(circuit,['use_via','use_layer'],'net class circuit ' + cls[1]);
      const rules = readRules(children(cls,'rule'),defaultWidth,defaultClearance,'net class ' + cls[1]);
      const hasClearanceRule = children(cls,'rule').some(scope=>children(scope).some(rule=>['clear','clearance'].includes(tag(rule))));
      const clearanceClass = hasClearanceRule ? cls[1] : 'default';
      if(hasClearanceRule)classClearances.set(clearanceClass,rules.clearance);
      const directVias = first(circuit,'use_via'), ruleName = first(cls,'via_rule');
      const choices = directVias ? atoms(directVias).slice(1) : ruleName ? viaRules.get(ruleName[1]) : viaNames;
      if (ruleName && !choices) fail('Unknown via rule ' + ruleName[1] + '.');
      if (choices && choices.some(v => !board.viaDefs.some(d => d.name === v))) fail('Unknown via in net class ' + cls[1] + '.');
      const active = first(circuit,'use_layer'), activeLayers = active ? atoms(active).slice(1).flatMap(x => layerNumbers(x)) : everyLayer.slice();
      if (!activeLayers.length) fail('Net class ' + cls[1] + ' has no active routing layers.');
      const names = atoms(cls).slice(2);
      if(cls[1]==='default') {
        defaultWidth=rules.width;defaultClearance=rules.clearance;
        board.defaultWidth=defaultWidth;board.defaultClearance=defaultClearance;
        classClearances.set('default',defaultClearance);
        if(defaultClearance!==board.structureClearance && globalRules.some(scope=>children(scope).some(rule=>['clear','clearance'].includes(tag(rule))&&first(rule,'type'))))
          fail('Default-class clearance overrides combined with item-type clearance rules are not supported.');
        for(const net of board.nets)Object.assign(net,rules,{viaName:choices?.[0]||null,useLayers:[...new Set(activeLayers)]});
      }
      for (const name of names) {
        const net = netByName.get(name); if (!net) fail('Unknown net ' + name + ' in class ' + cls[1] + '.');
        if (assigned.has(name)) fail('Multiple classes for net ' + name + '.');
        assigned.add(name);
        Object.assign(net,rules,{ className: cls[1], clearanceClass, viaName: choices?.[0] || null, useLayers: [...new Set(activeLayers)] });
      }
    }
    // Specctra circuit rules on a net override the class's routing layers.
    // Keep the original class membership: splitting classes changes clearance
    // relationships even when their numeric rules initially look identical.
    for (const net of board.nets) if (netLayerOverrides.has(net.name)) net.useLayers = netLayerOverrides.get(net.name);
    board.crossClassClearance=defaultClearance;
    board.classClearances=Object.fromEntries(classClearances);
    // The board outline belongs to the default clearance class. The geometry
    // planner accepts one outline margin, so use the largest class-to-default
    // requirement rather than ever relaxing a class's copper-to-edge rule.
    board.edgeClearance=Math.max(defaultClearance,...classClearances.values());
    for(const net of board.nets) {
      // Conservative planning allowance; validation uses the exact pair matrix.
      net.routingClearance=Math.max(defaultClearance,net.clearance,...board.nets.filter(other=>other.id!==net.id).map(other=>
        other.clearanceClass===net.clearanceClass ? net.clearance : Math.max(defaultClearance,net.clearance,other.clearance)));
    }
    for (const net of board.nets) if (!(net.width > 0)) fail('No positive trace width was specified for net ' + net.name + '.');
    const placement = first(ast,'placement');
    if (!placement) fail('No component placement was found.');
    allowed(placement,['component','place_control'],'placement');
    const placeControl = first(placement,'place_control');
    if (placeControl) allowed(placeControl,['flip_style'],'placement control');
    const flipStyle = String(first(placeControl,'flip_style')?.[1] || 'mirror_first');
    if (!['mirror_first','rotate_first'].includes(flipStyle)) fail('Unknown component flip style ' + flipStyle + '.');
    const images = new Map();
    for(const image of children(library,'image')) {
      if(images.has(image[1]))fail('Duplicate image '+image[1]+'.');
      images.set(image[1],image);
    }
    const pinIds = new Set();
    function transform(point, place, pinOffset = [0,0], pinRotation = 0) {
      let p = rotation(point,pinRotation); p = [p[0]+pinOffset[0],p[1]+pinOffset[1]];
      if (place.back && flipStyle === 'mirror_first') p[0] = -p[0];
      p = rotation(p,place.rotation);
      if (place.back && flipStyle === 'rotate_first') p[0] = -p[0];
      return [clean(p[0]+place.x),clean(p[1]+place.y)];
    }
    function transformedShape(s, place, offset, angle, absolute = false) {
      const layer = place.back && !absolute ? board.layers.length - 1 - s.layer : s.layer;
      if (s.type === 'circle') { const c = transform([s.cx,s.cy],place,offset,angle); return { layer,type:'circle',cx:c[0],cy:c[1],r:s.r }; }
      return { layer,type:'polygon',points:s.points.map(p => transform(p,place,offset,angle)) };
    }
    function keepouts(node, place = null) {
      for (const child of children(node).filter(c => ['keepout','via_keepout'].includes(tag(c)))) {
        allowed(child,['rect','circle','polygon','path'],'keepout');
        const shapes = children(child).flatMap(s => shapeRead(s));
        if (!shapes.length) fail('Empty keepout.');
        for (const s of shapes) {
          const shape = place ? transformedShape(s,place,[0,0],0) : s;
          board.keepouts.push({ layers:[shape.layer], shape, kind:tag(child)==='via_keepout'?'via':'all' });
        }
      }
    }
    keepouts(structure);
    for (const component of children(placement,'component')) {
      allowed(component,['place'],'component ' + component[1]);
      const image = images.get(component[1]); if (!image) fail('Unknown image ' + component[1] + '.');
      allowed(image,['pin','keepout','via_keepout','place_keepout','outline'],'image ' + image[1]);
      for (const p of children(component,'place')) {
        allowed(p,['lock_type'],'placement ' + p[1]);
        const a = atoms(p); if (a.length !== 6 || !['front','back'].includes(a[4])) fail('Malformed placement ' + a[1] + '.');
        const place = { name:a[1],x:n(a[2]),y:n(a[3]),back:a[4]==='back',rotation:n(a[5],'rotation') };
        for (const pin of children(image,'pin')) {
          allowed(pin,['rotate'],'pin in ' + image[1]);
          const v = atoms(pin); if (v.length !== 5) fail('Malformed pin in image ' + image[1] + '.');
          const ps = padstacks.get(v[1]); if (!ps) fail('Unknown padstack ' + v[1] + '.');
          const id = place.name + '-' + v[2]; if (pinIds.has(id)) fail('Duplicate pin ' + id + '.');
          pinIds.add(id);
          const offset = [n(v[3]),n(v[4])], angle = n(first(pin,'rotate')?.[1] || 0,'pin rotation'), center = transform([0,0],place,offset,angle);
          board.pads.push({ id,component:place.name,pin:v[2],net:netByPin.get(id) || null,x:center[0],y:center[1],shapes:ps.shapes.map(s => transformedShape(s,place,offset,angle,ps.absolute)) });
        }
        keepouts(image,place);
      }
    }
    for (const net of board.nets) for (const pin of net.pins) if (!pinIds.has(pin)) fail('Net ' + net.name + ' references missing pin ' + pin + '.');
    if(copperMetadata)board.copperZones=copperZonesValidate(board,copperMetadata.zones,true);
    const zoneById=new Map(board.copperZones.map(zone=>[zone.id,zone])), copperWireFills=[];
    function copperRegionRead(node,plane=false){
      if(atoms(node).length!==(plane?2:1)||(!plane&&['net','type','clearance_class'].some(key=>children(node,key).length>1)))fail('Malformed copper region scope.');
      const geometries=children(node).filter(child=>['polygon','rect'].includes(tag(child)));
      if(geometries.length!==1)fail('A copper region needs exactly one polygon or rectangle.');
      const geometry=geometries[0];
      if(tag(geometry)==='polygon'&&n(geometry[2],'copper polygon width')!==0)fail('Copper polygons must have zero stroke width.');
      const shape=shapeRead(geometry);if(shape.length!==1||shape[0].type!=='polygon')fail('A copper region needs one copper layer.');
      const netNode=plane?['net',atoms(node)[1]]:first(node,'net');
      if(!netNode||!netByName.has(netNode[1])||(netNode[2]&&netNode[2]!=='1'))fail('A copper region needs a known net without subnets.');
      const state=plane?'protect':String(first(node,'type')?.[1]||'route');
      if(!['normal','route','fix','protect'].includes(state))fail('Unknown copper fixed state '+state+'.');
      const holes=[];
      for(const window of children(node,'window')){
        const nodes=children(window);if(atoms(window).length!==1||nodes.length!==1||!['polygon','rect'].includes(tag(nodes[0])))fail('A copper window needs one polygon or rectangle.');
        if(tag(nodes[0])==='polygon'&&n(nodes[0][2],'copper window width')!==0)fail('Copper windows must have zero stroke width.');
        const hole=shapeRead(nodes[0]);if(hole.length!==1||hole[0].type!=='polygon'||hole[0].layer!==shape[0].layer)fail('A copper window must use its region layer.');
        holes.push(hole[0].points);
      }
      const fill={zoneId:null,net:netByName.get(netNode[1]).id,layer:shape[0].layer,points:shape[0].points,holes,fixed:true,imported:true,_dsnType:state};
      if(plane)fill._dsnPlane=true;else fill._dsnWire=clone(node);
      board.copperFills.push(fill);if(!plane)copperWireFills.push(fill);
    }
    for(const plane of children(structure,'plane')){allowed(plane,['polygon','rect','window'],'copper plane');copperRegionRead(plane,true);}
    const wiring = first(ast,'wiring');
    if (wiring) {
      allowed(wiring,['wire','via'],'wiring');
      for (const wire of children(wiring,'wire')) {
        allowed(wire,['path','polygon','rect','window','net','type','clearance_class'],'wire');
        if(first(wire,'polygon')||first(wire,'rect')){
          if(first(wire,'path'))fail('A wire cannot contain both a path and a copper polygon.');
          if(first(wire,'clearance_class')&&first(wire,'clearance_class')[1]!=='default')fail('Per-wire clearance classes are not supported.');
          copperRegionRead(wire);continue;
        }
        if(children(wire,'window').length)fail('A path wire cannot contain copper windows.');
        const p = first(wire,'path'), netNode = first(wire,'net');
        if (!p || !netNode || !netByName.has(netNode[1])) fail('A wire needs a supported path and a known net.');
        if(children(p).length)fail('Nested wire-path constraints are not supported.');
        if (netNode[2] && netNode[2] !== '1') fail('Multiple electrical subnets are not supported.');
        if (first(wire,'clearance_class') && first(wire,'clearance_class')[1] !== 'default') fail('Per-wire clearance classes are not supported.');
        const v = atoms(p), layers = layerNumbers(v[1]); if (layers.length !== 1) fail('A wire needs one copper layer.');
        const state = String(first(wire,'type')?.[1] || 'normal');
        if (!['normal','route','fix','protect'].includes(state)) fail('Unknown wire fixed state ' + state + '.');
        board.traces.push({ net:netByName.get(netNode[1]).id,layer:layers[0],width:positive(v[2],'trace width'),points:points(v.slice(3),'trace'),fixed:['fix','protect'].includes(state) });
      }
      for (const via of children(wiring,'via')) {
        allowed(via,['net','type','clearance_class'],'via');
        const v = atoms(via), netNode = first(via,'net'), def = board.viaDefs.find(d => d.name === v[1]);
        if (v.length !== 4 || !def || !netNode || !netByName.has(netNode[1])) fail('A via needs a known padstack, net, and position.');
        if(netNode[2]&&netNode[2]!=='1')fail('Multiple electrical subnets are not supported.');
        if (first(via,'clearance_class') && first(via,'clearance_class')[1] !== 'default') fail('Per-via clearance classes are not supported.');
        const state = String(first(via,'type')?.[1] || 'normal');
        if (!['normal','route','fix','protect'].includes(state)) fail('Unknown via fixed state ' + state + '.');
        board.vias.push({ x:n(v[2]),y:n(v[3]),padstack:def.name,net:netByName.get(netNode[1]).id,diameter:def.diameter,layers:everyLayer.filter(l=>l>=def.fromLayer&&l<=def.toLayer),fixed:['fix','protect'].includes(state) });
      }
    }
    if(copperMetadata){
      if(copperMetadata.fillZones.length!==copperWireFills.length)fail('Copper fill associations do not match the actual wiring polygons.');
      copperMetadata.fillZones.forEach((association,index)=>{
        if(association===null)return;const regionIds=Array.isArray(association)?association:[association],fill=copperWireFills[index];
        for(const id of regionIds){const zone=zoneById.get(id);if(!zone||zone.net!==fill.net||zone.layer!==fill.layer)fail('Copper fill association does not match its net and layer.');}
        fill.zoneId=regionIds[0];if(regionIds.length>1)fill.zoneIds=regionIds.slice();fill.imported=options?.inputCopper===true;if(!fill.imported){delete fill._dsnWire;delete fill._dsnType;}
      });
    }
    return board;
  }
  function atomWrite(value) {
    const s = String(value);
    if (s && !/[\s()"\\;]/.test(s)) return s;
    return '"' + s.replace(/\\/g,'\\\\').replace(/"/g,'\\"') + '"';
  }
  function astWrite(node, level = 0) {
    if (!isList(node)) return atomWrite(node);
    if (tag(node) === 'string_quote') return '(string_quote ")';
    if (!node.some(isList)) return '(' + node.map(atomWrite).join(' ') + ')';
    let out = '(';
    for (let i = 0; i < node.length; i++) {
      if (isList(node[i])) out += '\n' + '  '.repeat(level + 1) + astWrite(node[i],level + 1);
      else out += (i ? ' ' : '') + atomWrite(node[i]);
    }
    return out + '\n' + '  '.repeat(level) + ')';
  }
  function nativeNumber(v) {
    if (!Number.isFinite(v)) throw new Error('Cannot export non-finite geometry.');
    return String(clean(Number(v.toFixed(10))));
  }
  function clearRoutingDsn(board) {
    if (!board._ast) throw new Error('The original DSN syntax tree is required to clear routing safely.');
    // Work from the imported design rather than a routed board. In particular,
    // a previous run's via-in-pad override must not become a new input rule.
    const ast = clone(board._ast), index = ast.findIndex(x=>tag(x)==='wiring');
    const copperWiring=['wiring',...copperWiresWrite(board)];
    if (index < 0) ast.push(copperWiring);
    else {
      ast[index] = copperWiring;
      for (let i=ast.length-1;i>index;i--) if(tag(ast[i])==='wiring') ast.splice(i,1);
    }
    return boardMetadataWrite(board)+astWrite(ast)+'\n';
  }
  function setNetRoutingRules(board, changes) {
    if (!board._ast) throw new Error('The original DSN syntax tree is required to change routing rules safely.');
    if (!Array.isArray(changes)) throw new Error('Net routing rule changes must be a list.');
    const ast = clone(board._ast), network = first(ast,'network');
    if (!network) throw new Error('The original DSN network is missing.');
    const nets=board.nets.map(net=>({...net}));
    const netById = new Map(nets.map(net=>[net.id,net])), nodesByName = new Map(children(network,'net').map(net=>[net[1],net]));
    const layerNames = new Map(board.layers.map(layer=>[layer.index,layer.name])), seen = new Set();
    for (const change of changes) {
      const net = change && netById.get(change.netId);
      if (!net || !Number.isInteger(change.netId)) throw new Error('Unknown net in routing rule changes.');
      if (seen.has(net.id)) throw new Error('Duplicate routing rule changes for net ' + net.name + '.');
      seen.add(net.id);
      const hasLayers=Object.prototype.hasOwnProperty.call(change,'layers'),hasShort=Object.prototype.hasOwnProperty.call(change,'preferShort');
      if(!hasLayers&&!hasShort)throw new Error('Choose a routing rule to change for net '+net.name+'.');
      if(hasShort) {
        if(typeof change.preferShort!=='boolean')throw new Error('The shorter-route preference must be true or false.');
        net.preferShort=change.preferShort;
      }
      if(!hasLayers)continue;
      if (!Array.isArray(change.layers) || !change.layers.length) throw new Error('Choose at least one routing layer for net ' + net.name + '.');
      if (change.layers.some(layer=>!Number.isInteger(layer)||!layerNames.has(layer))) throw new Error('Unknown routing layer for net ' + net.name + '.');
      if(new Set(change.layers).size!==change.layers.length)throw new Error('An allowed layer cannot be listed twice.');
      if(net.useLayers?.length===change.layers.length&&net.useLayers.every(layer=>change.layers.includes(layer)))continue;
      const node = nodesByName.get(net.name);
      if (!node) throw new Error('The original DSN is missing net ' + net.name + '.');
      let circuit = first(node,'circuit');
      if (!circuit) { circuit = ['circuit']; node.push(circuit); }
      const layerRule = ['use_layer',...[...new Set(change.layers)].sort((a,b)=>a-b).map(layer=>layerNames.get(layer))];
      const index = circuit.findIndex(child=>tag(child)==='use_layer');
      if (index < 0) circuit.push(layerRule); else circuit[index] = layerRule;
    }
    if((board.copperZones||[]).length||(board.copperFills||[]).length){
      const index=ast.findIndex(node=>tag(node)==='wiring'),wiring=routedWiringWrite(board);
      if(index<0)ast.push(wiring);else ast[index]=wiring;
    }
    return boardMetadataWrite(board,nets)+astWrite(ast)+'\n';
  }
  function setNetRoutingLayers(board, changes) {return setNetRoutingRules(board,changes);}
  function copperWiresWrite(board){
    const netNames=new Map(board.nets.map(net=>[net.id,net.name])),out=[];
    if(!Array.isArray(board.copperFills||[])||(board.copperFills||[]).length>100000)throw new Error('Cannot export an invalid copper fill list.');
    for(const fill of board.copperFills||[]){
      if(fill._dsnPlane)continue;
      const net=netNames.get(fill.net),layer=board.layers[fill.layer]?.name;
      if(!net||!layer||!Array.isArray(fill.points)||!Array.isArray(fill.holes||[]))throw new Error('Cannot export a copper fill with an invalid net, layer or shape.');
      const geometry=pts=>{
        if(pts.length<3||pts.length>10000||pts.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isFinite(v))))throw new Error('Cannot export invalid copper polygon coordinates.');
        return ['polygon',layer,'0',...pts.flatMap(p=>p.map(nativeNumber))];
      };
      if(fill.imported===true&&fill._dsnWire){
        // Imported regions are immutable. Retain original rectangle/polygon
        // syntax, precision and allowed per-region attributes without rewriting.
        out.push(clone(fill._dsnWire));continue;
      }
      const wire=['wire',geometry(fill.points),['net',net],['type',fill.imported?fill._dsnType||'protect':'protect'],...(fill.holes||[]).map(hole=>['window',geometry(hole)])];
      out.push(wire);
    }
    return out;
  }
  function routedWiringWrite(board){
    const netNames=new Map(board.nets.map(net=>[net.id,net.name]));
    const wiring = ['wiring'];
    for (const trace of board.traces) {
      const name = netNames.get(trace.net), layer = board.layers[trace.layer]?.name;
      if (!name || !layer || trace.points.length < 2) throw new Error('Cannot export a trace with an invalid net, layer, or path.');
      wiring.push(['wire',['path',layer,nativeNumber(trace.width),...trace.points.flatMap(p=>p.map(nativeNumber))],['net',name],['type',trace.fixed?'protect':'route']]);
    }
    for (const via of board.vias) {
      const name = netNames.get(via.net), def = board.viaDefs.find(d=>d.name===via.padstack);
      if (!name || !def) throw new Error('Cannot export a via with an invalid net or padstack.');
      wiring.push(['via',via.padstack,nativeNumber(via.x),nativeNumber(via.y),['net',name],['type',via.fixed?'protect':'route']]);
    }
    wiring.push(...copperWiresWrite(board));
    return wiring;
  }
  function setCopperZones(board,zones){
    if(!board._ast)throw new Error('The original DSN syntax tree is required to edit copper zones safely.');
    // Retain fills when only a zone's name changes. Geometry/rule edits and
    // deletion discard its old fill so it cannot become immutable copper.
    const validated=copperZonesValidate(board,zones),previous=copperZonesValidate(board,board.copperZones||[]);
    const signature=list=>JSON.stringify(list.map(zone=>({...zone,name:''})).sort((a,b)=>a.id.localeCompare(b.id)));
    const unchanged=signature(validated)===signature(previous);
    const next={...board,copperZones:validated,copperFills:(board.copperFills||[]).filter(fill=>fill.imported===true||fill.zoneId===null||fill.zoneId===undefined||unchanged)};
    return exportDsn(next,board.filename||board.name||'board.dsn');
  }
  function copperBoardReference(board){
    const scale=board.units?.mmPerUnit;
    if(!(scale>0)||!Number.isFinite(scale))throw new Error('Copper settings need known DSN units.');
    const netNames=new Map(board.nets.map(net=>[net.id,net.name])),number=value=>Number((value*scale).toFixed(7)),point=p=>p.map(number);
    // Association hashes cover the full geometry and net list; only a few
    // readable anchors are kept in the sidecar rather than the whole board.
    const fingerprint=value=>{
      const text=JSON.stringify(value);let a=2166136261,b=2654435769;
      for(let i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619)>>>0;b=Math.imul(b^text.charCodeAt(i),2246822519)>>>0;}
      return a.toString(16).padStart(8,'0')+b.toString(16).padStart(8,'0');
    };
    const anchors=board.pads.map(pad=>({id:pad.id,component:pad.component,pin:pad.pin,netName:netNames.get(pad.net)||null,xMm:pad.x*scale,yMm:pad.y*scale})).sort((a,b)=>a.id.localeCompare(b.id));
    const shape=value=>value.type==='circle'?{layer:board.layers[value.layer]?.name,type:'circle',cx:number(value.cx),cy:number(value.cy),r:number(value.r)}:{layer:board.layers[value.layer]?.name,type:'polygon',points:value.points.map(point)};
    const pads=board.pads.map(pad=>({id:pad.id,component:pad.component,pin:pad.pin,netName:netNames.get(pad.net)||null,x:number(pad.x),y:number(pad.y),shapes:pad.shapes.map(shape).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))})).sort((a,b)=>a.id.localeCompare(b.id));
    const selected=anchors.length<=6?anchors:[...new Set(Array.from({length:6},(_,index)=>Math.round(index*(anchors.length-1)/5)))].map(index=>anchors[index]);
    return {layers:board.layers.map(layer=>layer.name),
      boundsMm:Object.fromEntries(Object.entries(board.bounds||{}).map(([key,value])=>[key,value*scale])),
      outlineFingerprint:fingerprint([(board.outlines||[]).map(poly=>poly.map(point)),(board.holes||[]).map(poly=>poly.map(point))]),
      netFingerprint:fingerprint(board.nets.map(net=>({name:net.name,pins:net.pins.slice().sort()})).sort((a,b)=>a.name.localeCompare(b.name))),
      padFingerprint:fingerprint(pads),padAnchors:selected};
  }
  function exportCopperData(board){
    // Separate, reusable configuration: no poured polygons are transferred to
    // the CAD editor. Millimetres preserve physical dimensions across DSN units.
    const zones=copperZonesValidate(board,board.copperZones||[]),scale=board.units?.mmPerUnit;
    if(!(scale>0)||!Number.isFinite(scale))throw new Error('Copper settings need known DSN units.');
    const nets=new Map(board.nets.map(net=>[net.id,net.name])),layers=new Map(board.layers.map(layer=>[layer.index,layer.name])),point=p=>p.map(value=>value*scale);
    const named=zones.map(zone=>{
      const result={...zone,net:nets.get(zone.net),layer:layers.get(zone.layer),points:zone.points.map(point),cutouts:zone.cutouts.map(poly=>poly.map(point))};
      for(const field of copperDimensions)result[field]*=scale;
      return result;
    });
    const text=JSON.stringify({format:'RamenRouter copper fill settings',version:1,
      coordinates:{unit:'mm',origin:'DSN absolute coordinates',axes:'DSN original axes',sourceUnits:{...board.units}},
      board:copperBoardReference(board),zones:named,
      exportScope:{containsActualFilledPolygons:false,containsEditableZoneSettings:true,containsTracksAndVias:false,cadImportVerified:false},
      usage:'Load this settings file into RamenRouter with the matching board. Its regions are temporary routing aids. Routed DSN and SES exports contain tracks, vias and any original DSN copper, while newly generated fills remain separate. Keep or recreate matching copper pours in your PCB editor and rebuild them after importing routing. This file is not an EasyEDA import format. Coordinates use the original DSN origin and axes without translation or mirroring.'},null,2)+'\n';
    if(text.length>2*1024*1024)throw new Error('Copper settings exceed 2 MiB.');
    return text;
  }
  function parseCopperSettings(board,input){
    let metadata;
    try{
      if(typeof input==='string'){if(input.length>2*1024*1024)throw new Error('size');metadata=JSON.parse(input);}
      else {const text=JSON.stringify(input);if(!text||text.length>2*1024*1024)throw new Error('size');metadata=JSON.parse(text);}
    }catch(_){throw new Error('Copper settings: choose a valid JSON settings file no larger than 2 MiB.');}
    const bad=message=>{throw new Error('Copper settings: '+message);};
    if(!metadata||metadata.format!=='RamenRouter copper fill settings'||metadata.version!==1)bad('Unsupported settings format or version.');
    const coordinates=metadata.coordinates,source=coordinates?.sourceUnits,scale=board.units?.mmPerUnit;
    if(coordinates?.unit!=='mm'||coordinates.origin!=='DSN absolute coordinates'||coordinates.axes!=='DSN original axes')bad('The settings need millimetres with the original DSN origin and axes.');
    if(!source||!Object.prototype.hasOwnProperty.call(copperUnitScales,source.name)||!Number.isFinite(source.resolution)||source.resolution<=0||!Number.isFinite(source.mmPerUnit)||Math.abs(source.mmPerUnit-copperUnitScales[source.name])>1e-12)bad('The declared source units are invalid.');
    if(!(scale>0)||!Number.isFinite(scale))bad('The current board has unknown DSN units.');
    function equal(a,b){
      if(typeof b==='number')return typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<=1e-7;
      if(Array.isArray(b))return Array.isArray(a)&&a.length===b.length&&b.every((value,index)=>equal(a[index],value));
      if(b&&typeof b==='object')return a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(key=>Object.prototype.hasOwnProperty.call(a,key)&&equal(a[key],b[key]));
      return a===b;
    }
    if(!equal(metadata.board,copperBoardReference(board)))bad('This file belongs to a different board, layer set, net list, pad geometry or pad placement. Load its matching DSN.');
    if(!Array.isArray(metadata.zones)||metadata.zones.length>64)bad('Use at most 64 copper regions.');
    const point=p=>{
      if(!Array.isArray(p)||p.length!==2||p.some(value=>typeof value!=='number'||!Number.isFinite(value)))bad('A region has invalid millimetre coordinates.');
      return p.map(value=>value/scale);
    };
    const native=metadata.zones.map(zone=>{
      if(!zone||typeof zone!=='object'||Array.isArray(zone)||!Array.isArray(zone.points)||!Array.isArray(zone.cutouts||[])||zone.points.length>2048||(zone.cutouts||[]).length>64)bad('A region has invalid geometry.');
      const result={...zone,points:zone.points.map(point),cutouts:(zone.cutouts||[]).map(poly=>{if(!Array.isArray(poly)||poly.length>2048)bad('A cutout has invalid geometry.');return poly.map(point);})};
      for(const field of copperDimensions)if(Object.prototype.hasOwnProperty.call(zone,field)){if(typeof zone[field]!=='number'||!Number.isFinite(zone[field]))bad('A region has an invalid '+field+'.');result[field]=zone[field]/scale;}
      return result;
    });
    return copperZonesValidate(board,native,true);
  }
  function exportRoutedDsn(board,filename=board.filename||board.name||'board.dsn'){
    // Only physical copper present in the imported DSN belongs in the CAD
    // routing download. Editable temporary pours are saved in their sidecar.
    const imported=(board.copperFills||[]).filter(fill=>fill.imported===true||fill.fixed===true&&!fill.zoneId);
    return exportDsn({...board,copperZones:[],copperFills:imported},filename);
  }
  function exportDsn(board, filename = board.filename || board.name || 'board.dsn') {
    if (!board._ast) throw new Error('The original DSN syntax tree is required for lossless rule export.');
    const ast = clone(board._ast);
    ast[1] = filename;
    const wiring=routedWiringWrite(board);
    const index = ast.findIndex(x=>tag(x)==='wiring'); if(index<0) ast.push(wiring); else ast[index]=wiring;
    if (typeof board.viaInPadOverride==='boolean'||board.viaInPadApplied) {
      const enabled=typeof board.viaInPadOverride==='boolean'?board.viaInPadOverride:true,value=enabled?'on':'off';
      const structure = first(ast,'structure'); let control=first(structure,'control');
      if(!control) {control=['control'];structure.push(control);}
      let setting=first(control,'via_at_smd'); if(setting)setting[1]=value;else control.push(['via_at_smd',value]);
      const viaNames = new Set(board.viaDefs.map(v=>v.name));
      for(const pad of children(first(ast,'library'),'padstack')) if(viaNames.has(pad[1])) {
        const attach=first(pad,'attach');if(attach)attach[1]=value;else pad.push(['attach',value]);
      }
      for(const info of children(first(ast,'network'),'via')) {
        const atomIndices=info.map((value,index)=>isList(value)?-1:index).filter(index=>index>=0),modifiers=atomIndices.slice(3);
        if(enabled&&!modifiers.some(index=>info[index]==='attach')){if(atomIndices.length===3)info.push('default');info.push('attach');}
        else if(!enabled)for(const index of modifiers.reverse())if(info[index]==='attach')info.splice(index,1);
      }
    }
    return boardMetadataWrite(board)+astWrite(ast)+'\n';
  }
  function sesPlan(board) {
    const limit=2147483647, originalResolution=positive(board.units.resolution,'SES resolution');
    let largest=0;
    const consider=value=>{
      if(!Number.isFinite(value))throw new Error('Cannot export non-finite SES geometry.');
      largest=Math.max(largest,Math.abs(value));
    };
    if(board.bounds)for(const value of Object.values(board.bounds))consider(value);
    for(const trace of board.traces){consider(trace.width);for(const p of trace.points){consider(p[0]);consider(p[1]);}}
    for(const via of board.vias){consider(via.x);consider(via.y);}
    for(const via of board.viaDefs)consider(via.diameter);
    const desired=Math.ceil(Math.max(originalResolution,Math.min(1000000,originalResolution*100)));
    const allowedResolution=largest===0?limit:Math.min(limit,Math.floor(limit/largest));
    const resolution=Math.min(desired,allowedResolution);
    if(!Number.isSafeInteger(resolution)||resolution<1)throw new Error('This design cannot fit signed 32-bit SES coordinates at a positive integer resolution.');
    function checked(value){
      if(!Number.isSafeInteger(value)||Math.abs(value)>limit)throw new Error('SES geometry exceeds the signed 32-bit coordinate range.');
      return String(value===0?0:value);
    }
    const position=value=>checked(Math.round(value*resolution));
    const dimension=value=>{
      if(!(value>0)&&Number.isFinite(value))throw new Error('SES copper dimensions must be positive.');
      const scaled=value*resolution;
      // Ignore only binary floating-point noise at an integer boundary. Genuine
      // fractional widths/diameters always round outward, never to a thinner size.
      const noise=Number.EPSILON*Math.max(1,Math.abs(scaled))*4;
      return checked(Math.max(1,Math.ceil(scaled-noise)));
    };
    const report={
      originalResolution,resolution,unit:board.units.name,
      coordinateRounding:'nearest',copperDimensionRounding:'outward ceiling (floating-point noise tolerated)',
      coarserThanInput:resolution<originalResolution,
      maximumCoordinateErrorNative:0,maximumWidthIncreaseNative:0,maximumViaDiameterIncreaseNative:0,
      maximumCoordinateErrorMm:0,maximumWidthIncreaseMm:0,maximumViaDiameterIncreaseMm:0,
      coordinateErrorBoundNative:Math.SQRT2/(2*resolution),copperDimensionIncreaseBoundNative:1/resolution,
      widthsExpanded:0,viaDefinitionsExpanded:0,
      note:'SES coordinates are quantized to the stated resolution. Copper widths and via diameters round outward by at most one resolution unit; this can consume a small amount of clearance. Original DSN rules are unchanged.'
    };
    if((board.copperFills||[]).length||(board.copperZones||[]).length){
      report.copperFillsIncluded=false;report.copperZonesIncluded=false;report.copperFillCount=(board.copperFills||[]).length;
      report.copperWarning='SES exports tracks and vias only. Temporary copper fills are excluded from routed DSN and SES exports; save Copper settings separately. Keep or recreate matching copper pours in your PCB editor and rebuild them after importing routing. A connection that relies on a temporary fill is incomplete until the corresponding PCB-editor copper is rebuilt.';
    }
    const checkPoint=p=>{report.maximumCoordinateErrorNative=Math.max(report.maximumCoordinateErrorNative,Math.hypot(Number(position(p[0]))/resolution-p[0],Number(position(p[1]))/resolution-p[1]));};
    for(const trace of board.traces){
      const delta=Number(dimension(trace.width))/resolution-trace.width;
      report.maximumWidthIncreaseNative=Math.max(report.maximumWidthIncreaseNative,delta);
      if(delta>Number.EPSILON*Math.max(1,trace.width)*8)report.widthsExpanded++;
      for(const p of trace.points)checkPoint(p);
    }
    for(const via of board.vias)checkPoint([via.x,via.y]);
    for(const def of board.viaDefs){
      const delta=Number(dimension(def.diameter))/resolution-def.diameter;
      report.maximumViaDiameterIncreaseNative=Math.max(report.maximumViaDiameterIncreaseNative,delta);
      if(delta>Number.EPSILON*Math.max(1,def.diameter)*8)report.viaDefinitionsExpanded++;
    }
    report.maximumCoordinateErrorMm=report.maximumCoordinateErrorNative*board.units.mmPerUnit;
    report.maximumWidthIncreaseMm=report.maximumWidthIncreaseNative*board.units.mmPerUnit;
    report.maximumViaDiameterIncreaseMm=report.maximumViaDiameterIncreaseNative*board.units.mmPerUnit;
    return {resolution,position,dimension,report};
  }
  function exportSesReport(board){return sesPlan(board).report;}
  function exportSes(board, filename = board.filename || board.name || 'board.dsn') {
    const plan=sesPlan(board),resolution=plan.resolution,integer=plan.position,dimension=plan.dimension;
    const library = ['library_out'];
    for (const via of board.viaDefs) {
      const pad = ['padstack',via.name];
      for (let layer=via.fromLayer;layer<=via.toLayer;layer++) pad.push(['shape',['circle',board.layers[layer].name,dimension(via.diameter),'0','0']]);
      if (!via.attachAllowed && !board.viaInPadApplied) pad.push(['attach','off']);
      library.push(pad);
    }
    const network = ['network_out'];
    for (const net of board.nets) {
      const node=['net',net.name];
      for (const trace of board.traces.filter(t=>t.net===net.id)) {
        const width=dimension(trace.width);
        node.push(['wire',['path',board.layers[trace.layer].name,width,...trace.points.flatMap(p=>p.map(integer))],['type',trace.fixed?'protect':'route']]);
      }
      for (const via of board.vias.filter(v=>v.net===net.id)) node.push(['via',via.padstack,integer(via.x),integer(via.y),['type',via.fixed?'protect':'route']]);
      if(node.length>2)network.push(node);
    }
    const sessionName=/\.dsn$/i.test(filename)?filename.replace(/\.dsn$/i,'.ses'):filename+'.ses';
    const session=['session',sessionName,['base_design',filename],['placement',['resolution',board.units.name,String(resolution)]],['routes',['resolution',board.units.name,String(resolution)],['parser',['host_cad','RamenRouter JavaScript'],['host_version','0.3.0']],library,network]];
    return astWrite(session)+'\n';
  }
  return { parse, exportSes, exportDsn, exportSesReport, clearRoutingDsn, setNetRoutingRules, setNetRoutingLayers, setCopperZones, exportCopperData, parseCopperSettings, exportRoutedDsn };
}
if (typeof globalThis !== 'undefined') globalThis.createRamenDSN = createRamenDSN;
if (typeof module !== 'undefined' && module.exports) module.exports = { createRamenDSN };
