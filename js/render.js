/* ============================================================
 * render.js —— 幸存者、伤口与末日检查站场景的 Canvas 渲染
 * ============================================================ */

(function (global) {
  'use strict';

  var SDT = global.SDT = global.SDT || {};
  var C = SDT.CONST || {};
  var W = C.CANVAS_W || 640;
  var H = C.CANVAS_H || 660;
  var noiseCanvas = null;
  var ctx = null;
  var loopId = null;
  var lastTime = 0;

  function setupCanvas(canvas, logicalW, logicalH) {
    // 逻辑尺寸由调用方给出：图表给的是「实际显示宽度」，让字号在手机上保持
    // 真实大小；舞台给的是固定的设计尺寸。每次按参数更新，尺寸没变就不动
    // 后备缓冲区。
    // 注意：给 canvas.width 赋值会同步改写 width 内容属性，所以逻辑尺寸只能
    // 来自参数，绝不能再回头去读 canvas 的 width/height 属性。
    canvas.dataset.logicalW = logicalW;
    canvas.dataset.logicalH = logicalH;
    var w = logicalW;
    var h = logicalH;

    var dpr = Math.max(1, global.devicePixelRatio || 1);
    var nextW = Math.round(w * dpr);
    var nextH = Math.round(h * dpr);

    // 尺寸没变就不要重新赋值：给 canvas.width 赋值会强制清空并重新分配
    // 后备缓冲区，在拖动滑块的连续重绘下是纯浪费。
    if (canvas.width !== nextW || canvas.height !== nextH) {
      canvas.width = nextW;
      canvas.height = nextH;
    }

    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    var context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = true;
    return context;
  }

  function rgb(color, alpha) {
    return 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + alpha + ')';
  }

  function shade(color, amount) {
    return [
      Math.round(SDT.stats.clamp(color[0] * amount, 0, 255)),
      Math.round(SDT.stats.clamp(color[1] * amount, 0, 255)),
      Math.round(SDT.stats.clamp(color[2] * amount, 0, 255))
    ];
  }

  function woundColor(t) {
    var low = C.COLOR_LOW || [198, 72, 62];
    var mid = C.COLOR_MID || [122, 44, 74];
    var high = C.COLOR_HIGH || [62, 68, 58];
    var a, b, amount;

    if (t < 0.38) {
      a = low;
      b = mid;
      amount = t / 0.38;
    } else {
      a = mid;
      b = high;
      amount = (t - 0.38) / 0.62;
    }

    return [
      Math.round(a[0] + (b[0] - a[0]) * amount),
      Math.round(a[1] + (b[1] - a[1]) * amount),
      Math.round(a[2] + (b[2] - a[2]) * amount)
    ];
  }

  function buildBlob(rng, radius, t, scale) {
    scale = scale || 1;
    var count = 18 + Math.floor(rng() * 9);
    var points = [];
    for (var i = 0; i < count; i++) {
      var angle = Math.PI * 2 * i / count;
      var base = radius * scale * (0.62 + 0.34 * rng());
      var edgeNoise = (rng() - 0.5) * radius * scale * 0.42 * t;
      points.push({
        angle: angle,
        radius: Math.max(radius * scale * 0.24, base + edgeNoise)
      });
    }
    return points;
  }

  function traceBlob(context, points, x, y, rotation) {
    context.beginPath();
    for (var i = 0; i < points.length; i++) {
      var angle = points[i].angle + rotation;
      var px = x + Math.cos(angle) * points[i].radius;
      var py = y + Math.sin(angle) * points[i].radius;
      if (i === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.closePath();
  }

  function prepareTrial(trial) {
    if (!trial || !trial.wound || trial._renderReady) return;

    var wound = trial.wound;
    var site = wound.site;
    var radius = Math.min(site.r * wound.sizeMul, site.maxR || site.r * 1.5);
    var rng = SDT.stats.makeRng(wound.seed);
    var render = {
      radius: radius,
      rotation: wound.rot,
      spots: [],
      veins: []
    };

    if (wound.kind === 'bite') {
      render.body = buildBlob(rng, radius, trial.t, 1);
      render.deep = buildBlob(rng, radius, trial.t * 0.65, 0.55);
      /* 齿印是机械成因（牙齿咬穿皮肤），只要有咬伤就必然存在，与感染无关。
       * 齿数、齿大小由本试次的随机种子决定，不随 t 变化；
       * t 只调制"清晰度"（组织坏死、伤口张开会让齿印更明显）。 */
      render.teeth = {
        count: 5 + Math.floor(rng() * 4),   // 5~8 颗，本试次固定
        sizeMul: 0.85 + rng() * 0.35        // 0.85~1.20，本试次固定
      };
    } else {
      render.strips = [];
      var stripCount = 3 + Math.floor(rng() * 3);
      var stripWidth = radius * (0.12 + wound.sizeMul * 0.08);
      for (var s = 0; s < stripCount; s++) {
        render.strips.push({
          offset: (s - (stripCount - 1) / 2) * radius * 0.32,
          length: radius * (1.3 + rng() * 0.5),
          width: stripWidth * (0.78 + rng() * 0.48),
          bow: (rng() - 0.5) * radius * 0.18
        });
      }
    }

    if (site.onCloth) {
      render.tear = buildBlob(rng, radius, 0.85, 1.42);
      render.skinPatch = buildBlob(rng, radius, 0.75, 1.18);
    }

    /* 斑点数与显现进度用同一个公式，避免"生成了但画不出来"。
     * 旧代码 spotCount 不设阈值（t=0 也生成 0 个，t=0.28 生成 6 个却因 fade=0 而不可见）。 */
    var spotProgress = SDT.stats.clamp((trial.t - 0.42) / 0.40, 0, 1);
    var spotCount = Math.round(spotProgress * 22);
    for (var i = 0; i < spotCount; i++) {
      var angle = rng() * Math.PI * 2;
      var distance = Math.sqrt(rng()) * radius * 1.3;
      render.spots.push({
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        r: radius * (0.03 + rng() * 0.07),
        color: [
          28 + Math.round(rng() * 20),
          20 + Math.round(rng() * 14),
          24 + Math.round(rng() * 16)
        ]
      });
    }

    /* 与 drawWound 里的 veinFade 用同一个公式。
     * 旧代码这里用 0.62、drawWound 用 0.50，t ∈ (0.50, 0.62) 时会白生成 0 条血管纹。 */
    var veinProgress = SDT.stats.clamp((trial.t - 0.65) / 0.30, 0, 1);
    var veinCount = Math.round(veinProgress * 9);
    for (var v = 0; v < veinCount; v++) {
      var veinAngle = rng() * Math.PI * 2;
      var length = radius * (1.00 + rng() * 0.55);
      var bend = (rng() - 0.5) * radius * 0.9;
      render.veins.push({
        a: veinAngle,
        length: length,
        bend: bend,
        width: 1 + rng()
      });
    }

    wound.radius = radius;
    trial._render = render;
    trial._renderReady = true;
  }

  function drawRoundedRect(context, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function drawBackground(context) {
    var bg = context.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#060906');
    bg.addColorStop(0.52, '#111711');
    bg.addColorStop(1, '#050705');
    context.fillStyle = bg;
    context.fillRect(0, 0, W, H);

    var haze = context.createRadialGradient(W / 2, 220, 40, W / 2, 290, 380);
    haze.addColorStop(0, 'rgba(134,192,77,0.055)');
    haze.addColorStop(0.55, 'rgba(94,110,72,0.018)');
    haze.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = haze;
    context.fillRect(0, 0, W, H);

    context.strokeStyle = 'rgba(217,164,65,0.07)';
    context.lineWidth = 1;
    for (var x = 42; x < W; x += 64) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, H);
      context.stroke();
    }
    for (var y = 54; y < H; y += 64) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(W, y);
      context.stroke();
    }

    context.fillStyle = 'rgba(0,0,0,0.42)';
    context.fillRect(0, 570, W, 90);
    context.strokeStyle = 'rgba(217,164,65,0.18)';
    context.beginPath();
    context.moveTo(0, 570);
    context.lineTo(W, 570);
    context.stroke();
  }

  function drawSubject(context, trial) {
    var skin = trial.subject.skinTone;
    var hair = trial.subject.hairColor;
    var shirt = [48 + (trial.subject.hairStyle * 7), 65, 62];
    var outline = 'rgba(14,12,10,0.9)';

    context.save();
    context.lineJoin = 'round';
    context.lineCap = 'round';

    // 躯干与病号服
    context.beginPath();
    context.moveTo(160, 320);
    context.quadraticCurveTo(320, 270, 480, 320);
    context.quadraticCurveTo(505, 460, 485, 660);
    context.lineTo(155, 660);
    context.quadraticCurveTo(135, 460, 160, 320);
    context.closePath();
    context.fillStyle = 'rgb(48,66,60)';
    context.fill();
    context.strokeStyle = outline;
    context.lineWidth = 3;
    context.stroke();

    context.beginPath();
    context.moveTo(228, 303);
    context.lineTo(320, 390);
    context.lineTo(412, 303);
    context.strokeStyle = 'rgba(157,177,151,0.22)';
    context.lineWidth = 2;
    context.stroke();
    context.beginPath();
    context.moveTo(250, 330);
    context.lineTo(390, 330);
    context.stroke();

    // 手臂
    context.beginPath();
    context.moveTo(178, 326);
    context.quadraticCurveTo(142, 390, 151, 660);
    context.lineTo(229, 660);
    context.quadraticCurveTo(218, 440, 249, 344);
    context.closePath();
    context.fillStyle = 'rgb(' + skin.r + ',' + skin.g + ',' + skin.b + ')';
    context.fill();
    context.strokeStyle = outline;
    context.lineWidth = 3;
    context.stroke();

    context.beginPath();
    context.moveTo(462, 326);
    context.quadraticCurveTo(498, 390, 489, 660);
    context.lineTo(411, 660);
    context.quadraticCurveTo(422, 440, 391, 344);
    context.closePath();
    context.fill();
    context.stroke();

    // 颈部
    drawRoundedRect(context, 295, 205, 50, 112, 18);
    context.fillStyle = 'rgb(' + Math.max(0, skin.r - 12) + ',' +
      Math.max(0, skin.g - 12) + ',' + Math.max(0, skin.b - 10) + ')';
    context.fill();
    context.strokeStyle = outline;
    context.lineWidth = 3;
    context.stroke();

    // 头部
    context.beginPath();
    context.ellipse(320, 150, 62, 78, 0, 0, Math.PI * 2);
    context.fillStyle = 'rgb(' + skin.r + ',' + skin.g + ',' + skin.b + ')';
    context.fill();
    context.strokeStyle = outline;
    context.lineWidth = 3;
    context.stroke();

    // 耳与面部
    context.beginPath();
    context.ellipse(258, 156, 10, 20, 0, 0, Math.PI * 2);
    context.ellipse(382, 156, 10, 20, 0, 0, Math.PI * 2);
    context.fillStyle = 'rgb(' + Math.max(0, skin.r - 8) + ',' +
      Math.max(0, skin.g - 8) + ',' + Math.max(0, skin.b - 6) + ')';
    context.fill();

    context.strokeStyle = 'rgba(35,25,22,0.72)';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(292, 145);
    context.quadraticCurveTo(304, 139, 315, 145);
    context.moveTo(325, 145);
    context.quadraticCurveTo(337, 139, 349, 145);
    context.stroke();
    context.beginPath();
    context.ellipse(303, 158, 4, 3, 0, 0, Math.PI * 2);
    context.ellipse(338, 158, 4, 3, 0, 0, Math.PI * 2);
    context.fillStyle = '#251a18';
    context.fill();
    context.beginPath();
    context.moveTo(320, 158);
    context.lineTo(315, 184);
    context.lineTo(323, 184);
    context.stroke();
    context.beginPath();
    context.moveTo(303, 198);
    context.quadraticCurveTo(320, 205, 338, 198);
    context.stroke();

    // 发型
    context.fillStyle = 'rgb(' + hair.r + ',' + hair.g + ',' + hair.b + ')';
    context.beginPath();
    if (trial.subject.hairStyle === 0) {
      context.ellipse(320, 100, 65, 42, 0, Math.PI, Math.PI * 2);
      context.lineTo(382, 142);
      context.quadraticCurveTo(359, 103, 320, 105);
      context.quadraticCurveTo(281, 103, 258, 142);
    } else if (trial.subject.hairStyle === 1) {
      // 长发：外轮廓沿两侧垂到肩，内轮廓只到额头。
      // 内轮廓三个关键点的 y 值必须始终 ≤ 140，否则会盖住眉毛(y=145)和眼睛(y=158)。
      context.moveTo(248, 222);
      context.quadraticCurveTo(238, 150, 258, 100);
      context.ellipse(320, 100, 62, 42, 0, Math.PI, Math.PI * 2);
      context.quadraticCurveTo(402, 150, 392, 222);
      context.quadraticCurveTo(378, 150, 350, 126);
      context.quadraticCurveTo(320, 112, 290, 126);
      context.quadraticCurveTo(262, 150, 248, 222);
    } else if (trial.subject.hairStyle === 2) {
      context.moveTo(255, 172);
      context.quadraticCurveTo(266, 77, 331, 81);
      context.quadraticCurveTo(392, 80, 385, 174);
      context.quadraticCurveTo(365, 124, 320, 118);
      context.quadraticCurveTo(278, 121, 255, 172);
    } else {
      context.ellipse(320, 112, 63, 44, 0, Math.PI, Math.PI * 2);
      context.lineTo(360, 145);
      context.quadraticCurveTo(340, 120, 320, 123);
      context.quadraticCurveTo(300, 121, 280, 145);
    }
    context.closePath();
    context.fill();

    if (trial.subject.hasBeard) {
      context.beginPath();
      context.moveTo(279, 174);
      context.quadraticCurveTo(286, 226, 320, 233);
      context.quadraticCurveTo(354, 226, 361, 174);
      context.quadraticCurveTo(343, 207, 320, 209);
      context.quadraticCurveTo(297, 207, 279, 174);
      context.closePath();
      context.fillStyle = 'rgba(' + hair.r + ',' + hair.g + ',' + hair.b + ',0.78)';
      context.fill();
    }

    context.restore();
  }

  function drawHalo(context, site, radius, t) {
    var endsAt = radius * (1.35 + t * 1.05);
    var color = woundColor(t);
    var gradient = context.createRadialGradient(site.x, site.y, radius * 0.12, site.x, site.y, endsAt);
    gradient.addColorStop(0, rgb(color, 0.3 + t * 0.35));
    gradient.addColorStop(0.5, rgb(color, 0.18 + t * 0.18));
    gradient.addColorStop(1, rgb(color, 0));
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(site.x, site.y, endsAt, 0, Math.PI * 2);
    context.fill();
  }

  function drawBite(context, trial, render, site, radius) {
    var color = woundColor(trial.t);
    var bodyColor = shade(color, 0.8);
    var deepColor = shade(color, 0.55);

    traceBlob(context, render.body, site.x, site.y, render.rotation);
    context.fillStyle = rgb(bodyColor, 1);
    context.fill();
    context.strokeStyle = 'rgba(20,8,10,0.75)';
    context.lineWidth = 1.5;
    context.stroke();

    traceBlob(context, render.deep, site.x, site.y, render.rotation);
    context.fillStyle = rgb(deepColor, 0.98);
    context.fill();

    context.save();
    context.globalAlpha = 0.4 + trial.t * 0.4;
    context.beginPath();
    context.ellipse(site.x, site.y, radius * 0.3, radius * 0.23, render.rotation, 0, Math.PI * 2);
    context.fillStyle = '#261014';
    context.fill();
    context.restore();

    /* 齿印始终可见，t 只调制清晰度：0.40（刚被咬，很淡）→ 1.00（深度坏死，清晰）。
     * 注意这里不再有 if (teethAlpha > 0) 的判断——齿印永远存在。 */
    var teethAlpha = 0.40 + 0.60 * trial.t;
    var teeth = render.teeth || { count: 6, sizeMul: 1.0 };
    context.save();
    context.globalAlpha = teethAlpha;
    var count = teeth.count;
    /* 两排齿沿 0.72R 的圆弧排列，弧长固定。齿数在 5~8 之间变化，
     * 所以单齿半径必须按"每个齿槽的宽度"限幅，否则齿会糊成一条黑带。 */
    var arcLength = radius * 0.72 * 2.443;            // 140° 弧长
    var slot = arcLength / count;
    var toothRadius = Math.min(radius * 0.11 * teeth.sizeMul, slot * 0.42);

      function drawToothArc(startDeg, endDeg) {
        for (var i = 0; i < count; i++) {
          var amount = count === 1 ? 0.5 : i / (count - 1);
          var angle = (startDeg + (endDeg - startDeg) * amount) * Math.PI / 180 + render.rotation;
          var tx = site.x + Math.cos(angle) * radius * 0.72;
          var ty = site.y + Math.sin(angle) * radius * 0.72;
          context.beginPath();
          context.ellipse(tx, ty, toothRadius, toothRadius * 0.72, angle + Math.PI / 2, 0, Math.PI * 2);
          context.fillStyle = 'rgb(38,22,26)';
          context.fill();
          context.beginPath();
          context.ellipse(tx - toothRadius * 0.26, ty - toothRadius * 0.3,
            toothRadius * 0.36, toothRadius * 0.22, angle, 0, Math.PI * 2);
          context.fillStyle = 'rgba(160,120,120,0.58)';
          context.fill();
        }
      }

      drawToothArc(-160, -20);
      drawToothArc(20, 160);
      context.restore();
  }

  function drawScratch(context, trial, render, site, radius) {
    var color = woundColor(trial.t);
    context.save();
    context.translate(site.x, site.y);
    context.rotate(render.rotation);
    context.lineCap = 'round';

    render.strips.forEach(function (strip) {
      context.beginPath();
      context.moveTo(-strip.length / 2, strip.offset);
      context.quadraticCurveTo(0, strip.offset + strip.bow, strip.length / 2, strip.offset);
      context.strokeStyle = rgb(color, 0.5 + trial.t * 0.4);
      context.lineWidth = strip.width + radius * 0.12 * trial.t;
      context.stroke();

      context.beginPath();
      context.moveTo(-strip.length / 2, strip.offset);
      context.quadraticCurveTo(0, strip.offset + strip.bow, strip.length / 2, strip.offset);
      context.strokeStyle = 'rgba(83,24,30,0.9)';
      context.lineWidth = Math.max(1.2, strip.width * (0.38 + trial.t * 0.12));
      context.stroke();
    });

    context.restore();
  }

  function drawWound(context, trial) {
    prepareTrial(trial);
    var wound = trial.wound;
    var site = wound.site;
    var render = trial._render;
    var radius = render.radius;

    if (wound.site.onCloth && render.tear) {
      var skin = trial.subject.skinTone;

      // 1) 衣服破口：比伤口大一圈的深色不规则形状
      traceBlob(context, render.tear, site.x, site.y, render.rotation);
      context.fillStyle = 'rgb(26,36,32)';
      context.fill();

      // 2) 破口内暴露的皮肤
      traceBlob(context, render.skinPatch, site.x, site.y, render.rotation);
      context.fillStyle = 'rgb(' + skin.r + ',' + skin.g + ',' + skin.b + ')';
      context.fill();
    }

    drawHalo(context, site, radius, trial.t);
    if (wound.kind === 'bite') drawBite(context, trial, render, site, radius);
    else drawScratch(context, trial, render, site, radius);

    var spotFade = SDT.stats.clamp((trial.t - 0.42) / 0.40, 0, 1);
    if (spotFade > 0) {
      context.save();
      context.translate(site.x, site.y);
      context.rotate(render.rotation);
      context.globalAlpha = 0.55 * spotFade;
      render.spots.forEach(function (spot) {
        context.beginPath();
        context.arc(spot.x, spot.y, spot.r, 0, Math.PI * 2);
        context.fillStyle = rgb(spot.color, 1);
        context.fill();
      });
      context.restore();
    }

    var veinFade = SDT.stats.clamp((trial.t - 0.65) / 0.30, 0, 1);
    if (veinFade > 0) {
      context.save();
      context.globalAlpha = 0.5 * veinFade;
      context.strokeStyle = 'rgba(26,14,28,1)';
      if (wound.site.onCloth && render.tear) {
        traceBlob(context, render.tear, site.x, site.y, render.rotation);
        context.clip();
      }
      render.veins.forEach(function (vein) {
        var sx = site.x + Math.cos(vein.a) * radius * 0.28;
        var sy = site.y + Math.sin(vein.a) * radius * 0.28;
        var ex = site.x + Math.cos(vein.a) * vein.length;
        var ey = site.y + Math.sin(vein.a) * vein.length;
        var mx = (sx + ex) / 2 + Math.cos(vein.a + Math.PI / 2) * vein.bend;
        var my = (sy + ey) / 2 + Math.sin(vein.a + Math.PI / 2) * vein.bend;
        context.beginPath();
        context.moveTo(sx, sy);
        context.quadraticCurveTo(mx, my, ex, ey);
        context.lineWidth = vein.width;
        context.stroke();
      });
      context.restore();
    }
  }

  function makeNoiseCanvas() {
    if (noiseCanvas) return noiseCanvas;
    noiseCanvas = global.document.createElement('canvas');
    noiseCanvas.width = 128;
    noiseCanvas.height = 128;
    var noiseCtx = noiseCanvas.getContext('2d');
    var image = noiseCtx.createImageData(128, 128);
    for (var i = 0; i < image.data.length; i += 4) {
      var value = Math.floor(Math.random() * 255);
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
    noiseCtx.putImageData(image, 0, 0);
    return noiseCanvas;
  }

  function drawSpotlight(context, wound, now) {
    var jitterX = Math.sin(now / 970) * 16;
    var jitterY = Math.cos(now / 1230) * 10;
    var x = wound.site.x + jitterX;
    var y = wound.site.y + jitterY;
    var gradient = context.createRadialGradient(x, y, 15, x, y, 300);
    gradient.addColorStop(0, 'rgba(255,246,214,0.15)');
    gradient.addColorStop(0.46, 'rgba(255,236,178,0.065)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, W, H);
  }

  function drawVignette(context) {
    var radius = Math.sqrt(W * W + H * H) * 0.65;
    var gradient = context.createRadialGradient(W / 2, H * 0.48, 90, W / 2, H * 0.5, radius);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(0.58, 'rgba(0,0,0,0.16)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.78)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, W, H);
  }

  function drawNoise(context, now) {
    var tile = makeNoiseCanvas();
    var offsetX = Math.floor((now / 31) % 128);
    var offsetY = Math.floor((now / 23) % 128);
    context.save();
    context.globalAlpha = 0.05;
    for (var y = -128; y < H + 128; y += 128) {
      for (var x = -128; x < W + 128; x += 128) {
        context.drawImage(tile, x - offsetX, y - offsetY);
      }
    }
    context.restore();
  }

  function drawScanline(context, trial, now) {
    if (!trial || !trial.scanStartedAt) return;
    var elapsed = now - trial.scanStartedAt;
    if (elapsed < 0 || elapsed > (C.TRIAL_SCAN_MS || 420)) return;
    var amount = elapsed / (C.TRIAL_SCAN_MS || 420);
    var y = amount * H;
    var gradient = context.createLinearGradient(0, y - 30, 0, y + 30);
    gradient.addColorStop(0, 'rgba(134,192,77,0)');
    gradient.addColorStop(0.5, 'rgba(134,192,77,0.55)');
    gradient.addColorStop(1, 'rgba(134,192,77,0)');
    context.fillStyle = gradient;
    context.fillRect(0, y - 30, W, 60);
    context.fillStyle = 'rgba(210,255,158,0.65)';
    context.fillRect(0, y - 0.5, W, 1);
  }

  function drawEmpty(context) {
    context.fillStyle = 'rgba(204,214,196,0.35)';
    context.font = '14px Consolas, monospace';
    context.textAlign = 'center';
    context.fillText('等待下一名队员归队', W / 2, H / 2);
    context.textAlign = 'start';
  }

  function draw(trial, now, dt) {
    if (!ctx) return;
    contextDraw(ctx, trial, now, dt);
  }

  function contextDraw(context, trial, now, dt) {
    context.save();
    context.setTransform(
      Math.max(1, global.devicePixelRatio || 1),
      0,
      0,
      Math.max(1, global.devicePixelRatio || 1),
      0,
      0
    );
    var shakeX = (Math.random() - 0.5) * 0.6;
    var shakeY = (Math.random() - 0.5) * 0.6;
    context.translate(shakeX, shakeY);
    drawBackground(context);

    if (trial) {
      drawSubject(context, trial);
      drawWound(context, trial);
      drawSpotlight(context, trial.wound, now);
    } else {
      drawEmpty(context);
    }

    drawVignette(context);
    drawNoise(context, now);
    drawScanline(context, trial, now);
    context.restore();
  }

  function currentTrial() {
    if (!SDT.game || !SDT.game.state) return null;
    return SDT.game.state.trials[SDT.game.state.current] || null;
  }

  function loop(now) {
    var dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0;
    lastTime = now;
    draw(currentTrial(), now, dt);
    loopId = global.requestAnimationFrame(loop);
  }

  function start() {
    var canvas = global.document.getElementById('stage');
    if (!canvas) return;
    if (!ctx) ctx = setupCanvas(canvas, W, H);
    if (loopId === null) {
      lastTime = 0;
      loopId = global.requestAnimationFrame(loop);
    }
  }

  function stop() {
    if (loopId !== null) global.cancelAnimationFrame(loopId);
    loopId = null;
    lastTime = 0;
  }

  SDT.render = {
    setupCanvas: setupCanvas,
    prepareTrial: prepareTrial,
    woundColor: woundColor,
    draw: draw,
    start: start,
    stop: stop
  };

})(window);
