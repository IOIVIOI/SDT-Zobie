/* ============================================================
 * main.js —— DOM 绑定、屏幕切换与启动引导
 * ============================================================ */

(function (global) {
  'use strict';

  var SDT = global.SDT = global.SDT || {};
  var C = SDT.CONST || {};

  function byId(id) {
    return global.document.getElementById(id);
  }

  function selectedPolicyKey() {
    var input = global.document.querySelector('input[name="policy"]:checked');
    return input ? input.value : 'balanced';
  }

  function selectedPolicyPayoff() {
    var key = selectedPolicyKey();
    var table = C.POLICY_PAYOFF || {};
    return table[key] || C.PAYOFF || { H: 0, CR: 0, FA: -4, M: -8 };
  }

  function showScreen(name) {
    var screens = global.document.querySelectorAll('.screen');
    Array.prototype.forEach.call(screens, function (screen) {
      screen.classList.toggle('is-active', screen.id === 'screen-' + name);
    });
    Array.prototype.forEach.call(global.document.querySelectorAll('.navbtn'), function (button) {
      button.classList.toggle('is-active', button.getAttribute('data-screen') === name);
    });

    if (name === 'result' && SDT.charts) {
      SDT.charts.renderAll();
      if (SDT.game) SDT.game.renderLeaderboard();
    }
    if (name === 'lab' && SDT.charts) SDT.charts.renderLab();
    if (name === 'brief' && SDT.game) SDT.game.renderLastRun();
    global.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function dPrimeHint(value) {
    if (value < 0.5) return '几乎无法区分：信号与噪音分布几乎完全重合，只能靠猜。';
    if (value < 1.5) return '特征很微弱：只有极少数病例能看出来，判断会很不稳定。';
    if (value < 2.5) return '特征中等明显：信号与噪音有明显重叠，需要集中注意力。';
    if (value < 3.5) return '特征比较明显：大部分感染者能被识别，但仍有混淆。';
    return '特征极为明显：几乎不可能看错，d′ 高说明辨别难度很低。';
  }

  function prioriHint(value) {
    if (value < 0.3) return '小股遭遇，队伍基本完整——被咬的人不多。此时最优策略偏向保守。';
    if (value > 0.7) return '遭遇尸潮，几乎全军覆没——大部分归队者都已感染。此时最优策略偏向激进。';
    return '正面交火，伤亡惨重——大约一半人可能被咬。这是最“中立”的设定。';
  }

  function bindBriefControls() {
    var dPrime = byId('opt-dprime');
    var trials = byId('opt-trials');
    var priori = byId('opt-priori');
    var timeLimit = byId('opt-timelimit');
    var sound = byId('opt-sound');

    function sync() {
      var dValue = Number(dPrime.value);
      var pValue = Number(priori.value);
      byId('val-dprime').textContent = dValue.toFixed(1);
      byId('val-trials').textContent = trials.value;
      byId('val-priori').textContent = pValue + '%';
      byId('val-timelimit').textContent = Number(timeLimit.value).toFixed(1) + ' s';
      byId('hint-dprime').textContent = dPrimeHint(dValue);
      byId('hint-priori').textContent = prioriHint(pValue / 100);
    }

    [dPrime, trials, priori, timeLimit].forEach(function (input) {
      input.addEventListener('input', sync);
    });
    sound.addEventListener('change', function () {
      SDT.audio.setEnabled(sound.checked);
    });
    Array.prototype.forEach.call(
      global.document.querySelectorAll('input[name="policy"]'),
      function (input) {
        input.addEventListener('change', function () {
          var lab = byId('screen-lab');
          if (lab && lab.classList.contains('is-active')) SDT.charts.renderLab();
        });
      }
    );
    sync();
  }

  function collectConfig() {
    var policy = selectedPolicyKey();
    return {
      dPrime: Number(byId('opt-dprime').value),
      nTrials: Number(byId('opt-trials').value),
      priori: Number(byId('opt-priori').value) / 100,
      timeLimit: Number(byId('opt-timelimit').value),
      feedback: byId('opt-feedback').checked,
      sound: byId('opt-sound').checked,
      policy: policy,
      payoff: JSON.parse(JSON.stringify(selectedPolicyPayoff()))
    };
  }

  function runIsActive() {
    var phase = SDT.game.state.phase;
    return phase === 'stimulus' || phase === 'feedback';
  }

  function bindNavigation() {
    Array.prototype.forEach.call(global.document.querySelectorAll('.navbtn'), function (button) {
      button.addEventListener('click', function () {
        var target = button.getAttribute('data-screen');
        if (runIsActive() && target !== 'game') {
          global.alert('执勤尚未结束。请完成本局，或点击“提前结束”后再离开。');
          return;
        }
        if (target === 'result' && !SDT.game.state.lastResult && !SDT.store.getRuns().length) {
          global.alert('还没有执勤报告。请先完成一局。');
          return;
        }
        showScreen(target);
      });
    });

    byId('btn-to-lab').addEventListener('click', function () { showScreen('lab'); });
    byId('btn-lab-back').addEventListener('click', function () { showScreen('brief'); });
    byId('btn-again').addEventListener('click', function () { showScreen('brief'); });
  }

  function bindGameActions() {
    byId('btn-start').addEventListener('click', function () {
      SDT.audio.ensureCtx();
      var config = collectConfig();
      showScreen('game');
      SDT.game.start(config);
    });
    byId('btn-pass').addEventListener('click', function () {
      SDT.game.handleResponse('pass');
    });
    byId('btn-quar').addEventListener('click', function () {
      SDT.game.handleResponse('quarantine');
    });
    byId('btn-abort').addEventListener('click', function () {
      SDT.game.abortRun();
    });
    byId('opt-correction').addEventListener('change', function () {
      SDT.game.renderResult();
    });
    byId('btn-clear-history').addEventListener('click', function () {
      if (!global.confirm('确认清空本机保存的全部执勤记录吗？')) return;
      SDT.store.clear();
      SDT.game.renderLeaderboard();
      SDT.game.renderLastRun();
    });

    global.document.addEventListener('keydown', function (event) {
      if (SDT.game.state.phase !== 'stimulus') return;
      if (event.key === 'a' || event.key === 'A' || event.key === 'ArrowLeft') {
        event.preventDefault();
        SDT.game.handleResponse('pass');
      } else if (event.key === 'd' || event.key === 'D' || event.key === 'ArrowRight') {
        event.preventDefault();
        SDT.game.handleResponse('quarantine');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        SDT.game.abortRun();
      }
    });
  }

  function syncLabLabels() {
    byId('lab-val-dprime').textContent = Number(byId('lab-dprime').value).toFixed(2);
    byId('lab-val-c').textContent = Number(byId('lab-c').value).toFixed(2);
    byId('lab-val-priori').textContent = byId('lab-priori').value + '%';
  }

  function bindLabControls() {
    var pending = false;

    function scheduleRender() {
      if (pending) return;
      pending = true;
      global.requestAnimationFrame(function () {
        pending = false;
        syncLabLabels();
        SDT.charts.renderLab();
      });
    }

    ['lab-dprime', 'lab-c', 'lab-priori'].forEach(function (id) {
      byId(id).addEventListener('input', scheduleRender);
    });

    syncLabLabels();
    SDT.charts.renderLab();
  }

  function boot() {
    bindBriefControls();
    bindNavigation();
    bindGameActions();
    bindLabControls();
    SDT.game.renderLastRun();
    SDT.game.renderLeaderboard();
    showScreen('brief');
  }

  SDT.main = {
    showScreen: showScreen,
    selectedPolicyKey: selectedPolicyKey,
    selectedPolicyPayoff: selectedPolicyPayoff
  };

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window);
