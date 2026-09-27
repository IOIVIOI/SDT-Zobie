/* ============================================================
 * storage.js —— localStorage 战绩持久化与内存降级
 * ============================================================ */

(function (global) {
  'use strict';

  var SDT = global.SDT = global.SDT || {};
  var KEY = 'sdt_zombie_runs_v1';
  var memoryRuns = [];
  var storageAvailable = true;

  function storage() {
    if (!storageAvailable) return null;
    try {
      var ls = global.localStorage;
      if (!ls) throw new Error('localStorage unavailable');
      return ls;
    } catch (err) {
      storageAvailable = false;
      return null;
    }
  }

  function validRun(run) {
    return !!run &&
      typeof run === 'object' &&
      typeof run.timestamp === 'number' &&
      run.counts &&
      typeof run.counts.H === 'number' &&
      typeof run.counts.M === 'number' &&
      typeof run.counts.FA === 'number' &&
      typeof run.counts.CR === 'number';
  }

  function getRuns() {
    var ls = storage();
    if (!ls) return memoryRuns.slice();

    try {
      var raw = ls.getItem(KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every(validRun)) throw new Error('invalid data');
      return parsed;
    } catch (err) {
      try { ls.removeItem(KEY); } catch (removeErr) { /* 忽略 */ }
      return [];
    }
  }

  function writeRuns(runs) {
    var safe = Array.isArray(runs) && runs.every(validRun) ? runs.slice(-50) : [];
    memoryRuns = safe.slice();
    var ls = storage();
    if (!ls) return safe;
    try {
      ls.setItem(KEY, JSON.stringify(safe));
    } catch (err) {
      storageAvailable = false;
    }
    return safe;
  }

  function saveRun(run) {
    if (!validRun(run)) return null;
    var copy = JSON.parse(JSON.stringify(run));
    if (!copy.id) copy.id = String(copy.timestamp);
    var runs = getRuns();
    runs.push(copy);
    writeRuns(runs);
    return copy;
  }

  function getBest() {
    var runs = getRuns();
    var best = null;
    runs.forEach(function (run) {
      if (typeof run.dPrime !== 'number' || !isFinite(run.dPrime)) return;
      if (!best || run.dPrime > best.dPrime) best = run;
    });
    return best;
  }

  function getLast() {
    var runs = getRuns();
    return runs.length ? runs[runs.length - 1] : null;
  }

  function clear() {
    memoryRuns = [];
    var ls = storage();
    if (!ls) return;
    try { ls.removeItem(KEY); } catch (err) { storageAvailable = false; }
  }

  SDT.store = {
    KEY: KEY,
    saveRun: saveRun,
    getRuns: getRuns,
    getBest: getBest,
    getLast: getLast,
    clear: clear
  };

})(window);
