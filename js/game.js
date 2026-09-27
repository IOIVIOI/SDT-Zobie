/* ============================================================
 * game.js —— 试次生成、状态机、计时、计分与结果页渲染
 * ============================================================ */

(function (global) {
  'use strict';

  var SDT = global.SDT = global.SDT || {};
  var C = SDT.CONST || {};
  var state = {
    phase: 'idle',
    config: {
      dPrime: 2.0,
      nTrials: 30,
      priori: 0.5,
      timeLimit: 5.0,
      feedback: true,
      sound: true,
      policy: 'balanced',
      payoff: { H: 0, CR: 0, FA: -4, M: -8 }
    },
    trials: [],
    responses: [],
    current: 0,
    counts: { H: 0, M: 0, FA: 0, CR: 0 },
    timeouts: 0,
    trialStartTime: 0,
    nextHeartbeatAt: Infinity,
    rAFId: null,
    timerId: null,
    lastResult: null,
    finishedEarly: false
  };

  var SKIN_TONES = [
    { r: 230, g: 194, b: 166 },
    { r: 211, g: 169, b: 139 },
    { r: 190, g: 143, b: 111 },
    { r: 158, g: 112, b: 86 },
    { r: 119, g: 82, b: 64 },
    { r: 83, g: 58, b: 47 }
  ];

  var HAIR_COLORS = [
    { r: 38, g: 31, b: 27 },
    { r: 65, g: 43, b: 29 },
    { r: 104, g: 72, b: 42 },
    { r: 148, g: 126, b: 94 },
    { r: 74, g: 72, b: 68 },
    { r: 28, g: 24, b: 22 }
  ];

  function byId(id) {
    return global.document.getElementById(id);
  }

  function clamp(value, lo, hi) {
    return SDT.stats.clamp(value, lo, hi);
  }

  function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  function copyCounts(counts) {
    return { H: counts.H, M: counts.M, FA: counts.FA, CR: counts.CR };
  }

  function policyLabel(key) {
    if (key === 'humane') return '人道优先';
    if (key === 'hardline') return '铁腕';
    return '均衡';
  }

  function createSubject() {
    return {
      id: String(Math.floor(Math.random() * 9000) + 1000),
      skinTone: randomItem(SKIN_TONES),
      hairStyle: Math.floor(Math.random() * 4),
      hairColor: randomItem(HAIR_COLORS),
      hasBeard: Math.random() < 0.38
    };
  }

  function createTrial(index) {
    var config = state.config;
    var isSignal = Math.random() < config.priori;
    var mean = isSignal ? config.dPrime / 2 : -config.dPrime / 2;
    var evidence = SDT.stats.gaussRandom(mean, 1);
    var visual = 1 / (1 + Math.exp(-evidence));
    var siteIndex = Math.floor(Math.random() * C.WOUND_SITES.length);
    var selectedSite = C.WOUND_SITES[siteIndex];

    return {
      index: index,
      isSignal: isSignal,
      x: evidence,
      t: visual,
      scanStartedAt: 0,
      subject: createSubject(),
      wound: {
        siteIndex: siteIndex,
        site: {
          x: selectedSite.x,
          y: selectedSite.y,
          r: selectedSite.r,
          maxR: selectedSite.maxR,
          onCloth: selectedSite.onCloth,
          label: selectedSite.label
        },
        kind: Math.random() < 0.5 ? 'bite' : 'scratch',
        sizeMul: 0.6 + Math.random() * 0.9,
        rot: (Math.random() - 0.5) * Math.PI,
        seed: (Math.floor(Math.random() * 0xffffffff) >>> 0)
      }
    };
  }

  function setButtonsEnabled(enabled) {
    var pass = byId('btn-pass');
    var quar = byId('btn-quar');
    if (pass) pass.disabled = !enabled;
    if (quar) quar.disabled = !enabled;
  }

  function updateHeader() {
    var trial = state.trials[state.current];
    var counter = byId('trial-counter');
    var subject = byId('subject-tag');
    var priori = byId('priori-tag');
    if (counter) counter.textContent = '已归队 ' + (state.current + 1) + ' / ' + state.config.nTrials;
    if (subject && trial) subject.textContent = '队员 #' + trial.subject.id;
    if (priori) priori.textContent = 'P(S) = ' + Math.round(state.config.priori * 100) + '%';
  }

  function updateTally() {
    var ids = ['H', 'M', 'FA', 'CR'];
    ids.forEach(function (key) {
      var element = byId('t-' + key);
      if (element) element.textContent = state.counts[key];
    });
  }

  function formatMetric(value, digits) {
    if (!isFinite(value)) {
      if (value === Infinity) return '∞';
      if (value === -Infinity) return '−∞';
      return '—';
    }
    return value.toFixed(digits);
  }

  function updateLiveMetrics() {
    var container = byId('live-metrics');
    if (!container) return;
    var metrics = SDT.stats.computeSDT(state.counts, {
      useCorrection: true,
      priori: state.config.priori,
      payoff: state.config.payoff
    });

    if (!metrics.valid) {
      container.innerHTML = '<p class="muted">尚需同时出现信号与噪音试次后才能估计指标。</p>';
      return;
    }

    container.innerHTML =
      '<div class="live-row"><span>P(Hit)</span><b>' + metrics.pHit.toFixed(3) + '</b></div>' +
      '<div class="live-row"><span>P(FA)</span><b>' + metrics.pFA.toFixed(3) + '</b></div>' +
      '<div class="live-row"><span>d′</span><b>' + formatMetric(metrics.dPrime, 2) + '</b></div>' +
      '<div class="live-row"><span>c</span><b>' + formatMetric(metrics.c, 2) + '</b></div>' +
      '<div class="live-row"><span>准确率</span><b>' +
      (isFinite(metrics.accuracy) ? metrics.accuracy.toFixed(3) : '—') + '</b></div>';
  }

  function resetTimer() {
    var fill = byId('timer-fill');
    var text = byId('timer-text');
    var bar = byId('timer-bar');
    if (fill) fill.style.transform = 'scaleX(1)';
    if (text) text.textContent = state.config.timeLimit.toFixed(1) + 's';
    if (bar) bar.classList.remove('is-urgent');
  }

  function timerStep(now) {
    if (state.phase !== 'stimulus') return;
    var elapsed = (now - state.trialStartTime) / 1000;
    var remaining = state.config.timeLimit - elapsed;
    var ratio = clamp(remaining / state.config.timeLimit, 0, 1);
    var fill = byId('timer-fill');
    var text = byId('timer-text');
    var bar = byId('timer-bar');

    if (fill) fill.style.transform = 'scaleX(' + ratio + ')';
    if (text) text.textContent = Math.max(0, remaining).toFixed(1) + 's';
    if (bar) bar.classList.toggle('is-urgent', remaining <= state.config.timeLimit * 0.3);

    if (remaining <= state.config.timeLimit * 0.3 && now >= state.nextHeartbeatAt) {
      SDT.audio.heartbeat();
      state.nextHeartbeatAt = now + 900;
    }

    if (remaining <= 0) {
      handleResponse(null);
      return;
    }
    state.rAFId = global.requestAnimationFrame(timerStep);
  }

  function nextTrial() {
    if (state.phase === 'finished') return;
    if (state.responses.length >= state.config.nTrials) {
      finish(false);
      return;
    }

    var trial = createTrial(state.responses.length + 1);
    state.trials.push(trial);
    state.current = state.trials.length - 1;
    SDT.render.prepareTrial(trial);
    updateHeader();
    resetTimer();
    setButtonsEnabled(true);

    state.phase = 'stimulus';
    state.trialStartTime = global.performance.now();
    state.nextHeartbeatAt = state.trialStartTime + state.config.timeLimit * 700;
    trial.scanStartedAt = state.trialStartTime;
    SDT.audio.scan();
    state.rAFId = global.requestAnimationFrame(timerStep);
  }

  function addResult(response, isSignal) {
    var correct;
    if (response === 'quarantine') {
      correct = isSignal;
      if (isSignal) state.counts.H++;
      else state.counts.FA++;
    } else {
      correct = !isSignal;
      if (isSignal) state.counts.M++;
      else state.counts.CR++;
    }
    return correct;
  }

  /* 伤口形态决定反馈文案，必须与画出来的图案一致：
   *   bite    → 画的是咬痕  → 说"野狗咬的" / "咬痕"
   *   scratch → 画的是条形  → 说"碎玻璃划的" / "抓痕"
   * from 只用在噪音试次（正确拒绝 / 虚报），mark 只用在信号试次（漏报）。 */
  function woundNarrative(trial) {
    var kind = trial && trial.wound ? trial.wound.kind : 'scratch';
    if (kind === 'bite') {
      return { from: '野狗咬的', mark: '咬痕' };
    }
    // 碎玻璃、铁丝网、武器误伤在现实中都造成条形撕裂伤，
    // 与 scratch 的图案一致，所以可以随机挑一个，增加变化而不破坏对应关系。
    var scratchCauses = ['碎玻璃划的', '铁丝网剐的', '同伴武器误伤的'];
    return {
      from: scratchCauses[Math.floor(Math.random() * scratchCauses.length)],
      mark: '抓痕'
    };
  }

  function showFeedback(timedOut, correct, responded) {
    var veil = byId('stage-veil');
    var message = byId('stage-msg');
    var n = woundNarrative(state.trials[state.current]);
    if (!message) return;

    if (timedOut) {
      message.textContent = '⏱ 超时：你犹豫太久，他自己推开闸门走了进去。';
      message.className = 'stage-msg show bad';
    } else if (state.config.feedback) {
      if (correct) {
        if (responded === 'quarantine') {
          message.textContent = '✅ 击中：他确实被感染了，你拦住了他。';
        } else {
          message.textContent = '✅ 正确拒绝：那道伤只是' + n.from + '，你放对了。';
        }
        message.className = 'stage-msg show good';
      } else {
        if (responded === 'quarantine') {
          message.textContent = '❌ 虚报：那道伤是' + n.from + '，你冤枉了他。';
        } else {
          message.textContent = '❌ 漏报：他带着' + n.mark + '归了队，和其他人睡在同一个帐篷里……';
        }
        message.className = 'stage-msg show bad';
      }
    } else {
      message.className = 'stage-msg';
    }

    if (veil && (state.config.feedback || timedOut)) {
      veil.className = 'stage-veil ' + (correct ? 'flash-good' : 'flash-bad');
      global.setTimeout(function () { veil.className = 'stage-veil'; }, 130);
    }

    if (timedOut) {
      SDT.audio.timeout();
    } else if (state.config.feedback) {
      if (correct) SDT.audio.correct();
      else SDT.audio.wrong();
      if (responded === 'quarantine') SDT.audio.alarm();
    }
  }

  function handleResponse(responded) {
    if (state.phase !== 'stimulus') return;
    var trial = state.trials[state.current];
    if (!trial) return;

    state.phase = 'feedback';
    if (state.rAFId !== null) global.cancelAnimationFrame(state.rAFId);
    state.rAFId = null;
    setButtonsEnabled(false);

    var timedOut = responded === null;
    var finalResponse = timedOut ? 'pass' : responded;
    var rtMs = timedOut ? state.config.timeLimit * 1000 :
      Math.max(0, global.performance.now() - state.trialStartTime);
    var correct = addResult(finalResponse, trial.isSignal);

    state.responses.push({
      index: trial.index,
      isSignal: trial.isSignal,
      responded: finalResponse,
      timedOut: timedOut,
      correct: correct,
      rtMs: rtMs
    });

    if (timedOut) state.timeouts++;
    if (!timedOut) SDT.audio.click();

    updateTally();
    updateLiveMetrics();
    showFeedback(timedOut, correct, finalResponse);

    var delay = state.config.feedback ? (C.FEEDBACK_MS || 1100) : (C.FEEDBACK_FAST_MS || 260);
    state.timerId = global.setTimeout(function () {
      state.timerId = null;
      if (state.phase === 'finished') return;
      nextTrial();
    }, delay);
  }

  function meanResponseTime(responses) {
    var values = responses.filter(function (response) {
      return !response.timedOut && isFinite(response.rtMs);
    }).map(function (response) {
      return response.rtMs;
    });
    if (!values.length) return 0;
    return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
  }

  function cleanupRun() {
    if (state.rAFId !== null) global.cancelAnimationFrame(state.rAFId);
    if (state.timerId !== null) global.clearTimeout(state.timerId);
    state.rAFId = null;
    state.timerId = null;
    if (SDT.render && SDT.render.stop) SDT.render.stop();
    setButtonsEnabled(false);
    var bar = byId('timer-bar');
    if (bar) bar.classList.remove('is-urgent');
  }

  function finish(early) {
    if (state.phase === 'finished') return;
    state.phase = 'finished';
    cleanupRun();

    if (state.responses.length < (C.MIN_TRIALS_SETTLE || 5)) return;

    var metrics = SDT.stats.computeSDT(state.counts, {
      useCorrection: true,
      priori: state.config.priori
    });
    var completed = state.responses.length;
    var run = {
      id: String(Date.now()),
      timestamp: Date.now(),
      dPrimeSetting: state.config.dPrime,
      nTrials: state.config.nTrials,
      completedTrials: completed,
      priori: state.config.priori,
      timeLimit: state.config.timeLimit,
      feedback: state.config.feedback,
      policy: state.config.policy,
      payoff: JSON.parse(JSON.stringify(state.config.payoff)),
      counts: copyCounts(state.counts),
      timeouts: state.timeouts,
      dPrime: isFinite(metrics.dPrime) ? metrics.dPrime : null,
      c: isFinite(metrics.c) ? metrics.c : null,
      beta: isFinite(metrics.beta) ? metrics.beta : null,
      accuracy: isFinite(metrics.accuracy) ? metrics.accuracy : null,
      stability: isFinite(metrics.stability) ? metrics.stability : null,
      meanRtMs: meanResponseTime(state.responses),
      early: !!early
    };

    SDT.store.saveRun(run);
    state.finishedEarly = !!early;
    state.lastResult = {
      sdt: metrics,
      config: JSON.parse(JSON.stringify(state.config)),
      counts: copyCounts(state.counts),
      responses: state.responses.slice(),
      trials: state.trials.slice(),
      timeouts: state.timeouts,
      completed: completed,
      early: !!early
    };

    renderResult();
    if (SDT.main && SDT.main.showScreen) SDT.main.showScreen('result');
  }

  function abortRun() {
    if (state.phase !== 'stimulus' && state.phase !== 'feedback') return;
    var completed = state.responses.length;
    if (completed < (C.MIN_TRIALS_SETTLE || 5)) {
      global.alert('至少需要 5 次判断才能得出结论。');
      return;
    }
    if (!global.confirm('确认提前结束执勤，并用已完成的 ' + completed + ' 次判断结算吗？')) return;
    finish(true);
  }

  function start(config) {
    cleanupRun();
    state.phase = 'idle';
    state.config = {
      dPrime: Number(config.dPrime),
      nTrials: Number(config.nTrials),
      priori: Number(config.priori),
      timeLimit: Number(config.timeLimit),
      feedback: !!config.feedback,
      sound: !!config.sound,
      policy: config.policy || 'balanced',
      payoff: config.payoff ? JSON.parse(JSON.stringify(config.payoff)) : { H: 0, CR: 0, FA: -4, M: -8 }
    };
    state.trials = [];
    state.responses = [];
    state.current = 0;
    state.counts = { H: 0, M: 0, FA: 0, CR: 0 };
    state.timeouts = 0;
    state.finishedEarly = false;
    state.lastResult = null;

    updateTally();
    updateLiveMetrics();
    SDT.audio.setEnabled(state.config.sound);
    SDT.render.start();
    nextTrial();
  }

  function metricValue(value, digits) {
    if (!isFinite(value)) {
      if (value === Infinity) return '∞';
      if (value === -Infinity) return '−∞';
      return '—';
    }
    return value.toFixed(digits);
  }

  function card(className, label, value, sub) {
    return '<div class="mcard ' + className + '">' +
      '<span class="mcard-label">' + label + '</span>' +
      '<span class="mcard-value">' + value + '</span>' +
      '<span class="mcard-sub">' + sub + '</span>' +
      '</div>';
  }

  function comparisonText(metrics, priori) {
    var cOpt = metrics.cOpt;
    if (!isFinite(cOpt) || !isFinite(metrics.c)) {
      return '本局信息量不足，最优标准无法可靠计算。';
    }

    var difference = Math.abs(metrics.c - cOpt);
    var closeText = difference < 0.15 ? '非常接近。' :
      (metrics.c * cOpt < 0 ? '两者的方向相反。' : '两者方向相同，但仍有差距。');
    var priorText = Math.round(priori * 100) + '%';
    var direction = cOpt > 0.05 ? '偏向放行' : (cOpt < -0.05 ? '偏向隔离' : '接近中立');

    return '本局 P(S) = ' + priorText + '，按当前先验与安全区政策，理论最优标准为 c_opt = ' +
      cOpt.toFixed(2) + '（' + direction + '），你的 c = ' + metrics.c.toFixed(2) +
      '，' + closeText;
  }

  function interpretationHtml(metrics, result) {
    if (!metrics.valid) {
      return '<article class="interp-card ic-warn"><h4>数据不足</h4>' +
        '<p>本局未能同时取得信号与噪音试次，四格统计不完整，无法可靠计算 d′ 与 c。</p></article>';
    }

    var d = metrics.dPrime;
    var c = metrics.c;
    var dTone = SDT.stats.gradeDPrime(d).tone;
    var dText;
    if (d < 0.5) {
      dText = '你的 d′ 仅为 <b>' + d.toFixed(2) + '</b>，接近 0。这意味着信号与噪音在你的知觉里几乎完全重叠——你的判断和抛硬币没有本质区别。';
    } else if (d < 1.5) {
      dText = '你的 d′ 为 <b>' + d.toFixed(2) + '</b>，辨别力偏弱。你能觉察到一些线索，但在特征微弱时经常拿不准。';
    } else if (d < 2.5) {
      dText = '你的 d′ 为 <b>' + d.toFixed(2) + '</b>，属于中等水平。你确实捕捉到了有效的感染特征，但仍有明显的重叠区。';
    } else {
      dText = '你的 d′ 为 <b>' + d.toFixed(2) + '</b>，辨别力很强。你稳定地抓住了伤口上那个真正有效的证据维度。';
    }

    var cText;
    if (c < -0.3) {
      cText = '你的 c = <b>' + c.toFixed(2) + '</b>，偏<b>激进</b>。你倾向于把可疑的队友一律隔离——击中率高的代价是虚报率也高。';
    } else if (c > 0.3) {
      cText = '你的 c = <b>' + c.toFixed(2) + '</b>，偏<b>保守</b>。你倾向于放行——虚报少了，但混进安全区的感染者也多了。';
    } else {
      cText = '你的 c = <b>' + c.toFixed(2) + '</b>，大致<b>中立</b>。你没有明显的偏向，攻守均衡。';
    }

    var cards = [];
    cards.push('<article class="interp-card ic-' + dTone + '"><h4>辨别力 d′</h4>' +
      '<p>' + dText + '</p>' +
      '<p>d′ 衡量你的知觉能从证据中提取多少信息，与决策偏好无关。改变“宁可错杀”或“宁可放过”的策略，只会让 P(Hit) 与 P(FA) 同时升降，不会改变 d′。</p></article>');
    cards.push('<article class="interp-card ic-info"><h4>判断标准 c</h4>' +
      '<p>' + cText + '</p><p>c 是横切两条分布的位置，它决定同样的证据有多少会被你判为感染。</p></article>');
    cards.push('<article class="interp-card ic-warn"><h4>与最优标准比较</h4>' +
      '<p>' + comparisonText(metrics, result.config.priori) + '</p>' +
      '<p><span class="mono">β_opt = [P(N)/P(S)] · [V(CR)−V(FA)] / [V(H)−V(M)]</span><br>' +
      '<span class="mono">c_opt = ln(β_opt) / d′</span></p></article>');

    if (isFinite(metrics.stability)) {
      var payoff = result.config.payoff || { H: 0, CR: 0, FA: -4, M: -8 };
      var faPenalty = Math.abs(Number(payoff.FA) || 0);
      var missPenalty = Math.abs(Number(payoff.M) || 0);
      cards.push('<article class="interp-card ic-info"><h4>准确率与稳定度</h4>' +
        '<p>你的准确率是 <b>' + (metrics.accuracy * 100).toFixed(1) +
        '%</b>，但按“' + policyLabel(result.config.policy) + '”政策的实际代价算，稳定度是 <b>' +
        Math.round(metrics.stability) + '</b>。</p>' +
        '<p>本局每次虚报扣 ' + faPenalty + '，每次漏报扣 ' + missPenalty +
        '。准确率把四种结果等权看待，稳定度则保留现实中的代价差异。</p></article>');
    }

    if (metrics.counts.M >= 3) {
      cards.push('<article class="interp-card ic-bad"><h4>漏报代价提醒</h4>' +
        '<p>你有 <b>' + metrics.counts.M + '</b> 次漏报。若放走感染者的代价高于冤枉队友，应把 c 调得更小，主动用更多虚报换取更低漏报。</p></article>');
    } else if (metrics.counts.FA >= 4) {
      cards.push('<article class="interp-card ic-bad"><h4>虚报代价提醒</h4>' +
        '<p>你有 <b>' + metrics.counts.FA + '</b> 次虚报。若安全区人手紧张，应把 c 调得更大，接受更高漏报风险来保住人力资源。</p></article>');
    }

    return cards.join('');
  }

  function renderResult() {
    var result = state.lastResult;
    if (!result) return;

    var correctionToggle = byId('opt-correction');
    var useCorrection = correctionToggle ? correctionToggle.checked : true;
    var metrics = SDT.stats.computeSDT(result.counts, {
      useCorrection: useCorrection,
      priori: result.config.priori,
      payoff: result.config.payoff
    });
    result.sdt = metrics;

    var counts = metrics.counts;
    var headline = byId('result-headline');
    if (headline) {
      if (!metrics.valid) {
        headline.textContent = '本局数据不足，无法形成可靠的信号检测论结论。';
      } else {
        headline.textContent = '你在 ' + result.completed + ' 名队员中识别出 ' +
          counts.H + ' 名感染者，同时放过了 ' + counts.M + ' 名感染者、冤枉了 ' +
          counts.FA + ' 名健康人。' + (result.early ? ' 本局为提前结束。' : '');
      }
    }

    var matrix = {
      'm-H': counts.H,
      'm-FA': counts.FA,
      'm-M': counts.M,
      'm-CR': counts.CR,
      'm-report-yes': counts.H + counts.FA,
      'm-report-no': counts.M + counts.CR,
      'm-ns': counts.H + counts.M,
      'm-nn': counts.FA + counts.CR,
      'm-total': metrics.nTotal
    };
    Object.keys(matrix).forEach(function (id) {
      var element = byId(id);
      if (element) element.textContent = matrix[id];
    });

    var timeoutNote = byId('timeout-note');
    if (timeoutNote) {
      var notes = [];
      if (result.timeouts) notes.push('其中 ' + result.timeouts + ' 次因超时按放行处理。');
      if (result.early) notes.push('本局提前结束，仅完成 ' + result.completed + ' 次判断。');
      timeoutNote.textContent = notes.join(' ');
    }

    var cards = byId('metric-cards');
    if (cards) {
      if (!metrics.valid) {
        cards.innerHTML = '<p class="muted">未同时获得信号与噪音试次，指标不可计算。</p>';
      } else {
        var dGrade = SDT.stats.gradeDPrime(metrics.dPrime);
        var cGrade = SDT.stats.gradeC(metrics.c);
        cards.innerHTML =
          card('mc-hit', '击中率 P(Hit)', metricValue(metrics.pHit, 3),
            'H / (H+M) = ' + counts.H + '/' + metrics.nSignal) +
          card('mc-fa', '虚报率 P(FA)', metricValue(metrics.pFA, 3),
            'FA / (FA+CR) = ' + counts.FA + '/' + metrics.nNoise) +
          card('mc-d', '辨别力 d′', metricValue(metrics.dPrime, 2), dGrade.label) +
          card('mc-c', '判断标准 c', metricValue(metrics.c, 2), cGrade.label) +
          card('mc-beta', '似然比 β', metricValue(metrics.beta, 2),
            '最优 β = ' + metricValue(metrics.betaOpt, 2)) +
          card('mc-acc', '准确率', isFinite(metrics.accuracy) ?
            (metrics.accuracy * 100).toFixed(1) + '%' : '—', '(H+CR) / N') +
          card('mc-stab', '安全区稳定度',
            isFinite(metrics.stability) ? String(Math.round(metrics.stability)) : '—',
            '100 + 四格代价累计');
      }
    }

    var correctionNote = byId('correction-note');
    if (correctionNote) {
      correctionNote.classList.remove('warn-note');
      correctionNote.style.color = '';
      if (!metrics.valid) {
        correctionNote.textContent = '数据不足，无法判断是否需要校正。';
      } else if (metrics.needsCorrection && metrics.appliedCorrection) {
        correctionNote.textContent = '检测到至少一个零计数格，已使用 log-linear 校正：每格 +0.5、每类总数 +1。';
      } else if (metrics.needsCorrection && !metrics.appliedCorrection) {
        correctionNote.textContent = '存在极端比例，结果不可靠，请勾选 log-linear 校正。';
        correctionNote.style.color = '#e07266';
      } else {
        correctionNote.textContent = '本局四格均非零，未触发 log-linear 校正。';
      }
    }

    var interpretation = byId('interpretation');
    if (interpretation) interpretation.innerHTML = interpretationHtml(metrics, result);

    if (SDT.charts) {
      SDT.charts.renderAll();
      SDT.charts.renderLab();
    }
    renderLeaderboard();
  }

  function formatDate(timestamp) {
    var date = new Date(timestamp);
    function pad(value) { return String(value).padStart(2, '0'); }
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
      pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function renderLeaderboard() {
    var container = byId('leaderboard');
    if (!container) return;
    var runs = SDT.store.getRuns().slice().sort(function (a, b) {
      var aValue = typeof a.dPrime === 'number' && isFinite(a.dPrime) ? a.dPrime : -Infinity;
      var bValue = typeof b.dPrime === 'number' && isFinite(b.dPrime) ? b.dPrime : -Infinity;
      return bValue - aValue;
    }).slice(0, 10);

    if (!runs.length) {
      container.innerHTML = '<p class="lb-empty">还没有执勤记录。完成一局后这里会出现你的成绩。</p>';
      return;
    }

    var html = '<table class="lb-table"><thead><tr>' +
      '<th>排名</th><th>时间</th><th>设定 d′</th><th>实测 d′</th>' +
      '<th>c</th><th>准确率</th><th>H/M/FA/CR</th><th>试次</th>' +
      '</tr></thead><tbody>';

    runs.forEach(function (run, index) {
      var counts = run.counts;
      var hasD = typeof run.dPrime === 'number' && isFinite(run.dPrime);
      var hasC = typeof run.c === 'number' && isFinite(run.c);
      var hasAccuracy = typeof run.accuracy === 'number' && isFinite(run.accuracy);
      var accuracy = hasAccuracy ? (run.accuracy * 100).toFixed(1) + '%' : '—';
      html += '<tr class="' + (index === 0 ? 'lb-top' : '') + '">' +
        '<td class="lb-rank">' + (index + 1) + '</td>' +
        '<td>' + formatDate(run.timestamp) + '</td>' +
        '<td>' + Number(run.dPrimeSetting).toFixed(1) + '</td>' +
        '<td class="lb-d">' + (hasD ? run.dPrime.toFixed(2) : '—') + '</td>' +
        '<td>' + (hasC ? run.c.toFixed(2) : '—') + '</td>' +
        '<td>' + accuracy + '</td>' +
        '<td>' + counts.H + '/' + counts.M + '/' + counts.FA + '/' + counts.CR + '</td>' +
        '<td>' + (run.completedTrials || run.nTrials) + '</td></tr>';
    });
    container.innerHTML = html + '</tbody></table>';
  }

  function renderLastRun() {
    var container = byId('last-run');
    if (!container) return;
    var last = SDT.store.getLast();
    if (!last) {
      container.textContent = '还没有执勤记录。';
      return;
    }
    var hasD = typeof last.dPrime === 'number' && isFinite(last.dPrime);
    var hasC = typeof last.c === 'number' && isFinite(last.c);
    var hasAccuracy = typeof last.accuracy === 'number' && isFinite(last.accuracy);
    container.innerHTML =
      '<div class="lr-row"><span>时间</span><b>' + formatDate(last.timestamp) + '</b></div>' +
      '<div class="lr-row"><span>实测 d′</span><b>' +
      (hasD ? last.dPrime.toFixed(2) : '—') + '</b></div>' +
      '<div class="lr-row"><span>判断标准 c</span><b>' +
      (hasC ? last.c.toFixed(2) : '—') + '</b></div>' +
      '<div class="lr-row"><span>准确率</span><b>' +
      (hasAccuracy ? (last.accuracy * 100).toFixed(1) + '%' : '—') + '</b></div>';
  }

  SDT.game = {
    state: state,
    start: start,
    handleResponse: handleResponse,
    abortRun: abortRun,
    finish: finish,
    renderResult: renderResult,
    renderLeaderboard: renderLeaderboard,
    renderLastRun: renderLastRun,
    createTrial: createTrial
  };

})(window);
