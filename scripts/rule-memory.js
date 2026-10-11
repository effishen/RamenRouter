/* Local per-net routing preferences. GPL-3.0-or-later. */
'use strict';
function createRamenRuleMemory() {
  const SCHEMA='ramenrouter-rule-profile',KEY='ramenrouter.rule-profile.v1',MAX_BYTES=512*1024,MAX_NETS=10000,MAX_LAYERS=64;
  const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
  const name=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x1f\x7f]/.test(value);
  const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const exactKeys=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>own(value,key));
  const bytes=value=>new TextEncoder().encode(value).byteLength;
  const same=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
  function invalid(){throw new Error('These saved routing rules are invalid. Use the imported rules or set them again.');}
  function validateProfile(input) {
    if(typeof input==='string'){if(input.length>MAX_BYTES||bytes(input)>MAX_BYTES)invalid();try{input=JSON.parse(input);}catch(_){invalid();}}
    if(!exactKeys(input,['schema','version','matchFingerprint','sourceName','layers','nets'])||input.schema!==SCHEMA||input.version!==1||!hash(input.matchFingerprint)||typeof input.sourceName!=='string'||input.sourceName.length>160||/[\x00-\x1f\x7f]/.test(input.sourceName))invalid();
    if(!Array.isArray(input.layers)||input.layers.length<1||input.layers.length>MAX_LAYERS||input.layers.some(layer=>!name(layer))||new Set(input.layers).size!==input.layers.length||!Array.isArray(input.nets)||input.nets.length<1||input.nets.length>MAX_NETS)invalid();
    const allowed=new Set(input.layers),seen=new Set(),nets=[];
    for(const net of input.nets){
      if(!exactKeys(net,['name','layers','preferShort'])||!name(net.name)||seen.has(net.name)||typeof net.preferShort!=='boolean'||!Array.isArray(net.layers)||!net.layers.length||net.layers.length>input.layers.length||net.layers.some(layer=>!allowed.has(layer))||new Set(net.layers).size!==net.layers.length)invalid();
      seen.add(net.name);nets.push({name:net.name,layers:input.layers.filter(layer=>net.layers.includes(layer)),preferShort:net.preferShort});
    }
    nets.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    const profile={schema:SCHEMA,version:1,matchFingerprint:input.matchFingerprint,sourceName:input.sourceName,layers:input.layers.slice(),nets};
    if(bytes(JSON.stringify(profile))>MAX_BYTES)invalid();return profile;
  }
  function topology(board) {
    const layers=board?.layers,nets=board?.nets;if(!Array.isArray(layers)||layers.length<1||layers.length>MAX_LAYERS||!Array.isArray(nets)||!nets.length||nets.length>MAX_NETS)return null;
    const layerNames=layers.map(layer=>layer.name);if(layerNames.some(layer=>!name(layer))||new Set(layerNames).size!==layerNames.length)return null;
    const seen=new Set(),records=[];let pins=0;
    for(const net of nets){if(!name(net.name)||seen.has(net.name)||!Array.isArray(net.pins)||net.pins.some(pin=>!name(pin))||new Set(net.pins).size!==net.pins.length)return null;seen.add(net.name);pins+=net.pins.length;if(pins>100000)return null;records.push({name:net.name,pins:net.pins.slice().sort()});}
    records.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
    const value=JSON.stringify({schema:'ramenrouter-rule-topology-v1',layers:layerNames,nets:records});return bytes(value)<=4*1024*1024?value:null;
  }
  async function fingerprintBoard(board,hashText){const value=topology(board);if(value===null)return null;if(typeof hashText!=='function')throw new Error('The board-matching check is unavailable. Use the imported routing rules for this board.');const valueHash=await hashText(value);return hash(valueHash)?valueHash:null;}
  function makeProfile(board,matchFingerprint,sourceName='') {
    if(!hash(matchFingerprint))return null;
    try {
      const layerNames=(board.layers||[]).map(layer=>layer.name),byId=new Map((board.layers||[]).map(layer=>[layer.index,layer.name]));
      return validateProfile({schema:SCHEMA,version:1,matchFingerprint,sourceName:String(sourceName).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,160),layers:layerNames,nets:(board.nets||[]).map(net=>({name:net.name,layers:net.useLayers?net.useLayers.map(id=>byId.get(id)):layerNames.slice(),preferShort:net.preferShort===true}))});
    } catch(_){return null;}
  }
  function proposal(profile,board,matchFingerprint) {
    if(!profile||!hash(matchFingerprint))return null;
    try{profile=validateProfile(profile);}catch(_){return null;}
    const layers=(board?.layers||[]).map(layer=>layer.name),nets=board?.nets;
    if(profile.matchFingerprint!==matchFingerprint||!same(profile.layers,layers)||!Array.isArray(nets)||nets.length!==profile.nets.length)return null;
    const byName=new Map(nets.map(net=>[net.name,net])),layerIds=new Map(board.layers.map(layer=>[layer.name,layer.index]));if(byName.size!==nets.length)return null;
    const changes=[];
    for(const saved of profile.nets){const current=byName.get(saved.name);if(!current||!Number.isInteger(current.id))return null;const wanted=saved.layers.map(layer=>layerIds.get(layer)),existing=current.useLayers||board.layers.map(layer=>layer.index);if(wanted.some(id=>!Number.isInteger(id)))return null;if(existing.length!==wanted.length||existing.some(layer=>!wanted.includes(layer))||(current.preferShort===true)!==saved.preferShort)changes.push({netId:current.id,layers:wanted,preferShort:saved.preferShort});}
    return changes.length?{changes,changedNets:changes.length,matchedNets:nets.length}:null;
  }
  function createStore(storage=null) {
    let remembered=null,persistent=false;
    try{const raw=storage?.getItem(KEY);if(raw!==null&&raw!==undefined)remembered=validateProfile(raw);persistent=!!storage;}catch(_){remembered=null;}
    return {get(){return remembered?validateProfile(remembered):null;},save(value){let valid;try{valid=validateProfile(value);}catch(_){return {saved:false,persistent:false};}remembered=valid;try{if(!storage)throw new Error('Session only');storage.setItem(KEY,JSON.stringify(valid));persistent=true;}catch(_){persistent=false;}return {saved:true,persistent};},get persistent(){return persistent;}};
  }
  return {fingerprintBoard,makeProfile,validateProfile,proposal,createStore,storageKey:KEY,maxBytes:MAX_BYTES};
}
if(typeof module!=='undefined'&&module.exports)module.exports=createRamenRuleMemory;
if(typeof globalThis!=='undefined')globalThis.createRamenRuleMemory=createRamenRuleMemory;
