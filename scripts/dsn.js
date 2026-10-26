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
      if(rules!==null)fail('This file has more than one saved routing-rule record.');
      const version=comment.startsWith('RamenRouter routing rules v1:')?1:comment.startsWith('RamenRouter routing rules v2:')?2:0;
      if(!version)fail('This version of saved routing rules is not supported. Try a newer RamenRouter.');
      const prefix='RamenRouter routing rules v'+version+':';
      try {rules=JSON.parse(comment.slice(prefix.length));}
      catch(_) {fail('The saved routing rules are damaged. Try exporting the board again.');}
      const keys=version===1?['shorterNets']:['shorterNets','padEscapeNets'];
      if(!rules||typeof rules!=='object'||Array.isArray(rules)||Object.keys(rules).length!==keys.length||
        keys.some(key=>!Object.prototype.hasOwnProperty.call(rules,key)||!Array.isArray(rules[key])||rules[key].some(name=>typeof name!=='string')||new Set(rules[key]).size!==rules[key].length))
        fail(version===1?'The saved shorter-route choices are invalid. Each net name needs to appear only once.':'The saved routing rules are invalid. Each net name needs to appear only once in each list.');
    }
    return rules;
  }
  function routingRulesWrite(nets) {
    const shorterNets=nets.filter(net=>net.preferShort===true).map(net=>net.name);
    return shorterNets.length?'; RamenRouter routing rules v1: '+JSON.stringify({shorterNets})+'\n':'';
  }
  const scaleProfiles=new Set(['auto','declared','easyeda-standard']);
  function boardEdgeClearanceRead(text) {
    let i=0,record=null;
    while(i<text.length) {
      if(/\s/.test(text[i])){i++;continue;}
      if(text[i]!==';'&&!(text[i]==='#'&&(i===0||text[i-1]==='\n')))break;
      const start=++i;while(i<text.length&&text[i]!=='\n')i++;
      const comment=text.slice(start,i).trim();
      if(!comment.startsWith('RamenRouter board edge clearance'))continue;
      if(record!==null)fail('This file has more than one saved board-edge clearance.');
      const prefix='RamenRouter board edge clearance v1:';
      if(!comment.startsWith(prefix))fail('This version of the saved board-edge clearance is not supported. Try a newer RamenRouter.');
      try{record=JSON.parse(comment.slice(prefix.length));}catch(_){fail('The saved board-edge clearance is damaged. Try exporting the board again.');}
      if(!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).length!==1||!Object.prototype.hasOwnProperty.call(record,'clearanceMm')||!Number.isFinite(record.clearanceMm)||record.clearanceMm<0||record.clearanceMm>1000)fail('The saved board-edge clearance needs a number between 0 and 1000 mm.');
    }
    return record;
  }
  function boardScaleRead(text) {
    let i=0,record=null;
    while(i<text.length) {
      if(/\s/.test(text[i])){i++;continue;}
      if(text[i]!==';'&&!(text[i]==='#'&&(i===0||text[i-1]==='\n')))break;
      const start=++i;while(i<text.length&&text[i]!=='\n')i++;
      const comment=text.slice(start,i).trim();
      if(!comment.startsWith('RamenRouter board scale'))continue;
      if(record!==null)fail('This file has more than one saved board-scale choice.');
      const prefix='RamenRouter board scale v1:';
      if(!comment.startsWith(prefix))fail('This version of the saved board scale is not supported. Try a newer RamenRouter.');
      try{record=JSON.parse(comment.slice(prefix.length));}catch(_){fail('The saved board scale is damaged. Try exporting the board again.');}
      if(!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).length!==1||!scaleProfiles.has(record.profile))fail('The saved board-scale choice is invalid. Choose Automatic, DSN units or EasyEDA Standard.');
    }
    return record;
  }
  function detectBoardScale(ast,board) {
    if(board.units.name!=='mil')return {profile:'declared',source:'file-units',reason:'Using the units declared in this file.'};
    const parser=first(ast,'parser'),host=String(first(parser,'host_cad')?.[1]||'').trim();
    // Pro exports and ordinary Specctra files keep their declared unit scale.
    // Only Standard's known legacy flattened layout uses 10-mil coordinates.
    if(/easyeda/i.test(host)&&/pro/i.test(host))return {profile:'declared',source:'file-units',reason:'Using the units declared by EasyEDA Pro.'};
    if(/^easyeda\s*(?:standard|std|\(standard\)|\(std\))$/i.test(host))return {profile:'easyeda-standard',source:'host-cad',reason:'EasyEDA Standard export: one coordinate unit is 10 mil.'};
    if(host&&!/^easyeda$/i.test(host))return {profile:'declared',source:'file-units',reason:'Using the units declared in this file.'};
    const library=first(ast,'library'),images=children(library,'image'),components=children(first(ast,'placement'),'component'),layers=board.layers.map(layer=>layer.name);
    const expected=['1',...Array.from({length:Math.max(0,layers.length-2)},(_,i)=>String(21+i)),'2'];
    const image=images[0],pins=children(image,'pin'),places=children(components[0],'place'),padNames=children(library,'padstack').map(pad=>String(pad[1]));
    const legacy=board.units.resolution===1000&&layers.length>=2&&layers.length<=18&&layers.every((name,i)=>name===expected[i])&&
      images.length===1&&image[1]==='u1'&&components.length===1&&components[0][1]==='u1'&&places.length===1&&places[0][1]==='u1'&&
      atoms(places[0]).length===6&&n(places[0][2])===0&&n(places[0][3])===0&&places[0][4]==='front'&&n(places[0][5])===0&&
      pins.length>0&&pins.every(pin=>/^p\d+$/.test(String(pin[1]))&&/^\d+$/.test(String(pin[2])))&&
      padNames.length>0&&padNames.every(name=>/^p\d+$/.test(name)||/^via\d+$/.test(name))&&board.viaDefs.length>0&&board.viaDefs.every(def=>/^via\d+$/.test(def.name))&&
      board.nets.every(net=>net.pins.every(pin=>/^u1-\d+$/.test(String(pin))));
    return legacy?{profile:'easyeda-standard',source:'legacy-layout',reason:'Recognised EasyEDA Standard export: one coordinate unit is 10 mil.'}:{profile:'declared',source:'file-units',reason:'Using the units declared in this file.'};
  }
  function applyBoardScale(board,selectedProfile='auto') {
    if(!scaleProfiles.has(selectedProfile))throw new Error('Choose Automatic, DSN units or EasyEDA Standard for this board.');
    if(selectedProfile==='easyeda-standard'&&board.units.name!=='mil')throw new Error('EasyEDA Standard scale needs a file declared in mil. Choose DSN units for this board.');
    const declaredMmPerUnit={mm:1,mil:.0254,inch:25.4,um:.001,cm:10}[board.units.name];
    const detected=detectBoardScale(board._ast,board),autoProfile=detected.profile,profile=selectedProfile==='auto'?autoProfile:selectedProfile;
    const mmPerUnit=profile==='easyeda-standard'?.254:declaredMmPerUnit;
    board.units.mmPerUnit=mmPerUnit;
    board.boardScale={selectedProfile,detectedProfile:detected.profile,autoProfile,profile,effectiveProfile:profile,mmPerUnit,declaredMmPerUnit,canUseEasyedaStandard:board.units.name==='mil',
      source:selectedProfile==='auto'?detected.source:'user-choice',reason:selectedProfile==='auto'?detected.reason:profile==='easyeda-standard'?'Using EasyEDA Standard 10-mil coordinates for this board.':'Using the units declared in this file.',
      widthMm:(board.bounds.maxX-board.bounds.minX)*mmPerUnit,heightMm:(board.bounds.maxY-board.bounds.minY)*mmPerUnit,
      minViaDiameterMm:board.viaDefs.length?Math.min(...board.viaDefs.map(def=>def.diameter))*mmPerUnit:null,
      viaDiametersMm:board.viaDefs.map(def=>({name:def.name,diameterMm:def.diameter*mmPerUnit}))};
    return board;
  }
  function boardMetadataWrite(board,nets=board.nets){return routingRulesWrite(nets)+(board.boardScale?.selectedProfile&&board.boardScale.selectedProfile!=='auto'?'; RamenRouter board scale v1: '+JSON.stringify({profile:board.boardScale.selectedProfile})+'\n':'')+(Number.isFinite(board.boardEdgeClearanceMm)?'; RamenRouter board edge clearance v1: '+JSON.stringify({clearanceMm:board.boardEdgeClearanceMm})+'\n':'');}
  function astRead(text) {
    if (typeof text !== 'string' || !text.trim()) fail('This file is empty. Choose a DSN exported from your PCB editor.');
    if (text.length > 64 * 1024 * 1024) fail('This file is too large. Choose a DSN no larger than 64 MiB.');
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
        if (stack.length >= 256) fail('This DSN has too many nested sections. Try exporting the board again.');
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
          if (!closed) fail('A quoted name is missing its closing quote. Try exporting the board again.');
        }
      } else {
        const start = i;
        while (i < text.length && !/[\s()]/.test(text[i])) i++;
        value = text.slice(start, i);
      }
      stack[stack.length - 1].push(value);
      if (++tokenCount > 3000000) fail('This DSN has too many entries to load. Try a simpler export.');
    }
    if (stack.length !== 1) fail('This DSN is missing a closing parenthesis. Try exporting the board again.');
    if (root.length !== 1 || tag(root[0]) !== 'pcb') fail('Choose a DSN containing one PCB design, starting with (pcb ...).');
    return root[0];
  }
  function allowed(node, names, context) {
    for (const child of children(node)) if (!names.includes(tag(child)))
      fail('Unsupported ' + tag(child) + ' constraint in ' + context + '. This rule cannot be applied here, so the board was not loaded. Try a simpler Specctra DSN export.');
  }
  function points(values, what) {
    if (values.length < 4 || values.length % 2) fail('Invalid coordinate list in ' + what + '.');
    const out = [];
    for (let i = 0; i < values.length; i += 2) out.push([n(values[i]), n(values[i + 1])]);
    return out;
  }
  function polygon(pts, context) {
    if (pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1e-10) pts = pts.slice(0, -1);
    if (pts.length < 3) fail(context + ' needs at least three corners.');
    if (pts.length > 10000) fail(context + ' has more than 10,000 corners.');
    let area = 0;
    for (let i=0;i<pts.length;i++) { const a=pts[i],b=pts[(i+1)%pts.length]; area+=a[0]*b[1]-a[1]*b[0]; }
    if (Math.abs(area) < 1e-16) fail(context + ' has no area. Draw a closed shape with some space inside it.');
    const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    for(let i=0;i<pts.length;i++) for(let j=i+2;j<pts.length;j++) {
      if(i===0&&j===pts.length-1)continue;
      const a=pts[i],b=pts[(i+1)%pts.length],c=pts[j],d=pts[(j+1)%pts.length];
      if(cross(a,b,c)*cross(a,b,d)<0&&cross(c,d,a)*cross(c,d,b)<0)fail(context+' crosses itself. Move its points so the boundary does not cross.');
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
  function parse(text, filename = 'board.dsn') {
    const ast = astRead(text);
    const routingRules = routingRulesRead(text),scaleChoice=boardScaleRead(text),edgeChoice=boardEdgeClearanceRead(text);
    allowed(ast, ['parser','resolution','unit','structure','placement','library','network','wiring'], 'the design');
    const parser = first(ast, 'parser'), quote = first(parser, 'string_quote');
    if (quote && quote[1] !== '"') fail('This DSN needs standard double quotes around quoted names. Try exporting it again.');
    const structure = first(ast, 'structure'), library = first(ast, 'library'), network = first(ast, 'network');
    if (!structure || !library || !network) fail('This DSN is missing its board structure, component library or nets. Try exporting the whole board again.');
    allowed(structure, ['layer','boundary','via','rule','layer_rule','control','grid','keepout','via_keepout','place_keepout','snap_angle','plane'], 'structure');
    allowed(library, ['image','padstack'], 'library');
    allowed(network, ['net','class','via','via_rule'], 'network');
    const snapAngle=first(structure,'snap_angle');
    if(snapAngle&&!['fortyfive_degree','none'].includes(snapAngle[1]))fail('Unsupported snap-angle constraint '+snapAngle[1]+'.');
    const res = first(ast, 'resolution'), unitNode = first(ast, 'unit');
    const unitName = String(unitNode ? unitNode[1] : res ? res[1] : 'mil').toLowerCase();
    const scales = { mm: 1, mil: 0.0254, inch: 25.4, um: 0.001, cm: 10 };
    if (!(unitName in scales)) fail('Unsupported unit ' + unitName + '.');
    if (res && String(res[1]).toLowerCase() !== unitName) fail('The DSN units and resolution units need to match. Check the export settings.');
    const board = {
      name: ast[1] && ast[1] !== "''" ? ast[1] : filename, filename, originalText: text,
      units: { name: unitName, resolution: res ? positive(res[2], 'resolution') : 1000, mmPerUnit: scales[unitName] },
      layers: [], nets: [], pads: [], viaDefs: [], vias: [], traces: [], outlines: [], holes: [], keepouts: [],
      viaAtSmd: false, warnings: [], grids: {}, _ast: ast, copperFills: [], ...(edgeChoice?{boardEdgeClearanceMm:edgeChoice.clearanceMm}:{})
    };
    for (const layer of children(structure, 'layer')) {
      allowed(layer, ['type','property'], 'layer ' + layer[1]);
      const type = first(layer, 'type');
      if (!type || tag(type) !== 'type' || String(type[1]).toLowerCase() !== 'signal') fail('Only layers marked as signal layers are supported in this DSN. Dedicated plane-layer types cannot be loaded yet.');
      if (board.layers.some(x => x.name === layer[1])) fail('Duplicate layer ' + layer[1] + '.');
      board.layers.push({ name: layer[1], index: board.layers.length, type: 'signal' });
    }
    if (!board.layers.length) fail('This DSN has no signal layers to route on.');
    const layerIndex = new Map(board.layers.map(l => [l.name, l.index]));
    const everyLayer = board.layers.map(l => l.index);
    function layerNumbers(name, boundary = false) {
      if (name === 'signal' || name === 'all' || (boundary && name === 'pcb')) return everyLayer.slice();
      if (!layerIndex.has(name)) fail('This layer is missing or not supported: ' + name + '.');
      return [layerIndex.get(name)];
    }
    function shapeRead(node, boundary = false) {
      const kind = tag(node), values = atoms(node);
      if (!['circle','rect','polygon','path'].includes(kind)) fail('Unsupported shape ' + kind + '.');
      if (children(node).length) fail('Nested rules in ' + kind + ' shapes cannot be loaded yet.');
      const layers = layerNumbers(values[1], boundary), out = [];
      if (kind === 'circle') {
        if (![3,5].includes(values.length)) fail('A circle has invalid dimensions or coordinates.');
        const r = positive(values[2], 'circle diameter') / 2, cx = values.length > 3 ? n(values[3]) : 0, cy = values.length > 4 ? n(values[4]) : 0;
        for (const layer of layers) out.push({ layer, type: 'circle', cx, cy, r });
      } else if (kind === 'rect') {
        if (values.length !== 6) fail('A rectangle has invalid coordinates.');
        const x1 = n(values[2]), y1 = n(values[3]), x2 = n(values[4]), y2 = n(values[5]);
        if (x1 === x2 || y1 === y2) fail('A rectangle has no area. Check its corner coordinates.');
        for (const layer of layers) out.push({ layer, type: 'polygon', points: [[x1,y1],[x2,y1],[x2,y2],[x1,y2]] });
      } else {
        const width = n(values[2], kind + ' width');
        if (width < 0) fail('A shape has a negative width. Set it to zero or more.');
        const pts = points(values.slice(3), kind);
        if (kind === 'polygon' || (boundary && width === 0)) {
          const poly = polygon(pts, kind);
          for (const layer of layers) out.push({ layer, type: 'polygon', points: poly });
        } else {
          if (width <= 0) fail('A pad or keepout path needs a width greater than zero.');
          if (!board.warnings.includes('Rounded pads and keepouts use straight-edged approximations that keep their full size.')) board.warnings.push('Rounded pads and keepouts use straight-edged approximations that keep their full size.');
          for (const layer of layers) for (let i = 1; i < pts.length; i++) out.push({ layer, type: 'polygon', points: capsule(pts[i - 1], pts[i], width / 2) });
        }
      }
      return out;
    }
    function contour(node) {
      if(tag(node)==='path'&&n(node[2],'boundary path width')!==0)fail('The board boundary needs a zero-width path. Export its outline as a polygon.');
      const shapes = shapeRead(node, true), s = shapes[0];
      if (s.type !== 'polygon') fail('Curved board edges and holes cannot be loaded yet. Export them as polygons.');
      return s.points;
    }
    const contours = [];
    for (const boundary of children(structure, 'boundary')) {
      allowed(boundary, ['path','polygon','rect','window'], 'board boundary');
      for (const geometry of children(boundary).filter(x => tag(x) !== 'window')) contours.push(contour(geometry));
      for (const hole of children(boundary, 'window')) {
        if (children(hole).length !== 1) fail('Each board hole needs one polygon for its boundary.');
        board.holes.push(contour(children(hole)[0]));
      }
    }
    if (!contours.length) fail('This DSN has no polygonal board outline. Export the outline as a polygon.');
    for (const poly of contours) {
      const depth = contours.filter(other => other !== poly && inside(poly[0], other)).length;
      if(depth>1)fail('Islands inside board cutouts cannot be loaded yet.');
      (depth % 2 ? board.holes : board.outlines).push(poly);
    }
    const allBoundaryPoints = board.outlines.flat();
    board.bounds = { minX: Math.min(...allBoundaryPoints.map(p => p[0])), minY: Math.min(...allBoundaryPoints.map(p => p[1])), maxX: Math.max(...allBoundaryPoints.map(p => p[0])), maxY: Math.max(...allBoundaryPoints.map(p => p[1])) };
    if (!(board.bounds.maxX > board.bounds.minX && board.bounds.maxY > board.bounds.minY)) fail('The board outline has no area. Check its boundary in your PCB editor.');
    const padstacks = new Map();
    for (const p of children(library, 'padstack')) {
      allowed(p, ['shape','attach','absolute'], 'padstack ' + p[1]);
      if (padstacks.has(p[1])) fail('Duplicate padstack ' + p[1] + '.');
      const shapes = [];
      for (const wrapper of children(p, 'shape')) {
        const values = children(wrapper);
        if (values.length !== 1) fail('Padstack ' + p[1] + ' needs exactly one shape in each shape entry.');
        shapes.push(...shapeRead(values[0]));
      }
      if (!shapes.length) fail('No pad shapes were found for padstack ' + p[1] + '.');
      padstacks.set(p[1], { name: p[1], shapes, attachAllowed: String(first(p,'attach')?.[1] || 'on').toLowerCase() !== 'off', absolute: String(first(p,'absolute')?.[1] || 'off').toLowerCase() === 'on' });
    }
    let defaultWidth = null, defaultClearance = 0;
    const globalRules = children(structure, 'rule');
    function readRules(ruleScopes, width, clearance, context) {
      for (const rules of ruleScopes) for (const rule of children(rules)) {
        if (tag(rule) === 'width') width = positive(rule[1], context + ' width');
        else if (tag(rule) === 'clearance' || tag(rule) === 'clear') {
          const value = n(rule[1], context + ' clearance');
          if (value < 0) fail('Clearance cannot be negative. Set it to zero or more.');
          const type = first(rule, 'type');
          if (type) {
            const names = atoms(type).slice(1).map(String);
            if (names.includes('smd_to_turn_gap')) { board.warnings.push('The pad-to-bend preference (smd_to_turn_gap) is kept in the exported DSN, but does not guide this routing run.'); continue; }
            if (value !== clearance || names.some(x => !['default_smd','smd_smd','wire_smd','smd_wire','wire_wire','default','smd','wire'].includes(x)))
              fail('Pair-specific clearance rule ' + names.join(' ') + ' is not supported.');
          } else clearance = value;
        } else fail('Unsupported ' + tag(rule) + ' routing rule in ' + context + '.');
      }
      return { width, clearance };
    }
    ({ width: defaultWidth, clearance: defaultClearance } = readRules(globalRules, defaultWidth, defaultClearance, 'default'));
    if (children(structure,'layer_rule').length) fail('Different widths or clearances for each layer cannot be applied yet.');
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
      if (p.shapes.some(s => s.type !== 'circle' || Math.hypot(s.cx,s.cy) > 1e-9)) fail('Via ' + name + ' needs round pads centred on the same point.');
      const diameters = p.shapes.map(s => s.r * 2), layers = [...new Set(p.shapes.map(s => s.layer))].sort((a,b) => a-b);
      if (Math.max(...diameters) - Math.min(...diameters) > 1e-9) fail('Via ' + name + ' uses different pad diameters on different layers. That via type cannot be loaded yet.');
      if (layers.some((v,i) => v !== layers[0] + i)) fail('Via ' + name + ' skips copper layers in its span. That via type cannot be loaded yet.');
      board.viaDefs.push({ name, diameter: diameters[0], fromLayer: layers[0], toLayer: layers.at(-1), attachAllowed: p.attachAllowed });
    }
    const viaInfos = new Map(), viaAttachment = new Map();
    for (const v of children(network,'via')) {
      const a = atoms(v); if (a.length < 3) fail('A via rule is incomplete or damaged.');
      if (a.length > 3 && a[3] !== 'default') fail('Separate named clearance classes for vias cannot be applied yet.');
      if(a.length>5||(a.length===5&&a[4]!=='attach'))fail('This via rule has extra settings that cannot be applied yet.');
      viaInfos.set(a[1], a[2]);
      const attach=a.slice(3).includes('attach');
      if(viaAttachment.has(a[2])&&viaAttachment.get(a[2])!==attach)fail('Different pad-attachment permissions on each net for via '+a[2]+' are not supported.');
      viaAttachment.set(a[2],attach);
    }
    for(const def of board.viaDefs)if(viaAttachment.has(def.name))def.attachAllowed=def.attachAllowed&&viaAttachment.get(def.name);
    const viaRules = new Map(children(network,'via_rule').map(v => [v[1], atoms(v).slice(2).map(x => viaInfos.get(x) || x)]));
    const netByName = new Map(), netByPin = new Map(), netLayerOverrides = new Map();
    for (const net of children(network,'net')) {
      allowed(net,['pins','circuit'],'net ' + net[1]);
      if (netByName.has(net[1])) fail('A repeated or subnet net name ' + net[1] + ' is not supported.');
      const circuits = children(net,'circuit');
      if (circuits.length > 1) fail('More than one circuit rule was found for net ' + net[1] + '.');
      if (circuits.length) {
        allowed(circuits[0],['use_layer'],'net circuit ' + net[1]);
        const settings = children(circuits[0],'use_layer');
        if (settings.length > 1) fail('More than one layer-selection rule was found for net ' + net[1] + '.');
        if (settings.length) {
          if (children(settings[0]).length) fail('Nested layer-selection rules for net ' + net[1] + ' are not supported.');
          const activeLayers = [...new Set(atoms(settings[0]).slice(1).flatMap(x => layerNumbers(x)))];
          if (!activeLayers.length) fail('Net ' + net[1] + ' has no allowed routing layers. Choose at least one.');
          netLayerOverrides.set(net[1],activeLayers);
        }
      }
      const names = children(net,'pins').flatMap(p => atoms(p).slice(1));
      const item = { id: board.nets.length + 1, name: net[1], pins: names, width: defaultWidth, clearance: defaultClearance, className: 'default', clearanceClass: 'default', viaName: viaNames[0] || null, useLayers: everyLayer.slice(), preferShort: false };
      board.nets.push(item); netByName.set(item.name,item);
      for (const pin of names) {
        if (netByPin.has(pin) && netByPin.get(pin) !== item.id) fail('Pin ' + pin + ' belongs to more than one net. Check its connections in your PCB editor.');
        netByPin.set(pin,item.id);
      }
    }
    for(const name of routingRules?.shorterNets||[]) {
      const net=netByName.get(name);
      if(!net)fail('Unknown net '+name+' in the saved RamenRouter routing rules.');
      net.preferShort=true;
    }
    // Older v2 files named nets with optional pad access. Validate that legacy
    // metadata, then discard it: selected layers now always include local access.
    for(const name of routingRules?.padEscapeNets||[])if(!netByName.has(name))fail('Unknown net '+name+' in the saved RamenRouter routing rules.');
    const assigned = new Set();
    const classes=children(network,'class'), defaults=classes.filter(c=>c[1]==='default');
    if(defaults.length>1)fail('This DSN has more than one default net class.');
    if(new Set(classes.map(c=>c[1])).size!==classes.length)fail('More than one net class has the same name. Give each class its own name.');
    for (const cls of defaults.concat(classes.filter(c=>c[1]!=='default'))) {
      allowed(cls,['rule','circuit','via_rule','clearance_class','pull_tight','shove_fixed'],'net class ' + cls[1]);
      if (first(cls,'clearance_class') && first(cls,'clearance_class')[1] !== 'default') fail('Named clearance matrices cannot be applied yet. Export clearance values for each net class instead.');
      if(String(first(cls,'shove_fixed')?.[1]||'off').toLowerCase()==='on')fail('Moving fixed tracks (shove_fixed) cannot be applied here. Keep that net-class option off.');
      if(String(first(cls,'pull_tight')?.[1]||'on').toLowerCase()==='off')fail('Turning off track tightening (pull_tight) cannot be applied here. Keep that net-class option on.');
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
      if (!activeLayers.length) fail('Net class ' + cls[1] + ' has no allowed routing layers. Choose at least one.');
      const names = atoms(cls).slice(2);
      if(cls[1]==='default') {
        defaultWidth=rules.width;defaultClearance=rules.clearance;
        board.defaultWidth=defaultWidth;board.defaultClearance=defaultClearance;
        classClearances.set('default',defaultClearance);
        if(defaultClearance!==board.structureClearance && globalRules.some(scope=>children(scope).some(rule=>['clear','clearance'].includes(tag(rule))&&first(rule,'type'))))
          fail('Changing default-class clearance while also using clearance rules for different object types cannot be applied yet.');
        for(const net of board.nets)Object.assign(net,rules,{viaName:choices?.[0]||null,useLayers:[...new Set(activeLayers)]});
      }
      for (const name of names) {
        const net = netByName.get(name); if (!net) fail('Unknown net ' + name + ' in class ' + cls[1] + '.');
        if (assigned.has(name)) fail('More than one net class was assigned to net ' + name + '.');
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
    for (const net of board.nets) if (!(net.width > 0)) fail('Set a trace width greater than zero for net ' + net.name + '.');
    const placement = first(ast,'placement');
    if (!placement) fail('This DSN has no component positions. Try exporting the whole board again.');
    allowed(placement,['component','place_control'],'placement');
    const placeControl = first(placement,'place_control');
    if (placeControl) allowed(placeControl,['flip_style'],'placement control');
    const flipStyle = String(first(placeControl,'flip_style')?.[1] || 'mirror_first');
    if (!['mirror_first','rotate_first'].includes(flipStyle)) fail('Unknown component flip style ' + flipStyle + '.');
    const images = new Map();
    for(const image of children(library,'image')) {
      if(images.has(image[1]))fail('More than one footprint was found with the name '+image[1]+'.');
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
        if (!shapes.length) fail('A keepout has no shape. Check it in your PCB editor.');
        for (const s of shapes) {
          const shape = place ? transformedShape(s,place,[0,0],0) : s;
          board.keepouts.push({ layers:[shape.layer], shape, kind:tag(child)==='via_keepout'?'via':'all' });
        }
      }
    }
    keepouts(structure);
    for (const component of children(placement,'component')) {
      allowed(component,['place'],'component ' + component[1]);
      const image = images.get(component[1]); if (!image) fail('The component footprint is missing: ' + component[1] + '.');
      allowed(image,['pin','keepout','via_keepout','place_keepout','outline'],'image ' + image[1]);
      for (const p of children(component,'place')) {
        allowed(p,['lock_type'],'placement ' + p[1]);
        const a = atoms(p); if (a.length !== 6 || !['front','back'].includes(a[4])) fail('Check the position, board side and rotation of component ' + a[1] + '.');
        const place = { name:a[1],x:n(a[2]),y:n(a[3]),back:a[4]==='back',rotation:n(a[5],'rotation') };
        for (const pin of children(image,'pin')) {
          allowed(pin,['rotate'],'pin in ' + image[1]);
          const v = atoms(pin); if (v.length !== 5) fail('A pin has invalid settings in footprint ' + image[1] + '.');
          const ps = padstacks.get(v[1]); if (!ps) fail('Unknown padstack ' + v[1] + '.');
          const id = place.name + '-' + v[2]; if (pinIds.has(id)) fail('Duplicate pin ' + id + '.');
          pinIds.add(id);
          const offset = [n(v[3]),n(v[4])], angle = n(first(pin,'rotate')?.[1] || 0,'pin rotation'), center = transform([0,0],place,offset,angle);
          board.pads.push({ id,component:place.name,pin:v[2],net:netByPin.get(id) || null,x:center[0],y:center[1],shapes:ps.shapes.map(s => transformedShape(s,place,offset,angle,ps.absolute)) });
        }
        keepouts(image,place);
      }
    }
    for (const net of board.nets) for (const pin of net.pins) if (!pinIds.has(pin)) fail('Net ' + net.name + ' refers to a missing pin: ' + pin + '.');
    function copperRegionRead(node,plane=false){
      if(atoms(node).length!==(plane?2:1)||(!plane&&['net','type','clearance_class'].some(key=>children(node,key).length>1)))fail('A copper area has incomplete or repeated settings.');
      const geometries=children(node).filter(child=>['polygon','rect'].includes(tag(child)));
      if(geometries.length!==1)fail('Each copper area needs one polygon or rectangle for its boundary.');
      const geometry=geometries[0];
      if(tag(geometry)==='polygon'&&n(geometry[2],'copper polygon width')!==0)fail('Copper polygons need a stroke width of zero.');
      const shape=shapeRead(geometry);if(shape.length!==1||shape[0].type!=='polygon')fail('Each copper area needs exactly one copper layer.');
      const netNode=plane?['net',atoms(node)[1]]:first(node,'net');
      if(!netNode||!netByName.has(netNode[1])||(netNode[2]&&netNode[2]!=='1'))fail('Each copper area needs a net from this board, without subnets.');
      const state=plane?'protect':String(first(node,'type')?.[1]||'route');
      if(!['normal','route','fix','protect'].includes(state))fail('This copper protection setting is not recognised: '+state+'.');
      const holes=[];
      for(const window of children(node,'window')){
        const nodes=children(window);if(atoms(window).length!==1||nodes.length!==1||!['polygon','rect'].includes(tag(nodes[0])))fail('Each copper cutout needs one polygon or rectangle for its boundary.');
        if(tag(nodes[0])==='polygon'&&n(nodes[0][2],'copper window width')!==0)fail('Copper cutouts need a stroke width of zero.');
        const hole=shapeRead(nodes[0]);if(hole.length!==1||hole[0].type!=='polygon'||hole[0].layer!==shape[0].layer)fail('A copper cutout needs to be on the same layer as its copper area.');
        holes.push(hole[0].points);
      }
      const fill={net:netByName.get(netNode[1]).id,layer:shape[0].layer,points:shape[0].points,holes,fixed:true,imported:true,_dsnType:state};
      if(plane)fill._dsnPlane=true;else fill._dsnWire=clone(node);
      board.copperFills.push(fill);
    }
    for(const plane of children(structure,'plane')){allowed(plane,['polygon','rect','window'],'copper plane');copperRegionRead(plane,true);}
    const wiring = first(ast,'wiring');
    if (wiring) {
      allowed(wiring,['wire','via'],'wiring');
      for (const wire of children(wiring,'wire')) {
        allowed(wire,['path','polygon','rect','window','net','type','clearance_class'],'wire');
        if(first(wire,'polygon')||first(wire,'rect')){
          if(first(wire,'path'))fail('One wire entry cannot contain both a trace path and a copper area.');
          if(first(wire,'clearance_class')&&first(wire,'clearance_class')[1]!=='default')fail('Separate clearance classes for individual tracks cannot be applied yet.');
          copperRegionRead(wire);continue;
        }
        if(children(wire,'window').length)fail('A trace path cannot contain copper cutouts.');
        const p = first(wire,'path'), netNode = first(wire,'net');
        if (!p || !netNode || !netByName.has(netNode[1])) fail('Each track needs a supported path and a net from this board.');
        if(children(p).length)fail('Extra rules inside a trace path cannot be applied yet.');
        if (netNode[2] && netNode[2] !== '1') fail('Electrical subnets cannot be loaded yet. Export each connection as one net.');
        if (first(wire,'clearance_class') && first(wire,'clearance_class')[1] !== 'default') fail('Separate clearance classes for individual tracks cannot be applied yet.');
        const v = atoms(p), layers = layerNumbers(v[1]); if (layers.length !== 1) fail('Each track needs exactly one copper layer.');
        const state = String(first(wire,'type')?.[1] || 'normal');
        if (!['normal','route','fix','protect'].includes(state)) fail('This track protection setting is not recognised: ' + state + '.');
        board.traces.push({ net:netByName.get(netNode[1]).id,layer:layers[0],width:positive(v[2],'trace width'),points:points(v.slice(3),'trace'),fixed:['fix','protect'].includes(state) });
      }
      for (const via of children(wiring,'via')) {
        allowed(via,['net','type','clearance_class'],'via');
        const v = atoms(via), netNode = first(via,'net'), def = board.viaDefs.find(d => d.name === v[1]);
        if (v.length !== 4 || !def || !netNode || !netByName.has(netNode[1])) fail('Each via needs a padstack, net and position from this board.');
        if(netNode[2]&&netNode[2]!=='1')fail('Electrical subnets cannot be loaded yet. Export each connection as one net.');
        if (first(via,'clearance_class') && first(via,'clearance_class')[1] !== 'default') fail('Separate clearance classes for individual vias cannot be applied yet.');
        const state = String(first(via,'type')?.[1] || 'normal');
        if (!['normal','route','fix','protect'].includes(state)) fail('This via protection setting is not recognised: ' + state + '.');
        board.vias.push({ x:n(v[2]),y:n(v[3]),padstack:def.name,net:netByName.get(netNode[1]).id,diameter:def.diameter,layers:everyLayer.filter(l=>l>=def.fromLayer&&l<=def.toLayer),fixed:['fix','protect'].includes(state) });
      }
    }
    if(/^\s*;\s*RamenRouter copper fills/m.test(text))board.warnings.push("Saved copper-area settings are no longer used. Physical copper already in this DSN has been kept.");
    return applyBoardScale(board,scaleChoice?.profile||'auto');
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
    if (!Number.isFinite(v)) throw new Error('Export stopped because a coordinate or dimension is invalid.');
    return String(clean(Number(v.toFixed(10))));
  }
  function clearRoutingDsn(board) {
    if (!board._ast) throw new Error('Reload the original DSN before clearing its routing.');
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
    if (!board._ast) throw new Error('Reload the original DSN before changing its routing rules.');
    if (!Array.isArray(changes)) throw new Error('The net-rule changes are invalid. Reopen Routing rules and try again.');
    const ast = clone(board._ast), network = first(ast,'network');
    if (!network) throw new Error('The original DSN has no net list. Reload a complete board export.');
    const nets=board.nets.map(net=>({...net}));
    const netById = new Map(nets.map(net=>[net.id,net])), nodesByName = new Map(children(network,'net').map(net=>[net[1],net]));
    const layerNames = new Map(board.layers.map(layer=>[layer.index,layer.name])), seen = new Set();
    for (const change of changes) {
      const net = change && netById.get(change.netId);
      if (!net || !Number.isInteger(change.netId)) throw new Error('A net in these routing-rule changes is missing from the board.');
      if (seen.has(net.id)) throw new Error('More than one rule change was supplied for net ' + net.name + '.');
      seen.add(net.id);
      const hasLayers=Object.prototype.hasOwnProperty.call(change,'layers'),hasShort=Object.prototype.hasOwnProperty.call(change,'preferShort');
      if(!hasLayers&&!hasShort)throw new Error('Choose a routing rule to change for net '+net.name+'.');
      if(hasShort) {
        if(typeof change.preferShort!=='boolean')throw new Error('Set Prefer shorter routes to on or off.');
        net.preferShort=change.preferShort;
      }
      if(!hasLayers)continue;
      if (!Array.isArray(change.layers) || !change.layers.length) throw new Error('Choose at least one routing layer for net ' + net.name + '.');
      if (change.layers.some(layer=>!Number.isInteger(layer)||!layerNames.has(layer))) throw new Error('Unknown routing layer for net ' + net.name + '.');
      if(new Set(change.layers).size!==change.layers.length)throw new Error('Each allowed layer needs to appear only once.');
      if(net.useLayers?.length===change.layers.length&&net.useLayers.every(layer=>change.layers.includes(layer)))continue;
      const node = nodesByName.get(net.name);
      if (!node) throw new Error('The original DSN is missing net ' + net.name + '.');
      let circuit = first(node,'circuit');
      if (!circuit) { circuit = ['circuit']; node.push(circuit); }
      const layerRule = ['use_layer',...[...new Set(change.layers)].sort((a,b)=>a-b).map(layer=>layerNames.get(layer))];
      const index = circuit.findIndex(child=>tag(child)==='use_layer');
      if (index < 0) circuit.push(layerRule); else circuit[index] = layerRule;
    }
    if((board.copperFills||[]).length){
      const index=ast.findIndex(node=>tag(node)==='wiring'),wiring=routedWiringWrite(board);
      if(index<0)ast.push(wiring);else ast[index]=wiring;
    }
    return boardMetadataWrite(board,nets)+astWrite(ast)+'\n';
  }
  function setNetRoutingLayers(board, changes) {return setNetRoutingRules(board,changes);}
  function setBoardScale(board,profile) {
    const scaled=applyBoardScale({...board,units:{...board.units}},profile);
    // Write current checked tracks and vias, not just the original import's AST.
    // The saved choice changes measurements only; all CAD numbers stay native.
    return exportDsn(scaled,board.filename||board.name||'board.dsn');
  }
  function copperWiresWrite(board){
    if(!Array.isArray(board.copperFills||[])||(board.copperFills||[]).length>100000)throw new Error('Export stopped because the imported copper list is invalid or too large.');
    const out=[];
    for(const fill of board.copperFills||[]){
      if(fill.imported!==true||fill.fixed!==true)throw new Error('Export stopped because this copper was not part of the imported DSN. Reload the original board and route its nets with traces and vias.');
      if(fill._dsnPlane)continue;
      if(!fill._dsnWire)throw new Error('Export stopped because an imported copper area is missing its original DSN shape. Reload the original board.');
      // Retain the input's physical copper exactly, including its windows,
      // rectangle/polygon syntax, precision and per-region protection.
      out.push(clone(fill._dsnWire));
    }
    return out;
  }
  function routedWiringWrite(board){
    const netNames=new Map(board.nets.map(net=>[net.id,net.name]));
    const wiring = ['wiring'];
    for (const trace of board.traces) {
      const name = netNames.get(trace.net), layer = board.layers[trace.layer]?.name;
      if (!name || !layer || trace.points.length < 2) throw new Error('Export stopped because a track has an invalid net, layer or path.');
      wiring.push(['wire',['path',layer,nativeNumber(trace.width),...trace.points.flatMap(p=>p.map(nativeNumber))],['net',name],['type',trace.fixed?'protect':'route']]);
    }
    for (const via of board.vias) {
      const name = netNames.get(via.net), def = board.viaDefs.find(d=>d.name===via.padstack);
      if (!name || !def) throw new Error('Export stopped because a via has an invalid net or padstack.');
      wiring.push(['via',via.padstack,nativeNumber(via.x),nativeNumber(via.y),['net',name],['type',via.fixed?'protect':'route']]);
    }
    wiring.push(...copperWiresWrite(board));
    return wiring;
  }
  function exportRoutedDsn(board,filename=board.filename||board.name||'board.dsn'){
    return exportDsn(board,filename);
  }
  function exportDsn(board, filename = board.filename || board.name || 'board.dsn') {
    if (!board._ast) throw new Error('Reload the original DSN before exporting so its board rules can be kept.');
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
      if(!Number.isFinite(value))throw new Error('SES export stopped because a coordinate or dimension is invalid.');
      largest=Math.max(largest,Math.abs(value));
    };
    if(board.bounds)for(const value of Object.values(board.bounds))consider(value);
    for(const trace of board.traces){consider(trace.width);for(const p of trace.points){consider(p[0]);consider(p[1]);}}
    for(const via of board.vias){consider(via.x);consider(via.y);}
    for(const via of board.viaDefs)consider(via.diameter);
    // Keep sub-micron contacts and edge margins when native units are small.
    // The 32-bit bound below still takes precedence for large board origins.
    const desired=Math.ceil(Math.max(originalResolution,1000000));
    const allowedResolution=largest===0?limit:Math.min(limit,Math.floor(limit/largest));
    let resolution=Math.min(desired,allowedResolution);
    if(!Number.isSafeInteger(resolution)||resolution<1)throw new Error('This board’s coordinates are too large for SES. Check the board origin and scale in your PCB editor.');
    function checked(value){
      if(!Number.isSafeInteger(value)||Math.abs(value)>limit)throw new Error('A coordinate is outside the SES 32-bit range. Check the board origin and scale in your PCB editor.');
      return String(value===0?0:value);
    }
    const position=value=>checked(Math.round(value*resolution));
    const dimension=value=>{
      if(!(value>0)&&Number.isFinite(value))throw new Error('SES export needs track widths and via diameters greater than zero.');
      const scaled=value*resolution;
      // Ignore only binary floating-point noise at an integer boundary. Genuine
      // fractional widths/diameters always round outward, never to a thinner size.
      const noise=Number.EPSILON*Math.max(1,Math.abs(scaled))*4;
      return checked(Math.max(1,Math.ceil(scaled-noise)));
    };
    // SES coordinates round to the nearest integer and copper rounds outward.
    // At an exact spacing limit that can consume a legal gap. Check nearby
    // via pairs at the actual exported sizes, then increase precision without
    // moving a via or reducing its copper. Existing input issues remain visible.
    const spacingEps=1e-8,nets=new Map(board.nets.map(net=>[String(net.id),net])),defs=new Map(board.viaDefs.map(def=>[def.name,def]));
    const pairClearance=(a,b)=>{
      const base=Math.max(0,board.crossClassClearance??board.defaultClearance??0);
      if(board.clearanceMode!=='specctra-class-matrix')return Math.max(0,a?.clearance??base,b?.clearance??base);
      if(!a||!b)return base;
      const ca=a.clearanceClass??'default',cb=b.clearanceClass??'default';
      const value=c=>Math.max(0,board.classClearances?.[c]??(c===ca?a.clearance:b.clearance)??base);
      return ca===cb?value(ca):Math.max(base,value(ca),value(cb));
    };
    const vias=board.vias.map(via=>{
      const def=defs.get(via.padstack);
      if(!def)throw new Error('SES export stopped because a via type is missing. Reload the original DSN.');
      return {via,def,net:nets.get(String(via.net)),diameter:via.diameter??def.diameter,layers:via.layers||Array.from({length:def.toLayer-def.fromLayer+1},(_,i)=>def.fromLayer+i)};
    });
    const maxDiameter=vias.reduce((value,item)=>Math.max(value,item.diameter),board.viaDefs.reduce((value,def)=>Math.max(value,def.diameter),0));
    const maxClearance=Object.values(board.classClearances||{}).reduce((value,clearance)=>Math.max(value,clearance),board.nets.reduce((value,net)=>Math.max(value,net.clearance||0),Math.max(0,board.crossClassClearance||0,board.defaultClearance||0)));
    const cell=maxDiameter+maxClearance+(Math.SQRT2+1)/resolution+spacingEps,pairs=[],bins=new Map();let inputSpacingIssues=0;
    for(const item of vias){
      const x=Math.floor(item.via.x/cell),y=Math.floor(item.via.y/cell);
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const other of bins.get((x+dx)+':'+(y+dy))||[]){
        if(!item.layers.some(layer=>other.layers.includes(layer)))continue;
        const distance=Math.hypot(item.via.x-other.via.x,item.via.y-other.via.y),required=pairClearance(other.net,item.net);
        if(distance>maxDiameter+required+(Math.SQRT2+1)/resolution+spacingEps)continue;
        const gap=distance-(item.diameter+other.diameter)/2;
        if(gap+spacingEps<required||(String(item.via.net)!==String(other.via.net)&&gap<=spacingEps)){inputSpacingIssues++;continue;}
        pairs.push({a:item,b:other,required});
      }
      const key=x+':'+y;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(item);
    }
    const spacingSafe=()=>pairs.every(({a,b,required})=>{
      const dx=Number(position(a.via.x))-Number(position(b.via.x)),dy=Number(position(a.via.y))-Number(position(b.via.y));
      const gap=(Math.hypot(dx,dy)-(Number(dimension(a.def.diameter))+Number(dimension(b.def.diameter)))/2)/resolution;
      return gap+spacingEps>=required;
    });
    // Check the actual serialized copper against the board outline as well.
    // Merely raising the usual precision can still round an exact edge margin
    // outward, especially on a diagonal boundary or a board with a large origin.
    const geometryFactory=typeof globalThis.createRamenGeometry==='function'?globalThis.createRamenGeometry:typeof require==='function'&&typeof module!=='undefined'&&module.exports?require('./geometry.js').createRamenGeometry:null;
    if(!geometryFactory)throw new Error('SES export needs the geometry checker. Reload RamenRouter and try again.');
    const geometry=geometryFactory(),edges=geometry.boundaryEdges(board),edgeObjects=[];
    let originalEdgeIssues=0;
    const edgeTolerance=Number.EPSILON*Math.max(1,largest)*32;
    const edgeSafe=(points,radius,clearance)=>{
      const shape=points.length===1?{type:'circle',cx:points[0][0],cy:points[0][1],r:radius}:{type:'capsule',a:points[0],b:points[1],r:radius};
      if(!geometry.shapeInsideBoard(shape,board,edges,0))return false;
      if(points.length===1)return edges.every(([a,b])=>geometry.distancePointSegment(points[0][0],points[0][1],a,b)+edgeTolerance>=radius+clearance);
      return edges.every(([a,b])=>geometry.distanceSegments(points[0],points[1],a,b)+edgeTolerance>=radius+clearance);
    };
    for(const trace of board.traces)for(let index=1;index<trace.points.length;index++){
      const points=[trace.points[index-1],trace.points[index]],clearance=geometry.boardEdgeClearance(board,'trace');
      if(edgeSafe(points,trace.width/2,clearance))edgeObjects.push({points,diameter:trace.width,clearance});else originalEdgeIssues++;
    }
    for(const {via,def} of vias){
      const points=[[via.x,via.y]],clearance=geometry.boardEdgeClearance(board,'via');
      if(edgeSafe(points,def.diameter/2,clearance))edgeObjects.push({points,diameter:def.diameter,clearance});else originalEdgeIssues++;
    }
    const routingEdgeSafe=()=>edgeObjects.every(item=>edgeSafe(item.points.map(p=>p.map(value=>Number(position(value))/resolution)),Number(dimension(item.diameter))/resolution/2,item.clearance));
    let precisionIncreases=0,edgePrecisionIncreases=0,spacingPrecisionIncreases=0;
    while(!spacingSafe()||!routingEdgeSafe()){
      const edgeFailed=!routingEdgeSafe();if(edgeFailed)edgePrecisionIncreases++;if(!spacingSafe())spacingPrecisionIncreases++;
      if(precisionIncreases>=6||resolution>=allowedResolution)throw new Error(edgeFailed?'SES export stopped because rounding would put routing too close to the board edge. Move those routes slightly inward or move the board closer to the origin in your PCB editor, then reload its DSN.':'SES export stopped because rounding would put separate vias too close together. Separate those vias a little or move the board closer to the origin in your PCB editor, then reload its DSN.');
      resolution=Math.min(allowedResolution,precisionIncreases===5?allowedResolution:resolution*10);precisionIncreases++;
    }
    const report={
      originalResolution,resolution,unit:board.units.name,
      viaSpacingPairsChecked:pairs.length,originalViaSpacingIssues:inputSpacingIssues,viaSpacingPrecisionIncreases:spacingPrecisionIncreases,
      routingEdgeObjectsChecked:edgeObjects.length,originalRoutingEdgeIssues:originalEdgeIssues,routingEdgePrecisionIncreases:edgePrecisionIncreases,
      coordinateRounding:'nearest',copperDimensionRounding:'outward ceiling (floating-point noise tolerated)',
      coarserThanInput:resolution<originalResolution,
      maximumCoordinateErrorNative:0,maximumWidthIncreaseNative:0,maximumViaDiameterIncreaseNative:0,
      maximumCoordinateErrorMm:0,maximumWidthIncreaseMm:0,maximumViaDiameterIncreaseMm:0,
      coordinateErrorBoundNative:Math.SQRT2/(2*resolution),copperDimensionIncreaseBoundNative:1/resolution,
      widthsExpanded:0,viaDefinitionsExpanded:0,
      note:'SES rounds coordinates to the resolution shown here. Track widths and via diameters round up by no more than one resolution unit, which can use a little clearance. Your original DSN rules stay the same. Check the imported routes in your PCB editor.'
    };
    if((board.copperFills||[]).length){
      report.copperFillsIncluded=false;report.copperFillCount=board.copperFills.length;
      report.copperWarning='SES contains tracks and vias only. Keep the physical copper from your original DSN in your PCB editor and check the imported routes there.';
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
    const session=['session',sessionName,['base_design',filename],['placement',['resolution',board.units.name,String(resolution)]],['routes',['resolution',board.units.name,String(resolution)],['parser',['host_cad','RamenRouter JavaScript'],['host_version','0.4.4']],library,network]];
    return astWrite(session)+'\n';
  }
  return { parse, exportSes, exportDsn, exportSesReport, clearRoutingDsn, setNetRoutingRules, setNetRoutingLayers, setBoardScale, exportRoutedDsn };
}
if (typeof globalThis !== 'undefined') globalThis.createRamenDSN = createRamenDSN;
if (typeof module !== 'undefined' && module.exports) module.exports = { createRamenDSN };
