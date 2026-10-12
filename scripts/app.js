'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const activeStates = new Set(['inspecting', 'clearing', 'updating_rules', 'starting', 'running', 'routing', 'fanout', 'optimizing', 'stopping', 'loading', 'pausing', 'paused']);
  const terminalStates = new Set(['completed', 'stopped', 'timed_out', 'error', 'failed']);
  const palette = ['#df9676', '#73c7c2', '#c1ab69', '#a394d3', '#83b76e', '#be86a6', '#73a0d0', '#a5b4bf'];
  const nativeEngine = globalThis.RamenNative;
  let currentState = null;
  let connected = false;
  let busy = false;
  let board = null;
  let boardKey = '';
  let fetchingBoard = false;
  let lastJobId = null;
  let lastLogs = '';
  let pollFailures = 0;
  let toastTimer;
  let stoppingSince = null;
  let forcedStop = false;
  let dismissedSuggestionJobId = null;
  let announcedSuggestionJobId = null;
  let adviceRenderKey = '';
  let announcedAdviceJobId = null;
  let focusedAdvice = null;
  let dismissedStopJobId = null;
  let viewedStopJobId = null;
  let announcedStopJobId = null;
  let budgetPromptJobId = null;
  let announcedBudgetKey = null;
  let announcedExportJobId = null;
  let downloadedSesJobId = null;
  let downloadedDsnJobId = null;
  let remainingRenderKey = '';
  let clearRoutingJobId = null;
  let netLayersData = null;
  let netLayerDrafts = new Map();
  let netShortDrafts = new Map();
  let routingOptionsBeforeDialog = null;
  let pendingRoutingOptions = null;
  let previousRulesDialogKey = null;
  let previousRulesAction = null;
  let previousRulesError = '';
  let dismissedDirectionJobId = null;
  const acknowledgedAttention = new Set();
  let activeAttentionKey = null;
  const visibleLayers = new Map();
  let layerColors = new Map();
  let layerRenderKey = '';
  let activityFrame = null;
  let activityExpiryTimer = null;
  let activityEventKey = '';
  let spatialActivity = null;
  let activitySnapshot = null;
  const recentWorkActivity = new Map();
  let recentWorkJobKey = '';
  let recentWorkFamily = '';
  let lastActivityPaintAt = 0;
  let progressClock = null;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = $('boardCanvas');
  const ctx = canvas.getContext('2d');
  const activityCanvas = $('activityCanvas');
  const activityCtx = activityCanvas.getContext('2d');
  const view = { scale: 1, fitScale: 1, x: 0, y: 0, width: 1, height: 1, dragging: false, moved: false };
  let drawQueued = false;

  const icons = { ready: '○', completed: '✓', stopped: 'Ⅱ', paused: 'Ⅱ', pausing: '◷', timed_out: '◷', error: '!', failed: '!' };
  const labels = { ready: 'Board ready', inspecting: 'Reading your board', clearing: 'Clearing traces and vias', updating_rules: 'Updating routing rules', starting: 'Getting started', running: 'Routing your board', routing: 'Routing your board', fanout: 'Adding pad escapes', optimizing: 'Refining routes', stopping: 'Stopping safely', pausing: 'Time limit reached', paused: 'Paused · time limit reached', completed: 'Run complete', stopped: 'Run stopped', timed_out: 'Time limit reached', error: 'This run needs a look', failed: 'This run needs a look', idle: 'Ready when you are' };

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4500);
  }

  async function api(path, options = {}) {
    if (!nativeEngine || typeof nativeEngine.request !== 'function') throw new Error('RamenRouter did not load. Keep the folder together, then reopen index.html.');
    return await nativeEngine.request(path, options);
  }

  async function post(path, data) {
    const options = { method: 'POST' };
    if (data !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(data); }
    const result = await api(path, options);
    if (result && ('job' in result || 'engineVersion' in result)) applyState(result);
    return result;
  }

  function setConnection(value) {
    connected = value;
    $('connection').className = `connection ${value ? 'connected' : 'disconnected'}`;
    $('connectionText').textContent = value ? 'Works offline' : 'RamenRouter is not ready';
    $('disconnectBanner').hidden = value;
    updateControls();
    syncActivityVisual();
  }

  function number(value, maximumFractionDigits = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits }) : '—';
  }

  function seconds(value) {
    if (!Number.isFinite(Number(value)) || value === null || value === undefined) return '—';
    const n = Math.max(0, Math.floor(Number(value)));
    if (n >= 3600) return `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  }

  function phaseName(phase) { return ({ reading: 'Reading your board', checking: 'Checking routing rules', advising: 'Looking for placement changes that may help', exporting: 'Getting your exports ready', rasterizing: 'Mapping copper and clearances', loading: 'Loading your board', routing: 'Connecting pads', fanout: 'Finding room for pad escapes', optimizing: 'Refining routes', deep_search: 'Trying different routes', pad_escape: 'Finding a way out of the pads', finishing: 'Working on the remaining connections', updating_rules: 'Updating routing rules' })[phase] || phase; }

  function isActive() { return Boolean(currentState?.job && activeStates.has(currentState.job.state)); }
  function awaitingMoreTime(job = currentState?.job) { return job?.operation === 'run' && ['pausing', 'paused'].includes(job.state); }

  function outputAvailable(type) {
    const output = currentState?.job?.hasOutput;
    if (typeof output === 'object' && output !== null) return Boolean(output[type]);
    return Boolean(output);
  }

  function hasPreviousRulesDecision() { return Boolean(currentState?.job?.previousRulesProposal); }

  function updatePreviousRulesPrompt() {
    const job = currentState?.job, proposal = job?.previousRulesProposal;
    const dialog = $('previousRulesDialog');
    if (!proposal || job.state !== 'ready' || isActive()) {
      if (dialog.open) dialog.close();
      if (!proposal) { previousRulesDialogKey = null; previousRulesError = ''; }
      return;
    }
    const key = `${job.id}:${proposal.id}`;
    if (previousRulesDialogKey !== key) {
      previousRulesDialogKey = key;
      previousRulesError = '';
    }
    $('previousRulesOldName').textContent = proposal.previousName || 'Previous board';
    $('previousRulesNewName').textContent = proposal.currentName || 'Imported board';
    $('previousRulesCount').textContent = `${number(proposal.changedNets)} matching ${proposal.changedNets === 1 ? 'net has' : 'nets have'} different saved routing rules.`;
    const error = previousRulesError || job.ruleError;
    $('previousRulesError').hidden = !error;
    $('previousRulesError').textContent = error ? `Your previous rules were not applied. ${error}` : '';
    const waiting = Boolean(previousRulesAction);
    dialog.setAttribute('aria-busy', String(waiting));
    for (const id of ['previousRulesReuse', 'previousRulesImported', 'closePreviousRules']) $(id).disabled = !connected || busy || waiting;
    $('previousRulesReuse').textContent = previousRulesAction === 'reuse' ? 'Applying rules…' : 'Reuse previous rules';
    $('previousRulesImported').textContent = previousRulesAction === 'imported' ? 'Keeping imported rules…' : 'Use imported rules';
    if (!dialog.open && !busy && !waiting && connected && !document.querySelector('dialog[open]')) {
      dialog.showModal();
      $('previousRulesImported').focus();
    }
  }

  async function choosePreviousRules(reuse) {
    const job = currentState?.job, proposal = job?.previousRulesProposal;
    if (!proposal || job.state !== 'ready' || busy || previousRulesAction || !connected || isActive()) return;
    previousRulesAction = reuse ? 'reuse' : 'imported';
    previousRulesError = ''; busy = true; updateControls();
    try {
      const state = await api('/api/reuse-routing-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id, proposalId: proposal.id, reuse }) });
      if (!state?.job) throw new Error('Could not confirm your choice. Try again.');
      applyState(state);
      if (!state.job.previousRulesProposal) $('previousRulesDialog').close();
      toast(reuse ? 'Previous rules loaded. Checking your new board…' : 'Using the rules from the board you just loaded.');
    } catch (error) {
      if (currentState?.job?.id === job.id && currentState.job.previousRulesProposal?.id === proposal.id) previousRulesError = error.message || String(error);
      else toast(error.message || String(error), true);
    } finally { previousRulesAction = null; busy = false; updateControls(); }
  }

  function updateControls() {
    const job = currentState?.job;
    const active = isActive();
    const available = connected && !busy;
    const previousRulesPending = hasPreviousRulesDecision();
    const stopping = job?.state === 'stopping';
    $('runButton').hidden = active;
    $('stopButton').hidden = !active;
    $('runButton').disabled = !available || !job || job.state === 'idle' || active || previousRulesPending;
    $('stopButton').disabled = !available || stopping;
    $('stopButton').lastChild.textContent = stopping ? ' Stopping…' : 'Stop routing';
    $('forceStopButton').hidden = !stopping || !stoppingSince || Date.now() - stoppingSince < 5000;
    $('forceStopButton').disabled = !available || forcedStop;
    for (const id of ['dropzone', 'replaceButton', 'demoButton']) $(id).disabled = !available || active || previousRulesPending;
    const routing = job?.routingSummary;
    $('clearRoutingButton').hidden = !job || job.state === 'idle';
    $('clearRoutingButton').disabled = !available || active || previousRulesPending || !routing || routing.traceCount + routing.viaCount === 0;
    $('clearRoutingButton').title = routing && routing.traceCount + routing.viaCount === 0 ? 'There are no traces or routing vias to clear yet.' : 'Clear every trace and routing via from this board.';
    $('confirmClearRouting').disabled = !available || active || job?.id !== clearRoutingJobId;
    if ($('clearRoutingDialog').open && (job?.id !== clearRoutingJobId || active)) $('clearRoutingDialog').close();
    $('netLayersSetting').hidden = !job || job.state === 'idle';
    $('netLayersButton').disabled = !available || active || previousRulesPending;
    $('cancelNetLayers').disabled = busy;
    $('closeNetLayers').disabled = busy;
    if ($('netLayersDialog').open && (job?.id !== netLayersData?.jobId || active)) { discardRoutingRuleDraft(); $('netLayersDialog').close(); }
    const layerSummary = job?.routingRuleSummary || job?.layerRuleSummary;
    const savedOptions = routingOptionsBeforeDialog || readRoutingOptions();
    const optionSummary = `${number(savedOptions.maxPasses)} attempts · ${number(savedOptions.timeoutMinutes)} min${savedOptions.preferredDirections ? ' · alternating directions' : ''}${savedOptions.benchmarkMode ? ' · fixed-work benchmark' : ''}`;
    $('netLayersSummary').textContent = optionSummary + (layerSummary ? ` · ${number(layerSummary.restrictedNets)} nets with layer limits · ${number(layerSummary.shortRouteNets || 0)} prefer shorter routes` : '');
    const layerConflicts = layerSummary?.conflictingTraces || 0;
    $('netLayerConflict').hidden = !layerConflicts || active;
    $('netLayerConflict').textContent = layerConflicts ? `${number(layerConflicts)} existing ${layerConflicts === 1 ? 'trace uses' : 'traces use'} a layer you have not selected, and cannot count as a short pad escape. Choose “Clear routing & start over”, or change the allowed layers.` : '';
    updateNetLayerDraftStatus();
    for (const control of $('settingsForm').elements) control.disabled = !available || active;
    if (available && !active) {
      const fanoutOnly = $('fanout').checked && $('fanoutOnly').checked;
      $('optimize').disabled = fanoutOnly; $('deepSearch').disabled = fanoutOnly;
      $('preferredDirections').disabled = fanoutOnly || (netLayersData?.layers.length ?? board?.layers?.length ?? 2) < 2;
    }
    $('fanoutOnlyRow').hidden = !$('fanout').checked;
    const fanoutOnlyMode = $('fanout').checked && $('fanoutOnly').checked;
    const smartMode = $('deepSearch').checked && !fanoutOnlyMode;
    $('routingModeName').textContent = fanoutOnlyMode ? 'Ramen SMD escape' : (smartMode ? 'Ramen smart routing' : 'Ramen direct routing');
    $('routingModeDetail').textContent = fanoutOnlyMode ? 'Add pad escapes, then stop before routing the rest.' : (smartMode ? 'Try different routes and keep the best checked result.' : 'Try one routing attempt.');
    $('routingModeTag').textContent = fanoutOnlyMode ? 'FANOUT' : (smartMode ? 'SMART' : 'DIRECT');
    $('importedCopperOption').hidden = !board?.copperFills?.length;
    $('downloadSes').disabled = !connected || !outputAvailable('ses') || active;
    $('downloadDsn').disabled = !connected || !outputAvailable('dsn') || active;
    $('downloadDsn').firstChild.textContent = job?.state === 'ready' ? (job.routingCleared ? 'Unrouted DSN ' : ((job.routingRulesChanged || job.layerRulesChanged) ? 'Board DSN ' : 'Routed DSN ')) : 'Routed DSN ';
    $('downloadChecks').disabled = !connected || !outputAvailable('report') || active;
    $('downloadLog').disabled = !connected || !job;
    $('copyLog').disabled = !lastLogs;
    $('runLabel').textContent = $('fanout').checked && $('fanoutOnly').checked ? 'Run SMD escape' : (job && terminalStates.has(job.state) ? 'Route again' : 'Start routing');
    let hint = !job ? 'Load a board to get started.' : (active ? 'Working on your board. Let it cook.' : (job.routingCleared ? 'Your next run starts with the cleared board.' : 'Your next run starts with the board you loaded.'));
    if (job?.state === 'clearing') hint = 'Removing routes and checking your board…';
    if (job?.state === 'updating_rules') hint = 'Applying your layer choices and checking the board…';
    if (busy) hint = 'Preparing your board…';
    if (previousRulesPending) hint = 'Choose your routing rules before starting.';
    if (stopping) hint = forcedStop ? 'Stopping now…' : 'Finishing this step, then stopping…';
    if (awaitingMoreTime(job)) hint = job.state === 'paused' ? 'Extend the time to continue this run, or stop.' : 'Finishing this step before pausing. You can add time now.';
    if (!connected) hint = 'Waiting for RamenRouter to get ready.';
    $('runHint').textContent = hint;
    updateStoppedFeedback();
    updateBudgetFeedback();
    updateViaSuggestion();
    updateDirectionSuggestion();
    updateRemainingRoutes();
    updatePlacementAdvice();
    updateExportAttention();
    updateRunReportControls();
    updatePreviousRulesPrompt();
    updateAttention();
  }

  function acknowledgeAttention(key = activeAttentionKey) {
    if (key) acknowledgedAttention.add(key);
    updateAttention();
  }

  function updateAttention() {
    const job = currentState?.job;
    let key = null, target = null;
    if (connected && !busy && (!isActive() || awaitingMoreTime(job))) {
      if (awaitingMoreTime(job)) { key = `budget:${job.id}:${job.budgetGeneration || 0}`; target = $('timeBudgetPrompt'); }
      else if (!job || job.state === 'idle') { key = 'import'; target = $('dropzone'); }
      else if (job.state === 'stopped' && !$('stopResultPrompt').hidden) { key = `stopped:${job.id}`; target = $('stopResultPrompt'); }
      else if (!$('directionSuggestion').hidden && !acknowledgedAttention.has(`directions:${job.id}`)) { key = `directions:${job.id}`; target = $('directionSuggestion'); }
      else if (!$('placementAdvice').hidden && !acknowledgedAttention.has(`advice:${job.id}`)) { key = `advice:${job.id}`; target = $('showPlacementAdvice'); }
      else if (job.state === 'ready') { key = `start:${job.id}`; target = $('runButton'); }
      else if (!$('remainingRoutes').hidden && $('placementAdvice').hidden && job.state !== 'stopped') { key = `remaining:${job.id}`; target = $('remainingRoutes'); }
    }
    if (key && acknowledgedAttention.has(key)) { key = null; target = null; }
    for (const node of [$('dropzone'), $('runButton'), $('stopResultPrompt'), $('timeBudgetPrompt'), $('directionSuggestion'), $('showPlacementAdvice'), $('remainingRoutes')]) node.classList.toggle('attention-cue', node === target);
    $('placementAdvice').classList.toggle('attention-panel', target === $('showPlacementAdvice'));
    activeAttentionKey = key;
  }

  function currentBoardKey() {
    const job = currentState?.job;
    const revision = currentState?.boardRevision ?? job?.revision;
    // Phase and activity changes do not change the board geometry.
    return revision === undefined ? `${job?.id}|${job?.state}|${job?.phase || ''}` : `${job?.id}|${revision}`;
  }

  function updateBudgetFeedback() {
    const job = currentState?.job, show = awaitingMoreTime(job);
    $('timeBudgetPrompt').hidden = !show;
    for (const id of ['extraTimeMinutes', 'extendTimeButton', 'finishTimedRun']) $(id).disabled = !show || !connected || busy;
    if (!show) return;
    if (budgetPromptJobId !== job.id) {
      budgetPromptJobId = job.id;
      const minutes = job.settings?.timeoutMinutes;
      $('extraTimeMinutes').value = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : 30;
    }
    $('timeBudgetTitle').textContent = job.state === 'paused' ? 'Continue this run?' : 'Time limit reached';
    $('timeBudgetDetail').textContent = job.state === 'paused'
      ? 'Your work is paused, including any board preparation. Add time to pick up where it stopped, or end this run.'
      : 'Finishing this step before pausing. Add time to keep going, including any board preparation already underway.';
    $('finishTimedRun').textContent = job.bestResult?.available ? 'Keep best & stop' : 'Stop routing';
    $('timeBudgetStopDetail').textContent = job.bestResult?.available ? 'Stop here and keep the best checked result to review or export.' : 'There is no checked result yet. Stop here to end this run.';
    const key = `budget:${job.id}:${job.budgetGeneration || 0}`;
    if (announcedBudgetKey !== key) {
      announcedBudgetKey = key;
      requestAnimationFrame(() => { if (!$('timeBudgetPrompt').hidden) $('timeBudgetPrompt').scrollIntoView({ block: 'nearest' }); });
    }
  }

  async function extendRoutingTime() {
    const job = currentState?.job;
    if (busy || !connected || !awaitingMoreTime(job) || !$('extraTimeMinutes').reportValidity()) return;
    const timeoutMinutes = Number($('extraTimeMinutes').value);
    if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 1440) return;
    acknowledgeAttention();
    busy = true; updateControls();
    try {
      await post('/api/extend', { jobId: job.id, timeoutMinutes });
      toast(`Added ${number(timeoutMinutes)} ${timeoutMinutes === 1 ? 'minute' : 'minutes'}. Picking up the same run.`);
    } catch (error) { toast(error.message, true); }
    finally { busy = false; updateControls(); }
  }

  async function finishTimedRun() {
    if (busy || !connected || !awaitingMoreTime()) return;
    acknowledgeAttention();
    busy = true; updateControls();
    try { await post('/api/stop'); }
    catch (error) { toast(error.message, true); }
    finally { busy = false; updateControls(); }
  }

  function stoppedResultAvailable() {
    const job = currentState?.job;
    return Boolean(job?.state === 'stopped' && job.bestResult?.available && outputAvailable('ses'));
  }

  function updateStoppedFeedback() {
    const job = currentState?.job;
    const stopped = job?.state === 'stopped';
    const available = stoppedResultAvailable();
    const show = stopped && dismissedStopJobId !== job.id && viewedStopJobId !== job.id;
    $('stopResultPrompt').hidden = !show;
    $('viewStoppedResult').hidden = !available || show;
    $('viewStoppedResult').disabled = busy || !connected || !board || boardKey !== currentBoardKey();
    $('viewBestResult').hidden = !available;
    $('viewBestResult').disabled = !available || busy || !board || boardKey !== currentBoardKey();
    if (!show) return;
    const count = job.bestResult?.unrouted ?? job.stats?.unrouted;
    const remaining = Number.isFinite(count) ? `${number(count)} ${count === 1 ? 'connection remains' : 'connections remain'}.` : '';
    let detail = available ? (job.bestResult.fromInput ? `The best checked result is your ${job.routingCleared ? 'cleared board' : 'loaded board'}. ${remaining}` : `Your best checked result is saved. ${remaining}`) : 'Routing stopped before a checked result was ready. Start another run when you are ready.';
    const issues = job.stats?.totalViolations ?? job.stats?.clearanceViolations;
    if (available && issues > 0) detail += ` ${number(issues)} ${issues === 1 ? 'rule issue needs' : 'rule issues need'} review.`;
    if (available) detail += ' Open it to see the missing routes and any advice. This will not restart routing.';
    if ($('stopResultDetail').textContent !== detail) $('stopResultDetail').textContent = detail;
    if (announcedStopJobId !== job.id) {
      clearTimeout(toastTimer); $('toast').hidden = true;
      announcedStopJobId = job.id;
      requestAnimationFrame(() => { if (!$('stopResultPrompt').hidden) $('stopResultPrompt').scrollIntoView({ block: 'nearest' }); });
    }
  }

  function viewBestResult() {
    const job = currentState?.job;
    if (!stoppedResultAvailable() || !board || boardKey !== currentBoardKey() || busy) return;
    acknowledgedAttention.add(`stopped:${job.id}`);
    dismissedStopJobId = job.id;
    viewedStopJobId = job.id;
    announcedAdviceJobId = job.id;
    clearAdviceFocus();
    $('showAirwires').checked = true;
    $('showPads').checked = true;
    for (const layer of board.layers || []) visibleLayers.set(layerKey(layer.id), true);
    updateLayers(); fitBoard(); updateControls();
    $('canvasLabelText').textContent = job.bestResult.fromInput ? (job.routingCleared ? 'Cleared board · routing stopped' : 'Loaded board · routing stopped') : 'Best checked result · routing stopped';
    const target = !$('remainingRoutes').hidden ? $('remainingRoutes') : (!$('placementAdvice').hidden ? $('placementAdvice') : $('jobState'));
    target.scrollIntoView({ block: 'start' });
    if (window.innerWidth > 900) canvas.scrollIntoView({ block: 'nearest' });
  }

  function updateRemainingRoutes() {
    const job = currentState?.job;
    const show = terminalStates.has(job?.state) && !job.settings?.fanoutOnly && job.stats?.unrouted > 0 &&
      (job.state !== 'stopped' || viewedStopJobId === job.id) && board && boardKey === currentBoardKey();
    $('remainingRoutes').hidden = !show;
    if (!show) { remainingRenderKey = ''; return; }
    const groups = new Map();
    for (const wire of board.airwires || []) {
      const name = wire.net || 'Unnamed net';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(wire);
    }
    const key = JSON.stringify([job.id, job.revision, [...groups.keys()], job.stats.unrouted]);
    if (remainingRenderKey === key) return;
    remainingRenderKey = key;
    $('remainingRoutesDetail').textContent = `${number(job.stats.unrouted)} ${job.stats.unrouted === 1 ? 'connection remains' : 'connections remain'} across ${number(groups.size)} ${groups.size === 1 ? 'net' : 'nets'}.`;
    const container = $('remainingRoutesList'); container.replaceChildren();
    for (const [name, wires] of groups) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'remaining-net-button';
      const label = document.createElement('span'); label.textContent = name;
      const count = document.createElement('small'); count.textContent = `${wires.length} ${wires.length === 1 ? 'gap' : 'gaps'} · Show`;
      button.append(label, count);
      button.addEventListener('click', () => {
        const points = wires.flatMap(wire => wire.points || []).filter(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite));
        if (!points.length) return;
        const area = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
        $('showAirwires').checked = true;
        focusAdviceArea({ net: name, area }, -1, `${name} · missing connections`);
      });
      container.append(button);
    }
  }

  function updateExportAttention() {
    const job = currentState?.job, stats = job?.stats;
    const clean = job?.state === 'completed' && !job.settings?.fanoutOnly && outputAvailable('ses') &&
      stats?.unrouted === 0 && (stats.totalViolations ?? stats.clearanceViolations) === 0 &&
      stats.belowNominalWidthTraceCount === 0 && stats.drcChecked && stats.widthRulesChecked;
    const show = Boolean(clean && downloadedSesJobId !== job.id && !busy);
    $('downloadSes').classList.toggle('export-ready', show);
    $('downloadDsn').classList.remove('export-ready');
    $('exportReadyMessage').textContent = 'All connected. Your routes are ready to export.';
    $('exportReadyMessage').hidden = !show;
    if (show && announcedExportJobId !== job.id) {
      clearTimeout(toastTimer); $('toast').hidden = true;
      announcedExportJobId = job.id;
      requestAnimationFrame(() => { const target = $('downloadSes'); if (target.classList.contains('export-ready')) target.scrollIntoView({ block: 'nearest' }); });
    }
  }

  function canSuggestViaInPad() {
    const job = currentState?.job;
    return Boolean(job?.state === 'completed' && job.hasOutput && job.stats?.unrouted > 0 &&
      job.suggestions?.viaInPad && !job.settings?.viaInPad && !job.settings?.fanoutOnly &&
      !($('fanout').checked && $('fanoutOnly').checked) && job.id !== dismissedSuggestionJobId);
  }

  function updateViaSuggestion() {
    const show = canSuggestViaInPad();
    $('viaSuggestion').hidden = !show;
    $('enableViaRetry').disabled = !show || busy || !connected || isActive();
    $('dismissViaSuggestion').disabled = busy;
    if (!show) return;
    const job = currentState.job, count = job.stats.unrouted;
    $('viaSuggestionDetail').textContent = `${number(count)} ${count === 1 ? 'connection remains' : 'connections remain'}. Allowing vias in SMD pads may give those connections another way through.`;
    if (announcedSuggestionJobId !== job.id) {
      announcedSuggestionJobId = job.id;
      requestAnimationFrame(() => { if (!$('viaSuggestion').hidden) $('viaSuggestion').scrollIntoView({ block: 'nearest' }); });
    }
  }

  function canSuggestRelaxingDirections() {
    const job = currentState?.job;
    return Boolean(job?.state === 'completed' && job.hasOutput && job.stats?.unrouted > 0 &&
      job.settings?.preferredDirections && !job.settings?.fanoutOnly && job.suggestions?.relaxDirections && job.id !== dismissedDirectionJobId);
  }

  function updateDirectionSuggestion() {
    const show = canSuggestRelaxingDirections();
    $('directionSuggestion').hidden = !show;
    $('relaxDirectionsRetry').disabled = !show || busy || !connected || isActive();
    $('dismissDirectionSuggestion').disabled = busy;
    if (show) {
      const count = currentState.job.stats.unrouted;
      $('directionSuggestionDetail').textContent = `${number(count)} ${count === 1 ? 'connection remains' : 'connections remain'} with alternating layer directions on. Try another run with that preference off.`;
    }
  }

  function adviceArea(item) {
    const area = item?.area;
    if (Array.isArray(area) && area.length === 4 && area.every(Number.isFinite) && area[2] >= area[0] && area[3] >= area[1]) return area;
    const point = item?.location;
    if (Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) return [point[0] - 1, point[1] - 1, point[0] + 1, point[1] + 1];
    return null;
  }

  function updatePlacementAdvice() {
    const job = currentState?.job;
    const advice = job?.advice;
    const supplied = Array.isArray(advice?.items) ? advice.items : [];
    const needsWork = (job?.stats?.unrouted || 0) > 0 || (job?.stats?.totalViolations ?? job?.stats?.clearanceViolations ?? 0) > 0;
    const finished = terminalStates.has(job?.state) && !job?.settings?.fanoutOnly;
    const items = (job?.state === 'ready' ? supplied.filter(item => item.kind === 'existing_short') : (finished && needsWork ? supplied : [])).slice(0, 3);
    const show = items.length > 0 && !isActive() && (job?.state !== 'stopped' || viewedStopJobId === job.id);
    $('placementAdvice').hidden = !show;
    $('showPlacementAdvice').hidden = !show;
    $('placementAdviceCount').textContent = show ? String(items.length) : '';
    if (!show) {
      if (focusedAdvice && focusedAdvice.index >= 0) clearAdviceFocus();
      adviceRenderKey = '';
      return;
    }
    const key = JSON.stringify([job.id, items, Boolean(advice.limitedComponentLabels), advice.note || '']);
    if (key !== adviceRenderKey) {
      adviceRenderKey = key;
      $('placementLabelNote').hidden = !advice.limitedComponentLabels;
      $('placementLabelDetail').textContent = advice.note || 'This DSN is missing the original component labels. Use the pad, net and location below to find the area.';
      const container = $('placementAdviceItems');
      container.replaceChildren();
      for (const [index, item] of items.entries()) {
        const card = document.createElement('details');
        card.className = 'advice-finding';
        card.dataset.adviceId = String(item.id ?? index);
        card.open = index === 0;
        const heading = document.createElement('summary');
        const numeral = document.createElement('span'); numeral.className = 'advice-item-number'; numeral.textContent = String(index + 1);
        const title = document.createElement('span'); title.textContent = item.title || 'Take a look here';
        heading.append(numeral, title);
        const body = document.createElement('div'); body.className = 'advice-finding-body';
        const marker = document.createElement('span'); marker.className = 'advice-certainty' + (item.kind === 'existing_short' ? ' confirmed' : '');
        marker.textContent = item.kind === 'existing_short' ? 'Confirmed issue in your board' : 'Something to try';
        body.append(marker);
        const references = [];
        if (item.component && !advice.limitedComponentLabels) references.push(String(item.component));
        if (item.pin) references.push(`${item.component && !advice.limitedComponentLabels ? 'Pin' : 'Pad'} ${item.pin}`);
        if (item.net) references.push(`Net ${item.net}`);
        if (references.length) { const context = document.createElement('p'); context.className = 'advice-context'; context.textContent = references.join(' · '); body.append(context); }
        if (Array.isArray(item.location) && item.location.length === 2 && item.location.every(Number.isFinite)) {
          const position = document.createElement('p'); position.className = 'advice-location'; position.textContent = `X ${number(item.location[0], 2)} · Y ${number(item.location[1], 2)} mm`; body.append(position);
        }
        if (item.detail) {
          const evidence = document.createElement('details'); evidence.className = 'advice-evidence';
          const label = document.createElement('summary'); label.textContent = 'Why this area?';
          const detail = document.createElement('p'); detail.className = 'advice-detail'; detail.textContent = item.detail;
          evidence.append(label, detail); body.append(evidence);
        }
        if (item.suggestion) { const action = document.createElement('p'); action.className = 'advice-action'; action.textContent = item.suggestion; body.append(action); }
        if (!advice.limitedComponentLabels && Array.isArray(item.nearbyComponents) && item.nearbyComponents.length) {
          const nearby = document.createElement('p'); nearby.className = 'advice-nearby'; nearby.textContent = `Nearby: ${item.nearbyComponents.slice(0, 4).join(', ')}`; body.append(nearby);
        }
        if (adviceArea(item)) {
          const focus = document.createElement('button'); focus.type = 'button'; focus.className = 'advice-show-area'; focus.textContent = 'Show area';
          focus.addEventListener('click', () => focusAdviceArea(item, index)); body.append(focus);
        }
        card.append(heading, body); container.append(card);
      }
    }
    for (const button of $('placementAdviceItems').querySelectorAll('.advice-show-area')) button.disabled = !board || busy;
    if (announcedAdviceJobId !== job.id && !canSuggestViaInPad() && job.state !== 'stopped') {
      announcedAdviceJobId = job.id;
      requestAnimationFrame(() => { if (!$('placementAdvice').hidden) $('placementAdvice').scrollIntoView({ block: 'start' }); });
    }
  }

  function clearAdviceFocus() {
    focusedAdvice = null;
    $('adviceFocusChip').hidden = true;
    for (const item of $('placementAdviceItems').querySelectorAll('.advice-finding')) item.classList.remove('focused');
    draw();
  }

  function focusAdviceArea(item, index, label) {
    const bounds = adviceArea(item);
    if (!board || !bounds) return;
    if (index >= 0) acknowledgeAttention(`advice:${currentState?.job?.id}`);
    else acknowledgeAttention(`remaining:${currentState?.job?.id}`);
    focusedAdvice = { item, bounds, jobId: currentState?.job?.id, index };
    const boardBounds = getBounds();
    const boardSpan = boardBounds ? Math.max(boardBounds[2] - boardBounds[0], boardBounds[3] - boardBounds[1]) : Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
    const minimumSpan = Math.max(boardSpan * .01, Number.EPSILON);
    const width = Math.max(bounds[2] - bounds[0], minimumSpan), height = Math.max(bounds[3] - bounds[1], minimumSpan);
    const padding = Math.max(width, height) * .18;
    view.scale = Math.max(view.fitScale, Math.min(view.fitScale * 40, (view.width - 64) / (width + padding * 2), (view.height - 100) / (height + padding * 2)));
    view.x = view.width / 2 - (bounds[0] + bounds[2]) / 2 * view.scale;
    view.y = view.height / 2 + (bounds[1] + bounds[3]) / 2 * view.scale;
    $('showPads').checked = true;
    if (Number.isInteger(item.evidence?.layer)) { visibleLayers.set(layerKey(item.evidence.layer), true); updateLayers(); }
    $('adviceFocusLabel').textContent = label || `Suggestion ${index + 1} · highlighted area`;
    $('adviceFocusChip').hidden = false;
    for (const [i, card] of [...$('placementAdviceItems').children].entries()) card.classList.toggle('focused', i === index);
    updateZoom(); draw();
    canvas.scrollIntoView({ block: 'center' });
  }

  function stat(id, value, initial, unit = '') {
    const digits = unit === 'mm' ? 1 : 0;
    $(id + 'Value').textContent = number(value, digits);
    const detail = $(id + 'Change');
    detail.classList.remove('improved');
    if (typeof value !== 'number') detail.textContent = currentState?.job ? 'Waiting for a result' : 'No board loaded';
    else if (typeof initial === 'number' && initial !== value) {
      const difference = value - initial;
      detail.textContent = `${difference > 0 ? '+' : '−'}${number(Math.abs(difference), digits)}${unit ? ' ' + unit : ''} from input`;
      detail.classList.toggle('improved', difference < 0);
    } else detail.textContent = 'From your board';
  }

  function applyStats(job) {
    const stats = job?.stats || {};
    const initial = job?.initialStats || {};
    stat('unrouted', stats.unrouted ?? stats.incomplete, initial.unrouted ?? initial.incomplete);
    stat('vias', stats.viaCount ?? stats.vias, initial.viaCount ?? initial.vias);
    stat('traces', stats.traceLengthMm, initial.traceLengthMm, 'mm');
    const clearances = stats.totalViolations ?? stats.clearanceViolations;
    $('connectionsValue').textContent = number(Array.isArray(clearances) ? clearances.length : clearances);
    $('connectionsChange').textContent = clearances === null || clearances === undefined ? 'Final check pending' : (stats.drcChecked ? 'Clearance + placement checks' : 'Reported so far');
    $('connectionsChange').classList.toggle('improved', clearances === 0 && stats.drcChecked);
    $('widthValue').textContent = number(stats.belowNominalWidthTraceCount);
    $('widthValue').classList.toggle('width-warning', stats.belowNominalWidthTraceCount > 0);
    $('widthDetail').textContent = stats.widthRulesChecked ? 'Traces checked against each net’s width rule' : 'Check pending';
  }

  function updatePhases(job) {
    const phase = String(job?.phase || job?.state || '').toLowerCase();
    const settings = job?.settings || {};
    let stage = -1;
    if (job) stage = 0;
    if (phase.includes('fanout')) stage = 1;
    else if (phase.includes('optimiz')) stage = 3;
    else if (phase.includes('rout') || (phase === 'deep_search' || phase === 'pad_escape' || phase === 'finishing') || job?.state === 'running') stage = 2;
    if (job?.state === 'completed') stage = 4;
    for (const [i, node] of [...$('phaseTrack').children].entries()) {
      node.className = i < stage ? 'complete' : i === stage ? 'current' : '';
      if ((i === 1 && !settings.fanout) || (i === 3 && !settings.optimize) || ((i === 2 || i === 3) && settings.fanoutOnly)) node.className = 'skipped';
    }
    $('phaseCaption').textContent = job ? (phaseName(job.phase) || labels[job.state] || job.state) : 'Waiting for a board';
    // Attempt numbers come from the dedicated counters, never a pass limit
    // attached to a later checkpoint.
    $('passLabel').textContent = '';
  }

  function activityJob() {
    const job = currentState?.job;
    return job && activitySnapshot?.jobId === job.id ? { ...job, ...activitySnapshot } : job;
  }

  function progressText(id, value) {
    if ($(id).textContent !== value) $(id).textContent = value;
  }

  function counterDisplay(counter, job, attempt = false) {
    const current = Math.max(0, Math.floor(Number(counter?.current) || 0));
    const completed = Math.max(0, Math.floor(Number(counter?.completed) || 0));
    const limit = Number.isFinite(counter?.limit) ? Math.max(0, Math.floor(counter.limit)) : null;
    const status = counter?.status || 'pending';
    const noun = attempt ? 'attempt' : 'round';
    if (status === 'skipped') return { value: 'Skipped', detail: 'Not used for this run', status };
    if (status === 'done') return { value: String(completed), detail: `${noun}${completed === 1 ? '' : 's'} completed · 0 left`, status };
    const interrupted = terminalStates.has(job.state) || Number.isFinite(job.endedAt);
    const notStarted = limit === null ? null : Math.max(0, limit - Math.max(current, completed));
    if (interrupted) return {
      value: current ? `${current}${limit === null ? '' : ' / ' + limit}` : 'Not started',
      detail: `${number(completed)} completed${notStarted === null ? '' : ' · ' + number(notStarted) + ' not started'}`,
      status: 'interrupted'
    };
    if (status === 'pending' && completed > 0) return { value: String(completed), detail: `${noun}${completed === 1 ? '' : 's'} completed${notStarted === null ? '' : ' · up to ' + number(notStarted) + ' more if needed'}`, status };
    if (!current) return { value: attempt ? 'Preparing' : 'Not started', detail: limit === null ? 'Waiting for the first count' : `Up to ${number(limit)} ${noun}${limit === 1 ? '' : 's'} available`, status };
    return { value: `${current}${limit === null ? '' : ' / ' + limit}`, detail: notStarted === null ? `${number(completed)} completed` : (notStarted === 0 ? `Last available ${noun}` : `Up to ${number(notStarted)} more after this`), status };
  }

  function stopProgressClock() {
    if (progressClock !== null) clearTimeout(progressClock);
    progressClock = null;
  }

  function updateRunProgress() {
    const job = activityJob();
    const show = job?.operation === 'run';
    $('runProgress').hidden = !show;
    if (!show) { stopProgressClock(); return; }
    const ended = Number.isFinite(job.endedAt) || terminalStates.has(job.state);
    const running = activeStates.has(job.state) && !ended;
    const waiting = awaitingMoreTime(job);
    for (const name of ['attempt', 'refinement', 'repair']) {
      const display = counterDisplay(job.counters?.[name], job, name === 'attempt');
      progressText(name + 'Value', display.value);
      progressText(name + 'Detail', display.detail);
      $(name + 'Progress').dataset.status = display.status;
    }
    let left = null;
    if (running && Number.isFinite(job.deadlineAt)) left = Math.max(0, (job.deadlineAt - Date.now()) / 1000);
    else if (Number.isFinite(job.remainingSeconds)) left = Math.max(0, job.remainingSeconds);
    else if (Number.isFinite(job.deadlineAt) && Number.isFinite(job.endedAt)) left = Math.max(0, (job.deadlineAt - job.endedAt) / 1000);
    progressText('timeLeftValue', left === null ? '—' : seconds(Math.ceil(left)));
    progressText('timeLeftDetail', ended ? 'Time left when this run ended' : (waiting ? (job.state === 'paused' ? 'Paused · choose more time or stop' : 'Finishing this step before pausing') : (left === 0 ? 'Time limit reached · pausing' : 'Time allowed for this run')));
    $('timeLeftProgress').classList.toggle('time-low', running && left !== null && left <= 60);
    if (Number.isFinite(job.startedAt) && (!ended || Number.isFinite(job.endedAt))) progressText('elapsedValue', seconds(Math.max(0, ((ended ? job.endedAt : (Number.isFinite(job.pausedAt) ? job.pausedAt : Date.now())) - job.startedAt - (job.pausedDurationMs || 0)) / 1000)));
    const work = job.counters?.work;
    let detail = '';
    if (work && running) {
      const labels = { traces: 'Traces reviewed', vias: 'Vias reviewed', checking: 'Checking copper shapes' };
      detail = labels[work.kind] || '';
      if (detail && Number.isFinite(work.total) && work.total > 0 && Number.isFinite(work.processed)) detail += ` · ${number(work.processed)} / ${number(work.total)}`;
    }
    progressText('roundWorkDetail', detail);
    $('roundWorkDetail').hidden = !detail;
    if (running && job.state !== 'paused' && !document.hidden) {
      if (progressClock === null) progressClock = setTimeout(() => { progressClock = null; updateRunProgress(); }, 1000);
    } else stopProgressClock();
  }

  function updateEngineActivity() {
    updateRunProgress();
    const job = activityJob();
    const active = activeStates.has(job?.state);
    $('engineActivity').hidden = !active;
    document.querySelector('.activity-panel').classList.toggle('has-live-activity', active);
    if (active) {
      const waiting = awaitingMoreTime(job);
      const message = waiting ? (job.state === 'paused' ? 'Time is up. Add time to continue where this run paused, or stop here.' : 'Time is up. Finishing this step before pausing. You can add time now.') : (job?.activity?.message || (job?.state === 'stopping' ? 'Finishing this step, then stopping.' : 'Working on the next step.'));
      if ($('engineActivityMessage').textContent !== message) $('engineActivityMessage').textContent = message;
      const age = Number.isFinite(job.lastEngineUpdateAt) ? Math.max(0, Math.floor((Date.now() - job.lastEngineUpdateAt) / 1000)) : null;
      $('engineActivityAge').textContent = waiting ? (job.state === 'paused' ? 'Work kept · add time or stop here' : 'Finishing the current step before pausing') : (age === null ? 'Waiting for the first routing update' : (age < 2 ? 'Updated just now' : `Last routing update ${number(age)} s ago`));
      $('engineActivity').classList.toggle('awaiting-update', !waiting && (age === null || age >= 10));
      $('engineActivityAge').title = !waiting && age !== null && age >= 10 ? 'This step has not sent another update yet. You can still choose Stop routing.' : '';
    }
    receiveSpatialActivity(job);
    syncActivityVisual();
  }

  function applyState(state) {
    const firstState = currentState === null;
    const previousJob = currentState?.job;
    currentState = state;
    if (activitySnapshot && (activitySnapshot.jobId !== state.job?.id || (state.job?.activity?.sequence ?? 0) >= (activitySnapshot.activity?.sequence ?? 0) || !activeStates.has(state.job?.state))) activitySnapshot = null;
    if (state.appVersion) $('appVersion').textContent = state.appVersion;
    if (state.engineVersion) $('engineVersion').textContent = state.engineVersion;
    const job = state.job;
    if (pendingRoutingOptions?.transactionJobId) {
      const pending = pendingRoutingOptions;
      if (job?.id === pending.transactionJobId && job.state === 'ready' && !job.ruleError) {
        writeRoutingOptions(pending.options); saveSettings(pending.options); pendingRoutingOptions = null;
      } else if (job?.ruleError || job?.id === pending.sourceJobId || (job?.id !== pending.transactionJobId) || (!activeStates.has(job?.state) && job?.state !== 'ready')) {
        writeRoutingOptions(pending.previous); pendingRoutingOptions = null;
      }
    }
    if (previousJob?.state === 'clearing' && job?.state !== 'clearing') {
      if (job?.id === previousJob.id && job.state === 'ready' && job.routingCleared) {
        $('showAirwires').checked = true;
        $('showPads').checked = true;
        toast('Traces and routing vias cleared. Check the missing connections, then choose Start routing.');
      } else if (job?.clearError) toast(`Could not clear the routing. Your board and results are still here. ${job.clearError}`, true);
      else toast('Clear cancelled. Your board and results are still here.');
    }
    if (previousJob?.state === 'updating_rules' && job?.state !== 'updating_rules') {
      if (job?.id === previousJob.id && job.state === 'ready') {
        $('showAirwires').checked = true;
        toast('Rules applied. Check your board, then choose Start routing.');
      } else if (job?.ruleError) toast(`Could not apply your rules. Your board and results are still here. ${job.ruleError}`, true);
      else toast('Rule changes cancelled. Your board and results are still here.');
    }
    const hasJob = Boolean(job && job.state !== 'idle');
    const active = isActive();
    if (job?.settings && !['ready', 'inspecting', 'clearing', 'updating_rules'].includes(job.state) && !['clearing', 'updating_rules'].includes(previousJob?.state) && (firstState || job.id !== lastJobId)) {
      for (const key of ['fanout', 'fanoutOnly', 'optimize', 'deepSearch', 'viaInPad', 'preferredDirections', 'benchmarkMode']) if (typeof job.settings[key] === 'boolean') $(key).checked = job.settings[key];
      for (const key of ['maxPasses', 'timeoutMinutes']) if (typeof job.settings[key] === 'number') $(key).value = job.settings[key];
    }
    if (job?.state === 'stopping') stoppingSince ??= Date.now();
    else { stoppingSince = null; forcedStop = false; }
    $('dropzone').hidden = hasJob;
    $('fileCard').hidden = !hasJob;
    $('demoButton').hidden = hasJob;
    if (hasJob) {
      $('fileName').textContent = job.name || 'Untitled board';
      $('fileName').title = job.name || 'Untitled board';
      $('fileDetail').textContent = job.state === 'inspecting' ? 'Reading your board…' : (job.state === 'clearing' ? 'Clearing traces and vias…' : (job.state === 'updating_rules' ? 'Updating routing rules…' : (job.routingCleared ? 'DSN · traces and routing vias cleared' : ((job.routingRulesChanged || job.layerRulesChanged) ? 'DSN · your routing rules applied' : 'Your DSN is loaded'))));
      document.title = `${job.name || 'Board'} · RamenRouter`;
    }
    const completedWithRuleIssues = job?.state === 'completed' && (job.stats?.totalViolations ?? job.stats?.clearanceViolations ?? 0) > 0;
    $('stateTitle').textContent = job?.state === 'completed' && job.stats?.unrouted > 0 ? 'Connections remain' : (completedWithRuleIssues ? 'Check the rule issues' : (labels[job?.state] || (job?.state ? job.state : 'Ready when you are')));
    $('phaseLabel').textContent = phaseName(job?.phase) || (hasJob ? 'Choose settings and start routing' : 'No routing in progress');
    $('jobStateIcon').textContent = awaitingMoreTime(job) ? icons[job.state] : (active ? '⤳' : (completedWithRuleIssues ? '!' : (icons[job?.state] || '○')));
    $('jobState').className = `job-state ${active && !awaitingMoreTime(job) ? 'running' : (job?.state === 'error' || completedWithRuleIssues ? 'failed' : job?.state || '')}`;
    $('elapsedValue').textContent = seconds(job?.elapsedSeconds);
    $('jobError').hidden = !job?.error;
    $('jobError').textContent = job?.error ? String(job.error) : '';
    $('canvasLabelText').textContent = active ? 'Current board' : (job?.state === 'ready' ? (job.routingCleared ? 'Cleared board' : 'Loaded board') : (job?.state === 'stopped' && job.bestResult?.available ? (job.bestResult.fromInput ? (job.routingCleared ? 'Cleared board · routing stopped' : 'Loaded board · routing stopped') : 'Best checked result · routing stopped') : (hasJob ? 'Latest result' : '')));
    applyStats(job);
    updatePhases(job);
    const logs = Array.isArray(job?.log) ? job.log.map(line => typeof line === 'string' ? line : JSON.stringify(line)) : [];
    const text = logs.join('\n');
    if (text !== lastLogs) {
      lastLogs = text;
      $('logText').textContent = text;
      $('logCount').textContent = number(logs.length);
      $('logPlaceholder').hidden = logs.length > 0;
      if ($('autoScroll').checked) $('logScroll').scrollTop = $('logScroll').scrollHeight;
    }
    if (hasJob && job.id !== lastJobId) {
      if (focusedAdvice) clearAdviceFocus();
      lastJobId = job.id;
      acknowledgedAttention.clear();
      dismissedStopJobId = viewedStopJobId = announcedStopJobId = announcedExportJobId = downloadedSesJobId = downloadedDsnJobId = null;
      remainingRenderKey = '';
      boardKey = '';
      board = null;
      updateViaPreviewNote();
      visibleLayers.clear();
      layerRenderKey = '';
      $('emptyBoard').hidden = true;
      draw();
    }
    updateControls();
    updateEngineActivity();
    if (hasJob) {
      const nextKey = currentBoardKey();
      if (nextKey !== boardKey) void loadBoard(nextKey, !board);
    }
  }

  async function poll() {
    try {
      const state = await api('/api/state');
      pollFailures = 0;
      if (!connected) setConnection(true);
      applyState(state);
    } catch (error) {
      pollFailures++;
      if (pollFailures >= 2 || !currentState) setConnection(false);
      if (pollFailures === 1) $('disconnectBanner').textContent = error.message;
    } finally { setTimeout(poll, connected ? 1000 : 2000); }
  }

  async function loadBoard(key, fit) {
    if (fetchingBoard) return;
    fetchingBoard = true;
    if (!board) $('boardBusy').hidden = false;
    try {
      const geometry = await api('/api/board');
      if (!geometry || !Array.isArray(geometry.layers) || key !== currentBoardKey()) return;
      board = geometry;
      boardKey = key;
      updateLayers();
      updateViaPreviewNote();
      $('emptyBoard').hidden = true;
      $('canvasLabel').hidden = false;
      const parts = [`${board.layers.length} layers`, `${(board.traces || []).length.toLocaleString()} trace segments`];
      const bounds = getBounds();
      if (board.copperFills?.length) parts.push(`${number(board.copperFills.length)} imported copper regions`);
      if (bounds) parts.push(`${number(bounds[2] - bounds[0], 1)} × ${number(bounds[3] - bounds[1], 1)} mm`);
      $('geometrySummary').textContent = parts.join(' · ');
      if (fit) fitBoard(); else draw();
      updateControls();
      syncActivityVisual();
    } catch (error) {
      if (!board) $('geometrySummary').textContent = 'Your board preview is not ready yet';
    } finally { fetchingBoard = false; $('boardBusy').hidden = true; }
  }

  function getBounds() {
    const given = board?.bounds;
    if (Array.isArray(given) && given.length === 4 && given.every(Number.isFinite) && given[2] > given[0] && given[3] > given[1]) return given;
    const points = [];
    for (const trace of board?.traces || []) points.push(...(trace.points || []));
    for (const pad of board?.pads || []) if (Number.isFinite(pad.x) && Number.isFinite(pad.y)) points.push([pad.x, pad.y]);
    for (const outline of board?.outlines || []) points.push(...(Array.isArray(outline) ? outline : outline.points || []));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) { if (!Array.isArray(p) || !p.every(Number.isFinite)) continue; minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
    return minX < maxX && minY < maxY ? [minX, minY, maxX, maxY] : null;
  }

  function layerKey(value) { return String(value); }
  function layerVisible(value) { return visibleLayers.get(layerKey(value)) !== false; }
  function layerColor(value) { return layerColors.get(layerKey(value)) || '#bdc5a5'; }

  function displayLayers(layers) {
    const items = layers.map((layer, colorIndex) => ({ ...layer, colorIndex, displayName: layer.name }));
    // EasyEDA Standard exports this distinctive ID sequence, rather than
    // physical stack order. Keep raw names and IDs for every routing action.
    const easyeda = items.length > 2 && items.every((layer, i) => String(layer.name) === String(i < 2 ? i + 1 : i + 19));
    if (!easyeda) return items;
    for (const layer of items) {
      const id = Number(layer.name);
      layer.displayName = `${id === 1 ? 'Top Layer' : id === 2 ? 'Bottom Layer' : 'Inner' + (id - 20)} (${layer.name})`;
    }
    return [items[0], ...items.slice(2), items[1]];
  }

  function updateLayers() {
    const layers = displayLayers(board?.layers || []);
    const nextLayerKey = JSON.stringify(layers.map(layer => [layer.id, layer.name]));
    if (nextLayerKey === layerRenderKey) {
      const checkboxes = $('layersList').querySelectorAll('input');
      for (const [i, layer] of layers.entries()) if (checkboxes[i]) checkboxes[i].checked = visibleLayers.get(layerKey(layer.id)) !== false;
      return;
    }
    layerRenderKey = nextLayerKey;
    const list = $('layersList');
    list.replaceChildren();
    layerColors = new Map();
    for (const [i, layer] of layers.entries()) {
      const key = layerKey(layer.id);
      if (!visibleLayers.has(key)) visibleLayers.set(key, true);
      const color = palette[layer.colorIndex % palette.length];
      layerColors.set(key, color);
      const row = document.createElement('label'); row.className = 'layer-row';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = visibleLayers.get(key); checkbox.setAttribute('aria-label', `Show ${layer.displayName || 'layer ' + layer.id}`);
      checkbox.addEventListener('change', () => { visibleLayers.set(key, checkbox.checked); draw(); syncActivityVisual(); });
      const swatch = document.createElement('span'); swatch.className = 'layer-color'; swatch.style.background = color;
      const name = document.createElement('span'); name.className = 'layer-name'; name.textContent = layer.displayName || `Layer ${layer.id}`; name.title = name.textContent;
      const index = document.createElement('small'); index.textContent = String(i + 1).padStart(2, '0');
      row.append(checkbox, swatch, name, index); list.append(row);
    }
    $('layerCount').textContent = String(layers.length);
  }

  function resizeCanvas() {
    const rect = $('canvasWrap').getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const prevWidth = view.width, prevHeight = view.height;
    view.width = Math.max(1, rect.width); view.height = Math.max(1, rect.height);
    canvas.width = Math.round(view.width * dpr); canvas.height = Math.round(view.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const activityDpr = Math.min(dpr, 2);
    activityCanvas.width = Math.round(view.width * activityDpr); activityCanvas.height = Math.round(view.height * activityDpr);
    activityCtx.setTransform(activityDpr, 0, 0, activityDpr, 0, 0);
    if (prevWidth > 1 && prevHeight > 1) { view.x += (view.width - prevWidth) / 2; view.y += (view.height - prevHeight) / 2; }
    draw();
  }

  function fitBoard() {
    const bounds = getBounds();
    if (!bounds) { draw(); return; }
    const width = Math.max(.01, bounds[2] - bounds[0]), height = Math.max(.01, bounds[3] - bounds[1]);
    const margin = Math.min(60, view.width * .12, view.height * .12);
    view.scale = Math.max(.01, Math.min((view.width - margin * 2) / width, (view.height - margin * 2) / height));
    view.fitScale = view.scale;
    view.x = view.width / 2 - (bounds[0] + bounds[2]) / 2 * view.scale;
    view.y = view.height / 2 + (bounds[1] + bounds[3]) / 2 * view.scale;
    updateZoom(); draw();
  }

  function worldToScreen(x, y) { return [x * view.scale + view.x, -y * view.scale + view.y]; }
  function screenToWorld(x, y) { return [(x - view.x) / view.scale, (view.y - y) / view.scale]; }

  function updateZoom() { $('zoomValue').textContent = `${Math.round(view.scale / view.fitScale * 100)}%`; }

  function zoomBy(factor, px = view.width / 2, py = view.height / 2) {
    if (!board) return;
    const [wx, wy] = screenToWorld(px, py);
    view.scale = Math.max(view.fitScale * .08, Math.min(view.fitScale * 80, view.scale * factor));
    view.x = px - wx * view.scale; view.y = py + wy * view.scale;
    updateZoom(); draw();
  }

  function draw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => { drawQueued = false; paintBoard(); paintActivity(); });
  }

  function activityPath(item, limit = 512) {
    if (!item || !Array.isArray(item.points)) return null;
    const points = item.points.slice(0, limit);
    if (!points.every(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))) return null;
    if (points.length < 2) return null;
    const lengths = points.slice(1).map((point, i) => Math.hypot(point[0] - points[i][0], point[1] - points[i][1]));
    return { layer: item.layer, points, lengths, length: lengths.reduce((sum, value) => sum + value, 0) };
  }

  let activityPaintPending = false;
  let activityHasPixels = false;
  let activityPaintCost = 0;
  let activityFrameDelay = 30;
  // Geometry is immutable after a work report. Reuse its screen coordinates
  // and complete canvas path until the viewport changes; weak keys let old
  // samples disappear with the bounded history instead of retaining a cache.
  const activityGeometryCache = new WeakMap();

  function activityScreenGeometry(points) {
    let cached = activityGeometryCache.get(points);
    if (!cached || cached.scale !== view.scale || cached.x !== view.x || cached.y !== view.y) {
      cached = { scale: view.scale, x: view.x, y: view.y, points: points.map(point => worldToScreen(point[0], point[1])), path: null };
      activityGeometryCache.set(points, cached);
    }
    return cached;
  }

  function routePreviewLimit(job = activityJob()) {
    const netCount = job?.stats?.netCount ?? job?.initialStats?.netCount ?? 1;
    return Math.max(1, Math.min(25, Math.ceil((Number.isFinite(netCount) ? netCount : 1) * .25)));
  }

  function workActivityFamily(job = activityJob()) {
    if (['routing', 'rasterizing', 'finishing', 'deep_search', 'pad_escape'].includes(job?.phase)) return 'routing';
    return ({ fanout: 'fanout', optimizing: 'refining', checking: 'checking', advising: 'advising' })[job?.phase] || '';
  }

  function workSampleVisible(item) {
    return item.paths.some(path => spatialLayerVisible(path.layer ?? item.layer)) || item.points.some(point => spatialLayerVisible(point[2] ?? item.layer)) || Boolean(item.bounds && spatialLayerVisible(item.layer));
  }

  function pruneRecentWork() {
    const now = Date.now();
    const family = workActivityFamily();
    for (const [key, item] of recentWorkActivity) if (item.expiresAt <= now || (item.family !== family && item.family !== 'routing')) recentWorkActivity.delete(key);
    // Search branches stay limited to a quarter of the nets. Other work uses
    // object geometry, so many pads on one net remain separate actual samples.
    let routeCount = [...recentWorkActivity.values()].filter(item => item.routeSample).length;
    const routeLimit = routePreviewLimit();
    for (const [key, item] of recentWorkActivity) {
      if (routeCount <= routeLimit) break;
      if (item.routeSample) { recentWorkActivity.delete(key); routeCount--; }
    }
    // Reserve space for 512 current path vertices, 64 points, four bounds
    // corners, and a 512-vertex previous branch: under 8,192 in total.
    let coordinates = [...recentWorkActivity.values()].reduce((sum, item) => sum + item.coordinateCount, 0);
    while (recentWorkActivity.size > 25 || coordinates > 7040) {
      const key = recentWorkActivity.keys().next().value;
      coordinates -= recentWorkActivity.get(key).coordinateCount;
      recentWorkActivity.delete(key);
    }
  }

  function recentWorkPreviews(current = spatialActivityVisible() ? spatialActivity : null) {
    const family = workActivityFamily();
    if (!activityEnabled() || !board || !family) return [];
    pruneRecentWork();
    const available = 25 - (current ? 1 : 0);
    let routeSlots = routePreviewLimit() - (current?.routeSample ? 1 : 0);
    const previews = [];
    for (const item of [...recentWorkActivity.values()].reverse()) {
      if (item.family !== family || item.sampleKey === current?.sampleKey || !workSampleVisible(item)) continue;
      if (item.routeSample && routeSlots-- <= 0) continue;
      previews.push(item);
      if (previews.length === available) break;
    }
    return previews.reverse();
  }

  function receiveSpatialActivity(job) {
    const jobKey = `${job?.id || ''}|${job?.startedAt || ''}|${job?.operation || ''}`;
    const family = workActivityFamily(job);
    const newJob = jobKey !== recentWorkJobKey;
    const active = activeStates.has(job?.state) && !['stopping', 'pausing', 'paused'].includes(job?.state);
    const completionFamily = job?.activity?.complete ? (workActivityFamily({ phase: job.activity.phase }) || recentWorkFamily || family) : '';
    // Phase-only updates can carry the previous activity sequence. Suppress
    // incompatible samples before that sequence's early-return check.
    if (newJob || !active) {
      recentWorkActivity.clear();
      spatialActivity = null;
      if (newJob) activityEventKey = '';
    } else if (family !== recentWorkFamily || !family || job?.activity?.complete) {
      // Checked checkpoints briefly visit checking/advice/export. Keep route
      // samples bounded and hidden there so the next net can share their view.
      // Other families end on exit; completion ends only its own work family.
      for (const [sampleKey, item] of recentWorkActivity) {
        if ((item.family !== family && item.family !== 'routing') || (completionFamily && item.family === completionFamily)) recentWorkActivity.delete(sampleKey);
      }
      spatialActivity = null;
    }
    recentWorkJobKey = jobKey;
    recentWorkFamily = family;
    const report = job?.activity;
    const key = `${job?.id || ''}|${report?.sequence ?? report?.updatedAt ?? ''}`;
    if (key === activityEventKey) return;
    activityEventKey = key;
    const previous = spatialActivity;
    spatialActivity = null;
    if (!active || !family) return;
    if (report?.complete) return;
    const visual = report?.visual;
    if (!visual || !['pad', 'via', 'grid', 'search', 'candidate', 'trace', 'check'].includes(visual.kind)) return;
    let remainingVertices = 512;
    const paths = [];
    for (const item of (Array.isArray(visual.paths) ? visual.paths : []).slice(0, 32)) {
      if (remainingVertices < 2) break;
      const path = activityPath(item, remainingVertices);
      if (path) { paths.push(path); remainingVertices -= path.points.length; }
    }
    const points = (Array.isArray(visual.points) ? visual.points : []).filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])).slice(0, 64);
    const bounds = Array.isArray(visual.bounds) && visual.bounds.length === 4 && visual.bounds.every(Number.isFinite) ? visual.bounds : null;
    if (!paths.length && !points.length && !bounds) return;
    const searchId = visual.searchId ?? report.searchId;
    const reportedAt = Number.isFinite(report.updatedAt) ? report.updatedAt : Date.now();
    const netKey = report.netId !== undefined && report.netId !== null ? String(report.netId) : (report.netName ? `name:${report.netName}` : null);
    const routeSample = family === 'routing' && ['search', 'candidate'].includes(visual.kind) && paths.length > 0 && netKey !== null;
    const sampleKey = routeSample ? `route:${netKey}` : JSON.stringify([visual.kind, report.stage || family, visual.layer, points, paths.map(path => [path.layer, path.points]), bounds]);
    spatialActivity = { kind: visual.kind, label: visual.label, layer: visual.layer, points, paths, bounds, searchId, netKey, sampleKey, family, routeSample, receivedAt: performance.now(), expiresAt: reportedAt + 2000 };
    // Retain exact reported locations and segments. A finite replay is a view
    // of recent work, never an assertion that these objects run in parallel.
    if (board && !document.hidden && $('showLiveWork').checked && reportedAt + 12000 > Date.now()) {
      recentWorkActivity.delete(sampleKey);
      recentWorkActivity.set(sampleKey, { ...spatialActivity, paths: paths.map(path => ({ ...path })), expiresAt: reportedAt + 12000, coordinateCount: paths.reduce((sum, path) => sum + path.points.length, 0) + points.length + (bounds ? 4 : 0) });
      pruneRecentWork();
    }
    // Only shared, engine-reported segments can retract into a new branch.
    if (visual.kind === 'search' && previous?.kind === 'search' && searchId !== undefined && previous.searchId === searchId) {
      for (const [i, path] of paths.entries()) {
        const before = previous.paths[i];
        if (!before || layerKey(before.layer) !== layerKey(path.layer)) continue;
        let shared = 0;
        while (shared < Math.min(before.points.length, path.points.length) && Math.abs(before.points[shared][0] - path.points[shared][0]) < 1e-8 && Math.abs(before.points[shared][1] - path.points[shared][1]) < 1e-8) shared++;
        if (shared) path.transition = { before: { layer: before.layer, points: before.points, lengths: before.lengths, length: before.length }, sharedLength: path.lengths.slice(0, shared - 1).reduce((sum, value) => sum + value, 0) };
      }
    }
  }

  function spatialLayerVisible(layer) {
    return layer === undefined || layer === null ? [...visibleLayers.values()].some(Boolean) : layerVisible(layer);
  }

  function activityEnabled() {
    const job = activityJob();
    return connected && activeStates.has(job?.state) && !['stopping', 'pausing', 'paused'].includes(job?.state) && $('showLiveWork').checked && !document.hidden;
  }

  function spatialActivityVisible() {
    return activityEnabled() && !!board && !!spatialActivity && spatialActivity.family === workActivityFamily() && Date.now() < spatialActivity.expiresAt && workSampleVisible(spatialActivity);
  }

  function stopActivityFrames() {
    if (activityFrame !== null) cancelAnimationFrame(activityFrame);
    if (activityExpiryTimer !== null) clearTimeout(activityExpiryTimer);
    activityFrame = activityExpiryTimer = null;
    activityPaintPending = false;
  }

  function activityFrameState() {
    const enabled = activityEnabled();
    const current = enabled && spatialActivityVisible() ? spatialActivity : null;
    return { enabled, current, recent: enabled ? recentWorkPreviews(current) : [] };
  }

  function updateSpatialCaption(frame = activityFrameState()) {
    const { enabled, current, recent } = frame;
    $('connectionActivityLabel').hidden = !enabled;
    if (!enabled) return;
    const visible = !!current;
    const names = { pad: 'Checking pads', via: 'Checking vias', grid: 'Mapping clearances', search: 'Trying different paths', candidate: 'Trying this path', trace: 'Checking traces', check: 'Checking copper shapes' };
    const details = { pad: 'Pads being checked', via: 'Vias being checked', grid: 'Area being mapped', search: 'Paths being tried · not finished traces', candidate: 'Checking whether this path works', trace: 'Trace being checked', check: 'Area being checked' };
    const samples = visible ? [...recent, spatialActivity] : recent;
    const routeOnly = samples.length && samples.every(item => item.routeSample);
    const title = visible ? names[spatialActivity.kind] : (phaseName(activityJob()?.phase) || 'Routing activity');
    const titleText = recent.length ? `${title} · now + recent` : title;
    const detailText = recent.length ? (routeOnly ? `${samples.length} sampled paths · recent paths fade · not finished traces` : `${samples.length} work samples · now + recent areas${samples.some(item => ['search', 'candidate'].includes(item.kind)) ? ' · paths are still being checked' : ''}`) : (visible ? (spatialActivity.label || details[spatialActivity.kind]) : (!board ? 'Waiting for your board preview' : (spatialActivity ? 'Waiting for the next area' : 'This step has no area to highlight yet')));
    const kind = visible ? spatialActivity.kind : (recent.length ? recent[recent.length - 1].kind : 'phase');
    if ($('activityVisualTitle').textContent !== titleText) $('activityVisualTitle').textContent = titleText;
    if ($('activityVisualDetail').textContent !== detailText) $('activityVisualDetail').textContent = detailText;
    if ($('connectionActivityLabel').dataset.kind !== kind) $('connectionActivityLabel').dataset.kind = kind;
  }

  function workAnimationDuration(item, recent = false) {
    return recent ? 900 : (['search', 'candidate'].includes(item.kind) ? 120 : 700);
  }

  function activityIsAnimating(frame = activityFrameState()) {
    if (reducedMotion.matches || !frame.enabled) return false;
    const now = performance.now();
    return (frame.current && now - frame.current.receivedAt < workAnimationDuration(frame.current)) || frame.recent.some(item => now - item.receivedAt < workAnimationDuration(item, true));
  }

  function syncActivityVisual() {
    if (document.hidden || !$('showLiveWork').checked) { recentWorkActivity.clear(); spatialActivity = null; }
    if (!activityEnabled() || !board || !workActivityFamily()) {
      stopActivityFrames();
      const frame = activityFrameState();
      updateSpatialCaption(frame); paintActivity(frame);
      return;
    }
    // Worker reports never wait for a paint. Multiple reports and polling in
    // one frame share a single overlay update instead of repainting eagerly.
    activityPaintPending = true;
    if (activityFrame === null) activityFrame = requestAnimationFrame(animateReportedPath);
  }

  function scheduleActivityExpiry({ current, recent }) {
    if (activityExpiryTimer !== null) clearTimeout(activityExpiryTimer);
    activityExpiryTimer = null;
    if (!current && !recent.length) return;
    const expires = Math.min(current ? current.expiresAt : Infinity, ...recent.map(item => item.expiresAt));
    // Finished one-time animations need only a low-rate fade update.
    const fadeTick = recent.length && !reducedMotion.matches ? 250 : Infinity;
    activityExpiryTimer = setTimeout(() => { activityExpiryTimer = null; syncActivityVisual(); }, Math.max(1, Math.min(fadeTick, expires - Date.now() + 5)));
  }

  function animateReportedPath() {
    activityFrame = null;
    if (!activityEnabled()) { syncActivityVisual(); return; }
    const frame = activityFrameState();
    const animating = activityIsAnimating(frame);
    if (performance.now() - lastActivityPaintAt >= activityFrameDelay || !animating) {
      activityPaintPending = false;
      paintActivity(frame); updateSpatialCaption(frame); scheduleActivityExpiry(frame);
    }
    if (activityPaintPending || animating) activityFrame = requestAnimationFrame(animateReportedPath);
  }

  function strokeActivityPath(path, distance, color) {
    if (!path.points.length) return;
    const geometry = activityScreenGeometry(path.points);
    if (distance >= path.length && typeof Path2D === 'function') {
      if (!geometry.path) {
        geometry.path = new Path2D();
        geometry.path.moveTo(...geometry.points[0]);
        for (let i = 1; i < geometry.points.length; i++) geometry.path.lineTo(...geometry.points[i]);
      }
      activityCtx.lineWidth = 6; activityCtx.strokeStyle = '#07131de6'; activityCtx.stroke(geometry.path);
      activityCtx.lineWidth = 2.7; activityCtx.strokeStyle = color; activityCtx.stroke(geometry.path);
      return geometry.points[geometry.points.length - 1];
    }
    let remaining = Math.max(0, distance);
    let tip = geometry.points[0];
    activityCtx.beginPath(); activityCtx.moveTo(...tip);
    for (let i = 0; i < path.lengths.length && remaining > 0; i++) {
      const fraction = path.lengths[i] ? Math.min(1, remaining / path.lengths[i]) : 1;
      const a = geometry.points[i], b = geometry.points[i + 1];
      tip = fraction === 1 ? b : [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
      activityCtx.lineTo(...tip);
      remaining -= path.lengths[i];
    }
    activityCtx.lineWidth = 6; activityCtx.strokeStyle = '#07131de6'; activityCtx.stroke();
    activityCtx.lineWidth = 2.7; activityCtx.strokeStyle = color; activityCtx.stroke();
    return tip;
  }

  function paintWorkSample(visual, recent = false) {
    const colors = { pad: '#9bf0d6', via: '#dfb0f4', grid: '#7fd0ed', search: '#7ee5f4', candidate: '#ffc47c', trace: '#a2efd0', check: '#ebdb97' };
    const color = colors[visual.kind];
    const fraction = reducedMotion.matches ? 1 : Math.min(1, Math.max(0, (performance.now() - visual.receivedAt) / workAnimationDuration(visual, recent)));
    const alpha = recent ? (reducedMotion.matches ? .45 : .18 + .42 * Math.max(0, Math.min(1, (visual.expiresAt - Date.now()) / 12000))) : .95;
    activityCtx.save(); activityCtx.lineCap = 'round'; activityCtx.lineJoin = 'round'; activityCtx.strokeStyle = color; activityCtx.fillStyle = color; activityCtx.lineWidth = 2;
    if (visual.bounds && spatialLayerVisible(visual.layer)) {
      const [x0, y0] = worldToScreen(visual.bounds[0], visual.bounds[3]);
      const [x1, y1] = worldToScreen(visual.bounds[2], visual.bounds[1]);
      activityCtx.globalAlpha = alpha * (.12 + (1 - fraction) * .12); activityCtx.fillRect(x0, y0, x1 - x0, y1 - y0);
      activityCtx.globalAlpha = alpha * .8; activityCtx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    activityCtx.globalAlpha = alpha;
    activityCtx.setLineDash(visual.kind === 'candidate' ? [9, 3] : (recent ? [3, 3] : []));
    const tips = [];
    for (const path of visual.paths) {
      if (!spatialLayerVisible(path.layer ?? visual.layer)) continue;
      let tip;
      if (!recent && path.transition && fraction < .5) tip = strokeActivityPath(path.transition.before, path.transition.sharedLength + (path.transition.before.length - path.transition.sharedLength) * (1 - fraction * 2), color);
      else if (!recent && path.transition) tip = strokeActivityPath(path, path.transition.sharedLength + (path.length - path.transition.sharedLength) * Math.max(0, (fraction - .5) * 2), color);
      else tip = strokeActivityPath(path, path.length * fraction, color);
      if (tip && ['search', 'candidate', 'trace'].includes(visual.kind) && (!recent || fraction < 1)) tips.push(tip);
    }
    activityCtx.setLineDash([]);
    for (const tip of tips) {
      activityCtx.beginPath(); activityCtx.arc(tip[0], tip[1], recent ? 3 : 4, 0, Math.PI * 2);
      activityCtx.fillStyle = '#f1ffff'; activityCtx.strokeStyle = '#173944'; activityCtx.lineWidth = 1.5; activityCtx.fill(); activityCtx.stroke();
    }
    activityCtx.fillStyle = color; activityCtx.strokeStyle = color; activityCtx.lineWidth = 2;
    const screenPoints = activityScreenGeometry(visual.points).points;
    const visiblePoints = [];
    for (const [index, point] of visual.points.entries()) {
      if (spatialLayerVisible(point[2] ?? visual.layer)) visiblePoints.push(screenPoints[index]);
    }
    // A sample shares style and opacity. Batch its independent glyphs into
    // one stroke; moveTo keeps pads entirely disconnected from one another.
    if (visiblePoints.length) {
      const searchPoints = visual.kind === 'search';
      const radius = searchPoints ? 2.5 : 7;
      activityCtx.globalAlpha = alpha * (searchPoints ? .7 : 1);
      activityCtx.beginPath();
      for (const [x, y] of visiblePoints) {
        activityCtx.moveTo(x + radius, y); activityCtx.arc(x, y, radius, 0, Math.PI * 2);
        if (!searchPoints) { activityCtx.moveTo(x - 3, y); activityCtx.lineTo(x + 3, y); activityCtx.moveTo(x, y - 3); activityCtx.lineTo(x, y + 3); }
      }
      if (searchPoints) activityCtx.fill(); else activityCtx.stroke();
      if (!searchPoints && fraction < 1) {
        const pulseRadius = 7 + 9 * fraction;
        activityCtx.globalAlpha = alpha * (1 - fraction) * .7;
        activityCtx.beginPath();
        for (const [x, y] of visiblePoints) { activityCtx.moveTo(x + pulseRadius, y); activityCtx.arc(x, y, pulseRadius, 0, Math.PI * 2); }
        activityCtx.stroke();
      }
    }
    activityCtx.restore();
  }

  function paintActivity(frame = activityFrameState()) {
    const startedAt = performance.now();
    lastActivityPaintAt = startedAt;
    const hasSamples = !!(frame.enabled && board && (frame.current || frame.recent.length));
    if (activityHasPixels || hasSamples) activityCtx.clearRect(0, 0, view.width, view.height);
    activityHasPixels = false;
    if (!frame.enabled || !board) return;
    for (const recent of frame.recent) paintWorkSample(recent, true);
    if (frame.current) paintWorkSample(frame.current);
    activityHasPixels = hasSamples;
    activityPaintCost = activityPaintCost * .75 + (performance.now() - startedAt) * .25;
    // Keep animation affordable on slower machines without delaying worker
    // messages or routing. Actual locations and the sample limit stay intact.
    activityFrameDelay = Math.max(30, Math.min(100, activityPaintCost * 20));
  }

  function path(points, closed = false) {
    if (!Array.isArray(points) || points.length < 2) return false;
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      const [x, y] = worldToScreen(p[0], p[1]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    if (closed) ctx.closePath();
    return started;
  }

  function circle(x, y, radius) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const p = worldToScreen(x, y);
    ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(.75, (Number(radius) || .2) * view.scale), 0, Math.PI * 2);
    ctx.fill();
  }

  function viaVisible(via) {
    if (!board || !Number.isInteger(via.fromLayer) || !Number.isInteger(via.toLayer)) return false;
    return board.layers.some(layer => Number(layer.id) >= via.fromLayer && Number(layer.id) <= via.toLayer && layerVisible(layer.id));
  }

  function paintVia(via) {
    if (!viaVisible(via) || !Number.isFinite(via.x) || !Number.isFinite(via.y) || !Number.isFinite(via.radius) || via.radius <= 0) return;
    const [x, y] = worldToScreen(via.x, via.y);
    // Copper uses the same board scale as pads and traces. A minimum screen
    // size would make nearby vias look as though they overlap when zoomed out.
    ctx.fillStyle = '#bac5a4';
    ctx.beginPath(); ctx.arc(x, y, via.radius * view.scale, 0, Math.PI * 2); ctx.fill();
    // A copper diameter does not tell us the drill diameter. Show a hole only
    // when the imported data actually gives us its size.
    if (Number.isFinite(via.drillRadius) && via.drillRadius > 0) {
      ctx.fillStyle = '#102026';
      ctx.beginPath(); ctx.arc(x, y, via.drillRadius * view.scale, 0, Math.PI * 2); ctx.fill();
    }
  }

  function updateViaPreviewNote() {
    const vias = board?.vias || [], note = $('viaPreviewNote');
    note.hidden = !vias.length;
    if (!vias.length) { note.textContent = ''; return; }
    const known = vias.filter(via => Number.isFinite(via.drillRadius) && via.drillRadius > 0).length;
    note.textContent = known === vias.length ? 'Vias are drawn at their copper and hole sizes.' : (known ? 'Vias are drawn at their copper size. Holes are shown only where this file includes a drill size.' : "Vias are drawn at their copper size. This file has no drill sizes, so the holes aren't shown.");
  }

  function paintBoard() {
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.fillStyle = '#0c161d'; ctx.fillRect(0, 0, view.width, view.height);
    let gridStep = 25;
    let gridX = 0, gridY = 0;
    if (board) {
      const unit = Math.pow(10, Math.floor(Math.log10(28 / view.scale)));
      const ratio = 28 / view.scale / unit;
      gridStep = unit * (ratio > 5 ? 10 : ratio > 2 ? 5 : ratio > 1 ? 2 : 1) * view.scale;
      gridX = ((view.x % gridStep) + gridStep) % gridStep; gridY = ((view.y % gridStep) + gridStep) % gridStep;
    }
    ctx.fillStyle = '#24383e';
    for (let x = gridX; x < view.width; x += gridStep) for (let y = gridY; y < view.height; y += gridStep) ctx.fillRect(x, y, 1, 1);
    if (!board) return;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const outline of board.outlines || []) {
      const points = Array.isArray(outline) ? outline : outline.points;
      if (path(points, true)) { ctx.fillStyle = '#14252399'; ctx.fill(); ctx.strokeStyle = '#4e7567'; ctx.lineWidth = 1.4; ctx.stroke(); }
    }
    for (const layer of [...(board.layers || [])].reverse()) if (layerVisible(layer.id)) paintCopperLayer(layer.id);
    for (const layer of [...(board.layers || [])].reverse()) {
      if (!layerVisible(layer.id)) continue;
      ctx.strokeStyle = layerColor(layer.id); ctx.globalAlpha = .87;
      for (const trace of board.traces || []) {
        if (layerKey(trace.layer) !== layerKey(layer.id)) continue;
        if (path(trace.points)) { ctx.lineWidth = Math.max(.8, (Number(trace.width) || .1) * view.scale); ctx.stroke(); }
      }
      if ($('showPads').checked) {
        ctx.fillStyle = layerColor(layer.id); ctx.globalAlpha = .94;
        for (const pad of board.pads || []) {
          if (layerKey(pad.layer) !== layerKey(layer.id)) continue;
          if (pad.points && path(pad.points, true)) ctx.fill(); else circle(pad.x, pad.y, pad.radius);
        }
      }
    }
    ctx.globalAlpha = 1;
    if ($('showPads').checked) for (const via of board.vias || []) paintVia(via);
    if ($('showAirwires').checked) {
      ctx.strokeStyle = '#dfc77e'; ctx.lineWidth = viewedStopJobId === currentState?.job?.id ? 1.5 : .8; ctx.globalAlpha = viewedStopJobId === currentState?.job?.id ? .9 : .46; ctx.setLineDash([3, 4]);
      for (const wire of board.airwires || []) {
        const points = Array.isArray(wire) ? wire : wire.points;
        if (path(points)) ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    if (focusedAdvice && focusedAdvice.jobId === currentState?.job?.id) {
      const [minX, minY, maxX, maxY] = focusedAdvice.bounds;
      const [left, top] = worldToScreen(minX, maxY), [right, bottom] = worldToScreen(maxX, minY);
      const width = Math.max(10, right - left), height = Math.max(10, bottom - top);
      ctx.save();
      ctx.fillStyle = '#f5cc7312'; ctx.fillRect(left, top, width, height);
      ctx.strokeStyle = '#f4d28a'; ctx.lineWidth = 2; ctx.setLineDash([7, 5]); ctx.strokeRect(left, top, width, height); ctx.setLineDash([]);
      const focusNets = new Set([focusedAdvice.item.net, ...(focusedAdvice.item.evidence?.nets || []), ...(focusedAdvice.item.evidence?.nearbyPads || []).map(pad => pad.net)].filter(Boolean));
      for (const pad of board.pads || []) {
        if (!layerVisible(pad.layer) || (focusNets.size && !focusNets.has(pad.net))) continue;
        let padMinX = pad.x - (pad.radius || 0), padMaxX = pad.x + (pad.radius || 0);
        let padMinY = pad.y - (pad.radius || 0), padMaxY = pad.y + (pad.radius || 0);
        if (pad.points?.length) {
          padMinX = Math.min(...pad.points.map(point => point[0])); padMaxX = Math.max(...pad.points.map(point => point[0]));
          padMinY = Math.min(...pad.points.map(point => point[1])); padMaxY = Math.max(...pad.points.map(point => point[1]));
        }
        if (padMaxX < minX || padMinX > maxX || padMaxY < minY || padMinY > maxY) continue;
        if (pad.points && path(pad.points, true)) ctx.stroke();
        else {
          const [x, y] = worldToScreen(pad.x, pad.y);
          ctx.beginPath(); ctx.arc(x, y, Math.max(6, (Number(pad.radius) || .2) * view.scale + 3), 0, Math.PI * 2); ctx.stroke();
        }
      }
      const point = focusedAdvice.item.location;
      if (Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) {
        const [x, y] = worldToScreen(point[0], point[1]);
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x - 9, y); ctx.moveTo(x + 9, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 9); ctx.moveTo(x, y + 9); ctx.lineTo(x, y + 12); ctx.stroke();
      }
      ctx.restore();
    }
  }

  const copperPreviewCache = new WeakMap();
  function copperPreviewPath(fill) {
    let cached = copperPreviewCache.get(fill);
    if (cached && cached.scale === view.scale && cached.x === view.x && cached.y === view.y) return cached.path;
    const result = new Path2D();
    for (const points of [fill.points, ...(fill.holes || [])]) {
      if (!Array.isArray(points) || points.length < 3) continue;
      let first = true;
      for (const point of points) { const p = worldToScreen(point[0], point[1]); if (first) { result.moveTo(p[0], p[1]); first = false; } else result.lineTo(p[0], p[1]); }
      result.closePath();
    }
    copperPreviewCache.set(fill, { scale: view.scale, x: view.x, y: view.y, path: result }); return result;
  }

  function paintCopperLayer(layer) {
    if (!$('showCopper').checked) return;
    ctx.save(); ctx.fillStyle = layerColor(layer); ctx.globalAlpha = .25;
    for (const fill of board.copperFills || []) if (layerKey(fill.layer) === layerKey(layer)) ctx.fill(copperPreviewPath(fill), 'evenodd');
    ctx.restore();
  }

  function readRoutingOptions() {
    return { deepSearch: $('deepSearch').checked, viaInPad: $('viaInPad').checked, fanout: $('fanout').checked, fanoutOnly: $('fanoutOnly').checked, optimize: $('optimize').checked, preferredDirections: $('preferredDirections').checked, benchmarkMode: $('benchmarkMode').checked, maxPasses: Number($('maxPasses').value), timeoutMinutes: Number($('timeoutMinutes').value) };
  }

  function writeRoutingOptions(settings) {
    for (const key of ['fanout', 'fanoutOnly', 'optimize', 'deepSearch', 'viaInPad', 'preferredDirections', 'benchmarkMode']) if (typeof settings[key] === 'boolean') $(key).checked = settings[key];
    for (const key of ['maxPasses', 'timeoutMinutes']) if (Number.isFinite(settings[key])) $(key).value = settings[key];
  }

  function getSettings() {
    const settings = readRoutingOptions(), fanoutOnly = settings.fanout && settings.fanoutOnly;
    return { ...settings, fanoutOnly, deepSearch: settings.deepSearch && !fanoutOnly, optimize: settings.optimize && !fanoutOnly };
  }

  function saveSettings(settings = readRoutingOptions()) { try { localStorage.setItem('ramenrouter.browser.settings.v1', JSON.stringify(settings)); } catch {} }

  async function startRouting(enableViaInPad = false, relaxDirections = false) {
    if (busy || isActive() || hasPreviousRulesDecision() || !connected || $('netLayersDialog').open || !$('settingsForm').checkValidity()) return;
    if (enableViaInPad) {
      if (!canSuggestViaInPad()) return;
      $('viaInPad').checked = true;
      document.querySelector('.advanced-rules').open = true;
    }
    if (relaxDirections) {
      if (!canSuggestRelaxingDirections()) return;
      $('preferredDirections').checked = false;
    }
    acknowledgeAttention();
    busy = true; updateControls();
    try { saveSettings(); await post('/api/run', { ...getSettings(), animationEnabled: $('showLiveWork').checked }); }
    catch (error) { toast(error.message, true); }
    finally { busy = false; updateControls(); }
  }
  function restoreSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem('ramenrouter.browser.settings.v1') || '{}');
      for (const key of ['fanout', 'fanoutOnly', 'optimize', 'deepSearch', 'viaInPad', 'preferredDirections', 'benchmarkMode']) if (typeof settings[key] === 'boolean') $(key).checked = settings[key];
      if (Number.isInteger(settings.maxPasses) && settings.maxPasses >= 1 && settings.maxPasses <= 100) $('maxPasses').value = settings.maxPasses;
      if (Number.isInteger(settings.timeoutMinutes) && settings.timeoutMinutes >= 1 && settings.timeoutMinutes <= 1440) $('timeoutMinutes').value = settings.timeoutMinutes;
    } catch {}
  }

  function openClearRouting() {
    const job = currentState?.job, routing = job?.routingSummary;
    if (!connected || busy || isActive() || hasPreviousRulesDecision() || !routing || routing.traceCount + routing.viaCount === 0) return;
    clearRoutingJobId = job.id;
    $('clearRoutingFileName').textContent = job.name || 'Untitled board';
    const count = (value, singular, plural) => `${number(value)} ${value === 1 ? singular : plural}`;
    $('clearRoutingCounts').textContent = `all ${count(routing.traceCount, 'trace', 'traces')} and ${count(routing.viaCount, 'routing via', 'routing vias')}`;
    const fixedCount = (routing.fixedTraceCount || 0) + (routing.fixedViaCount || 0);
    $('clearRoutingFixed').hidden = fixedCount === 0;
    $('clearRoutingFixed').textContent = fixedCount ? `This includes ${count(routing.fixedTraceCount || 0, 'fixed or protected trace', 'fixed or protected traces')} and ${count(routing.fixedViaCount || 0, 'fixed or protected routing via', 'fixed or protected routing vias')}. They will be removed too.` : '';
    $('clearRoutingDialog').showModal();
    updateControls();
    $('cancelClearRouting').focus();
  }

  async function confirmClearRouting() {
    const jobId = clearRoutingJobId;
    if (!jobId || !connected || busy || isActive() || currentState?.job?.id !== jobId) return;
    $('clearRoutingDialog').close();
    busy = true; updateControls();
    try { await post('/api/clear-routing', { jobId }); }
    catch (error) { toast(error.message, true); }
    finally { busy = false; updateControls(); }
  }

  function sameLayerSelection(selected, layers) {
    return selected.size === layers.length && layers.every(layer => selected.has(layer));
  }

  function sameRoutingRule(net, imported = false) {
    return sameLayerSelection(netLayerDrafts.get(net.id), imported ? net.importedLayers : net.allowedLayers) &&
      netShortDrafts.get(net.id) === Boolean(imported ? net.importedPreferShort : net.preferShort);
  }

  function filteredNetLayerNets() {
    const query = $('netLayerSearch').value.trim().toLocaleLowerCase();
    if (!query.includes('*')) return netLayersData.nets.filter(net => String(net.name).toLocaleLowerCase().includes(query));
    const [first, ...parts] = query.split('*'), last = parts.pop();
    // Match literal pieces in order, reserving the suffix so pieces cannot
    // overlap. This keeps punctuation literal and avoids regex backtracking.
    return netLayersData.nets.filter(net => {
      const name = String(net.name).toLocaleLowerCase();
      if (!name.startsWith(first) || !name.endsWith(last)) return false;
      let position = first.length;
      const end = name.length - last.length;
      if (position > end) return false;
      for (const part of parts) {
        position = name.indexOf(part, position);
        if (position < 0 || position + part.length > end) return false;
        position += part.length;
      }
      return true;
    });
  }

  function setRoutingRulesTab(section, focus = false) {
    const options = section === 'options';
    for (const [id, selected] of [['routingOptionsTab', options], ['netRulesTab', !options]]) {
      $(id).setAttribute('aria-selected', String(selected)); $(id).tabIndex = selected ? 0 : -1;
      if (selected && focus) $(id).focus();
    }
    $('routingOptionsPanel').hidden = !options;
    $('netRulesPanel').hidden = options;
  }

  function updateDirectionPreview() {
    const layers = netLayersData?.layers || [];
    if (layers.length < 2) {
      $('directionLayerPreview').textContent = 'Alternating directions needs at least two copper layers. There is nothing to alternate on a single-layer board.';
      return;
    }
    const preview = layers.map(layer => `${layer.displayName || layer.name}: ${layer.preferredDirection === 'vertical' ? 'vertical ↕' : layer.preferredDirection === 'horizontal' ? 'horizontal ↔' : 'no preference'}`).join(' · ');
    $('directionLayerPreview').textContent = `${$('preferredDirections').checked ? 'Preferred directions' : 'If enabled'}: ${preview}`;
  }

  function discardRoutingRuleDraft() {
    if (routingOptionsBeforeDialog) writeRoutingOptions(routingOptionsBeforeDialog);
    routingOptionsBeforeDialog = null;
    netLayersData = null; netLayerDrafts.clear(); netShortDrafts.clear();
  }

  function updateNetLayerDraftStatus() {
    if (!netLayersData) return;
    let changed = 0, invalid = 0, inaccessible = 0;
    const shownNets = filteredNetLayerNets(), shownIds = new Set(shownNets.map(net => net.id));
    const unavailable = !connected || busy || isActive() || currentState?.job?.id !== netLayersData.jobId;
    for (const net of netLayersData.nets) {
      const selected = netLayerDrafts.get(net.id);
      const row = net.row;
      const edited = !sameRoutingRule(net);
      const imported = sameRoutingRule(net, true);
      const unreachable = (net.padLayers || []).filter(layers => layers.length && !layers.some(layer => selected.has(layer))).length;
      if (edited) changed++;
      if (!selected.size) invalid++;
      inaccessible += unreachable;
      row.hidden = !shownIds.has(net.id);
      row.classList.toggle('net-layer-invalid', selected.size === 0);
      row.classList.toggle('net-layer-edited', edited);
      net.status.textContent = !selected.size ? 'Select at least one layer' : (imported ? 'Imported rules' : 'Custom rules');
      net.padWarning.hidden = !unreachable;
      net.padWarning.textContent = unreachable ? `${number(unreachable)} ${unreachable === 1 ? 'pad needs' : 'pads need'} a short pad escape to reach the selected layers` : '';
      net.reset.disabled = unavailable || imported;
      for (const checkbox of row.querySelectorAll('input[data-layer-id]')) {
        checkbox.disabled = unavailable;
        checkbox.checked = selected.has(Number(checkbox.dataset.layerId));
        checkbox.setAttribute('aria-invalid', String(!selected.size));
      }
      net.shortCheckbox.disabled = unavailable;
      net.shortCheckbox.checked = netShortDrafts.get(net.id);
    }
    for (const checkbox of $('netLayerHead').querySelectorAll('input[data-layer-id]')) {
      const layerId = Number(checkbox.dataset.layerId);
      const selectedCount = shownNets.filter(net => netLayerDrafts.get(net.id).has(layerId)).length;
      checkbox.checked = shownNets.length > 0 && selectedCount === shownNets.length;
      checkbox.indeterminate = selectedCount > 0 && selectedCount < shownNets.length;
      checkbox.disabled = unavailable || shownNets.length === 0;
    }
    const shortHeading = $('netShortAll');
    const shortCount = shownNets.filter(net => netShortDrafts.get(net.id)).length;
    shortHeading.checked = shownNets.length > 0 && shortCount === shownNets.length;
    shortHeading.indeterminate = shortCount > 0 && shortCount < shownNets.length;
    shortHeading.disabled = unavailable || shownNets.length === 0;
    $('netLayerCount').textContent = `${number(shownNets.length)} of ${number(netLayersData.nets.length)} nets shown · ${number(changed)} ${changed === 1 ? 'change' : 'changes'} to apply`;
    $('netLayerValidation').hidden = !invalid;
    $('netLayerValidation').textContent = invalid ? `Every net needs at least one layer. ${number(invalid)} ${invalid === 1 ? 'net needs' : 'nets need'} a layer, including nets hidden by your search.` : '';
    $('netLayerPadWarning').hidden = !inaccessible;
    $('netLayerPadWarning').textContent = inaccessible ? `${number(inaccessible)} ${inaccessible === 1 ? 'pad has' : 'pads have'} no direct connection to a selected layer. RamenRouter will try a short, full-width escape to a nearby via, then stay on a selected layer. The escape still needs room and must pass your rules. The SMD-via switch controls whether that via can go inside the pad.` : '';
    const optionsChanged = routingOptionsBeforeDialog && JSON.stringify(readRoutingOptions()) !== JSON.stringify(routingOptionsBeforeDialog);
    $('applyNetLayers').disabled = unavailable || invalid > 0 || (!changed && !optionsChanged);
    $('netLayersApplyNote').textContent = changed ? 'Save your current result first. Changing net rules starts again from the board you loaded and keeps its imported copper. Routing options are saved once the net rules pass their checks.' : 'These options apply to your next run. Your current result stays here.';
    $('resetAllNetLayers').disabled = unavailable || netLayersData.nets.every(net => sameRoutingRule(net, true));
    $('netLayerSearch').disabled = unavailable;
  }

  function renderNetLayerRows() {
    const heading = document.createElement('tr');
    const netHeading = document.createElement('th'); netHeading.scope = 'col'; netHeading.textContent = 'Net'; heading.append(netHeading);
    const shortHeading = document.createElement('th'); shortHeading.scope = 'col'; shortHeading.className = 'net-short-column';
    const shortLabel = document.createElement('label'); shortLabel.className = 'net-layer-column';
    const shortName = document.createElement('span'); shortName.textContent = 'Prefer shorter routes';
    const shortAll = document.createElement('input'); shortAll.type = 'checkbox'; shortAll.id = 'netShortAll'; shortAll.dataset.preferShort = 'all';
    shortAll.setAttribute('aria-label', 'Prefer shorter routes: all shown nets');
    shortAll.setAttribute('aria-describedby', 'netShortDescription netLayerBulkHelp');
    shortAll.addEventListener('change', () => {
      if (!connected || busy || isActive() || currentState?.job?.id !== netLayersData?.jobId) return;
      for (const net of filteredNetLayerNets()) netShortDrafts.set(net.id, shortAll.checked);
      updateNetLayerDraftStatus();
    });
    shortLabel.append(shortName, shortAll); shortHeading.append(shortLabel); heading.append(shortHeading);
    for (const layer of netLayersData.layers) {
      const th = document.createElement('th'); th.scope = 'col';
      const label = document.createElement('label'); label.className = 'net-layer-column';
      const name = document.createElement('span'); name.textContent = layer.displayName;
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.layerId = String(layer.id);
      checkbox.setAttribute('aria-label', `${layer.displayName}: all shown nets`);
      checkbox.setAttribute('aria-describedby', 'netLayerBulkHelp');
      checkbox.addEventListener('change', () => {
        if (!connected || busy || isActive() || currentState?.job?.id !== netLayersData?.jobId) return;
        for (const net of filteredNetLayerNets()) {
          const selected = netLayerDrafts.get(net.id);
          if (checkbox.checked) selected.add(layer.id); else selected.delete(layer.id);
        }
        updateNetLayerDraftStatus();
      });
      label.append(name, checkbox); th.append(label); heading.append(th);
    }
    const restoreHeading = document.createElement('th'); restoreHeading.scope = 'col'; restoreHeading.textContent = 'Restore'; heading.append(restoreHeading);
    $('netLayerHead').replaceChildren(heading);
    const rows = document.createDocumentFragment();
    for (const net of netLayersData.nets) {
      const row = document.createElement('tr'); row.dataset.netId = String(net.id);
      const name = document.createElement('th'); name.scope = 'row';
      const label = document.createElement('span'); label.className = 'net-layer-name'; label.textContent = net.name;
      const status = document.createElement('small'); status.className = 'net-layer-rule-status';
      const warning = document.createElement('small'); warning.className = 'net-layer-row-warning';
      name.append(label, status, warning); row.append(name);
      const shortCell = document.createElement('td'); shortCell.className = 'net-short-column';
      const shortCheckbox = document.createElement('input'); shortCheckbox.type = 'checkbox'; shortCheckbox.dataset.preferShort = String(net.id);
      shortCheckbox.setAttribute('aria-label', `${net.name}: Prefer shorter routes`);
      shortCheckbox.setAttribute('aria-describedby', 'netShortDescription');
      shortCheckbox.addEventListener('change', () => {
        if (!connected || busy || isActive() || currentState?.job?.id !== netLayersData?.jobId) return;
        netShortDrafts.set(net.id, shortCheckbox.checked);
        updateNetLayerDraftStatus();
      });
      shortCell.append(shortCheckbox); row.append(shortCell);
      for (const layer of netLayersData.layers) {
        const cell = document.createElement('td');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.layerId = String(layer.id);
        checkbox.setAttribute('aria-label', `${net.name}: ${layer.displayName}`);
        checkbox.addEventListener('change', () => {
          if (busy || isActive() || currentState?.job?.id !== netLayersData?.jobId) return;
          const selected = netLayerDrafts.get(net.id);
          if (checkbox.checked) selected.add(layer.id); else selected.delete(layer.id);
          updateNetLayerDraftStatus();
        });
        cell.append(checkbox); row.append(cell);
      }
      const resetCell = document.createElement('td');
      const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset';
      reset.setAttribute('aria-label', `Reset ${net.name} to imported rules`);
      reset.addEventListener('click', () => {
        if (busy || isActive() || currentState?.job?.id !== netLayersData?.jobId) return;
        netLayerDrafts.set(net.id, new Set(net.importedLayers));
        netShortDrafts.set(net.id, Boolean(net.importedPreferShort));
        updateNetLayerDraftStatus();
      });
      resetCell.append(reset); row.append(resetCell); rows.append(row);
      net.row = row; net.status = status; net.padWarning = warning; net.reset = reset; net.shortCheckbox = shortCheckbox;
    }
    $('netLayerRows').replaceChildren(rows);
    updateNetLayerDraftStatus();
  }

  async function openNetLayers() {
    const jobId = currentState?.job?.id;
    if (!jobId || !connected || busy || isActive() || hasPreviousRulesDecision()) return;
    busy = true; updateControls();
    try {
      const data = await api('/api/routing-rules');
      if (currentState?.job?.id !== jobId || isActive() || data.jobId !== jobId) return;
      netLayersData = { ...data, layers: displayLayers(data.layers), nets: [...data.nets].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' })) };
      netLayerDrafts = new Map(netLayersData.nets.map(net => [net.id, new Set(net.allowedLayers)]));
      netShortDrafts = new Map(netLayersData.nets.map(net => [net.id, Boolean(net.preferShort)]));
      routingOptionsBeforeDialog = readRoutingOptions();
      $('routingRulesError').hidden = true;
      $('netLayerSearch').value = '';
      renderNetLayerRows();
      setRoutingRulesTab('options'); updateDirectionPreview();
      $('netLayersDialog').showModal();
    } catch (error) { toast(error.message, true); }
    finally { busy = false; updateControls(); if ($('netLayersDialog').open) $('routingOptionsTab').focus(); }
  }

  async function applyNetLayers() {
    const data = netLayersData;
    if (!data || !connected || busy || isActive() || currentState?.job?.id !== data.jobId) return;
    if (!$('settingsForm').checkValidity()) { setRoutingRulesTab('options'); $('settingsForm').reportValidity(); return; }
    if (data.nets.some(net => !netLayerDrafts.get(net.id).size)) { setRoutingRulesTab('nets'); updateNetLayerDraftStatus(); return; }
    const changes = data.nets.filter(net => !sameRoutingRule(net)).map(net => ({ netId: net.id, layers: data.layers.filter(layer => netLayerDrafts.get(net.id).has(layer.id)).map(layer => layer.id), preferShort: netShortDrafts.get(net.id) }));
    const options = readRoutingOptions(), previous = routingOptionsBeforeDialog;
    if (!changes.length) {
      routingOptionsBeforeDialog = null; saveSettings(options); discardRoutingRuleDraft(); $('netLayersDialog').close();
      updateControls(); toast('Options saved for your next run. Your current result stays here.'); return;
    }
    $('routingRulesError').hidden = true;
    busy = true; updateControls();
    try {
      const state = await api('/api/routing-rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: data.jobId, changes }) });
      if (!state?.job) throw new Error('Could not confirm your routing rules. Try again.');
      pendingRoutingOptions = { sourceJobId: data.jobId, transactionJobId: state.job.id, options, previous };
      discardRoutingRuleDraft(); $('netLayersDialog').close(); applyState(state);
    }
    catch (error) {
      pendingRoutingOptions = null;
      $('routingRulesError').textContent = `Your routing rules were not applied. ${error.message}`; $('routingRulesError').hidden = false;
    }
    finally { busy = false; updateControls(); }
  }

  async function upload(file) {
    if (!file) return;
    if (hasPreviousRulesDecision()) { $('fileInput').value = ''; toast('Choose whether to keep your previous rules first.'); return; }
    if (busy || isActive() || !connected) return;
    if (!/\.dsn$/i.test(file.name)) { toast('Choose a .dsn board exported from your PCB editor.', true); return; }
    if (file.size === 0) { toast('This file is empty. Export a new DSN from your PCB editor.', true); return; }
    busy = true; updateControls(); $('boardBusy').hidden = false;
    try {
      const result = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      if (result) applyState(result);
      toast(`${file.name} loaded. Reading your board…`);
    } catch (error) { toast(error.message, true); }
    finally { busy = false; $('fileInput').value = ''; updateControls(); $('boardBusy').hidden = false; setTimeout(() => { if (!fetchingBoard) $('boardBusy').hidden = true; }, 1000); }
  }

  async function download(type) {
    try {
      if (!nativeEngine || typeof nativeEngine.download !== 'function') throw new Error('Downloads are not ready. Reopen index.html and try again.');
      await nativeEngine.download(type);
      if (type === 'ses') downloadedSesJobId = currentState?.job?.id;
      if (type === 'dsn') downloadedDsnJobId = currentState?.job?.id;
      updateExportAttention();
      toast(type === 'log' ? 'Routing log saved.' : (type === 'report' ? 'Rule-check report saved.' : 'Export saved. Check the result in your PCB editor.'));
      return true;
    } catch (error) { toast(error.message, true); return false; }
  }

  // Reports are built only on request, outside the routing/animation hot path.
  let displayedRunReport = null;
  let importedRunReport = null;
  let reportJobId = null;
  let reportNetNames = new Map();
  const benchmarkTools = globalThis.RamenBenchmark;

  function reportElement(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function reportDuration(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${number(ms, 0)} ms`;
    if (ms < 60000) return `${number(ms / 1000, 2)} s`;
    return `${seconds(ms / 1000)}${ms >= 3600000 ? ' hr' : ' min'}`;
  }

  function updateRunReportControls() {
    const job = currentState?.job;
    const ready = Boolean(job?.runReport && terminalStates.has(job.state) && job.operation === 'run');
    $('runReportButton').hidden = !ready;
    $('runReportButton').disabled = !ready || busy;
    // Preserve an already-open report as a snapshot; replacing the board does
    // not quietly change the figures underneath a comparison.
  }

  function renderReportStages(report) {
    const names = { reading: 'Read board', preparing: 'Map copper and clearances', searching: 'Search paths', routing: 'Route & repair', fanout: 'Pad escapes', refining: 'Refine routes', checking: 'Check rules', advising: 'Placement advice', exporting: 'Get exports ready', fingerprinting: 'Identify this board', other: 'Other work' };
    const fragment = document.createDocumentFragment();
    for (const stage of report.stages) {
      if (stage.activeMs <= 0) continue;
      const row = reportElement('div', undefined, 'report-stage');
      const label = reportElement('span', names[stage.name] || stage.name);
      const bar = reportElement('span', undefined, 'report-stage-track');
      const fill = reportElement('span');
      fill.style.width = `${Math.min(100, Math.max(0, stage.activeMs / Math.max(1, report.timing.activeMs) * 100))}%`;
      bar.setAttribute('aria-hidden', 'true'); bar.append(fill);
      const value = reportElement('strong', reportDuration(stage.activeMs));
      row.append(label, bar, value); fragment.append(row);
    }
    $('reportStages').replaceChildren(fragment);
    const partial = report.coverage?.partial;
    $('reportCoverageNote').textContent = partial ? `Partial measurement: work and timing updates were recorded through ${reportDuration(report.timing.measuredThroughMs)}. Stopping can end a step before its next update.` : 'Includes board preparation and final checks. Time spent searching is counted once, and pauses are left out.';
  }

  function renderReportProgress(report) {
    const container = $('reportProgressChart');
    if (!report.progress.length) { container.replaceChildren(reportElement('p', 'No checked results were recorded for this run.', 'report-note')); return; }
    const points = report.progress;
    const width = Math.max(260, Math.min(760, window.innerWidth - (window.innerWidth <= 600 ? 70 : 110)));
    const height = 230, left = 48, right = 18, top = 18, bottom = 40;
    const maxTime = Math.max(1, report.timing.activeMs, ...points.map(point => point.activeMs));
    const maxRemaining = Math.max(1, ...points.map(point => point.unrouted));
    const x = value => left + value / maxTime * (width - left - right);
    const y = value => top + (1 - value / maxRemaining) * (height - top - bottom);
    const svgNode = (tag, attrs = {}, text) => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-labelledby': 'reportChartTitle reportChartDescription' });
    svg.append(svgNode('title', { id: 'reportChartTitle' }, 'Connections left over time, from checked results'));
    svg.append(svgNode('desc', { id: 'reportChartDescription' }, `The first recorded result had ${number(points[0].unrouted)} connections remaining. The last had ${number(points[points.length - 1].unrouted)} after ${reportDuration(points[points.length - 1].activeMs)} of processing.`));
    for (const level of [0, .5, 1]) {
      const remaining = Math.round(maxRemaining * level), py = y(remaining);
      svg.append(svgNode('line', { x1: left, x2: width - right, y1: py, y2: py, class: 'report-chart-grid' }));
      svg.append(svgNode('text', { x: left - 9, y: py + 5, 'text-anchor': 'end' }, remaining >= 10000 ? remaining.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 }) : number(remaining)));
    }
    svg.append(svgNode('text', { x: left, y: height - 12 }, '0 s'));
    svg.append(svgNode('text', { x: width - right, y: height - 12, 'text-anchor': 'end' }, reportDuration(maxTime)));
    let path = `M ${x(points[0].activeMs)} ${y(points[0].unrouted)}`;
    for (const point of points.slice(1)) path += ` H ${x(point.activeMs)} V ${y(point.unrouted)}`;
    path += ` H ${x(maxTime)}`;
    svg.append(svgNode('path', { d: path, class: 'report-chart-line' }));
    for (const point of [points[0], points[points.length - 1]]) svg.append(svgNode('circle', { cx: x(point.activeMs), cy: y(point.unrouted), r: 4, class: 'report-chart-dot' }));
    container.replaceChildren(svg);
  }

  function reportBrowser(report) {
    const env = report.environment;
    return env.browser || env.userAgent || 'Browser not recorded';
  }

  function renderReportDetails(report) {
    const stats = report.final || {}, counters = report.counters;
    const searchMs = report.stages.filter(stage => stage.name === 'searching').reduce((sum, stage) => sum + stage.activeMs, 0);
    const rows = [
      ['Total trace length', `${number(stats.traceLengthMm, 2)} mm`], ['Vias', number(stats.viaCount)],
      ['Trace segments', number(stats.traceCount)], ['Undersized traces', number(stats.belowNominalWidthTraceCount)],
      ['Paths searched', number(counters.searches)], ['Grid positions explored', number(counters.gridPositions)],
      ['Grid positions per search second', searchMs > 0 ? number(counters.gridPositions / (searchMs / 1000)) : '—'],
      ['Attempts to connect nets', number(counters.netAttempts)], ['Routes removed to make room', number(counters.ripups)],
      ['Refinements tried', number(counters.refinementCandidates)], ['Checks for unnecessary vias', number(counters.redundantViaChecks)],
      ['Pad escapes considered', number(counters.fanoutCandidates)], ['Pad-escape combinations', number(counters.fanoutCombinations)],
      ['Time paused', reportDuration(report.timing.pausedMs)]
    ];
    for (const [key, label] of [['attempt', 'Routing attempts'], ['repair', 'Repair rounds'], ['refinement', 'Refinement rounds']]) {
      const round = report.rounds?.[key];
      if (round) rows.push([label, `${number(round.completed)} completed${round.current > round.completed ? ` · ${number(round.current)} started` : ''}`]);
    }
    const fragment = document.createDocumentFragment();
    for (const [label, value] of rows) fragment.append(reportElement('dt', label), reportElement('dd', value));
    $('reportDetailStats').replaceChildren(fragment);
    const hardRows = document.createDocumentFragment();
    for (const net of [...report.hardestNets].sort((a, b) => b.gridPositions - a.gridPositions || b.activeMs - a.activeMs)) {
      const row = reportElement('tr');
      const localName = reportNetNames.get(net.netIndex);
      const name = reportElement('th', localName ? `${localName} · Net ${net.netIndex}` : `Net ${net.netIndex}`); name.scope = 'row'; row.append(name);
      for (const value of [number(net.searches), number(net.gridPositions), reportDuration(net.activeMs)]) row.append(reportElement('td', value));
      hardRows.append(row);
    }
    if (!report.hardestNets.length) { const row = reportElement('tr'), cell = reportElement('td', 'No search work was recorded for individual nets.'); cell.colSpan = 4; row.append(cell); hardRows.append(row); }
    $('reportHardest').replaceChildren(hardRows);
    $('reportEnvironment').textContent = `RamenRouter ${report.appVersion} · ${report.protocol === 'fixed-work-v1' ? 'Fixed-work benchmark' : 'Normal routing'} · ${reportBrowser(report)} · ${report.environment.workerCount} routing task · Live work ${report.environment.animationEnabled ? 'on' : 'off'}${report.environment.animationChanged ? ' (changed during run)' : ''}. Board match ID: ${report.boardFingerprint ? report.boardFingerprint.slice(0, 16) + '…' : 'not available'}`;
  }

  function reportWithLabel() {
    if (!displayedRunReport) return null;
    return benchmarkTools.validateReport({ ...displayedRunReport, environment: { ...displayedRunReport.environment, deviceLabel: $('reportDeviceLabel').value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80) } });
  }

  function comparisonLabel(report, fallback) { return report.environment.deviceLabel || fallback; }

  function renderBenchmarkComparison() {
    $('benchmarkCompareSection').hidden = !importedRunReport || !displayedRunReport;
    if (!importedRunReport || !displayedRunReport) return;
    const current = reportWithLabel(), other = importedRunReport;
    const comparison = benchmarkTools.compareReports(current, other);
    const aLabel = comparisonLabel(current, 'This run'), bLabel = comparisonLabel(other, 'Imported run');
    const status = $('benchmarkCompareStatus');
    status.classList.toggle('comparable', comparison.comparable);
    if (comparison.comparable) {
      const ratio = current.timing.activeMs / other.timing.activeMs;
      status.textContent = ratio >= 1 ? `Same completed workload. ${bLabel} was ${number(current.timing.activeMs / other.timing.activeMs, 2)}× as fast as ${aLabel}.` : `Same completed workload. ${aLabel} was ${number(other.timing.activeMs / current.timing.activeMs, 2)}× as fast as ${bLabel}.`;
      if (Math.abs(ratio - 1) < .005) status.textContent = 'Same completed workload. Both took about the same time.';
    } else status.textContent = `Compare the results side by side. These runs cannot give a fair speed ranking. ${comparison.reasons.join(' ')}`;
    const table = $('benchmarkCompareTable'), head = reportElement('thead'), headRow = reportElement('tr');
    for (const label of ['Measurement', aLabel, bLabel]) { const cell = reportElement('th', label); cell.scope = 'col'; headRow.append(cell); }
    head.append(headRow); const body = reportElement('tbody');
    const outcome = report => report.complete ? 'Complete & checked' : report.status === 'stopped' ? 'Stopped' : report.status === 'error' ? 'Error' : 'Incomplete';
    const rows = [
      ['Result', outcome(current), outcome(other)],
      ['Processing time', reportDuration(current.timing.activeMs), reportDuration(other.timing.activeMs)],
      ['First complete, checked route', reportDuration(current.timing.firstCompleteMs), reportDuration(other.timing.firstCompleteMs)],
      ['Connections remaining', number(current.final?.unrouted), number(other.final?.unrouted)],
      ['Rule issues', number(current.final?.totalViolations), number(other.final?.totalViolations)],
      ['Undersized traces', number(current.final?.belowNominalWidthTraceCount), number(other.final?.belowNominalWidthTraceCount)],
      ['Trace length', `${number(current.final?.traceLengthMm, 2)} mm`, `${number(other.final?.traceLengthMm, 2)} mm`],
      ['Vias', number(current.final?.viaCount), number(other.final?.viaCount)],
      ['Grid positions', number(current.counters.gridPositions), number(other.counters.gridPositions)],
      ['Searches', number(current.counters.searches), number(other.counters.searches)],
      ['Mode', current.protocol === 'fixed-work-v1' ? 'Fixed work' : 'Normal routing', other.protocol === 'fixed-work-v1' ? 'Fixed work' : 'Normal routing'],
      ['RamenRouter', current.appVersion, other.appVersion],
      ['Live work', `${current.environment.animationEnabled ? 'On' : 'Off'}${current.environment.animationChanged ? ' · changed during run' : ''}`, `${other.environment.animationEnabled ? 'On' : 'Off'}${other.environment.animationChanged ? ' · changed during run' : ''}`],
      ['Browser', reportBrowser(current), reportBrowser(other)]
    ];
    for (const [label, a, b] of rows) { const row = reportElement('tr'), cell = reportElement('th', label); cell.scope = 'row'; row.append(cell, reportElement('td', a), reportElement('td', b)); body.append(row); }
    table.replaceChildren(head, body);
  }

  async function openRunReport() {
    const job = currentState?.job;
    if (!job?.runReport || !terminalStates.has(job.state) || !benchmarkTools) return;
    try {
      displayedRunReport = benchmarkTools.validateReport(job.runReport);
      const report = displayedRunReport;
      reportNetNames = new Map();
      // The rules API preserves board.nets order, the same order used for
      // report netIndex. Names are kept in this view only, never in the report.
      try {
        const rules = await api('/api/routing-rules');
        if (rules.jobId === job.id && currentState?.job?.id === job.id) reportNetNames = new Map(rules.nets.map((net, index) => [index + 1, String(net.name)]));
      } catch {}
      if (currentState?.job?.id !== job.id || isActive()) return;
      $('reportActiveTime').textContent = reportDuration(report.timing.activeMs);
      $('reportFirstComplete').textContent = report.timing.firstCompleteMs === null ? 'Not reached' : reportDuration(report.timing.firstCompleteMs);
      $('reportRemaining').textContent = number(report.final?.unrouted);
      $('reportRuleIssues').textContent = number(report.final?.totalViolations);
      $('reportRuleNote').textContent = report.final?.drcChecked ? 'Imported clearance and placement checks' : 'Final rule checks did not finish';
      $('reportFirstCompleteNote').textContent = report.timing.firstCompleteMs === null ? 'No fully connected result passed every imported check' : !report.complete ? 'A fully connected, checked result was found earlier. The saved result is different.' : 'Every connection and imported check passed';
      $('reportOutcome').textContent = `${report.status === 'stopped' ? 'Stopped run' : report.status === 'error' ? 'Interrupted by an error' : report.complete ? 'Completed and checked' : 'Finished with missing connections or rule issues'} · ${report.protocol === 'fixed-work-v1' ? 'Fixed-work benchmark' : 'Normal routing'}${report.coverage?.partial ? ' · partial measurements' : ''}`;
      $('reportOutcome').classList.toggle('complete', report.complete);
      if (reportJobId !== job.id) {
        reportJobId = job.id;
        $('reportDeviceLabel').value = report.environment.deviceLabel || '';
        try { $('reportDeviceLabel').value ||= (localStorage.getItem('ramenrouter.benchmark.device.v1') || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80); } catch {}
        $('reportDetails').open = false;
      }
      $('benchmarkImportError').hidden = true;
      renderReportStages(report); renderReportProgress(report); renderReportDetails(report); renderBenchmarkComparison();
      $('runReportDialog').showModal();
    } catch (error) { toast(`Could not open this run’s report: ${error.message}`, true); }
  }

  function exportRunReport() {
    try {
      const report = reportWithLabel(); if (!report) return;
      const blob = new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = reportElement('a');
      link.href = url; link.download = `RamenRouter-benchmark-${report.appVersion}-${report.boardFingerprint ? report.boardFingerprint.slice(0, 12) : 'partial'}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Benchmark saved. It leaves out your board layout and net names.');
    } catch (error) { $('benchmarkImportError').textContent = error.message; $('benchmarkImportError').hidden = false; }
  }

  async function importRunReport(file) {
    if (!file || !displayedRunReport) return;
    $('benchmarkImportError').hidden = true;
    try {
      if (file.size > 256 * 1024) throw new Error('This benchmark file is too large. Choose one smaller than 256 KiB.');
      const report = benchmarkTools.validateReport(await file.text());
      importedRunReport = report; renderBenchmarkComparison();
      $('benchmarkCompareSection').scrollIntoView({ block: 'nearest' });
    } catch (error) { $('benchmarkImportError').textContent = `Could not compare this file: ${error.message}`; $('benchmarkImportError').hidden = false; }
    finally { $('benchmarkFileInput').value = ''; }
  }

  $('showCopper').addEventListener('change', draw);
  $('previousRulesReuse').addEventListener('click', () => void choosePreviousRules(true));
  $('previousRulesImported').addEventListener('click', () => void choosePreviousRules(false));
  $('closePreviousRules').addEventListener('click', () => void choosePreviousRules(false));
  $('previousRulesDialog').addEventListener('cancel', event => { event.preventDefault(); if (!previousRulesAction) void choosePreviousRules(false); });
  for (const id of ['aboutDialog', 'runReportDialog', 'clearRoutingDialog']) $(id).addEventListener('close', updateControls);
  $('runReportButton').addEventListener('click', openRunReport);
  $('closeRunReport').addEventListener('click', () => $('runReportDialog').close());
  $('closeRunReportBottom').addEventListener('click', () => $('runReportDialog').close());
  $('exportBenchmark').addEventListener('click', exportRunReport);
  $('compareBenchmarkButton').addEventListener('click', () => $('benchmarkFileInput').click());
  $('benchmarkFileInput').addEventListener('change', event => void importRunReport(event.target.files[0]));
  $('clearBenchmarkComparison').addEventListener('click', () => { importedRunReport = null; renderBenchmarkComparison(); });
  $('reportDeviceLabel').addEventListener('input', () => {
    try { localStorage.setItem('ramenrouter.benchmark.device.v1', $('reportDeviceLabel').value.trim()); } catch {}
    renderBenchmarkComparison();
  });
  $('dropzone').addEventListener('click', () => { acknowledgeAttention(); $('fileInput').click(); });
  $('replaceButton').addEventListener('click', () => $('fileInput').click());
  $('clearRoutingButton').addEventListener('click', openClearRouting);
  $('confirmClearRouting').addEventListener('click', () => void confirmClearRouting());
  $('cancelClearRouting').addEventListener('click', () => $('clearRoutingDialog').close());
  $('closeClearRouting').addEventListener('click', () => $('clearRoutingDialog').close());
  $('clearRoutingDialog').addEventListener('close', () => { clearRoutingJobId = null; });
  $('netLayersButton').addEventListener('click', () => void openNetLayers());
  $('applyNetLayers').addEventListener('click', () => void applyNetLayers());
  $('cancelNetLayers').addEventListener('click', () => $('netLayersDialog').close());
  $('closeNetLayers').addEventListener('click', () => $('netLayersDialog').close());
  $('netLayersDialog').addEventListener('close', () => { discardRoutingRuleDraft(); updateControls(); });
  $('netLayersDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('routingOptionsTab').addEventListener('click', () => setRoutingRulesTab('options'));
  $('netRulesTab').addEventListener('click', () => setRoutingRulesTab('nets'));
  for (const id of ['routingOptionsTab', 'netRulesTab']) $(id).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = event.key === 'Home' || (event.key !== 'End' && id === 'netRulesTab');
    setRoutingRulesTab(options ? 'options' : 'nets', true);
  });
  $('netLayerSearch').addEventListener('input', updateNetLayerDraftStatus);
  $('resetAllNetLayers').addEventListener('click', () => {
    if (!netLayersData || busy || isActive() || currentState?.job?.id !== netLayersData.jobId) return;
    netLayerDrafts = new Map(netLayersData.nets.map(net => [net.id, new Set(net.importedLayers)]));
    netShortDrafts = new Map(netLayersData.nets.map(net => [net.id, Boolean(net.importedPreferShort)]));
    updateNetLayerDraftStatus();
  });
  $('fileInput').addEventListener('change', event => void upload(event.target.files[0]));
  for (const eventName of ['dragenter', 'dragover']) document.addEventListener(eventName, event => {
    event.preventDefault(); if (connected && !isActive() && !busy && !hasPreviousRulesDecision()) $('dropzone').classList.add('drag-over');
  });
  document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('dropzone').classList.remove('drag-over'); });
  document.addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('drag-over'); void upload(event.dataTransfer?.files[0]); });
  $('demoButton').addEventListener('click', async () => {
    if (busy || isActive() || hasPreviousRulesDecision()) return;
    acknowledgeAttention();
    busy = true; updateControls();
    try { await post('/api/demo'); toast('Example board loaded. Choose your settings and give it a run.'); }
    catch (error) { toast(error.message, true); }
    finally { busy = false; updateControls(); }
  });
  $('settingsForm').addEventListener('submit', event => event.preventDefault());
  $('settingsForm').addEventListener('input', updateNetLayerDraftStatus);
  $('settingsForm').addEventListener('change', () => { updateControls(); updateDirectionPreview(); });
  $('runButton').addEventListener('click', () => void startRouting());
  $('enableViaRetry').addEventListener('click', () => void startRouting(true));
  $('relaxDirectionsRetry').addEventListener('click', () => void startRouting(false, true));
  $('dismissDirectionSuggestion').addEventListener('click', () => { dismissedDirectionJobId = currentState?.job?.id; acknowledgeAttention(); updateControls(); });
  $('dismissViaSuggestion').addEventListener('click', () => {
    dismissedSuggestionJobId = currentState?.job?.id;
    updateControls();
  });
  $('viewBestResult').addEventListener('click', viewBestResult);
  $('extendTimeButton').addEventListener('click', () => void extendRoutingTime());
  $('finishTimedRun').addEventListener('click', () => void finishTimedRun());
  $('extraTimeMinutes').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void extendRoutingTime(); } });
  $('viewStoppedResult').addEventListener('click', viewBestResult);
  $('keepStopped').addEventListener('click', () => { acknowledgeAttention(); dismissedStopJobId = currentState?.job?.id; updateControls(); });
  $('stopButton').addEventListener('click', async () => {
    $('stopButton').disabled = true;
    try { await post('/api/stop'); if (currentState?.job?.state === 'stopping') stoppingSince ??= Date.now(); }
    catch (error) { toast(error.message, true); updateControls(); }
  });
  $('forceStopButton').addEventListener('click', async () => {
    forcedStop = true; updateControls();
    try { await post('/api/stop', { force: true }); toast('Routing stopped. Any checked result stays here.'); }
    catch (error) { forcedStop = false; toast(error.message, true); updateControls(); }
  });
  $('forceStopButton').title = 'Stop routing now and keep any checked result.';
  for (const [id, type] of [['downloadSes', 'ses'], ['downloadDsn', 'dsn'], ['downloadChecks', 'report'], ['downloadLog', 'log']]) $(id).addEventListener('click', () => void download(type));
  $('copyLog').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastLogs); toast('Routing log copied.'); }
    catch { toast('Could not copy the log. Download the Routing log instead.', true); }
  });
  $('logToggle').addEventListener('click', () => {
    const collapsed = document.querySelector('.activity-panel').classList.toggle('collapsed');
    $('logToggle').setAttribute('aria-expanded', String(!collapsed)); $('logScroll').hidden = collapsed; $('logChevron').textContent = collapsed ? '⌃' : '⌄';
  });
  $('autoScroll').addEventListener('change', () => { if ($('autoScroll').checked) $('logScroll').scrollTop = $('logScroll').scrollHeight; });
  $('helpButton').addEventListener('click', () => $('aboutDialog').showModal());
  $('closeAbout').addEventListener('click', () => $('aboutDialog').close());
  $('closeAboutBottom').addEventListener('click', () => $('aboutDialog').close());
  $('aboutDialog').addEventListener('click', event => { if (event.target === $('aboutDialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
  $('fitButton').addEventListener('click', fitBoard);
  $('showPlacementAdvice').addEventListener('click', () => { acknowledgeAttention(`advice:${currentState?.job?.id}`); $('placementAdvice').scrollIntoView({ block: 'start' }); });
  $('placementAdvice').addEventListener('click', () => acknowledgeAttention(`advice:${currentState?.job?.id}`));
  $('remainingRoutes').addEventListener('click', () => acknowledgeAttention(`remaining:${currentState?.job?.id}`));
  $('clearAdviceFocus').addEventListener('click', clearAdviceFocus);
  $('zoomIn').addEventListener('click', () => zoomBy(1.25));
  $('zoomOut').addEventListener('click', () => zoomBy(.8));
  $('showPads').addEventListener('change', draw);
  $('showAirwires').addEventListener('change', draw);
  $('showLiveWork').addEventListener('change', () => {
    nativeEngine?.setBenchmarkEnvironment?.({ animationEnabled: $('showLiveWork').checked });
    syncActivityVisual();
  });
  reducedMotion.addEventListener('change', syncActivityVisual);
  document.addEventListener('visibilitychange', () => { syncActivityVisual(); updateRunProgress(); });
  window.addEventListener('pagehide', () => { stopActivityFrames(); stopProgressClock(); });
  window.addEventListener('pageshow', () => { syncActivityVisual(); updateRunProgress(); });
  canvas.addEventListener('wheel', event => { if (!board) return; event.preventDefault(); const rect = canvas.getBoundingClientRect(); zoomBy(Math.exp(-event.deltaY * .0018), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
  canvas.addEventListener('pointerdown', event => { if (!board || event.button !== 0) return; view.dragging = true; view.pointerX = event.clientX; view.pointerY = event.clientY; canvas.setPointerCapture(event.pointerId); canvas.classList.add('dragging'); });
  canvas.addEventListener('pointermove', event => {
    const rect = canvas.getBoundingClientRect();
    if (view.dragging) { view.x += event.clientX - view.pointerX; view.y += event.clientY - view.pointerY; view.pointerX = event.clientX; view.pointerY = event.clientY; draw(); }
    if (board) { const [x, y] = screenToWorld(event.clientX - rect.left, event.clientY - rect.top); $('cursorPosition').textContent = `X ${x.toFixed(2)} · Y ${y.toFixed(2)} mm`; }
  });
  const endDrag = () => { view.dragging = false; canvas.classList.remove('dragging'); };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag); canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('pointerleave', () => { $('cursorPosition').textContent = 'Drag to pan · scroll to zoom'; });
  canvas.addEventListener('dblclick', fitBoard);
  document.addEventListener('keydown', event => {
    if (event.target.matches('input,textarea,select') || $('aboutDialog').open || $('clearRoutingDialog').open || $('netLayersDialog').open || $('runReportDialog').open || $('previousRulesDialog').open || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); fitBoard(); }
  });
  if (typeof nativeEngine?.subscribeActivity === 'function') nativeEngine.subscribeActivity(event => {
    if (!currentState?.job || event.jobId !== currentState.job.id) return;
    // Fast work reports update only this overlay and status; full snapshots stay
    // on the normal polling path so large board geometry is not copied here.
    activitySnapshot = event;
    updateEngineActivity();
  });
  restoreSettings();
  new ResizeObserver(resizeCanvas).observe($('canvasWrap'));
  resizeCanvas(); updateControls();
  $('disconnectBanner').hidden = true;
  void poll();
})();
