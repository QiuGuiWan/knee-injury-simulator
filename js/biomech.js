/* =========================================================================
 * biomech.js —— 运动生物力学量化模块（解释"为什么伤"）
 * -------------------------------------------------------------------------
 * 与 stressShader.js 的区别（答辩可直接讲）：
 *   stressShader 给的是**相对风险色**（0~1，无物理单位）；
 *   biomech 给的是**带量级的力学读数**，让观察者用数字和力线位置判断损伤机制：
 *     ① 负重力线偏移   —— 重力线相对膝关节中心的水平位移（mm）
 *     ② 胫股关节接触力 —— 以体重倍数 BW 表示（×BW）
 *     ③ 内 / 外侧间室载荷分配（%）
 *     ④ Q 角（°）与膝内收力矩 KAM（N·m/kg）
 *
 * 【数据来源与诚实边界】
 *   下列锚点取自公开运动生物力学文献的量级，用于**教学映射**：
 *   - 关节接触力：平地行走 2–3×BW、深蹲约 7×BW、跑步 3–8×BW
 *     （Tibiofemoral contact forces during walking, running and sidestepping,
 *      J Biomech 2016；跑步内侧接触力峰值 5.1±0.95 BW）
 *   - Q 角：男性 10–15°、女性 15–20°，>20° 视为异常
 *     （Chaitow & DeLany, Clinical Application of Neuromuscular Techniques）
 *   - KAM：partial squat 约 4–8 N·m/kg，是内侧间室压缩的公认代理指标
 *     （BMC Sports Sci Med Rehabil 2025, doi:10.1186/s13102-025-01386-x）
 *   - 动态膝外翻（股骨内收内旋 + 胫骨内旋）增加内侧结构张力与髌股压力
 *     （Hewett 等 ACL 损伤风险研究）
 *   ★ 这是**基于角度的映射估计**，不是个体化有限元求解，不能给出临床诊断值。
 *     页面与论文里必须保留这句话。
 * ======================================================================= */

window.KneeBioMech = (function () {
  'use strict';

  /* 各动作的力学锚点统一由 motions.js 提供（15 模式 × 正误 = 30 段）。
     flex 曲线用屈膝角(度)驱动接触力，保证与动画自洽。 */
  const PROFILES = window.KneeMotions.profiles();

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /** 平滑采样折线关键帧 */
  function sample(keys, t) {
    if (!keys || !keys.length) return 0;
    if (t <= keys[0][0]) return keys[0][1];
    const last = keys[keys.length - 1];
    if (t >= last[0]) return last[1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const a = keys[i - 1], b = keys[i];
        const f = (t - a[0]) / Math.max(b[0] - a[0], 1e-6);
        return a[1] + (b[1] - a[1]) * (f * f * (3 - 2 * f));
      }
    }
    return last[1];
  }

  /**
   * 计算某一帧的力学读数
   * @param {string} clipKey   动作 key
   * @param {number} t         归一化进度 0~1
   * @param {number} flexionDeg 当前屈膝角（度）
   * @returns {Object} 见文件头
   */
  function compute(clipKey, t, flexionDeg) {
    const p = PROFILES[clipKey] || PROFILES.anim_squat_correct;
    const flex = clamp(flexionDeg || 0, 0, 110);

    // ① 关节接触力：随屈膝角上升，90° 达到该动作峰值
    //    指数曲线反映"屈膝越深、股四头肌张力越大、接触力越高"
    const flexFactor = Math.pow(clamp(flex / 90, 0, 1.2), 1.4);
    let forceBW = 1.0 + (p.forceAt90 - 1.0) * flexFactor;
    // 落地/触地冲击峰：与屈膝角**无关**——后跟硬落的危险恰在于
    // "屈膝很小、几乎没有缓冲，却承受全量冲击"（前掌落地则靠踝膝离心收缩吸收）。
    // 因此冲击项单独叠加，不乘 flexFactor。冲击曲线与增益由 motions.js 逐动作定义。
    if (p.impact && p.impact.keys) {
      const spike = Math.max(0, sample(p.impact.keys, t));
      forceBW += spike * (p.impact.gain || 0);
    }
    forceBW = clamp(forceBW, 1, 12);

    // ② 力线偏移与内外侧分配：错误姿态随屈膝加深而恶化
    const deep = clamp((flex - 15) / 75, 0, 1);   // 15°→0，90°→1
    const shiftMm = p.shiftBase * (0.35 + 0.65 * deep);
    const medialPct = clamp(p.medialBase + (p.valgus ? deep * 6 : 0), 45, 80);
    const lateralPct = 100 - medialPct;

    // ③ KAM 随屈膝发生变化（峰值在深屈曲）
    const kam = p.kam * (0.35 + 0.65 * sample([[0, 0.4], [0.4, 0.8], [0.65, 1], [1, 0.4]], t));

    // ④ Q 角：内扣姿态随屈膝增大
    const qAngle = p.qAngle + (p.valgus ? deep * 2.5 : 0);

    // 风险分级：以"力线偏移 + 内侧占比"判定，而非单看接触力
    let risk = 'low', riskText = '力线正常 · 负荷均衡';
    const riskScore = shiftMm / 12 * 0.5 + (medialPct - 55) / 20 * 0.5;
    if (riskScore > 0.62) { risk = 'high'; riskText = '力线内移 · 内侧应力集中'; }
    else if (riskScore > 0.25) { risk = 'mid'; riskText = '力线轻度偏移 · 需警惕'; }

    return {
      label: p.label,
      forceBW: forceBW,
      medialPct: medialPct,
      lateralPct: lateralPct,
      shiftMm: shiftMm,
      kam: kam,
      qAngle: qAngle,
      flexionDeg: flex,
      risk: risk,
      riskText: riskText,
      // 给小窗力线着色用：正确=青，错误=橙红
      valgus: p.valgus
    };
  }

  return { compute: compute, PROFILES: PROFILES };
})();
