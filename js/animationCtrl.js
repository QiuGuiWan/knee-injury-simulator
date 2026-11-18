/* =========================================================================
 * animationCtrl.js —— 动画与动作数据模块
 * -------------------------------------------------------------------------
 * 职责：
 *   1) 定义 4 段动作（标准深蹲 / 膝内扣深蹲 / 前掌落跑步 / 后跟硬落跑步）的
 *      关键帧数据与「应力-时间」曲线（应力曲线是热力高亮的驱动源）；
 *   2) 把关键帧数据转成 three.js 的 AnimationClip（内置解析模型使用）；
 *   3) 封装 AnimationController：切换动作、播放/暂停/重置、进度同步、淡入淡出。
 *
 * 说明（答辩可讲）：
 *   - 真实 GLB 模型自带 Blender 烘好的动画 clip，本模块只负责“播放与调度”；
 *   - 若没有 GLB（或用户还没做动画），本模块会用下面的关键帧数据生成等效动画，
 *     保证页面开箱可用。两条路径共用同一套 AnimationMixer 播放器。
 *   - 应力曲线不是有限元结果，而是根据屈膝角度与受力机制做的“映射式”近似，
 *     详见 stressShader.js 顶部注释。
 * ======================================================================= */

window.KneeAnim = (function () {
  'use strict';

  const DEG = Math.PI / 180;

  /* =======================================================================
   * 一、4 段动作的关键帧定义
   * -----------------------------------------------------------------------
   * tracks: 每条轨道 = { node, prop, keys }
   *   node —— 场景中 Object3D 的 name（内置模型用 FemurPivot/TibiaPivot/PatellaPivot）
   *   prop —— 属性路径，支持 'rotation[x]' 'rotation[z]' 'position[y]' 等
   *   keys —— [[归一化时间 0~1, 数值], ...]，时间会自动乘以 duration
   *
   * stress: 应力曲线 { 部件ID: [[归一化时间, 应力 0~1], ...] }
   *   部件ID 与 modelLoader 中的 stressTargets 对应：
   *   meniscus_medial（内侧半月板）/ meniscus_lateral（外侧半月板）/ tibia_plateau（胫骨平台）
   *   ★ 正确姿态的曲线整体压在 0.2 以下 → 不会触发红色高亮（需求 5）
   *   ★ 错误姿态在屈膝峰值冲到 0.9~1.0 → 触发半透红热力材质
   * ======================================================================= */

  /* 30 段动作的关键帧与应力曲线统一由 motions.js 提供。
     legacy 4 段（深蹲/跑步）轨道逐字保留以匹配 GLB 自带 clip；其余 26 段由曲线合成。 */
  const CLIP_DEFS = window.KneeMotions.clipDefs();

  /* 动作 key 与「模式 / 姿态」的映射表，UI 层直接查表 */
  const CLIP_MAP = {};
  window.KneeMotions.MODES.forEach(function (m) {
    CLIP_MAP[m.id] = { correct: m.correct.key, wrong: m.wrong.key };
  });

  /* 应力高亮阈值：低于该值视为“正常生理载荷”，不显示红色（正确姿态靠它保持干净） */
  const STRESS_THRESHOLD = 0.25;

  /* -----------------------------------------------------------------------
   * 二、关键帧工具
   * --------------------------------------------------------------------- */

  /** 线性插值采样：keys = [[t0,v0],[t1,v1]...]，t 为 0~1 */
  function sampleCurve(keys, t) {
    if (!keys || !keys.length) return 0;
    const x = Math.min(1, Math.max(0, t));
    if (x <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (x <= keys[i][0]) {
        const [t0, v0] = keys[i - 1];
        const [t1, v1] = keys[i];
        const k = (x - t0) / (t1 - t0 || 1);
        return v0 + (v1 - v0) * k;
      }
    }
    return keys[keys.length - 1][1];
  }

  /** 采样某段动作在 t（0~1）处的各部件应力值 */
  function sampleStress(clipKey, t) {
    const def = CLIP_DEFS[clipKey];
    const out = {};
    if (!def || !def.stress) return out;
    Object.keys(def.stress).forEach(function (partId) {
      out[partId] = sampleCurve(def.stress[partId], t);
    });
    return out;
  }

  /**
   * 根据关键帧定义生成 three.js AnimationClip 数组
   * 仅在“内置解析模型”路径使用（真实 GLB 模型用自带动画）
   */
  function buildProceduralClips() {
    const clips = [];
    Object.keys(CLIP_DEFS).forEach(function (key) {
      const def = CLIP_DEFS[key];
      const tracks = def.tracks.map(function (tr) {
        const times = tr.keys.map(function (k) { return k[0] * def.duration; });
        const values = tr.keys.map(function (k) { return k[1]; });
        return new THREE.NumberKeyframeTrack(
          tr.node + '.' + tr.prop,
          times,
          values
        );
      });
      const clip = new THREE.AnimationClip(key, def.duration, tracks);
      clips.push(clip);
    });
    return clips;
  }

  /* -----------------------------------------------------------------------
   * 三、动画控制器
   * --------------------------------------------------------------------- */
  class AnimationController {
    /**
     * @param {Object} model modelLoader 返回的实例 {root, clips, rig, ...}
     */
    constructor(model) {
      this.model = model;
      this.mixer = new THREE.AnimationMixer(model.root);
      this.actions = new Map();

      (model.clips || []).forEach((clip) => {
        const action = this.mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
        action.enabled = true;
        action.setEffectiveWeight(1);
        this.actions.set(clip.name, action);
      });

      this.currentKey = null;
      this.playing = false;
      this.speed = 0.8;      // 默认慢放，便于答辩讲解
      this._fade = null;
    }

    /** 当前 action */
    get action() {
      return this.currentKey ? this.actions.get(this.currentKey) : null;
    }

    get duration() {
      const a = this.action;
      return a ? a.getClip().duration : 0;
    }

    /** 当前播放进度 0~1（循环内） */
    get normalized() {
      const a = this.action;
      if (!a) return 0;
      const d = a.getClip().duration || 1;
      const t = a.time % d;
      return ((t < 0 ? t + d : t) / d);
    }

    /** 当前屈膝角度（度）——从模型 rig 的胫骨节点读取，用于 HUD 显示 */
    get flexionDeg() {
      const tibia = this.model.rig && this.model.rig.tibia;
      if (!tibia) return this.normalized * 90;   // 无骨骼时给个估算值
      const rx = Math.abs(tibia.rotation.x);
      const rz = Math.abs(tibia.rotation.z);
      return Math.min(180, Math.sqrt(rx * rx + rz * rz * 0.25) / DEG);
    }

    get hasClips() { return this.actions.size > 0; }

    /**
     * 切换动作
     * @param {string} key 动作 key
     * @param {Object} opt { fade: 淡入时长秒, norm: 目标进度 0~1, restart: 强制重播 }
     */
    setClip(key, opt) {
      opt = opt || {};
      const fade = opt.fade === undefined ? 0.35 : opt.fade;
      const next = this.actions.get(key);
      if (!next) {
        console.warn('[animationCtrl] 未找到动画轨道：' + key + '（GLB 中缺少该命名动画？）');
        return false;
      }
      if (this.currentKey === key && !opt.restart) {
        if (opt.norm !== undefined && opt.norm !== null) this.setNormalized(opt.norm);
        return true;
      }

      const phase = (opt.norm !== undefined && opt.norm !== null) ? opt.norm : this.normalized;
      const prev = this.action;

      next.stop();
      next.reset();
      next.enabled = true;
      next.setEffectiveTimeScale(1);
      next.time = phase * next.getClip().duration;
      next.setEffectiveWeight(prev && prev !== next ? 0 : 1);
      next.play();

      if (prev && prev !== next) {
        if (!this.playing) {
          // 暂停状态下切换：淡入需要「播放」来推进，暂停时直接完成切换，
          // 否则新动作权重一直是 0，画面会停在上一段动作的残留姿态上
          prev.stop();
          next.setEffectiveWeight(1);
          this._fade = null;
        } else {
          prev.setEffectiveWeight(1);
          this._fade = { from: prev, to: next, elapsed: 0, duration: Math.max(fade, 0.001) };
        }
      } else {
        this._fade = null;
      }

      this.currentKey = key;
      this.mixer.update(0);   // 立刻应用一帧，避免切换瞬间姿态闪回
      return true;
    }

    play() {
      this.playing = true;
      if (this.action && !this.action.isRunning()) this.action.play();
    }

    pause() { this.playing = false; }

    reset() {
      this._fade = null;
      this.actions.forEach((a) => { a.stop(); a.setEffectiveWeight(1); });
      if (this.action) {
        this.action.reset().play();
        this.action.setEffectiveWeight(1);
      }
      this.playing = true;
      this.mixer.update(0);
    }

    /** 进度跳转（时间轴滑块用） */
    setNormalized(t) {
      const a = this.action;
      if (!a) return;
      this._finishFade();          // 拖动时间轴时立即结束淡入，避免两个动作叠在一起
      const d = a.getClip().duration || 1;
      a.time = Math.min(0.999, Math.max(0, t)) * d;
      this.mixer.update(0);
    }

    /** 从另一个控制器同步进度（分屏模式：右视图跟随左视图） */
    syncTo(norm) {
      const a = this.action;
      if (!a) return;
      this._finishFade();
      const d = a.getClip().duration || 1;
      a.time = norm * d;
      this.mixer.update(0);
    }

    /** 立即结束淡入淡出，把权重交给当前动作 */
    _finishFade() {
      if (!this._fade) return;
      this._fade.from.stop();
      this._fade.from.setEffectiveWeight(1);
      this._fade.to.setEffectiveWeight(1);
      this._fade = null;
    }

    update(dt) {
      // 淡入淡出：只在播放状态下推进，暂停时冻结在中间姿态
      if (this._fade && this.playing) {
        const f = this._fade;
        f.elapsed += dt;
        const k = Math.min(1, f.elapsed / f.duration);
        const e = k * k * (3 - 2 * k);       // smoothstep
        f.to.setEffectiveWeight(e);
        f.from.setEffectiveWeight(1 - e);
        if (k >= 1) {
          f.from.stop();
          f.from.setEffectiveWeight(1);
          this._fade = null;
        }
      }
      this.mixer.update(this.playing ? dt * this.speed : 0);
    }
  }

  return {
    CLIP_DEFS: CLIP_DEFS,
    CLIP_MAP: CLIP_MAP,
    STRESS_THRESHOLD: STRESS_THRESHOLD,
    DEG: DEG,
    sampleCurve: sampleCurve,
    sampleStress: sampleStress,
    buildProceduralClips: buildProceduralClips,
    AnimationController: AnimationController,
    /** 便捷取值 */
    keyOf: function (mode, pose) { return (CLIP_MAP[mode] || CLIP_MAP.squat)[pose]; },
    labelOf: function (key) { return (CLIP_DEFS[key] && CLIP_DEFS[key].label) || key; }
  };
})();
