/* ============================================================
 * stats.js —— 统计核心：正态分布 / 逆正态(probit) / SDT 指标
 * ------------------------------------------------------------
 * 本文件是整个项目的地基，其他模块只依赖它，它不依赖任何模块。
 * 所有函数均为纯函数（除 selfTest 会打日志），便于单独验证。
 *
 * 阅读顺序：
 *   1. 全局常量 SDT.CONST
 *   2. 基础数值工具        clamp / lerp / gaussRandom / makeRng
 *   3. 正态分布            normPdf / normCdf / normInv
 *   4. 理论 SDT 模型        rateFromC / rocCurve
 *   5. 实测数据 -> 指标     computeSDT
 *   6. 等级判定            gradeDPrime / gradeC
 *   7. 自检                selfTest
 * ============================================================ */

(function (global) {
  'use strict';

  var SDT = global.SDT = global.SDT || {};

  /* ============================================================
   * 1. 全局常量
   * ------------------------------------------------------------
   * 集中定义，避免魔法数字散落在 render.js / game.js / charts.js 中。
   * ============================================================ */

  SDT.CONST = {
    /* --- 画布逻辑尺寸（index.html 中 #stage 的属性值） --- */
    CANVAS_W: 640,
    CANVAS_H: 660,

    /* 伤口位点。坐标已按 render.js 的实际身体轮廓校准，保证：
     *   - 伤口盘面（site.r × sizeMul，sizeMul 上限 1.5）不越出身体轮廓
     *   - onCloth 为 false 的位点，伤口完全落在裸露皮肤上
     *   - onCloth 为 true 的位点，绘制时会先铺一层"衣服撕裂 + 暴露皮肤"补丁
     * maxR 是硬上限，绘制时对半径做钳制，防止将来改坐标又溢出。 */
    WOUND_SITES: [
      { x: 313, y: 266, r: 14, maxR: 15, onCloth: false, label: '颈部'   },
      { x: 327, y: 266, r: 14, maxR: 15, onCloth: false, label: '颈部'   },
      { x: 210, y: 370, r: 21, maxR: 29, onCloth: false, label: '左上臂' },
      { x: 430, y: 370, r: 21, maxR: 29, onCloth: false, label: '右上臂' },
      { x: 278, y: 352, r: 20, maxR: 34, onCloth: true,  label: '左胸'   },
      { x: 362, y: 352, r: 20, maxR: 34, onCloth: true,  label: '右胸'   },
      { x: 194, y: 424, r: 25, maxR: 36, onCloth: false, label: '左前臂' },
      { x: 446, y: 424, r: 25, maxR: 36, onCloth: false, label: '右前臂' }
    ],

    /* --- 伤口配色：三段式 RGB 插值锚点（见方案 6.4 第 1 层） ---
     * 注意：这里刻意用 RGB 线性插值而不是 HSL 插值。
     * HSL 从红(0°) 插到 紫(300°) 会绕经黄→绿→青→蓝，出现彩虹色，
     * 而真实的感染坏死演变是 鲜红 → 暗紫红 → 灰绿黑，RGB 直达才对。 */
    COLOR_LOW:  [198, 72, 62],   // t = 0.00  新鲜外伤
    COLOR_MID:  [122, 44, 74],   // t = 0.38  暗紫红
    COLOR_HIGH: [ 62, 68, 58],   // t = 1.00  灰绿坏死

    /* --- 图表配色 --- */
    SIGNAL_COLOR: '#c4453a',
    NOISE_COLOR:  '#4fa8a0',
    HIT_FILL:     'rgba(134,192,77,0.42)',
    FA_FILL:      'rgba(196,69,58,0.42)',
    MISS_FILL:    'rgba(74,90,68,0.30)',
    CR_FILL:      'rgba(53,86,107,0.28)',

    /* --- 代价矩阵：稳定度变化。默认均衡：漏报 : 虚报 = 2 : 1 --- */
    PAYOFF: { H: 0, CR: 0, FA: -4, M: -8 },
    POLICY_PAYOFF: {
      humane:   { H: 0, CR: 0, FA: -8,  M: -8  },
      balanced: { H: 0, CR: 0, FA: -4,  M: -8  },
      hardline: { H: 0, CR: 0, FA: -2,  M: -12 }
    },

    /* --- 时序（毫秒） --- */
    TRIAL_SCAN_MS:     420,    // 每次换人时的扫描线动画时长
    FEEDBACK_MS:       1100,   // 开启反馈时，反馈停留时长
    FEEDBACK_FAST_MS:  260,    // 关闭反馈时，试次间隔
    MIN_TRIALS_SETTLE: 5       // 少于这个试次数不允许结算
  };

  /* ============================================================
   * 2. 基础数值工具
   * ============================================================ */

  /** 把 v 夹在 [lo, hi] 区间内 */
  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 线性插值 */
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * 高斯随机数（Box-Muller 变换）。
   * 注意 while(u === 0) 的保护：Math.log(0) === -Infinity，
   * 若不保护会返回 NaN 并污染整个试次。
   */
  function gaussRandom(mu, sigma) {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * 可复现的伪随机数生成器（mulberry32）。
   * 伤口的不规则形状靠噪声生成，必须每个试次固定种子，
   * 否则每帧重绘时伤口会"抖动"。
   *
   *   var rng = makeRng(918273);
   *   rng();  // 0.xxx  —— 同一 seed 永远得到同一串数
   */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ============================================================
   * 3. 正态分布
   * ============================================================ */

  var SQRT_2PI = Math.sqrt(2 * Math.PI);

  /** 标准正态概率密度 φ(x) */
  function normPdf(x) {
    return Math.exp(-0.5 * x * x) / SQRT_2PI;
  }

  /**
   * 标准正态累积分布 Φ(x)
   * Abramowitz & Stegun 26.2.17 有理逼近，绝对误差 < 7.5e-8。
   *
   *   Φ(x) = 1 − φ(x)·(b₁t + b₂t² + b₃t³ + b₄t⁴ + b₅t⁵)
   *   t    = 1 / (1 + 0.2316419·x),  要求 x ≥ 0
   *   x < 0 时利用对称性 Φ(x) = 1 − Φ(−x)
   *
   * 精度对"显示概率、画曲线"完全够用。
   * （真正要求高精度的是下面的 normInv，那里用的是 Acklam。）
   */
  function normCdf(x) {
    if (x < 0) return 1 - normCdf(-x);
    var t = 1 / (1 + 0.2316419 * x);
    var poly = t * (0.319381530 +
               t * (-0.356563782 +
               t * ( 1.781477937 +
               t * (-1.821255978 +
               t * ( 1.330274429)))));
    return 1 - normPdf(x) * poly;
  }

  /* --- Acklam 逆正态算法系数（不要手改，精度 ~1.15e-9） --- */
  var PP = [
    -3.969683028665376e+01,  2.209460984245205e+02, -2.759285104469687e+02,
     1.383577518672690e+02, -3.066479806614716e+01,  2.506628277459239e+00
  ];
  var QQ = [
    -5.447609879822406e+01,  1.615858368580409e+02, -1.556989798598866e+02,
     6.680131188771972e+01, -1.328068155288572e+01
  ];
  var RR = [
    -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00,  4.374664141464968e+00,  2.938163982698783e+00
  ];
  var SS = [
     7.784695709041462e-03,  3.224671290700398e-01,  2.445134137142996e+00,
     3.754408661907416e+00
  ];

  var P_LOW  = 0.02425;          // 下尾分界
  var P_HIGH = 1 - P_LOW;        // 上尾分界

  /**
   * 逆正态分布 z(p)：给定累积概率，返回对应的 z 分数。
   * 这是整个 SDT 计算的核心——d′ 和 c 都要靠它。
   *
   * p ≤ 0 → −Infinity ；p ≥ 1 → +Infinity
   * 调用方必须自己处理这两个边界（见 computeSDT 的校正逻辑）。
   */
  function normInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return  Infinity;

    var q, r;

    /* --- 左尾：p < 0.02425 --- */
    if (p < P_LOW) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((RR[0] * q + RR[1]) * q + RR[2]) * q + RR[3]) * q + RR[4]) * q + RR[5]) /
             ((((SS[0] * q + SS[1]) * q + SS[2]) * q + SS[3]) * q + 1);
    }

    /* --- 主体：0.02425 ≤ p ≤ 0.97575 --- */
    if (p <= P_HIGH) {
      q = p - 0.5;
      r = q * q;
      return (((((PP[0] * r + PP[1]) * r + PP[2]) * r + PP[3]) * r + PP[4]) * r + PP[5]) * q /
             (((((QQ[0] * r + QQ[1]) * r + QQ[2]) * r + QQ[3]) * r + QQ[4]) * r + 1);
    }

    /* --- 右尾：p > 0.97575（返回负值，因为是 1−p 的镜像） --- */
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((RR[0] * q + RR[1]) * q + RR[2]) * q + RR[3]) * q + RR[4]) * q + RR[5]) /
             ((((SS[0] * q + SS[1]) * q + SS[2]) * q + SS[3]) * q + 1);
  }

  /* ============================================================
   * 4. 理论 SDT 模型
   * ------------------------------------------------------------
   * 参数化约定（与 charts.js 的绘图坐标系一致）：
   *
   *    噪音分布  f_N ~ N(−d′/2, 1)
   *    信号分布  f_S ~ N(+d′/2, 1)
   *    判断标准  位于 x = c
   *
   *   —— 即以两条分布的中点为原点。
   *   这样 c 的几何意义就是"标准线相对中点的偏移"，
   *   在分布图上是一眼可见的位置，比"以噪音中心为原点"更直观。
   *
   * 由此（见方案 4.6 的推导）：
   *
   *    z(Hit) = d′/2 − c          z(FA) = −d′/2 − c
   *    d′     = z(Hit) − z(FA)                （两分布中心距离）
   *    c      = −½·[z(Hit) + z(FA)]           （相对中点的位置）
   *    ln β   = d′ · c                        （等方差下成立）
   * ============================================================ */

  /**
   * 由理论参数 (d′, c) 反推理论上的击中率与虚报率。
   * 用于画 ROC 曲线，以及在实验室页显示"当前标准下理论上的表现"。
   */
  function rateFromC(dPrime, c) {
    return {
      pHit: 1 - normCdf(c - dPrime / 2),
      pFA:  1 - normCdf(c + dPrime / 2)
    };
  }

  /**
   * 生成 ROC 曲线上的点列。
   *
   * 曲线的参数方程（以 c 为参数）：
   *     P(FA)(c) = 1 − Φ(c + d′/2)
   *     P(Hit)(c) = 1 − Φ(c − d′/2)
   *
   * c 从 +4 扫到 −4：
   *     c → +∞ 时两率都 → 0，点在左下角（极度保守，几乎从不报告信号）
   *     c → −∞ 时两率都 → 1，点在右上角（极度激进，一律报告信号）
   *
   * d′ = 0 时曲线退化为对角线——那是"完全无法辨别"的基线。
   *
   * @returns {Array<{pFA:number, pHit:number, c:number}>}
   */
  function rocCurve(dPrime, steps) {
    steps = steps || 200;
    var pts = [];
    var cMin = -4, cMax = 4;
    for (var i = 0; i <= steps; i++) {
      var c = cMin + (cMax - cMin) * (i / steps);
      var r = rateFromC(dPrime, c);
      pts.push({ pFA: r.pFA, pHit: r.pHit, c: c });
    }
    return pts;
  }

  /* ============================================================
   * 5. 实测数据 → SDT 指标
   * ============================================================ */

  /**
   * 计算最优似然比 β_opt。
   * 不传 payoff 时退化为纯先验公式 (1−P(S))/P(S)。
   */
  function optimalBeta(priori, payoff) {
    if (!(priori > 0 && priori < 1)) return NaN;
    var betaOpt = (1 - priori) / priori;

    if (payoff) {
      var num = Number(payoff.CR) - Number(payoff.FA);
      var den = Number(payoff.H) - Number(payoff.M);
      if (!(den > 1e-9) || !(num > 0)) return NaN;
      betaOpt *= num / den;
    }

    return betaOpt;
  }

  /**
   * 计算先验与代价共同决定的最优判断标准 c_opt。
   * d′ 过小时信息量不足，返回 NaN，界面显示“不适用”。
   */
  function optimalCriterion(dPrime, priori, payoff) {
    var betaOpt = optimalBeta(priori, payoff);
    if (!(dPrime > 0.05) || !(betaOpt > 0)) return NaN;
    return Math.log(betaOpt) / dPrime;
  }

  /**
   * 由四格计数计算全部 SDT 指标。
   *
   * @param {{H:number, M:number, FA:number, CR:number}} counts
   *        四格计数。H=击中 M=漏报 FA=虚报 CR=正确拒绝。
   * @param {{useCorrection?:boolean, priori?:number, payoff?:object}} [opts]
   *        useCorrection: 是否允许在出现极端比例时启用 log-linear 校正（默认 true）
   *        priori:        本局的信号先验 P(S)，用于计算最优标准 c_opt（默认 0.5）
   *        payoff:        可选的 H/CR/FA/M 收益矩阵；不传时退回纯先验最优标准
   *
   * @returns 见下方 return 语句的字段说明。valid=false 时 d′/c/β 均为 NaN。
   */
  function computeSDT(counts, opts) {
    opts = opts || {};
    var useCorrection = opts.useCorrection !== false;   // 默认 true
    var priori = (typeof opts.priori === 'number') ? opts.priori : 0.5;

    var H  = counts.H  | 0;
    var M  = counts.M  | 0;
    var FA = counts.FA | 0;
    var CR = counts.CR | 0;

    var nSignal = H + M;             // 信号试次总数
    var nNoise  = FA + CR;           // 噪音试次总数
    var nTotal  = nSignal + nNoise;

    /* ---------- 极端情况守卫 ----------
     * 若某一类试次完全没出现（例如 P(S) 被设成 0），
     * 无法计算击中率，直接标记无效，让 UI 显示 "—"。 */
    if (nSignal === 0 || nNoise === 0 || nTotal === 0) {
      return {
        valid: false,
        counts: { H: H, M: M, FA: FA, CR: CR },
        nSignal: nSignal, nNoise: nNoise, nTotal: nTotal,
        raw: { pHit: NaN, pFA: NaN },
        pHit: NaN, pFA: NaN, zH: NaN, zF: NaN,
        dPrime: NaN, c: NaN, beta: NaN, accuracy: NaN, cOpt: NaN,
        betaOpt: NaN, stability: NaN,
        needsCorrection: false, appliedCorrection: false
      };
    }

    /* ---------- 原始比例 ---------- */
    var rawPH = H  / nSignal;
    var rawPF = FA / nNoise;

    /* ---------- 是否需要校正 ----------
     * 只要四格中任意一格为 0，就必有一侧的比例恰好等于 0 或 1，
     * 此时 normInv 会返回 ±Infinity，d′ 与 c 全部失效。 */
    var needsCorrection = (H === 0 || M === 0 || FA === 0 || CR === 0);

    /* ---------- log-linear 校正（Hautus, 1995） ----------
     * 给每个格子 +0.5，给每个总数 +1，把 0/1 比例"拉"回有限值。
     * 注意：仅在确实出现极端值时才启用（needsCorrection 为真）。
     *      无条件使用校正会给所有结果引入系统性偏移，
     *      条件使用才是文献中的标准做法。 */
    var pHit, pFA;
    if (useCorrection && needsCorrection) {
      pHit = (H  + 0.5) / (nSignal + 1);
      pFA  = (FA + 0.5) / (nNoise  + 1);
    } else {
      pHit = rawPH;
      pFA  = rawPF;
    }

    var zH = normInv(pHit);
    var zF = normInv(pFA);

    /* ---------- 核心指标 ---------- */
    var dPrime = zH - zF;                    // 辨别力：两分布中心的距离
    var c      = -0.5 * (zH + zF);           // 判断标准：相对两分布中点
    var beta   = Math.exp(dPrime * c);       // 似然比（等方差下 ln β = d′·c）

    /* ---------- 准确率 ---------- */
    var accuracy = (H + CR) / nTotal;

    /* ---------- 先验 + 代价 共同决定的最优判断标准 ----------
     * β_opt = [P(N)/P(S)] · [V(CR)−V(FA)] / [V(H)−V(M)]
     * c_opt = ln(β_opt) / d′
     *
     * 不传 payoff 时 betaOpt 就是纯先验似然比，行为与旧版本完全一致。 */
    var betaOpt = optimalBeta(priori, opts.payoff);
    var cOpt = optimalCriterion(dPrime, priori, opts.payoff);

    /* ---------- 安全区稳定度 ----------
     * 0 为基准；均衡政策下每次虚报 −4，每次漏报 −8。
     * 未提供 payoff 时不计算，避免给旧调用方制造默认业务语义。 */
    var stability = NaN;
    if (opts.payoff) {
      stability = 100 +
        H * Number(opts.payoff.H) +
        M * Number(opts.payoff.M) +
        FA * Number(opts.payoff.FA) +
        CR * Number(opts.payoff.CR);
    }

    return {
      valid: true,
      counts:  { H: H, M: M, FA: FA, CR: CR },
      nSignal: nSignal,
      nNoise:  nNoise,
      nTotal:  nTotal,

      raw: { pHit: rawPH, pFA: rawPF },      // 未校正的原始比例，供对照展示
      pHit: pHit,                            // 实际用于计算的（可能已校正）
      pFA:  pFA,
      zH: zH,
      zF: zF,

      dPrime: dPrime,                        // 辨别力指数 d′
      c: c,                                  // 判断标准 c
      beta: beta,                            // 似然比 β
      accuracy: accuracy,                    // 准确率 (H+CR)/N
      cOpt: cOpt,                            // 本局先验与代价下的最优标准
      betaOpt: betaOpt,                      // 最优似然比
      stability: stability,                  // 安全区稳定度

      needsCorrection:   needsCorrection,     // 数据本身是否含极端比例
      appliedCorrection: (useCorrection && needsCorrection)
    };
  }

  /* ============================================================
   * 6. 等级判定（纯函数，阈值与方案 8.4 一致）
   * ============================================================ */

  /**
   * d′ 的定性等级。
   * @returns {{level:string, label:string, tone:'bad'|'warn'|'good'}}
   *          tone 用于选择结果页解读卡片的样式类（ic-bad / ic-warn / ic-good）
   */
  function gradeDPrime(d) {
    if (!isFinite(d)) return { level: 'unknown', label: '数据不足', tone: 'warn' };
    if (d < 0.5)  return { level: 'none',   label: '几乎无辨别力，接近随机', tone: 'bad'  };
    if (d < 1.5)  return { level: 'weak',   label: '辨别力较弱',             tone: 'warn' };
    if (d < 2.5)  return { level: 'medium', label: '辨别力中等',             tone: 'good' };
    if (d < 3.5)  return { level: 'strong', label: '辨别力较强',             tone: 'good' };
    return          { level: 'superb', label: '辨别力极强',             tone: 'good' };
  }

  /**
   * c 的定性等级。
   * @returns {{level:string, label:string}}
   *          c > 0 保守（倾向放行）；c < 0 激进（倾向隔离）
   */
  function gradeC(c) {
    if (!isFinite(c)) return { level: 'unknown', label: '数据不足' };
    if (c < -0.3) return { level: 'liberal',  label: '激进：倾向判定感染' };
    if (c >  0.3) return { level: 'conservative', label: '保守：倾向放行'   };
    return          { level: 'neutral', label: '中立：不偏不倚' };
  }

  /* ============================================================
   * 7. 自检
   * ------------------------------------------------------------
   * 在浏览器控制台执行：   SDT.stats.selfTest()
   * 全部 PASS 说明统计核心正确，可以放心在此之上开发。
   * ============================================================ */

  function selfTest() {
    var results = [];
    var pass = 0, fail = 0;

    function check(name, actual, expected, tol) {
      var ok = Math.abs(actual - expected) <= tol;
      if (ok) pass++; else fail++;
      results.push({
        name: name,
        ok: ok,
        actual: actual,
        expected: expected,
        diff: Math.abs(actual - expected)
      });
    }

    /* --- 7.1 逆正态分布的已知值 --- */
    check('normInv(0.5)',     normInv(0.5),     0,            1e-9);
    check('normInv(0.975)',   normInv(0.975),   1.959963985,  1e-6);
    check('normInv(0.025)',   normInv(0.025),  -1.959963985,  1e-6);
    check('normInv(0.001)',   normInv(0.001),  -3.090232306,  1e-6);
    check('normInv(0.999)',   normInv(0.999),   3.090232306,  1e-6);

    /* --- 7.2 正向累积分布的已知值 --- */
    check('normCdf(0)',       normCdf(0),       0.5,          1e-7);
    check('normCdf(1.96)',    normCdf(1.96),    0.975002105,  1e-6);
    check('normCdf(-1.645)',  normCdf(-1.645),  0.049984907,  1e-6);

    /* --- 7.3 正逆互逆性 --- */
    check('normInv(normCdf(1.3))', normInv(normCdf(1.3)), 1.3, 1e-5);
    check('normCdf(normInv(0.8))', normCdf(normInv(0.8)), 0.8, 1e-6);

    /* --- 7.4 理论模型 round-trip ---
     * d′=2, c=0 时，理论上 P(Hit) 应等于 Φ(1)，P(FA) 应等于 Φ(−1)。 */
    var r = rateFromC(2, 0);
    check('rateFromC(2,0).pHit', r.pHit, 0.841344746, 1e-6);
    check('rateFromC(2,0).pFA',  r.pFA,  0.158655254, 1e-6);

    /* c 移到 +1（保守）后，两个率都应变小 */
    var r2 = rateFromC(2, 1);
    check('rateFromC(2,1).pHit < 0.841', r2.pHit < 0.841 ? 1 : 0, 1, 0);
    check('rateFromC(2,1).pFA  < 0.159', r2.pFA  < 0.159 ? 1 : 0, 1, 0);

    /* --- 7.5 实测数据 → 指标（无极端值，不触发校正） ---
     * H=16, M=4, FA=4, CR=16  →  pHit=0.8, pFA=0.2
     * d′ = z(0.8) − z(0.2) = 0.841621 − (−0.841621) = 1.683242
     * c  = −½[0.841621 + (−0.841621)] = 0  */
    var sdt = computeSDT({ H: 16, M: 4, FA: 4, CR: 16 }, { priori: 0.5 });
    check('dPrime (H16 M4 FA4 CR16)', sdt.dPrime, 1.683242, 1e-4);
    check('c      (H16 M4 FA4 CR16)', sdt.c,      0,        1e-6);
    check('accuracy 对称四格',          sdt.accuracy, 0.8,   1e-9);
    check('appliedCorrection 应为 false', sdt.appliedCorrection ? 1 : 0, 0, 0);

    /* --- 7.6 极端值必须触发校正且结果有限 --- */
    var ext = computeSDT({ H: 20, M: 0, FA: 0, CR: 20 }, { useCorrection: true, priori: 0.5 });
    check('needsCorrection 应为 true', ext.needsCorrection ? 1 : 0, 1, 0);
    check('校正后 dPrime 有限',        isFinite(ext.dPrime) ? 1 : 0, 1, 0);
    check('校正后 c 有限',             isFinite(ext.c) ? 1 : 0,      1, 0);
    /* 校正后 pHit = 20.5/21 = 0.976190, pFA = 0.5/21 = 0.023810。
     * 两尾对称，故 d′ 应当恰好等于 2·z(20.5/21) ≈ 3.9615。
     * 这里不手写常数，而是用同一个 probit 反推——
     * probit 本身的精度已由 7.1 对照文献值单独把过关，
     * 本步要验证的是"校正公式被正确应用"这条流水线。 */
    check('校正后 dPrime = 2·z(20.5/21)', ext.dPrime, 2 * normInv(20.5 / 21), 1e-9);
    check('校正后 dPrime 落在 3.9~4.0', (ext.dPrime > 3.9 && ext.dPrime < 4.0) ? 1 : 0, 1, 0);

    /* --- 7.7 关闭校正时，极端值应产生 ±Infinity --- */
    var noCorr = computeSDT({ H: 20, M: 0, FA: 0, CR: 20 }, { useCorrection: false });
    check('关闭校正后 dPrime 为 Infinity', isFinite(noCorr.dPrime) ? 0 : 1, 1, 0);

    /* --- 7.8 c_opt ---
     * 注意不能用 H=M=FA=CR 这种四格全等的数据：那对应 d′ = 0，
     * 信息量为零，"最优标准"在数学上无定义，会被守卫拦成 NaN。
     * 这正是守卫该起的作用，先把它单独测出来。 */
    check('d′=0 时 cOpt 应为 NaN（无定义）',
          isNaN(computeSDT({ H: 10, M: 10, FA: 10, CR: 10 }, { priori: 0.5 }).cOpt) ? 1 : 0, 1, 0);

    /* 用非退化数据：H16 M4 FA4 CR16 → d′ ≈ 1.6832 */
    var base = { H: 16, M: 4, FA: 4, CR: 16 };

    /* P(S)=0.5 → c_opt = ln(1)/d′ = 0，最优标准恰好在中点 */
    check('cOpt (priori=0.5)', computeSDT(base, { priori: 0.5 }).cOpt, 0, 1e-9);

    /* P(S)=0.25 → c_opt = ln(0.75/0.25)/1.6832 = ln3/1.6832 ≈ 0.6527
     * 感染者少 → 最优策略偏向保守（c > 0），与直觉一致 */
    var cPriori = computeSDT(base, { priori: 0.25 }).cOpt;
    check('cOpt (priori=0.25) ≈ 0.6527', cPriori, 0.652676, 1e-5);
    check('cOpt (priori=0.25) 应为正',   cPriori > 0 ? 1 : 0, 1, 0);

    /* --- 7.9 gaussRandom 的均值/标准差 --- */
    var sum = 0, sumSq = 0, N = 20000;
    for (var i = 0; i < N; i++) {
      var g = gaussRandom(1.5, 2);
      sum += g; sumSq += g * g;
    }
    var mean = sum / N;
    var sd = Math.sqrt(sumSq / N - mean * mean);
    check('gaussRandom 均值 ≈ 1.5', mean, 1.5, 0.06);
    check('gaussRandom 标准差 ≈ 2',  sd,   2.0, 0.06);

    /* --- 7.10 输出 --- */
    if (global.console && console.table) {
      console.log('%c[SDT.stats] 自检报告', 'color:#d9a441;font-weight:bold');
      console.table(results.map(function (r) {
        return {
          项目: r.name,
          结果: r.ok ? 'PASS' : 'FAIL',
          实际值: typeof r.actual === 'number' ? r.actual.toPrecision(9) : r.actual,
          期望值: r.expected,
          误差: r.diff.toExponential(2)
        };
      }));
      console.log(
        (fail === 0 ? '%c全部通过 ✔ ' : '%c存在失败项 ✘ ') + pass + ' PASS / ' + fail + ' FAIL',
        fail === 0 ? 'color:#86c04d;font-weight:bold' : 'color:#c4453a;font-weight:bold'
      );
    }

    return { pass: pass, fail: fail, results: results };
  }

  /* ============================================================
   * 导出
   * ============================================================ */

  SDT.stats = {
    /* 数值工具 */
    clamp: clamp,
    lerp: lerp,
    gaussRandom: gaussRandom,
    makeRng: makeRng,

    /* 正态分布 */
    normPdf: normPdf,
    normCdf: normCdf,
    normInv: normInv,

    /* 理论模型 */
    rateFromC: rateFromC,
    rocCurve: rocCurve,
    optimalBeta: optimalBeta,
    optimalCriterion: optimalCriterion,

    /* 实测 → 指标 */
    computeSDT: computeSDT,

    /* 等级判定 */
    gradeDPrime: gradeDPrime,
    gradeC: gradeC,

    /* 自检 */
    selfTest: selfTest
  };

})(window);
