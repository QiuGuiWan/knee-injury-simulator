/* =========================================================================
 * stressShader.js —— 受力热力仿真模块（本项目答辩核心亮点）
 * -------------------------------------------------------------------------
 * 【方法说明 / 论文可写】
 *   本模块不是有限元（FEA）求解，而是「基于生物力学机制的映射式应力可视化」：
 *   1) 由 animationCtrl.js 中的应力-时间曲线给出各解剖结构在动作周期内的
 *      相对应力值 s ∈ [0,1]（依据：屈膝角度、力线偏移、冲击载荷出现时刻）；
 *   2) 通过 onBeforeCompile 向 MeshStandardMaterial 注入一段片元着色器，
 *      在保留 PBR 光照的前提下，把 s 映射为「黄 → 橙 → 红」的热力颜色，
 *      并按网格局部坐标做径向梯度（关节面边缘 / 半月板游离缘更红），
 *      模拟应力向接触边缘集中的现象；
 *   3) 应力升高时材质透明度同步下降（半透明红线），形成“应力集中”的直观印象。
 *
 *   局限性（答辩时必须说明）：无材料本构、无网格划分、无载荷边界条件，
 *   颜色只代表相对风险等级，不能给出 MPa 级应力数值或临床结论。
 * ======================================================================= */

