/* ============================================================
 * charts.js —— 正态分布图与 ROC 曲线（Canvas 2D 手绘）
 * ============================================================ */

(function (global) {
  'use strict';

  var SDT = global.SDT = global.SDT || {};
  var C = SDT.CONST || {};

  // 逻辑尺寸 = canvas 标签上写的 width/height（单位是 CSS 像素），必须在
  // setupCanvas 之前读一次：给 canvas.width 赋值会同步改写 width 内容属性，
  // 之后再读 getAttribute('width') 拿到的就是设备像素尺寸（560×DPR），
  // 整张图会被放大 DPR 倍、只剩左上角一块可见——在高 DPR 手机上表现为
  // “图表看不到全貌”。读到的值由 setupCanvas 存进 dataset，后续一律从
  // dataset 取，不再碰属性。
  function prepare(canvas) {
    var context = SDT.render.setupCanvas(
      canvas,
      Number(canvas.getAttribute('width')) || canvas.width,
      Number(canvas.getAttribute('height')) || canvas.height
    );
    return {
      context: context,
      width: Number(canvas.dataset.logicalW),
      height: Number(canvas.dataset.logicalH)
    };
  }

  function finite(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  function currentLabPayoff() {
    var input = global.document.querySelector('input[name="policy"]:checked');
    var key = input ? input.value : 'balanced';
    var table = C.POLICY_PAYOFF || {};
    return table[key] || C.PAYOFF || { H: 0, CR: 0, FA: -4, M: -8 };
  }

  function drawChartBackground(context, width, height) {
    var gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#091008');
    gradient.addColorStop(1, '#050805');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }

  function areaUnderCurve(context, sign, xStart, xEnd, dPrime, xMin, xMax, xScale, yScale, plot) {
    var samples = 100;
    context.beginPath();
    context.moveTo(plot.left + (xStart - xMin) * xScale, plot.bottom);
    for (var i = 0; i <= samples; i++) {
      var x = xStart + (xEnd - xStart) * i / samples;
      var density = SDT.stats.normPdf(x - sign * dPrime / 2);
      var px = plot.left + (x - xMin) * xScale;
      var py = plot.bottom - density * yScale;
      context.lineTo(px, py);
    }
    context.lineTo(plot.left + (xEnd - xMin) * xScale, plot.bottom);
    context.closePath();
    context.fill();
  }

  function drawDistribution(canvasId, options) {
    var canvas = global.document.getElementById(canvasId);
    if (!canvas) return;
    var prepared = prepare(canvas);
    var context = prepared.context;
    var width = prepared.width;
    var height = prepared.height;
    var dPrime = Math.max(0, finite(options.dPrime, 0));
    var criterion = finite(options.c, 0);
    var criterionOpt = Number.isFinite(options.cOpt) ? options.cOpt : null;
    var xMax = dPrime / 2 + 3.4;
    var xMin = -xMax;
    var yMax = Math.max(0.39894228, 0.42) * 1.15;
    var plot = {
      left: 48,
      right: width - 18,
      top: 26,
      bottom: height - 42
    };
    var xScale = (plot.right - plot.left) / (xMax - xMin);
    var yScale = (plot.bottom - plot.top) / yMax;

    drawChartBackground(context, width, height);

    context.strokeStyle = 'rgba(204,214,196,0.12)';
    context.lineWidth = 1;
    for (var gx = Math.ceil(xMin); gx <= Math.floor(xMax); gx++) {
      var gridX = plot.left + (gx - xMin) * xScale;
      context.beginPath();
      context.moveTo(gridX, plot.top);
      context.lineTo(gridX, plot.bottom);
      context.stroke();
    }
    for (var gy = 0; gy <= yMax; gy += 0.1) {
      var gridY = plot.bottom - gy * yScale;
      context.beginPath();
      context.moveTo(plot.left, gridY);
      context.lineTo(plot.right, gridY);
      context.stroke();
    }

    // 四块面积分别对应 H / M / FA / CR。
    context.fillStyle = C.MISS_FILL || 'rgba(74,90,68,0.30)';
    areaUnderCurve(context, 1, xMin, criterion, dPrime, xMin, xMax, xScale, yScale, plot);
    context.fillStyle = C.HIT_FILL || 'rgba(134,192,77,0.42)';
    areaUnderCurve(context, 1, criterion, xMax, dPrime, xMin, xMax, xScale, yScale, plot);
    context.fillStyle = C.CR_FILL || 'rgba(53,86,107,0.28)';
    areaUnderCurve(context, -1, xMin, criterion, dPrime, xMin, xMax, xScale, yScale, plot);
    context.fillStyle = C.FA_FILL || 'rgba(196,69,58,0.42)';
    areaUnderCurve(context, -1, criterion, xMax, dPrime, xMin, xMax, xScale, yScale, plot);

    function curve(sign, color, label, labelX) {
      context.beginPath();
      var peakX = sign * dPrime / 2;
      for (var i = 0; i <= 280; i++) {
        var x = xMin + (xMax - xMin) * i / 280;
        var density = SDT.stats.normPdf(x - peakX);
        var px = plot.left + (x - xMin) * xScale;
        var py = plot.bottom - density * yScale;
        if (i === 0) context.moveTo(px, py);
        else context.lineTo(px, py);
      }
      context.strokeStyle = color;
      context.lineWidth = 2.2;
      context.stroke();

      context.fillStyle = color;
      context.font = '12px "Microsoft YaHei", sans-serif';
      context.textAlign = 'center';
      context.fillText(label, labelX, 17);
    }

    var noiseLabelX = plot.left + (-dPrime / 2 - xMin) * xScale;
    var signalLabelX = plot.left + (dPrime / 2 - xMin) * xScale;
    if (Math.abs(signalLabelX - noiseLabelX) < 80) {
      noiseLabelX = Math.max(plot.left + 42, noiseLabelX - 46);
      signalLabelX = Math.min(plot.right - 42, signalLabelX + 46);
    }
    curve(-1, C.NOISE_COLOR || '#4fa8a0', '噪音 N', noiseLabelX);
    curve(1, C.SIGNAL_COLOR || '#c4453a', '信号 S', signalLabelX);

    var cX = plot.left + (criterion - xMin) * xScale;
    context.strokeStyle = '#f1c464';
    context.lineWidth = 2;
    context.setLineDash([5, 4]);
    context.beginPath();
    context.moveTo(cX, plot.top);
    context.lineTo(cX, plot.bottom);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(cX, plot.bottom - 8);
    context.lineTo(cX - 6, plot.bottom + 1);
    context.lineTo(cX + 6, plot.bottom + 1);
    context.closePath();
    context.fillStyle = '#f1c464';
    context.fill();

    if (criterionOpt !== null) {
      var cOptX = plot.left + (criterionOpt - xMin) * xScale;
      context.strokeStyle = '#86c04d';
      context.lineWidth = 2;
      context.setLineDash([3, 5]);
      context.beginPath();
      context.moveTo(cOptX, plot.top);
      context.lineTo(cOptX, plot.bottom);
      context.stroke();
      context.setLineDash([]);

      context.fillStyle = '#9bd76a';
      context.font = '10px Consolas, monospace';
      context.textAlign = cOptX < width / 2 ? 'left' : 'right';
      context.fillText('c_opt = ' + criterionOpt.toFixed(2),
        cOptX + (cOptX < width / 2 ? 6 : -6), plot.top + 13);
    }

    context.strokeStyle = 'rgba(204,214,196,0.48)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(plot.left, plot.bottom);
    context.lineTo(plot.right, plot.bottom);
    context.stroke();

    context.fillStyle = '#8b9782';
    context.font = '11px Consolas, monospace';
    context.textAlign = 'left';
    context.fillText('概率密度', 5, plot.top + 4);
    context.textAlign = 'center';
    context.fillText('c = ' + criterion.toFixed(2), cX, height - 21);
    context.textAlign = 'right';
    context.fillText('证据强度（感染特征）→', plot.right, height - 5);
  }

  function drawRoc(canvasId, options) {
    var canvas = global.document.getElementById(canvasId);
    if (!canvas) return;
    var prepared = prepare(canvas);
    var context = prepared.context;
    var width = prepared.width;
    var height = prepared.height;
    var dPrime = Math.max(0, finite(options.dPrime, 0));
    var margin = 52;
    var plot = {
      left: margin,
      top: 28,
      right: width - margin,
      bottom: height - margin
    };
    var size = Math.min(plot.right - plot.left, plot.bottom - plot.top);
    plot.right = plot.left + size;
    plot.bottom = plot.top + size;

    function mapX(value) {
      return plot.left + SDT.stats.clamp(value, 0, 1) * size;
    }
    function mapY(value) {
      return plot.bottom - SDT.stats.clamp(value, 0, 1) * size;
    }

    drawChartBackground(context, width, height);

    context.strokeStyle = 'rgba(204,214,196,0.11)';
    context.lineWidth = 1;
    for (var i = 0; i <= 5; i++) {
      var amount = i / 5;
      var gx = mapX(amount);
      var gy = mapY(amount);
      context.beginPath();
      context.moveTo(gx, plot.top);
      context.lineTo(gx, plot.bottom);
      context.stroke();
      context.beginPath();
      context.moveTo(plot.left, gy);
      context.lineTo(plot.right, gy);
      context.stroke();
    }

    context.strokeStyle = 'rgba(255,255,255,0.18)';
    context.setLineDash([5, 5]);
    context.beginPath();
    context.moveTo(mapX(0), mapY(0));
    context.lineTo(mapX(1), mapY(1));
    context.stroke();
    context.setLineDash([]);

    var points = SDT.stats.rocCurve(dPrime, 220);
    context.beginPath();
    points.forEach(function (point, index) {
      var px = mapX(point.pFA);
      var py = mapY(point.pHit);
      if (index === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    });
    context.strokeStyle = '#d9a441';
    context.lineWidth = 2.4;
    context.stroke();

    if (options.point && isFinite(options.point.pFA) && isFinite(options.point.pHit)) {
      context.beginPath();
      context.arc(mapX(options.point.pFA), mapY(options.point.pHit), 6, 0, Math.PI * 2);
      context.fillStyle = '#c4453a';
      context.fill();
      context.strokeStyle = '#f2eee2';
      context.lineWidth = 2;
      context.stroke();
    }

    if (typeof options.labC === 'number') {
      var lab = SDT.stats.rateFromC(dPrime, options.labC);
      context.beginPath();
      context.arc(mapX(lab.pFA), mapY(lab.pHit), 6, 0, Math.PI * 2);
      context.fillStyle = '#f1c464';
      context.fill();
      context.strokeStyle = '#fff3cf';
      context.lineWidth = 1.6;
      context.stroke();

      context.fillStyle = 'rgba(241,196,100,0.88)';
      context.font = '11px Consolas, monospace';
      context.textAlign = 'left';
      context.fillText('c', mapX(lab.pFA) + 9, mapY(lab.pHit) - 9);
    }

    if (Number.isFinite(options.cOpt)) {
      var optimal = SDT.stats.rateFromC(dPrime, options.cOpt);
      var optimalX = mapX(optimal.pFA);
      var optimalY = mapY(optimal.pHit);
      context.beginPath();
      context.arc(optimalX, optimalY, 6, 0, Math.PI * 2);
      context.strokeStyle = '#86c04d';
      context.lineWidth = 2.2;
      context.stroke();
      context.fillStyle = 'rgba(134,192,77,0.12)';
      context.fill();
      context.fillStyle = '#9bd76a';
      context.font = '10px Consolas, monospace';
      context.textAlign = 'left';
      context.fillText('c_opt', optimalX + 9, optimalY + 4);
    }

    context.strokeStyle = 'rgba(204,214,196,0.45)';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(plot.left, plot.bottom);
    context.lineTo(plot.right, plot.bottom);
    context.moveTo(plot.left, plot.bottom);
    context.lineTo(plot.left, plot.top);
    context.stroke();

    context.fillStyle = '#8b9782';
    context.font = '11px Consolas, monospace';
    context.textAlign = 'right';
    context.fillText('P(虚报) →', plot.right, height - 22);
    context.save();
    context.translate(15, plot.top);
    context.rotate(-Math.PI / 2);
    context.textAlign = 'right';
    context.fillText('P(击中) →', 0, 0);
    context.restore();

    context.fillStyle = '#d9a441';
    context.font = '12px Consolas, monospace';
    context.textAlign = 'right';
    context.fillText('d′ = ' + dPrime.toFixed(2), plot.right, 17);

    if (dPrime < 0.025) {
      context.fillStyle = 'rgba(241,196,100,0.78)';
      context.font = '11px "Microsoft YaHei", sans-serif';
      context.textAlign = 'center';
      context.fillText('d′ = 0：曲线与对角线重合，完全无法辨别', width / 2, height - 18);
    }
  }

  function renderLab() {
    var dSlider = global.document.getElementById('lab-dprime');
    var cSlider = global.document.getElementById('lab-c');
    var pSlider = global.document.getElementById('lab-priori');
    var readout = global.document.getElementById('lab-readout');
    var pSliderHint = global.document.getElementById('lab-hint-priori');
    if (!dSlider || !cSlider || !readout) return;

    var dPrime = Number(dSlider.value);
    var criterion = Number(cSlider.value);
    var priori = pSlider ? Number(pSlider.value) / 100 : 0.5;
    var payoff = currentLabPayoff();
    var rates = SDT.stats.rateFromC(dPrime, criterion);
    var beta = Math.exp(dPrime * criterion);
    var cOpt = SDT.stats.optimalCriterion(dPrime, priori, payoff);

    readout.innerHTML =
      '<div class="readout-row"><span>P(Hit)</span><b>' + rates.pHit.toFixed(3) + '</b></div>' +
      '<div class="readout-row"><span>P(FA)</span><b>' + rates.pFA.toFixed(3) + '</b></div>' +
      '<div class="readout-row"><span>d′</span><b>' + dPrime.toFixed(2) + '</b></div>' +
      '<div class="readout-row"><span>c</span><b>' + criterion.toFixed(2) + '</b></div>' +
      '<div class="readout-row"><span>β</span><b>' + beta.toFixed(2) + '</b></div>' +
      '<div class="readout-row"><span>最优 c</span><b>' +
      (isFinite(cOpt) ? cOpt.toFixed(2) : '不适用') + '</b></div>';

    if (pSliderHint) {
      if (!isFinite(cOpt)) {
        pSliderHint.textContent = '当前信息量不足，无法可靠计算最优标准。';
      } else if (cOpt > 0.05) {
        pSliderHint.textContent = '当前先验与政策共同作用下，最优标准偏保守。';
      } else if (cOpt < -0.05) {
        pSliderHint.textContent = '当前先验与政策共同作用下，最优标准偏激进。';
      } else {
        pSliderHint.textContent = '先验与代价的影响在当前设定下接近抵消。';
      }
    }

    drawDistribution('lab-dist', { dPrime: dPrime, c: criterion, cOpt: cOpt });
    drawRoc('lab-roc', { dPrime: dPrime, labC: criterion, cOpt: cOpt });
  }

  function renderAll() {
    var last = SDT.game && SDT.game.state ? SDT.game.state.lastResult : null;
    var metrics = last && last.sdt ? last.sdt : null;
    var dPrime = metrics && isFinite(metrics.dPrime) ? metrics.dPrime : 0;
    var criterion = metrics && isFinite(metrics.c) ? metrics.c : 0;
    var point = metrics && isFinite(metrics.pHit) && isFinite(metrics.pFA)
      ? { pHit: metrics.pHit, pFA: metrics.pFA }
      : null;

    drawDistribution('chart-dist', {
      dPrime: dPrime,
      c: criterion,
      cOpt: metrics && isFinite(metrics.cOpt) ? metrics.cOpt : null,
      showHistogram: !!(last && last.trials && last.trials.length)
    });
    drawRoc('chart-roc', {
      dPrime: dPrime,
      point: point,
      cOpt: metrics && isFinite(metrics.cOpt) ? metrics.cOpt : null
    });
  }

  SDT.charts = {
    renderDist: drawDistribution,
    renderRoc: drawRoc,
    renderAll: renderAll,
    renderLab: renderLab
  };

})(window);
