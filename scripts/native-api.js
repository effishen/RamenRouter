/* RamenRouter browser host. GPL-3.0-or-later. No server, runtime or network. */
'use strict';
(() => {
  const active = new Set(['inspecting','starting','running','pausing','paused','stopping','clearing','updating_rules']);
  const subscribers = new Set(), activitySubscribers = new Set();
  const benchmark=createRamenBenchmark();
  const hostGeometry=createRamenGeometry(),ruleMemory=createRamenRuleMemory();
  let profileStorage=null;try{profileStorage=globalThis.localStorage;}catch(_){}
  const ruleProfileStore=ruleMemory.createStore(profileStorage);let pendingRuleReuse=null;
  let benchmarkEnvironment={animationEnabled:true};
  let activitySequence=0;
  let job = null, worker = null, workerUrl = null, inputText = null;
  let board = null, preview = null, exports = null, bestChecked = null, clearTransaction = null, ruleTransaction = null, importedNetRules = null, serial = 0, timer = null, watchdog = null;
  const logs = [];
  const base = {appVersion:'0.2.22',engineVersion:'Ramen JS 0.2.22',fanoutVersion:'Ramen SMD escape'};
  function notifyActivity() {
    const update={jobId:job?.id,state:job?.state,phase:job?.phase,activity:job?.activity,lastEngineUpdateAt:job?.lastEngineUpdateAt,operation:job?.operation,counters:job?.counters,deadlineAt:job?.deadlineAt,remainingSeconds:remaining(),startedAt:job?.startedAt,endedAt:job?.endedAt,pausedAt:job?.pausedAt,pausedDurationMs:job?.pausedDurationMs,budgetGeneration:job?.budgetGeneration};
    for(const fn of activitySubscribers){try{fn(update);}catch(_){}}
  }
  function notify() { notifyActivity(); for (const fn of subscribers) { try { fn(state()); } catch (_) {} } }
  function log(message) {
    logs.push(new Date().toLocaleTimeString() + '  ' + String(message));
    if (logs.length > 20000) logs.splice(0,logs.length-20000);
  }
  function elapsed() { return job ? Math.max(0,((job.endedAt||job.pausedAt||Date.now())-job.startedAt-(job.pausedDurationMs||0))/1000) : 0; }
  function remaining() { return job?.operation==='run'&&Number.isFinite(job.deadlineAt)?Math.max(0,(job.deadlineAt-(job.endedAt??Date.now()))/1000):null; }
  function state() { return {...base,job:job?{...job,elapsedSeconds:elapsed(),remainingSeconds:remaining(),log:logs.slice(-180)}:null}; }
  function kill() {
    if(job?.activity)job.activity={...job.activity,visual:null,sequence:++activitySequence};
    if(worker) {worker.onmessage=null;worker.onerror=null;worker.terminate();} worker=null;
    if(workerUrl) URL.revokeObjectURL(workerUrl); workerUrl=null;
    clearTimeout(timer); timer=null; clearTimeout(watchdog); watchdog=null;
  }
  function rememberChecked(m) {
    if(!m.board||!m.preview||!m.exports||!m.stats?.drcChecked||!m.stats?.widthRulesChecked)return;
    bestChecked={board:m.board,preview:m.preview,stats:m.stats,exports:m.exports,advice:m.advice||{items:[]},fromInput:!!m.fromInput};
    job.bestResult={available:true,unrouted:m.stats.unrouted,traceCount:m.stats.traceCount,viaCount:m.stats.viaCount,fromInput:!!m.fromInput};
  }
  function routingSummary(b) {
    return {traceCount:(b?.traces||[]).length,viaCount:(b?.vias||[]).length,
      fixedTraceCount:(b?.traces||[]).filter(t=>t.fixed).length,fixedViaCount:(b?.vias||[]).filter(v=>v.fixed).length};
  }
  function netLayerSettings(b) {
    const directions=createRamenRouter().layerDirections(b?.layers||[]);
    const layers=(b?.layers||[]).map(layer=>({id:layer.index,name:layer.name,preferredDirection:directions.get(layer.index)||null})),all=layers.map(layer=>layer.id);
    const padsByNet=new Map();
    for(const pad of b?.pads||[]) {
      if(!padsByNet.has(pad.net))padsByNet.set(pad.net,[]);
      padsByNet.get(pad.net).push([...new Set(pad.shapes.map(shape=>shape.layer))]);
    }
    const nets=(b?.nets||[]).map(net=>({id:net.id,name:net.name,
      allowedLayers:[...(net.useLayers||all)],importedLayers:[...(importedNetRules?.[net.id]?.layers||net.useLayers||all)],
      preferShort:net.preferShort===true,importedPreferShort:importedNetRules?.[net.id]?.preferShort??(net.preferShort===true),
      padLayers:padsByNet.get(net.id)||[]}));
    return {jobId:job?.id,layers,nets};
  }
  function updateLayerRules() {
    if(!job||!board)return;
    const settings=netLayerSettings(board),nets=new Map(settings.nets.map(net=>[net.id,net])),rawNets=new Map(board.nets.map(net=>[net.id,net]));
    const same=(a,b)=>a.length===b.length&&a.every(layer=>b.includes(layer));
    job.layerRulesChanged=settings.nets.some(net=>!same(net.allowedLayers,net.importedLayers)||net.preferShort!==net.importedPreferShort);
    job.layerRuleSummary={restrictedNets:settings.nets.filter(net=>net.allowedLayers.length<settings.layers.length).length,
      totalNets:settings.nets.length,shortRouteNets:settings.nets.filter(net=>net.preferShort).length,
      conflictingTraces:(board.traces||[]).filter(trace=>nets.has(trace.net)&&!nets.get(trace.net).allowedLayers.includes(trace.layer)&&!hostGeometry.isPermittedLayerEscape(board,trace,rawNets.get(trace.net))).length,
      inaccessiblePads:settings.nets.reduce((count,net)=>count+net.padLayers.filter(layers=>!layers.some(layer=>net.allowedLayers.includes(layer))).length,0)};
    job.routingRulesChanged=job.layerRulesChanged;job.routingRuleSummary=job.layerRuleSummary;
  }
  function rememberRuleProfile() {
    if(!job||!board||!job.ruleMatchFingerprint)return;
    const profile=ruleMemory.makeProfile(board,job.ruleMatchFingerprint,job.name);
    if(profile)ruleProfileStore.save(profile);
  }
  function offerPreviousRules() {
    pendingRuleReuse=null;job.previousRulesProposal=null;
    const profile=ruleProfileStore.get(),match=ruleMemory.proposal(profile,board,job.ruleMatchFingerprint);
    if(!match){rememberRuleProfile();return;}
    const id=job.id+':'+job.ruleMatchFingerprint;
    pendingRuleReuse={jobId:job.id,id,changes:match.changes};
    job.previousRulesProposal={id,previousName:profile.sourceName||'Previous board',currentName:job.name,changedNets:match.changedNets,matchedNets:match.matchedNets};
    log('This board has the same nets and pins as the previous board. Choose whether to reuse its routing rules.');
  }
  function requireRuleDecision(){if(pendingRuleReuse)throw new Error('Choose whether to reuse the previous routing rules before continuing.');}
  function restoreBeforeRules(message,error=null) {
    kill();
    const saved=ruleTransaction;ruleTransaction=null;
    if(saved) {
      job={...saved.job,ruleError:error};board=saved.board;preview=saved.preview;
      exports=saved.exports;bestChecked=saved.bestChecked;inputText=saved.inputText;pendingRuleReuse=saved.pendingRuleReuse||null;
    }
    log(message);notify();return state();
  }
  function restoreBeforeClear(message,error=null) {
    kill();
    const saved=clearTransaction;clearTransaction=null;
    if(saved) {
      job={...saved.job,clearError:error};board=saved.board;preview=saved.preview;
      exports=saved.exports;bestChecked=saved.bestChecked;inputText=saved.inputText;pendingRuleReuse=saved.pendingRuleReuse||null;
    }
    log(message);notify();return state();
  }
  function freezeRunReport(status) {
    if(job?.operation!=='run'||!job.runReport)return;
    const retained=benchmark.cleanStats(bestChecked?.stats),report=job.runReport;
    const pausedMs=report.timing.pausedMs+(job.benchmarkPauseReceivedAt!==null&&job.benchmarkPauseReceivedAt!==undefined?Math.max(0,performance.now()-job.benchmarkPauseReceivedAt):0);
    const progress=report.progress.map(point=>({...point})),last=progress.at(-1);
    if(retained&&(!last||last.unrouted!==retained.unrouted||last.traceLengthMm!==retained.traceLengthMm||last.viaCount!==retained.viaCount||last.ruleIssues!==retained.totalViolations)){progress.push({activeMs:report.timing.measuredThroughMs,unrouted:retained.unrouted,traceLengthMm:retained.traceLengthMm,viaCount:retained.viaCount,ruleIssues:retained.totalViolations});if(progress.length>256)progress.splice(1,1);}
    job.runReport={...report,status,final:retained,complete:benchmark.completeStats(retained),progress,timing:{...report.timing,pausedMs},coverage:{partial:true},environment:{...report.environment,...job.benchmarkEnvironment}};
  }
  function stopWithBest(reason,message) {
    if(clearTransaction)return restoreBeforeClear(message+' Routing was not cleared; the previous board is unchanged.');
    if(ruleTransaction)return restoreBeforeRules(message+' Routing rules were not changed; the previous board is unchanged.');
    freezeRunReport(reason);kill();job.stopReason=reason;job.state=reason;job.phase=reason;job.endedAt=Date.now();job.suggestions={};
    if(job.pausedAt){job.pausedDurationMs=(job.pausedDurationMs||0)+job.endedAt-job.pausedAt;job.pausedAt=null;}
    if(bestChecked) {
      board=bestChecked.board;preview=bestChecked.preview;exports=bestChecked.exports;
      job.stats={...bestChecked.stats};job.routingSummary=routingSummary(board);updateLayerRules();job.advice=bestChecked.advice;job.hasOutput=true;job.revision++;
      log(message+' Best checked result retained: '+job.stats.unrouted+' incomplete.');
    } else {
      board=null;preview=null;exports=null;job.stats=null;job.routingSummary=null;job.advice={items:[]};job.hasOutput=false;
      log(message+' No checked result was available yet.');
    }
    notify();return state();
  }
  function armBudgetTimer(id) {
    clearTimeout(timer);clearTimeout(watchdog);timer=null;watchdog=null;
    const generation=job.budgetGeneration,timeLimit=Math.max(0,job.deadlineAt-Date.now());
    timer=setTimeout(()=>{
      if(id!==serial||!job||!active.has(job.state)||job.budgetGeneration!==generation)return;
      if(job.operation!=='run'){stopWithBest('timed_out','Time budget reached.');return;}
      if(job.state==='paused'||job.state==='pausing')return;
      job.resumeState=job.state;job.state='pausing';
      if(job.activity)job.activity={...job.activity,visual:null,sequence:++activitySequence};
      worker?.postMessage({type:'pause-budget',generation});
      log('Time budget reached. Pausing at the next safe point; current work will be kept.');notify();
    },timeLimit);
    if(job.operation!=='run')watchdog=setTimeout(()=>{if(id===serial&&job&&active.has(job.state))stopWithBest('timed_out','The worker exceeded its time budget and was terminated.');},timeLimit+30000);
  }
  function getSettings(value={}) {
    const s={fanout:true,fanoutOnly:false,optimize:true,deepSearch:true,viaInPad:false,preferredDirections:false,benchmarkMode:false,maxPasses:12,timeoutMinutes:30,quality:'balanced',...value,neckdown:false};
    // Layer-access-only preparation is derived by the router, never an external setting.
    delete s.layerAccessOnly;
    for(const k of ['fanout','fanoutOnly','optimize','deepSearch','viaInPad','preferredDirections','benchmarkMode']) if(typeof s[k]!=='boolean') throw new Error(k+' must be true or false.');
    for(const [k,min,max] of [['maxPasses',1,100],['timeoutMinutes',1,1440]]) {
      if(!Number.isFinite(s[k])||!Number.isInteger(s[k])||s[k]<min||s[k]>max) throw new Error(k+' must be an integer between '+min+' and '+max+'.');
    }
    if(s.quality!=='balanced')throw new Error('Unknown routing quality setting.');
    for(const key of ['gridStep','viaCost'])if(s[key]!==undefined&&(!Number.isFinite(s[key])||s[key]<=0))throw new Error(key+' must be a finite positive number.');
    if(s.fanoutOnly) s.fanout=true;
    return s;
  }
  function workerMain() {
    // Yield a real task turn without the repeated minimum delay of nested
    // timers. One worker-local queue serves routing, fanout and refinement.
    const yieldQueue=[],yieldChannel=typeof MessageChannel==='function'?new MessageChannel():null;
    if(yieldChannel)yieldChannel.port1.onmessage=()=>yieldQueue.shift()?.();
    const yieldTurn=()=>new Promise(resolve=>{
      if(yieldChannel){yieldQueue.push(resolve);yieldChannel.port2.postMessage(0);}
      else setTimeout(resolve,0);
    });
    let cancelled=false,deadline=Infinity,activityScale=1,lastSpatialAt=-Infinity;
    const benchmark=createRamenBenchmark();let measurement=null,lastMeasurementAt=-Infinity;
    function measured(stage,fn){const end=measurement?.begin(stage);try{const result=fn();if(result?.then)return result.finally(()=>end?.());end?.();return result;}catch(error){end?.();throw error;}}
    function reportSnapshot(status='running',force=false){if(!measurement)return null;const now=performance.now();if(!force&&now-lastMeasurementAt<1000)return null;lastMeasurementAt=now;return measurement.snapshot(status,true);}
    let managedBudget=false,budgetGeneration=0,pauseRequested=false,pauseResolve=null,pausedAt=null,pausedDurationMs=0;
    const yieldTask=async()=>{
      await yieldTurn();
      const runReport=reportSnapshot();if(runReport)self.postMessage({type:'measurement',runReport});
      while(managedBudget&&!cancelled&&(pauseRequested||Date.now()>=deadline)){
        const gate=new Promise(resolve=>{pauseResolve=resolve;});
        pausedAt=Date.now();measurement?.pause();self.postMessage({type:'budget-paused',generation:budgetGeneration,pausedAt,runReport:reportSnapshot('paused',true)});
        await gate;
      }
    };
    yieldTask.managesBudget=true;
    yieldTask.now=()=>{const now=Date.now();return now-pausedDurationMs-(pausedAt?now-pausedAt:0);};
    function resumeBudget(message){
      if(!managedBudget||!Number.isInteger(message.generation)||message.generation<=budgetGeneration||!Number.isFinite(message.deadlineAt))return;
      budgetGeneration=message.generation;deadline=message.deadlineAt;pauseRequested=false;
      if(pausedAt){pausedDurationMs+=Date.now()-pausedAt;pausedAt=null;measurement?.resume();}
      const resolve=pauseResolve;pauseResolve=null;resolve?.();
    }
    let activityNets=new Map();
    function visualInMm(visual) {
      if(!visual||!['pad','via','grid','search','candidate','trace','check'].includes(visual.kind))return null;
      const point=p=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1]);
      const result={kind:visual.kind,units:'mm',label:String(visual.label||'').slice(0,160)};
      if(Number.isInteger(visual.layer))result.layer=visual.layer;
      if(visual.searchId!==undefined)result.searchId=visual.searchId;
      result.points=(visual.points||[]).slice(0,64).filter(point).map(p=>[p[0]*activityScale,p[1]*activityScale,...(Number.isInteger(p[2])?[p[2]]:[])]);
      let remaining=512;result.paths=[];
      for(const path of (visual.paths||[]).slice(0,32)) {
        if(remaining<2)break;
        const points=(path.points||[]).slice(0,remaining);
        if(points.length<2||!points.every(point)||!Number.isInteger(path.layer))continue;
        result.paths.push({layer:path.layer,points:points.map(p=>[p[0]*activityScale,p[1]*activityScale])});remaining-=points.length;
      }
      if(Array.isArray(visual.bounds)&&visual.bounds.length===4&&visual.bounds.every(Number.isFinite))result.bounds=visual.bounds.map(n=>n*activityScale);
      return result;
    }
    const send=data=>{
      if(measurement&&data.counters)measurement.setRounds(data.counters);
      if(data.type==='activity'&&data.activity?.visual){const now=Date.now();if(now-lastSpatialAt<150)return;lastSpatialAt=now;}
      if(data.activity)data={...data,activity:{...data.activity,visual:visualInMm(data.activity.visual)}};
      self.postMessage(data);
    };
    function checkedActivity(activity) {
      const phase=activity.stage==='advising'?'advising':'checking';
      const netName=activityNets.get(activity.netId);
      const label=activity.visual?.label||(phase==='advising'?'Reviewing placement advice':'Checking board geometry');
      send({type:'activity',phase,message:label+(netName?' · '+netName:''),activity:{...activity,netName}});
    }
    const dsn=createRamenDSN(), geo=createRamenGeometry(checkedActivity), advisor=createRamenAdvisor(geo), router=createRamenRouter(geo,createRamenOptimizer(geo,yieldTask),createRamenFanout(geo,yieldTask),yieldTask);
    const stage=(phase,message,activity={},writeLog=true)=>send({type:'progress',phase,message,activity,log:writeLog});
    function placementAdvice(b,initialBoard,includeIncomplete) {
      try {return advisor.analyze(b,{initialBoard,includeIncomplete,onActivity:checkedActivity});}
      catch(error) {send({type:'progress',message:'Placement advice unavailable: '+(error.message||String(error))});return {items:[]};}
    }
    function restrictedSmdNets(b) {
      const candidates=new Set(), copperLayers=new Set(b.layers.map(layer=>layer.index));
      if(copperLayers.size<2)return candidates;
      const nets=new Map(b.nets.map(net=>[net.id,net]));
      for(const pad of b.pads) {
        const padLayers=new Set(pad.shapes.map(shape=>shape.layer)),net=nets.get(pad.net);
        if(padLayers.size!==1||!net)continue;
        const layer=[...padLayers][0],via=b.viaDefs.find(def=>def.name===net.viaName);
        if(!via||!Number.isFinite(via.diameter)||via.diameter<=0||!Number.isInteger(via.fromLayer)||!Number.isInteger(via.toLayer)||via.fromLayer>=via.toLayer||!copperLayers.has(via.fromLayer)||!copperLayers.has(via.toLayer))continue;
        if(b.viaAtSmd&&via.attachAllowed)continue;
        const permitted=(net.useLayers||[...copperLayers]).filter(value=>copperLayers.has(value)&&value>=via.fromLayer&&value<=via.toLayer);
        if(layer>=via.fromLayer&&layer<=via.toLayer&&permitted.some(value=>value!==layer))candidates.add(net.id);
      }
      return candidates;
    }
    function stats(b,full=true,connection=null,validation=null) {
      const c=connection||geo.connectivity(b),v=full?(validation||geo.validate(b)):null;
      let length=0; for(const t of b.traces||[]) for(let i=1;i<t.points.length;i++) length+=Math.hypot(t.points[i][0]-t.points[i-1][0],t.points[i][1]-t.points[i-1][1]);
      return {unrouted:c.unrouted,viaCount:(b.vias||[]).length,traceCount:(b.traces||[]).length,traceLengthMm:length*b.units.mmPerUnit,
        inactiveLayerViolations:v?v.violations.filter(issue=>issue.type==='inactive_layer').length:null,clearanceViolations:v?v.clearanceViolations:null,totalViolations:v?(v.totalViolations??v.clearanceViolations):null,viaInPadViolations:v?v.viaInPadViolations:null,outlineViolations:v?v.outlineViolations:null,keepoutViolations:v?v.keepoutViolations:null,drcChecked:!!v,belowNominalWidthTraceCount:v?v.belowNominalWidthTraceCount:null,widthRulesChecked:!!v,
        netCount:b.nets.length,componentCount:new Set(b.pads.map(p=>p.component)).size,layerCount:b.layers.length};
    }
    function geometry(b,connection=null) {
      const s=b.units.mmPerUnit,p=([x,y])=>[x*s,y*s],names=new Map(b.nets.map(net=>[net.id,net.name])),name=n=>names.get(n)||'';
      const pads=[];
      for(const pad of b.pads) for(const sh of pad.shapes) {
        const item={layer:sh.layer,x:pad.x*s,y:pad.y*s,component:pad.component,net:name(pad.net)};
        if(sh.type==='circle') {item.x=sh.cx*s;item.y=sh.cy*s;item.radius=sh.r*s;}
        else {item.points=sh.points.map(p);item.radius=0;}
        pads.push(item);
      }
      const air=(connection||geo.connectivity(b)).airwires||[];
      return {units:'mm',bounds:[b.bounds.minX*s,b.bounds.minY*s,b.bounds.maxX*s,b.bounds.maxY*s],
        layers:b.layers.map(l=>({id:l.index,name:l.name,signal:true})),
        traces:(b.traces||[]).map(t=>({layer:t.layer,width:t.width*s,points:t.points.map(p),net:name(t.net)})),pads,
        vias:(b.vias||[]).map(v=>({x:v.x*s,y:v.y*s,radius:v.diameter*s/2,net:name(v.net),fromLayer:Math.min(...v.layers),toLayer:Math.max(...v.layers)})),
        outlines:(b.outlines||[]).map(poly=>poly.map(p)),
        airwires:air.map(a=>({net:name(a.net),points:(a.points||[a.from,a.to]).map(p)}))};
    }
    async function checkedResult(result,initialBoard,options,name,initialStats,finalStats,fromInput=false,includeIncomplete=!options.fanoutOnly,prepared=null,writeLog=false) {
      stage('checking','Checking clearances and trace widths for a saved result.',{},writeLog);
      await yieldTask();
      const report=prepared?.validation||measured('checking',()=>geo.validate(result));
      const checkedStats={...finalStats,totalViolations:report.totalViolations??report.clearanceViolations,belowNominalWidthTraceCount:report.belowNominalWidthTraceCount,drcChecked:true,widthRulesChecked:true};
      measurement?.checkpoint(checkedStats,fromInput);
      finalStats=checkedStats;
      stage('advising','Reviewing remaining connections and placement advice.',{},writeLog);
      await yieldTask();
      const advice=measured('advising',()=>placementAdvice(result,initialBoard,includeIncomplete));
      stage('exporting','Preparing the checked preview and downloadable results.',{},writeLog);
      await yieldTask();
      return measured('exporting',()=>({board:result,preview:geometry(result,prepared?.connection),stats:finalStats,advice,fromInput,
        exports:{ses:dsn.exportSes(result,name),dsn:dsn.exportDsn(result,name),report:JSON.stringify({engine:'Ramen JS 0.2.22',settings:options,routingRules:{shorterNets:result.nets.filter(net=>net.preferShort).map(net=>net.name)},units:result.units,bounds:result.bounds,viaInPadApplied:!!result.viaInPadApplied,sesExport:dsn.exportSesReport(result),initialStats,stats:finalStats,checks:report,advice},null,2)}}));
    }
    self.onmessage=async event=>{
      const m=event.data;
      if(m.type==='stop') {cancelled=true;pauseResolve?.();pauseResolve=null;return;}
      if(m.type==='pause-budget'){if(managedBudget&&m.generation===budgetGeneration)pauseRequested=true;return;}
      if(m.type==='extend-budget'){resumeBudget(m);return;}
      if(!['inspect','run','clear','layer-rules'].includes(m.type)) return;
      try {
        cancelled=false;deadline=Number.isFinite(m.deadlineAt)?m.deadlineAt:Date.now()+(m.options?.timeoutMinutes||30)*60000;
        managedBudget=m.type==='run';measurement=managedBudget?benchmark.createCollector({appVersion:'0.2.22',settings:m.options,environment:m.environment}):null;yieldTask.measurement=measurement;lastMeasurementAt=-Infinity;budgetGeneration=m.budgetGeneration||0;pauseRequested=false;pausedAt=null;pausedDurationMs=0;
        if(measurement){const end=measurement.begin('fingerprinting');const boardFingerprint=await benchmark.fingerprint(m.text),workloadFingerprint=await benchmark.fingerprint(JSON.stringify({boardFingerprint,settings:benchmark.cleanSettings(m.options),appVersion:'0.2.22',protocol:m.options.benchmarkMode?'fixed-work-v1':'normal-v1'}));measurement.setFingerprints(boardFingerprint,workloadFingerprint);end();}
        stage('reading','Reading the DSN board and its routing rules.');
        await yieldTask();
        const b=measured('reading',()=>dsn.parse(m.text,m.name));measurement?.setNets(b.nets);
        // Apply the run's chosen policy before checking or saving its input fallback.
        if(m.type==='run'&&typeof m.options.viaInPad==='boolean'){
          b.viaAtSmd=m.options.viaInPad;for(const def of b.viaDefs)def.attachAllowed=m.options.viaInPad;
          b.viaInPadApplied=m.options.viaInPad;b.viaInPadOverride=m.options.viaInPad;
        }
        activityScale=b.units.mmPerUnit;activityNets=new Map(b.nets.map(net=>[net.id,net.name]));
        stage('checking','Loaded '+b.nets.length+' nets, '+b.pads.length+' pads and '+b.layers.length+' copper layers. Checking the input board.');
        await yieldTask();
        if(m.type==='clear') {
          // No host state changes until parsing, geometry checks, preview and
          // exports have all succeeded in this worker.
          const clearedInput=dsn.clearRoutingDsn(b),cleared=dsn.parse(clearedInput,m.name),finalStats=stats(cleared);
          if(cleared.traces.length||cleared.vias.length)throw new Error('The design still contains routing after clearing.');
          const result=await checkedResult(cleared,cleared,m.options,m.name,finalStats,finalStats,true,false,null,true);
          result.exports.dsn=clearedInput;
          send({type:'cleared',clearedInput,warnings:cleared.warnings||[],...result});return;
        }
        if(m.type==='layer-rules') {
          const editedInput=dsn.setNetRoutingRules(b,m.changes),edited=dsn.parse(editedInput,m.name),finalStats=stats(edited);
          // Forbidden imported traces remain visible and checked. The user can
          // widen the rule or deliberately clear routing before trying again.
          const result=await checkedResult(edited,edited,m.options,m.name,finalStats,finalStats,true,false,null,true);
          result.exports.dsn=editedInput;
          send({type:'rules-updated',editedInput,warnings:edited.warnings||[],...result});return;
        }
        const inputConnection=measured('checking',()=>geo.connectivity(b));await yieldTask();
        const inputValidation=measured('checking',()=>geo.validate(b)),initial=measured('checking',()=>stats(b,true,inputConnection,inputValidation));
        measurement?.checkpoint(initial,true);
        // Build the fallback before routing starts. Stop never has to validate,
        // analyze or serialize copper on the UI thread after terminating work.
        const initialResult=await checkedResult(b,b,m.options,m.name,initial,initial,true,!m.options.fanoutOnly,{connection:inputConnection,validation:inputValidation},true);
        send({type:'loaded',...initialResult,advice:measured('advising',()=>placementAdvice(b,b,false)),checkpointAdvice:initialResult.advice,warnings:b.warnings||[],runReport:reportSnapshot('running',true)});
        await yieldTask();
        if(m.type==='inspect') {
          let ruleMatchFingerprint=null;
          try{ruleMatchFingerprint=await createRamenRuleMemory().fingerprintBoard(b,benchmark.fingerprint);}catch(_){}
          send({type:'ready',ruleMatchFingerprint});return;
        }
        if(m.options.viaInPad===false&&initial.viaInPadViolations){
          const error=new Error('Existing vias inside SMD pads conflict with the current setting. Clear routing & start over, or enable Allow vias in SMD pads. Your existing copper has been kept.');
          error.code='VIA_IN_PAD_CONFLICT';throw error;
        }
        if(initial.inactiveLayerViolations) {
          const error=new Error(initial.inactiveLayerViolations+' imported trace(s) are outside their main routing layers and do not qualify as permitted short pad escapes. Clear routing & start over, or change the net routing rules before routing.');
          error.code='NET_LAYER_CONFLICT';throw error;
        }
        // Identify nets that might benefit from permitting in-pad vias.
        // This does not predict that enabling the option will succeed.
        const padViaCandidates=m.options.viaInPad||m.options.fanoutOnly?new Set():restrictedSmdNets(b);
        let lastPreview=0;
        const out=await router.route(b,m.options,message=>{
          if(typeof message==='string') {send({type:'progress',message});return;}
          if(message.type==='activity'){send(message);return;}
          if(message.counters)measurement?.setRounds(message.counters);
          if(message.type==='checkpoint') {
            const fromInput=message.stats.traceCount===initial.traceCount&&message.stats.viaCount===initial.viaCount&&message.stats.unrouted===initial.unrouted;
            return checkedResult(message.board,b,m.options,m.name,initial,message.stats,fromInput).then(checked=>send({type:'checkpoint',...checked,phase:message.phase,pass:message.pass,counters:message.counters,runReport:reportSnapshot('running',true)}));
          }
          const data={type:'progress',phase:message.phase,pass:message.pass,message:message.message,activity:message.activity,log:message.log,counters:message.counters};
          if(message.board && Date.now()-lastPreview>1200) {
            const connection=measured('checking',()=>geo.connectivity(message.board));
            lastPreview=Date.now();data.board=message.board;data.preview=geometry(message.board,connection);data.stats=message.stats||stats(message.board,false,connection);
          } else if(message.stats) data.stats=message.stats;
          send(data);
        },()=>cancelled);
        stage('checking','Routing search finished. Checking the retained result.');
        await yieldTask();
        const result=out?.board||out||b,finalConnection=measured('checking',()=>geo.connectivity(result));await yieldTask();
        const finalValidation=measured('checking',()=>geo.validate(result)),finalStats=measured('checking',()=>stats(result,true,finalConnection,finalValidation));
        measurement?.checkpoint(finalStats,false);
        const checked=await checkedResult(result,b,m.options,m.name,initial,finalStats,false,!m.options.fanoutOnly,{connection:finalConnection,validation:finalValidation},true);
        // A fully prepared result is terminal; do not park it behind a new
        // budget gate after its final exports have already been generated.
        const endState=cancelled||out?.stopped?'stopped':'completed';
        const suggestions=endState==='completed'&&finalStats.unrouted>0&&padViaCandidates.size&&finalConnection.components.some(component=>component.groups.length>1&&padViaCandidates.has(component.net))?{viaInPad:true}:{};
        if(endState==='completed'&&!m.options.fanoutOnly&&finalStats.unrouted>0&&m.options.preferredDirections&&b.layers.length>1)suggestions.relaxDirections=true;
        measurement?.setRounds(out?.counters);
        send({type:'done',state:endState,suggestions,counters:out?.counters,...checked,runReport:measurement?.finish(endState),
          message:finalStats.unrouted===0?(finalStats.totalViolations?'All connections routed, but '+finalStats.totalViolations+' rule issue(s) remain. Review them in your PCB editor.':'All connections routed. Verify the exported session in your PCB editor.'):finalStats.unrouted+' connections remain; best checked result retained.'});
      } catch(error) {send({type:'error',runReport:measurement?.finish('error'),error:error.message||String(error),code:error.code,stack:error.stack||''});}
    };
  }
  function launch(type,options,changes) {
    const clearing=type==='clear',editingRules=type==='layer-rules',transactional=clearing||editingRules;
    const saved=transactional?{job,board,preview,exports,bestChecked,inputText,pendingRuleReuse}:null;
    const ruleMatchFingerprint=type==='inspect'?null:job?.ruleMatchFingerprint||null;
    const routingCleared=!!job?.routingCleared,layerRulesChanged=!!job?.layerRulesChanged,layerRuleSummary=job?.layerRuleSummary||null;
    kill();
    clearTransaction=clearing?saved:null;ruleTransaction=editingRules?saved:null;pendingRuleReuse=null;
    if(!transactional) {exports=null;preview=null;board=null;bestChecked=null;}
    const id=++serial;
    const source='"use strict";\n'+[createRamenBenchmark,createRamenRuleMemory,createRamenDSN,createRamenGeometry,createRamenOptimizer,createRamenFanout,createRamenRouter,createRamenAdvisor,workerMain].map(fn=>fn.toString()).join('\n')+'\nworkerMain();';
    job={id:String(id),name:job?.name||'board.dsn',state:clearing?'clearing':editingRules?'updating_rules':type==='inspect'?'inspecting':'starting',phase:clearing?'clearing':editingRules?'updating_rules':'loading',startedAt:Date.now(),settings:options,stats:transactional?saved.job.stats:null,initialStats:null,error:null,clearError:null,ruleError:null,hasOutput:false,routingCleared,layerRulesChanged,layerRuleSummary,routingSummary:transactional?routingSummary(board):null,suggestions:{},advice:{items:[]},bestResult:{available:false},revision:0,pass:0};
    job.routingRulesChanged=layerRulesChanged;job.routingRuleSummary=layerRuleSummary;job.ruleMatchFingerprint=ruleMatchFingerprint;job.previousRulesProposal=null;
    job.operation=type;job.counters=null;job.runReport=null;
    job.benchmarkEnvironment={browser:String(globalThis.navigator?.userAgent||'Unknown browser').slice(0,160),userAgent:String(globalThis.navigator?.userAgent||'').slice(0,512),platform:String(globalThis.navigator?.platform||'').slice(0,160),hardwareConcurrency:globalThis.navigator?.hardwareConcurrency||null,workerCount:1,animationEnabled:typeof options.animationEnabled==='boolean'?options.animationEnabled:benchmarkEnvironment.animationEnabled,animationChanged:false};job.benchmarkEnvironment.initialAnimationEnabled=job.benchmarkEnvironment.animationEnabled;job.benchmarkPauseReceivedAt=null;
    if(type==='run')job.runReport=benchmark.createCollector({appVersion:base.appVersion,settings:options,environment:job.benchmarkEnvironment},()=>0).snapshot('running',true);
    job.budgetGeneration=0;job.pausedAt=null;job.pausedDurationMs=0;job.resumeState=null;
    job.deadlineAt=job.startedAt+(type==='run'?options.timeoutMinutes*60000:120000);
    job.lastEngineUpdateAt=null;
    job.activity={message:'Starting browser worker…',phase:job.phase,updatedAt:job.startedAt,source:'host',visual:null,sequence:++activitySequence};
    try {
      workerUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
      worker=new Worker(workerUrl);
    } catch(error) {
      if(clearing)restoreBeforeClear('Routing could not be cleared: '+error.message,error.message);
      if(editingRules)restoreBeforeRules('Routing rules could not be updated: '+error.message,error.message);
      throw error;
    }
    worker.onmessage=e=>{
      if(id!==serial||!job||!active.has(job.state))return;
      const m=e.data;
      if(m.type==='budget-paused'&&(type!=='run'||m.generation!==job.budgetGeneration))return;
      if(type==='run'&&m.runReport)job.runReport={...m.runReport,environment:{...m.runReport.environment,...job.benchmarkEnvironment}};
      if(m.type==='measurement'){notify();return;}
      if(m.type==='budget-paused'){
        if(type!=='run'||m.generation!==job.budgetGeneration)return;
        if(job.state!=='pausing'&&job.state!=='paused')job.resumeState=job.state;
        job.state='paused';job.benchmarkPauseReceivedAt=performance.now();job.pausedAt=Number.isFinite(m.pausedAt)?m.pausedAt:Date.now();
        clearTimeout(timer);timer=null;clearTimeout(watchdog);watchdog=null;
        if(job.activity)job.activity={...job.activity,visual:null,sequence:++activitySequence};
        log('Paused. Add more time to continue this exact work, or stop with the best checked result.');notify();return;
      }
      job.lastEngineUpdateAt=Date.now();
      if(m.counters){job.counters=m.counters;job.pass=m.counters.attempt?.current??job.pass;}
      if(m.type==='activity'||m.message)job.activity={...(m.activity||{}),visual:m.activity?.visual||null,message:String(m.message||m.activity?.visual?.label||'Working on the board'),phase:m.phase||job.phase,updatedAt:job.lastEngineUpdateAt,source:'engine',sequence:++activitySequence};
      // Spatial updates are small and independent of logs, statistics and board previews.
      if(m.type==='activity'){if(m.phase&&!transactional)job.phase=m.phase;notifyActivity();return;}
      if(m.type==='progress'&&transactional){if(m.message&&m.log!==false)log(m.message);notify();return;}
      if(editingRules) {
        if(m.type==='error') {restoreBeforeRules('Routing rules could not be updated: '+m.error,m.error);return;}
        if(m.type!=='rules-updated')return;
        if(!m.board||!m.preview||!m.exports||!m.stats?.drcChecked||!m.stats?.widthRulesChecked||typeof m.editedInput!=='string') {
          restoreBeforeRules('Routing rules could not be updated: the worker did not return a checked result.','The worker did not return a checked result.');return;
        }
        board=m.board;preview=m.preview;exports=m.exports;inputText=m.editedInput;
        job.stats=m.stats;job.initialStats=m.stats;job.routingSummary=routingSummary(board);updateLayerRules();
        job.advice=m.advice||{items:[]};job.hasOutput=true;
        job.state='ready';job.phase='ready';job.endedAt=Date.now();job.revision++;
        rememberChecked(m);ruleTransaction=null;kill();rememberRuleProfile();
        log('Routing rules updated. Existing input routing is retained. Start routing when ready.');
        if(job.layerRuleSummary.conflictingTraces)log(job.layerRuleSummary.conflictingTraces+' imported trace(s) use unselected layers without qualifying as permitted short pad escapes. Clear routing & start over, or change these rules.');
        if(job.layerRuleSummary.inaccessiblePads)log(job.layerRuleSummary.inaccessiblePads+' pad(s) have no copper on a selected main routing layer. The router will try short automatic escapes to nearby outside-pad vias; revise the selected layers if no legal access is available.');
        for(const warning of m.warnings||[])log('Input note: '+warning);
        notify();return;
      }
      if(clearing) {
        if(m.type==='error') {restoreBeforeClear('Routing could not be cleared: '+m.error,m.error);return;}
        if(m.type!=='cleared')return;
        if(!m.board||!m.preview||!m.exports||!m.stats?.drcChecked||!m.stats?.widthRulesChecked||typeof m.clearedInput!=='string'||m.board.traces?.length!==0||m.board.vias?.length!==0) {
          restoreBeforeClear('Routing could not be cleared: the worker did not return a checked, empty result.','The worker did not return a checked, empty result.');return;
        }
        board=m.board;preview=m.preview;exports=m.exports;inputText=m.clearedInput;
        job.stats=m.stats;job.initialStats=m.stats;job.routingSummary=routingSummary(board);updateLayerRules();
        job.advice=m.advice||{items:[]};job.hasOutput=true;job.routingCleared=true;
        job.state='ready';job.phase='ready';job.endedAt=Date.now();job.revision++;
        rememberChecked(m);clearTransaction=null;kill();
        log('All traces and routing vias cleared. Components, pads, connections and design rules are unchanged. Ready to route again.');
        notify();return;
      }
      if(m.type==='checkpoint') {
        rememberChecked(m);
        job.phase=m.phase||'routing';
        job.activity={message:'Saved checked result: '+m.stats.unrouted+' connections remaining.',phase:m.phase||'routing',updatedAt:job.lastEngineUpdateAt,source:'engine',visual:null,sequence:++activitySequence};
        if(!job.lastCheckpointLogAt||Date.now()-job.lastCheckpointLogAt>=5000){log(job.activity.message);job.lastCheckpointLogAt=Date.now();}
        notify();return;
      }
      if(m.message&&m.log!==false)log(m.message);
      if(m.board) {board=m.board;job.routingSummary=routingSummary(board);updateLayerRules();}
      if(m.preview) {preview=m.preview;job.revision++;}
      if(m.stats)job.stats={...job.stats,...m.stats};
      if(m.phase)job.phase=m.phase;
      if(m.pass!==undefined&&!job.counters)job.pass=m.pass;
      if(m.type==='loaded') {
        if(importedNetRules===null)importedNetRules=Object.fromEntries(netLayerSettings(board).nets.map(net=>[net.id,{layers:net.allowedLayers.slice(),preferShort:net.preferShort}]));
        updateLayerRules();
        job.initialStats=m.stats;
        rememberChecked({...m,advice:m.checkpointAdvice||m.advice});
        job.advice=m.advice||{items:[]};
        log('Loaded '+job.name+': '+m.stats.netCount+' nets, '+m.stats.unrouted+' incomplete connections.');
        for(const w of m.warnings||[])log('Input note: '+w);
        if(type==='run'&&job.state!=='stopping') {if(job.state==='pausing'||job.state==='paused')job.resumeState='running';else job.state='running';job.phase='routing';}
      }
      if(m.type==='ready') {job.state=job.stopReason||'ready';job.phase=job.state;job.endedAt=Date.now();kill();if(type==='inspect'&&job.state==='ready'){job.ruleMatchFingerprint=typeof m.ruleMatchFingerprint==='string'&&/^[a-f0-9]{64}$/.test(m.ruleMatchFingerprint)?m.ruleMatchFingerprint:null;offerPreviousRules();}}
      if(m.type==='done') {
        rememberChecked(m);exports=m.exports;job.hasOutput=true;job.state=job.stopReason||m.state;job.phase=job.state;job.endedAt=Date.now();
        job.suggestions=job.state==='completed'?(m.suggestions||{}):{};
        job.advice=m.advice||{items:[]};
        log('Checked result: '+job.stats.unrouted+' incomplete, '+(job.stats.totalViolations??job.stats.clearanceViolations)+' rule issues, '+job.stats.belowNominalWidthTraceCount+' undersized traces.');
        kill();
      }
      if(m.type==='error') {freezeRunReport('error');if(['NET_LAYER_CONFLICT','VIA_IN_PAD_CONFLICT'].includes(m.code)&&bestChecked?.fromInput){board=bestChecked.board;preview=bestChecked.preview;exports=bestChecked.exports;job.stats={...bestChecked.stats};job.routingSummary=routingSummary(board);updateLayerRules();job.advice=bestChecked.advice;job.hasOutput=true;job.revision++;}job.state='error';job.phase='error';job.error=m.error;job.endedAt=Date.now();log('Error: '+m.error);if(m.stack)log(m.stack);kill();}
      notify();
    };
    worker.onerror=e=>{if(id!==serial||!job||!active.has(job.state))return;const message=e.message||'Browser worker failed to start. Use a current Chrome, Edge or Firefox browser.';if(clearing){restoreBeforeClear('Routing could not be cleared: '+message,message);return;}if(editingRules){restoreBeforeRules('Routing rules could not be updated: '+message,message);return;}freezeRunReport('error');job.error=message;job.state='error';job.phase='error';job.endedAt=Date.now();log(job.error);kill();notify();};
    try {worker.postMessage({type,text:inputText,name:job.name,options,changes,environment:job.benchmarkEnvironment,deadlineAt:job.deadlineAt,budgetGeneration:job.budgetGeneration});}
    catch(error) {if(clearing)restoreBeforeClear('Routing could not be cleared: '+error.message,error.message);if(editingRules)restoreBeforeRules('Routing rules could not be updated: '+error.message,error.message);throw error;}
    armBudgetTimer(id);
    notify();return state();
  }
  function requireIdle(){if(job&&active.has(job.state))throw new Error('Stop the current operation before starting another.');}
  async function importText(text,name) {
    requireIdle();if(typeof text!=='string'||!text.trim())throw new Error('The DSN file is empty.');
    if(text.length>64*1024*1024)throw new Error('The DSN file is larger than 64 MiB.');
    if(!/\.dsn$/i.test(name))throw new Error('Choose a Specctra .dsn file.');
    inputText=text;job={name};importedNetRules=null;pendingRuleReuse=null;logs.length=0;
    return launch('inspect',getSettings());
  }
  async function request(path,options={}) {
    const [endpoint,query='']=path.split('?'),params=new URLSearchParams(query);
    let data=options.body;if(typeof data==='string'&&endpoint!=='/api/upload'){try{data=JSON.parse(data);}catch{throw new Error('Invalid settings.');}}
    if(endpoint==='/api/state')return state();
    if(endpoint==='/api/run-report'){if(!job?.runReport)throw new Error('A run report is not available yet.');return structuredClone(job.runReport);}
    if(endpoint==='/api/board'){if(!preview)throw new Error('Board preview is still loading.');return preview;}
    if(endpoint==='/api/raw'){if(!board)throw new Error('Board is still loading.');return structuredClone(board);}
    if(endpoint==='/api/demo')return importText(globalThis.RAMEN_DEMO_DSN,'RamenRouter-demo.dsn');
    if(endpoint==='/api/upload') {
      let text;if(typeof data==='string')text=data;else if(data instanceof Blob)text=await data.text();else if(data instanceof ArrayBuffer||ArrayBuffer.isView(data))text=new TextDecoder().decode(data);else throw new Error('Choose a DSN file.');
      return importText(text,params.get('name')||'board.dsn');
    }
    if(endpoint==='/api/reuse-routing-rules') {
      if(String(options.method||'GET').toUpperCase()!=='POST')throw new Error('Reusing routing rules requires a POST action.');
      requireIdle();
      if(!job||!board||!pendingRuleReuse||data?.jobId!==job.id||data?.proposalId!==pendingRuleReuse.id||pendingRuleReuse.jobId!==job.id)throw new Error('The selected board or routing-rule choice changed. Review the current board again.');
      if(typeof data.reuse!=='boolean')throw new Error('Choose whether to reuse the previous routing rules.');
      if(!data.reuse){pendingRuleReuse=null;job.previousRulesProposal=null;job.ruleError=null;rememberRuleProfile();log('Keeping the newly imported board’s routing rules.');notify();return state();}
      log('Reusing the previous board’s net routing rules. Existing input routing will be retained.');
      return launch('layer-rules',getSettings(job.settings),pendingRuleReuse.changes);
    }
    if(endpoint==='/api/routing-rules'||endpoint==='/api/net-layers') {
      requireIdle();
      if(!inputText||!board||!job)throw new Error('Load a board before choosing routing rules.');
      const method=String(options.method||'GET').toUpperCase();
      if(method==='GET')return netLayerSettings(board);
      if(method!=='POST')throw new Error('Routing rule changes require a confirmed POST action.');
      requireRuleDecision();
      if(typeof data?.jobId!=='string'||data.jobId!==job.id)throw new Error('The selected board changed. Review its routing rules again.');
      if(!Array.isArray(data.changes))throw new Error('Choose the nets and their routing rules.');
      const settings=netLayerSettings(board),nets=new Map(settings.nets.map(net=>[net.id,net]));
      const layerIds=new Set(settings.layers.map(layer=>layer.id)),seen=new Set();
      for(const change of data.changes) {
        if(!change||!Number.isInteger(change.netId)||!nets.has(change.netId))throw new Error('A selected net is unknown. Reload the routing rules.');
        if(seen.has(change.netId))throw new Error('Each net may only be changed once.');
        seen.add(change.netId);
        const hasLayers=Object.prototype.hasOwnProperty.call(change,'layers'),hasShort=Object.prototype.hasOwnProperty.call(change,'preferShort');
        if(!hasLayers&&!hasShort)throw new Error('Choose a routing rule to change.');
        if(hasShort&&typeof change.preferShort!=='boolean')throw new Error('The shorter-route preference must be true or false.');
        if(hasLayers) {
          if(!Array.isArray(change.layers)||!change.layers.length)throw new Error('Every net needs at least one allowed layer.');
          if(change.layers.some(layer=>!Number.isInteger(layer)||!layerIds.has(layer)))throw new Error('Choose only existing copper layers.');
          if(new Set(change.layers).size!==change.layers.length)throw new Error('An allowed layer cannot be listed twice.');
        }
      }
      const changes=data.changes.filter(change=>{const current=nets.get(change.netId);return (Object.prototype.hasOwnProperty.call(change,'layers')&&(current.allowedLayers.length!==change.layers.length||current.allowedLayers.some(layer=>!change.layers.includes(layer))))||
        (Object.prototype.hasOwnProperty.call(change,'preferShort')&&current.preferShort!==change.preferShort);}).map(change=>({netId:change.netId,
          ...(Object.prototype.hasOwnProperty.call(change,'layers')?{layers:change.layers}:{}),
          ...(Object.prototype.hasOwnProperty.call(change,'preferShort')?{preferShort:change.preferShort}:{})}));
      if(!changes.length)return state();
      log('Updating routing rules. The board will return to its input routing.');
      return launch('layer-rules',getSettings(job.settings),changes);
    }
    if(endpoint==='/api/run') {
      requireIdle();requireRuleDecision();if(!inputText)throw new Error('Load a board first.');const settings=getSettings(data||{});logs.length=0;
      log(job?.routingCleared?'Starting browser-native routing from the cleared board. Nominal trace widths are preserved.':'Starting browser-native routing. Original input and nominal trace widths are preserved.');
      if(settings.viaInPad)log('Explicit rule override: vias may attach to SMD pads.');
      if(settings.benchmarkMode)log('Fixed-work benchmark mode enabled. Difficult fanout rows use fixed candidate limits instead of a time cutoff.');
      if(settings.preferredDirections)log('Alternating layer directions enabled: vertical on the first copper layer, then alternating. Shorter-route nets keep their length priority.');
      return launch('run',settings);
    }
    if(endpoint==='/api/extend'){
      if(String(options.method||'GET').toUpperCase()!=='POST')throw new Error('Adding time requires a POST action.');
      if(!job||job.operation!=='run'||!worker||!['pausing','paused'].includes(job.state))throw new Error('This job is not waiting for more time.');
      if(typeof data?.jobId!=='string'||data.jobId!==job.id)throw new Error('The selected job changed. Review the current job before adding time.');
      const minutes=data.timeoutMinutes;
      if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw new Error('Additional time must be a whole number from 1 to 1440 minutes.');
      const now=Date.now();
      if(job.runReport&&job.benchmarkPauseReceivedAt!==null&&job.benchmarkPauseReceivedAt!==undefined)job.runReport.timing={...job.runReport.timing,pausedMs:job.runReport.timing.pausedMs+Math.max(0,performance.now()-job.benchmarkPauseReceivedAt)};
      job.benchmarkPauseReceivedAt=null;
      if(job.pausedAt){job.pausedDurationMs+=now-job.pausedAt;job.pausedAt=null;}
      job.budgetGeneration++;job.deadlineAt=now+minutes*60000;job.state=job.resumeState==='starting'?'starting':'running';job.resumeState=null;
      worker.postMessage({type:'extend-budget',generation:job.budgetGeneration,deadlineAt:job.deadlineAt});
      armBudgetTimer(serial);log('Added '+minutes+' minute(s). Continuing the same in-progress work.');notify();return state();
    }
    if(endpoint==='/api/clear-routing') {
      if(String(options.method||'GET').toUpperCase()!=='POST')throw new Error('Clear routing requires a confirmed POST action.');
      requireIdle();requireRuleDecision();
      if(!inputText||!board||!job)throw new Error('Load a board before clearing its routing.');
      if(typeof data?.jobId!=='string'||data.jobId!==job.id)throw new Error('The selected board changed. Review it and confirm clearing again.');
      if(!board.traces.length&&!board.vias.length)throw new Error('This board has no traces or routing vias to clear.');
      log('Clearing all traces and routing vias, including fixed and protected routing.');
      return launch('clear',getSettings(job.settings));
    }
    if(endpoint==='/api/stop') {
      if(!job||!active.has(job.state))return state();
      return stopWithBest(job.stopReason||'stopped','Stopped immediately.');
    }
    if(endpoint==='/api/download') {
      const type=params.get('type')||'ses',result=getDownload(type);
      return {blob:result.blob,disposition:'attachment; filename="'+result.filename+'"'};
    }
    if(endpoint==='/api/quit') {kill();serial++;job=null;board=null;preview=null;exports=null;bestChecked=null;clearTransaction=null;ruleTransaction=null;importedNetRules=null;pendingRuleReuse=null;inputText=null;logs.length=0;notify();return state();}
    throw new Error('Unknown local action.');
  }
  function getDownload(type) {
    if(!['ses','dsn','log','report','benchmark'].includes(type))throw new Error('Unknown export type.');
    if(!job)throw new Error('No board is loaded.');
    if(type==='benchmark'){if(!job.runReport||active.has(job.state))throw new Error('Finish or stop the run before exporting its benchmark.');return {blob:new Blob([JSON.stringify(benchmark.validateReport(job.runReport),null,2)],{type:'application/json'}),filename:'RamenRouter-'+base.appVersion+'-benchmark.json'};}
    if(type!=='log'&&(!exports||active.has(job.state)))throw new Error('A checked route is not ready to export.');
    const text=type==='log'?logs.join('\n')+'\n':exports[type];
    const stem=job.name.replace(/\.dsn$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
    const filename=stem+(type==='log'?'-routing.log':type==='report'?'-checks.json':job.routingCleared&&job.state==='ready'?'-unrouted.'+type:'-routed.'+type);
    return {blob:new Blob([text],{type:type==='report'?'application/json':'text/plain;charset=utf-8'}),filename};
  }
  function download(type) {
    const {blob,filename}=getDownload(type),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);return filename;
  }
  globalThis.RamenNative={request,download,setBenchmarkEnvironment(value){if(typeof value?.animationEnabled!=='boolean')return;benchmarkEnvironment={animationEnabled:value.animationEnabled};if(job?.operation==='run'&&active.has(job.state)&&job.benchmarkEnvironment){if(job.benchmarkEnvironment.animationEnabled!==value.animationEnabled)job.benchmarkEnvironment.animationChanged=true;job.benchmarkEnvironment.animationEnabled=value.animationEnabled;if(job.runReport)job.runReport.environment={...job.runReport.environment,...job.benchmarkEnvironment};}},subscribeActivity(fn){activitySubscribers.add(fn);return()=>activitySubscribers.delete(fn);},subscribe(fn){subscribers.add(fn);return()=>subscribers.delete(fn);}};
  window.addEventListener('beforeunload',event=>{if(job&&active.has(job.state)){event.preventDefault();event.returnValue='';}});
})();