window.KneeStress = (function () {
  'use strict';

  const HEAT_LOW = new THREE.Color(0xffd166);    // 低应力：黄
  const HEAT_MID = new THREE.Color(0xff8b3d);    // 中应力：橙
  const HEAT_HIGH = new THREE.Color(0xe03131);   // 高应力：红

  /**
   * 给标准材质注入热力着色逻辑
   * @param {THREE.Material} mat  材质（会被就地修改）
   * @param {number} radius       局部坐标下的特征半径，用于径向梯度归一化
   * @returns {{uStress:Object, uRadius:Object}} uniforms 引用
   */
  function patchMaterial(mat, radius, center) {
    const uniforms = {
      uStress: { value: 0 },
      uRadius: { value: Math.max(radius, 0.001) },
      uCenter: { value: center ? center.clone() : new THREE.Vector3() }
    };

    mat.transparent = true;
    mat.needsUpdate = true;

    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uStress = uniforms.uStress;
      shader.uniforms.uRadius = uniforms.uRadius;
      shader.uniforms.uCenter = uniforms.uCenter;

      // ---- 顶点着色器：把局部坐标传给片元（用于径向梯度） ----
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vHeatLocal;'
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  vHeatLocal = position;'
        );

      // ---- 片元着色器：把热力混进「漫反射基色」 ----
      // 注意：必须改 diffuseColor（进入 PBR 光照之前），而不是 gl_FragColor。
      // 改最终像素颜色会抹掉明暗关系，红色区域会变成一块平涂的色块。
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          [
            '#include <common>',
            'uniform float uStress;',
            'uniform float uRadius;',
            'uniform vec3 uCenter;',
            'varying vec3 vHeatLocal;'
          ].join('\n')
        )
        .replace(
          '#include <color_fragment>',
          [
            '#include <color_fragment>',
            '  float heat = clamp(uStress, 0.0, 1.0);',
            '  if (heat > 0.001) {',
            // 以该网格自身中心为原点做归一化距离：关节面周缘 / 半月板游离缘更红
            '    float dNorm = length(vHeatLocal - uCenter) / max(uRadius, 0.001);',
            '    float edge = smoothstep(0.25, 1.05, dNorm);',
            // 应力值 × 径向权重 → 最终热力强度
            '    float k = clamp(heat * (0.45 + 0.85 * edge), 0.0, 1.0);',
            '    vec3 cLow  = vec3(1.000, 0.720, 0.220);',
            '    vec3 cHigh = vec3(0.760, 0.045, 0.045);',
            '    vec3 heatColor = mix(cLow, cHigh, smoothstep(0.15, 0.85, k));',
            '    diffuseColor.rgb = mix(diffuseColor.rgb, heatColor, clamp(k * 1.15, 0.0, 1.0));',
            '  }'
          ].join('\n')
        );

      // 保存引用，便于调试
      mat.userData.shader = shader;
    };

    // 避免与未注入的同类材质共用编译缓存
    mat.customProgramCacheKey = function () { return 'knee-heat-v1'; };

    return uniforms;
  }

  /** 无着色器注入时的降级方案：直接改颜色（老设备/异常兜底） */
  function tintFallback(mat, s) {
    if (!mat.color) return;
    const c = new THREE.Color().copy(HEAT_LOW).lerp(HEAT_HIGH, Math.min(1, s * 1.15));
    mat.color.copy(c);
  }

  /**
   * 应力控制器：每个三维视图（单视图 / 分屏左右）各持有一个实例
   */
  class StressController {
    /**
     * @param {Object} model modelLoader 产出的实例（需含 stressTargets）
     */
    constructor(model) {
      this.model = model;
      this.entries = {};        // partId -> [{mesh, mat, uniforms}]
      this.maxStress = 0;
      this.enabled = true;
      this._shaderOK = true;

      const targets = model.stressTargets || {};
      Object.keys(targets).forEach((partId) => {
        const list = targets[partId] || [];
        if (!list.length) return;
        this.entries[partId] = list.map((mesh) => {
          const mat = mesh.material;
          // 标记为热力目标：图层显隐逻辑里要保留它的 transparent 属性
          mesh.userData.heatTarget = true;
          // 记录原始颜色 / 透明度，供还原使用
          mesh.userData.baseOpacity = (mat && mat.opacity !== undefined) ? mat.opacity : 1;
          mesh.userData.baseColor = mat && mat.color ? mat.color.getHex() : 0xffffff;

          let uniforms = { uStress: { value: 0 }, uRadius: { value: 0.4 } };
          const geo = mesh.geometry;
          if (geo && !geo.boundingSphere) geo.computeBoundingSphere();
          const radius = geo && geo.boundingSphere ? geo.boundingSphere.radius : 0.4;
          const center = geo && geo.boundingSphere ? geo.boundingSphere.center : null;

          try {
            if (mat && mat.isMeshStandardMaterial) {
              uniforms = patchMaterial(mat, radius, center);
            } else {
              this._shaderOK = false;
            }
          } catch (e) {
            console.warn('[stressShader] 着色器注入失败，使用颜色降级方案', e);
            this._shaderOK = false;
          }
          return { mesh: mesh, mat: mat, uniforms: uniforms, heat: 0 };
        });
      });
    }

    get hasTargets() { return Object.keys(this.entries).length > 0; }

    /**
     * 每帧更新
     * @param {Object} stressMap { partId: 0~1 }
     * @param {boolean} enabled 热力开关（关闭后所有部件恢复原样）
     * @param {number} time 秒，用于轻微脉动
     * @returns {number} 本帧最大应力值（用于 HUD / 进度条）
     */
    update(stressMap, enabled, time) {
      let max = 0;
      const on = enabled !== false;
      const pulse = 0.94 + 0.06 * Math.sin(time * 7.5);   // 轻微“心跳”脉动，强化视觉焦点

      Object.keys(this.entries).forEach((partId) => {
        let s = on ? (stressMap && stressMap[partId]) || 0 : 0;
        s = Math.min(1, Math.max(0, s));
        if (s > max) max = s;

        const v = s * pulse;
        this.entries[partId].forEach((e) => {
          e.heat = v;

          if (e.uniforms && e.uniforms.uStress) e.uniforms.uStress.value = v;

          if (e.mat) {
            // 半透红：基色透明度由图层滑块决定（userData.baseOpacity 动态读取）
            const base = e.mesh.userData.baseOpacity !== undefined ? e.mesh.userData.baseOpacity : 1;
            const targetOpacity = base * (1 - 0.26 * v);
            e.mat.transparent = true;
            if (Math.abs(e.mat.opacity - targetOpacity) > 0.003) e.mat.opacity = targetOpacity;
            if (Math.abs(e.mat.opacity - base) > 0.003 && v < 0.02) e.mat.opacity = base;

            // 自发光微微增强，让红色在浅色场景里更醒目
            if (e.mat.emissive) {
              e.mat.emissive.setRGB(v * 0.42, v * 0.012, v * 0.012);
            } else if (!this._shaderOK) {
              tintFallback(e.mat, v);
            }
          }
        });
      });

      this.maxStress = max;
      return max;
    }

    /** 恢复初始材质状态 */
    reset() {
      Object.keys(this.entries).forEach((partId) => {
        this.entries[partId].forEach((e) => {
          if (e.uniforms && e.uniforms.uStress) e.uniforms.uStress.value = 0;
          e.heat = 0;
          if (e.mat) {
            e.mat.opacity = e.mesh.userData.baseOpacity !== undefined ? e.mesh.userData.baseOpacity : 1;
            if (e.mat.emissive) e.mat.emissive.setRGB(0, 0, 0);
            if (e.mat.color && e.mesh.userData.baseColor !== undefined) e.mat.color.setHex(e.mesh.userData.baseColor);
          }
        });
      });
      this.maxStress = 0;
    }

    /** 供 HUD 显示“应力最集中的部位” */
    dominantPart(labels) {
      let best = null, val = 0;
      Object.keys(this.entries).forEach((partId) => {
        const list = this.entries[partId];
        if (!list.length) return;
        const v = list[0].heat;
        if (v > val) { val = v; best = partId; }
      });
      if (!best || val < 0.18) return '—';
      return (labels && labels[best]) || best;
    }
  }

  return {
    StressController: StressController,
    patchMaterial: patchMaterial,
    HEAT_LOW: HEAT_LOW,
    HEAT_MID: HEAT_MID,
    HEAT_HIGH: HEAT_HIGH
  };
})();
