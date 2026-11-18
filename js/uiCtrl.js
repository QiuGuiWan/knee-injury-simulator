/* =========================================================================
 * uiCtrl.js —— 右侧控制面板 / 科普文案 / 交互绑定
 * -------------------------------------------------------------------------
 * 职责：
 *   1) 文案数据统一来自动作库 motions.js（30 段科普文本、模式目录、图标）；
 *   2) 动态生成分组模式目录、图层列表（显隐 + 透明度），并绑定全部控件事件；
 *   3) 对外提供 setReadouts / setScience / showPart 等更新接口。
 *   设计原则：UI 只负责“显示与派发事件”，不直接操作 three.js 场景，
 *            所有对场景的修改都通过 main.js 传入的 actions 回调完成。
 * ======================================================================= */

window.KneeUI = (function () {
  'use strict';

  /* -----------------------------------------------------------------------
   * 一、科普文案 / 模式副标题：全部由动作库提供（唯一数据源）
   * --------------------------------------------------------------------- */
  const INFO = window.KneeMotions.info();
  const MODE_TEXT = window.KneeMotions.modeText();

  /* 分组主题色（与 css 中的 --gh 对应，用于模式芯片的高亮描边/光晕） */
  const GROUP_HUE = {
    teal: '#12a3a6',
    blue: '#3b76f6',
    amber: '#f5a623',
    magenta: '#e0348b'
  };

  /* -----------------------------------------------------------------------
   * 二、解剖结构说明（点击拾取后显示）
   * --------------------------------------------------------------------- */
  const PART_INFO = {
    femur: {
      name: '股骨（Femur）',
      tag: '骨性结构 · 大腿骨',
      desc: '人体最长、最坚固的骨。远端膨大为内侧髁与外侧髁，与胫骨平台构成胫股关节；' +
            '前方的滑车沟与髌骨构成髌股关节。股骨在屈膝时相对胫骨滚动 + 滑动，是膝关节屈伸的主体。'
    },
    tibia: {
      name: '胫骨（Tibia）',
      tag: '骨性结构 · 承重主力',
      desc: '小腿主要承重骨，近端膨大形成胫骨平台，承担几乎全部由股骨传来的压应力。' +
            '胫骨结节是髌韧带的附着点，也是青少年期“胫骨结节骨软骨炎”的好发部位。'
    },
    tibia_plateau: {
      name: '胫骨平台（Tibial Plateau）',
      tag: '关节面 · 应力集中区',
      desc: '胫骨近端的关节面，分为内侧平台与外侧平台，与半月板共同承载。' +
            '后跟硬着陆时冲击沿胫骨上传，此处是骨挫伤与应力性损伤的高发区域，因此本项目把它设为热力高亮对象之一。'
    },
    patella: {
      name: '髌骨（Patella）',
      tag: '籽骨 · 滑轮结构',
      desc: '人体最大的籽骨，位于股四头肌腱内。它把股四头肌的力臂延长，可将伸膝力矩效率提高约 30%。' +
            '屈膝时髌骨在股骨滑车沟内下滑，膝内扣会使轨迹外移，形成髌股关节外侧高压。'
    },
    meniscus_medial: {
      name: '内侧半月板（Medial Meniscus）',
      tag: '纤维软骨 · 最易受损',
      desc: '呈 C 形，周边与关节囊、内侧副韧带紧密相连，活动度明显小于外侧半月板。' +
            '膝内扣时内侧间室被压缩，其后角承受挤压 + 旋转剪切复合载荷，是运动损伤中最常见的撕裂部位。'
    },
    meniscus_lateral: {
      name: '外侧半月板（Lateral Meniscus）',
      tag: '纤维软骨 · 活动度大',
      desc: '更接近 O 形，与关节囊连接较松、活动度大，主要承受旋转剪切。' +
            '少数人存在盘状半月板（先天性形态异常），更易在扭转动作中撕裂。'
    },
    acl: {
      name: '前交叉韧带（ACL）',
      tag: '韧带 · 稳定核心',
      desc: '起自胫骨髁间前区，斜向后上外方止于股骨外侧髁内侧面，主要限制胫骨前移与内旋。' +
            '“膝外翻 + 胫骨内旋 + 膝接近伸直”是非接触性 ACL 断裂的经典机制。'
    },
    pcl: {
      name: '后交叉韧带（PCL）',
      tag: '韧带 · 限制后移',
      desc: '限制胫骨向后移位，是膝关节最强的韧带之一。' +
            '常见损伤机制为屈膝位受到来自前方的直接撞击（如“挡板伤”）。'
    },
    mcl: {
      name: '内侧副韧带（MCL）',
      tag: '韧带 · 抗外翻',
      desc: '位于膝关节内侧，对抗外翻应力。膝内扣时被反复牵拉，可出现内侧关节间隙压痛；' +
            '由于与内侧半月板相连，MCL 损伤常伴内侧半月板损伤。'
    },
    lcl: {
      name: '外侧副韧带（LCL）',
      tag: '韧带 · 抗内翻',
      desc: '位于膝关节外侧，呈条索状，对抗内翻应力。与外侧半月板不相连，因此外侧结构损伤模式与内侧不同。'
    },
    ligament: {
      name: '韧带结构（Ligaments）',
      tag: '被动稳定系统',
      desc: '交叉韧带控制前后位移与旋转，侧副韧带控制内外翻。它们与肌肉共同构成膝关节的稳定系统；' +
            '疲劳状态下神经肌肉控制下降，韧带承受的张力会明显增加。'
    }
  };

  /* 应力部位 HUD 用的中文短名 */
  const PART_LABEL = {
    meniscus_medial: '内侧半月板',
    meniscus_lateral: '外侧半月板',
    tibia_plateau: '胫骨平台'
  };

  /* -----------------------------------------------------------------------
   * 三、UI 类
   * --------------------------------------------------------------------- */
  class UI {
    /**
     * @param {Object} actions 由 main.js 提供的回调集合
     */
    constructor(actions) {
      this.a = actions || {};
      this.el = {};
      this._seeking = false;
      this._lastProgress = -1;
    }

    init() {
      const $ = (id) => document.getElementById(id);
      this.el = {
        segMode: $('seg-mode'),
        poseGrid: $('pose-grid'),
        poseWrongSub: $('pose-wrong-sub'),
        poseCorrectSub: document.querySelector('.pose-btn[data-pose="correct"] .pose-sub'),
        btnPlay: $('btn-play'),
        btnReset: $('btn-reset'),
        timeline: $('timeline'),
        speed: $('speed'),
        speedValue: $('speed-value'),
        hintSpeed: $('hint-speed'),
        segView: $('seg-view'),
        layers: $('layers'),
        btnLayerAll: $('btn-layer-all'),
        btnLayerSolo: $('btn-layer-solo'),
        heat: $('heat-toggle'),
        body: $('body-toggle'),
        stressFill: $('stress-fill'),
        sciTitle: $('sci-title'),
        sciTag: $('sci-tag'),
        sciPrinciple: $('sci-principle'),
        sciInjury: $('sci-injury'),
        sciRehab: $('sci-rehab'),
        sciNote: $('sci-note'),
        partCard: $('part-card'),
        partName: $('part-name'),
        partTag: $('part-tag'),
        partDesc: $('part-desc'),
        partClose: $('part-close'),
        hudClip: $('hud-clip'),
        hudAngle: $('hud-angle'),
        hudStress: $('hud-stress'),
        hudPart: $('hud-part'),
        hudForce: $('hud-force'),
        hudRisk: $('hud-risk'),
        hudMedial: $('hud-medial'),
        hudLateral: $('hud-lateral'),
        hudBarMedial: $('hud-bar-medial'),
        hudBarLateral: $('hud-bar-lateral'),
        hudShift: $('hud-shift'),
        hudQ: $('hud-q'),
        mechForce: $('mech-force'),
        mechMedial: $('mech-medial'),
        mechLateral: $('mech-lateral'),
        mechBarMedial: $('mech-bar-medial'),
        mechBarLateral: $('mech-bar-lateral'),
        mechShift: $('mech-shift'),
        mechQ: $('mech-q'),
        mechKam: $('mech-kam'),
        mechFlex: $('mech-flex'),
        mechRisk: $('mech-risk'),
        labelLeft: $('view-label-left'),
        labelRight: $('view-label-right'),
        divider: $('split-divider'),
        badge: $('badge-model'),
        loading: $('loading'),
        loadingText: $('loading-text'),
        modal: $('usage-modal'),
        modalClose: $('modal-close'),
        modalTabs: $('modal-tabs'),
        btnUsage: $('btn-usage')
      };

      this._buildModes();
      this._buildLayers();
      this._bind();
      this._bindScrollHint();
      this.setMode('squat');
      this.setScience('anim_squat_correct');
    }

    /* ---------- 分组模式目录（15 类动作，4 个主题分组） ---------- */
    _buildModes() {
      const wrap = this.el.segMode;
      if (!wrap) return;
      wrap.innerHTML = '';
      wrap.classList.add('mode-catalog');
      const MODES = window.KneeMotions.MODES;
      const GROUPS = window.KneeMotions.GROUPS;
      const ICONS = window.KneeMotions.ICONS;

      GROUPS.forEach((g) => {
        const modes = MODES.filter((m) => m.group === g.id);
        if (!modes.length) return;
        const group = document.createElement('div');
        group.className = 'mode-group';
        group.dataset.group = g.id;
        group.style.setProperty('--gh', GROUP_HUE[g.hue] || GROUP_HUE.teal);

        const head = document.createElement('div');
        head.className = 'mode-group-head';
        head.innerHTML = '<span class="mode-group-name">' + g.name + '</span>' +
                         '<span class="mode-group-count">' + modes.length + '</span>';
        group.appendChild(head);

        const chips = document.createElement('div');
        chips.className = 'mode-chips';
        modes.forEach((m) => {
          const btn = document.createElement('button');
          btn.className = 'mode-chip';
          btn.dataset.mode = m.id;
          btn.title = m.en + ' · ' + m.name;
          btn.innerHTML =
            '<svg class="mode-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="' + (ICONS[m.id] || '') + '"/></svg>' +
            '<span class="mode-name">' + m.name + '</span>';
          chips.appendChild(btn);
        });
        group.appendChild(chips);
        wrap.appendChild(group);
      });
    }

    /* ---------- 控制区滚动提示（内容超长时出现） ---------- */
    _bindScrollHint() {
      const scroller = document.querySelector('.panel-scroll');
      const hint = document.getElementById('scroll-more');
      if (!scroller || !hint) return;

      const update = () => {
        const overflow = scroller.scrollHeight - scroller.clientHeight > 8;
        const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
        hint.classList.toggle('is-on', overflow && !atEnd);
      };
      scroller.addEventListener('scroll', update, { passive: true });
      if (window.ResizeObserver) new ResizeObserver(update).observe(scroller);
      window.addEventListener('resize', update);
      setTimeout(update, 120);
      update();
    }

    /* ---------- 图层列表 ---------- */
    _buildLayers() {
      const wrap = this.el.layers;
      wrap.innerHTML = '';
      KneeModel.LAYERS.forEach((layer) => {
        const row = document.createElement('div');
        row.className = 'layer-row';
        row.dataset.layer = layer.key;
        row.innerHTML =
          '<input type="checkbox" checked title="显示/隐藏" />' +
          '<span class="layer-name" title="' + layer.en + '">' + layer.name + '</span>' +
          '<input type="range" min="0.1" max="1" step="0.05" value="' + layer.opacity + '" title="透明度" />';

        const cb = row.querySelector('input[type="checkbox"]');
        const range = row.querySelector('input[type="range"]');

        cb.addEventListener('change', () => {
          row.classList.toggle('is-off', !cb.checked);
          if (this.a.setLayerVisible) this.a.setLayerVisible(layer.key, cb.checked);
        });
        range.addEventListener('input', () => {
          if (this.a.setLayerOpacity) this.a.setLayerOpacity(layer.key, parseFloat(range.value));
        });

        layer._cb = cb;
        layer._range = range;
        wrap.appendChild(row);
      });
    }

    /* ---------- 事件绑定 ---------- */
    _bind() {
      const el = this.el;

      // 模式切换
      el.segMode.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-mode]');
        if (!btn || btn.classList.contains('is-active')) return;
        this.setMode(btn.dataset.mode);
        if (this.a.setMode) this.a.setMode(btn.dataset.mode);
      });

      // 姿态切换
      el.poseGrid.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pose]');
        if (!btn || btn.classList.contains('is-active')) return;
        this.setPose(btn.dataset.pose);
        if (this.a.setPose) this.a.setPose(btn.dataset.pose);
      });

      // 播放 / 暂停
      el.btnPlay.addEventListener('click', () => {
        if (this.a.togglePlay) this.a.togglePlay();
      });
      el.btnReset.addEventListener('click', () => {
        if (this.a.reset) this.a.reset();
      });

      // 时间轴拖动
      el.timeline.addEventListener('input', () => {
        this._seeking = true;
        if (this.a.seek) this.a.seek(parseInt(el.timeline.value, 10) / 1000);
      });
      el.timeline.addEventListener('change', () => { this._seeking = false; });

      // 速度
      el.speed.addEventListener('input', () => {
        const v = parseFloat(el.speed.value);
        el.speedValue.textContent = v.toFixed(1) + '×';
        el.hintSpeed.textContent = v < 0.9 ? v.toFixed(1) + '× 慢放' : v.toFixed(1) + '× 播放';
        if (this.a.setSpeed) this.a.setSpeed(v);
      });

      // 视图
      el.segView.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-view]');
        if (!btn || btn.classList.contains('is-active')) return;
        this.setView(btn.dataset.view);
        if (this.a.setView) this.a.setView(btn.dataset.view);
      });

      // 图层快捷操作
      el.btnLayerAll.addEventListener('click', () => {
        this._setAllLayers(true, 1);
        if (this.a.setAllLayers) this.a.setAllLayers(true);
      });
      el.btnLayerSolo.addEventListener('click', () => {
        this._setAllLayers(null);
        if (this.a.soloBones) this.a.soloBones();
      });

      // 热力开关
      el.heat.addEventListener('change', () => {
        if (this.a.setHeat) this.a.setHeat(el.heat.checked);
      });

      // 全身姿态小窗开关
      el.body.addEventListener('change', () => {
        if (this.a.setBody) this.a.setBody(el.body.checked);
      });

      // 结构卡片关闭
      el.partClose.addEventListener('click', () => {
        el.partCard.hidden = true;
        if (this.a.clearPick) this.a.clearPick();
      });

      // 使用说明弹窗
      el.btnUsage.addEventListener('click', () => this.openModal());
      el.modalClose.addEventListener('click', () => this.closeModal());
      el.modal.addEventListener('click', (e) => {
        if (e.target.dataset.close || e.target.classList.contains('modal-mask')) this.closeModal();
      });
      el.modalTabs.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (!tab) return;
        el.modalTabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
        this.el.modal.querySelectorAll('.pane, .tab-pane').forEach((p) => {
          if (!p.dataset.pane) return;
          p.classList.toggle('is-active', p.dataset.pane === tab.dataset.tab);
        });
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.closeModal();
        if (e.key === ' ' && document.activeElement === document.body) {
          e.preventDefault();
          if (this.a.togglePlay) this.a.togglePlay();
        }
      });
    }

    _setAllLayers(on, opacity) {
      KneeModel.LAYERS.forEach((layer) => {
        if (on !== null) {
          layer._cb.checked = on;
          layer._cb.closest('.layer-row').classList.remove('is-off');
        }
        if (opacity) {
          layer._range.value = opacity;
        }
      });
    }

    /* ---------- 状态同步（由 main.js 调用） ---------- */
    setMode(mode) {
      this.el.segMode.querySelectorAll('[data-mode]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.mode === mode);
      });
      // 高亮当前分组，便于在 15 类动作中快速定位
      const active = this.el.segMode.querySelector('[data-mode].is-active');
      const gid = active ? active.closest('.mode-group').dataset.group : null;
      this.el.segMode.querySelectorAll('.mode-group').forEach((g) => {
        g.classList.toggle('is-current', g.dataset.group === gid);
      });
      const t = MODE_TEXT[mode] || MODE_TEXT.squat;
      if (this.el.poseWrongSub) this.el.poseWrongSub.textContent = t.wrongSub;
      if (this.el.poseCorrectSub) this.el.poseCorrectSub.textContent = t.correctSub;
    }

    setPose(pose) {
      this.el.poseGrid.querySelectorAll('[data-pose]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.pose === pose);
      });
    }

    setPlaying(playing) {
      this.el.btnPlay.textContent = playing ? '暂停' : '播放';
      this.el.btnPlay.classList.toggle('primary', playing);
    }

    setView(view) {
      const split = view === 'split';
      this.el.segView.querySelectorAll('[data-view]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.view === view);
      });
      this.el.labelLeft.hidden = !split;
      this.el.labelRight.hidden = !split;
      this.el.divider.hidden = !split;
    }

    setHeat(on) {
      this.el.heat.checked = on;
      this.el.stressFill.style.opacity = on ? '1' : '0.35';
    }

    setProgress(n) {
      if (this._seeking) return;
      const v = Math.round(Math.min(1, Math.max(0, n)) * 1000);
      if (v === this._lastProgress) return;
      this._lastProgress = v;
      this.el.timeline.value = String(v);
    }

    /** 实时读数（建议 8~10 Hz 调用，避免频繁触发重排） */
    setReadouts(data) {
      if (data.clip !== undefined) this.el.hudClip.textContent = data.clip;
      if (data.angle !== undefined) this.el.hudAngle.textContent = Math.round(data.angle) + '°';
      if (data.stress !== undefined) {
        this.el.hudStress.textContent = data.stress.toFixed(2);
        this.el.stressFill.style.width = Math.round(Math.min(1, data.stress) * 100) + '%';
      }
      if (data.part !== undefined) this.el.hudPart.textContent = data.part;
    }

    /** 力学证据读数（带单位，肉眼可判读） */
    setMech(m) {
      const e = this.el;
      if (!m || !e.mechForce) return;
      // 画布内 HUD（常驻，与模型同屏）
      if (e.hudForce) {
        e.hudForce.textContent = m.forceBW.toFixed(1);
        e.hudMedial.textContent = Math.round(m.medialPct) + '%';
        e.hudLateral.textContent = Math.round(m.lateralPct) + '%';
        e.hudBarMedial.style.width = m.medialPct + '%';
        e.hudBarLateral.style.width = m.lateralPct + '%';
        e.hudShift.textContent = m.shiftMm.toFixed(0) + ' mm';
        e.hudQ.textContent = m.qAngle.toFixed(0) + '°';
        e.hudRisk.textContent = m.riskText;
        e.hudRisk.className = 'hud-mech-risk ' + (m.risk === 'high' ? 'risk-high' : (m.risk === 'mid' ? 'risk-mid' : ''));
      }
      // 右侧面板（可滚动的详细读数）
      e.mechForce.textContent = m.forceBW.toFixed(1);
      e.mechMedial.textContent = Math.round(m.medialPct) + '%';
      e.mechLateral.textContent = Math.round(m.lateralPct) + '%';
      e.mechBarMedial.style.width = m.medialPct + '%';
      e.mechBarLateral.style.width = m.lateralPct + '%';
      e.mechShift.textContent = m.shiftMm.toFixed(0) + ' mm';
      e.mechQ.textContent = m.qAngle.toFixed(0) + '°';
      e.mechKam.textContent = m.kam.toFixed(1) + ' N·m/kg';
      e.mechFlex.textContent = Math.round(m.flexionDeg) + '°';
      e.mechRisk.textContent = m.riskText;
      e.mechRisk.className = 'hint ' + (m.risk === 'high' ? 'risk-high' : (m.risk === 'mid' ? 'risk-mid' : ''));
    }

    /** 切换科普文案 */
    setScience(key) {
      const d = INFO[key];
      if (!d) return;
      this.el.sciTitle.textContent = d.title;
      this.el.sciTag.textContent = d.tag;
      this.el.sciTag.className = 'tag ' + (d.tagType || '');
      this.el.sciPrinciple.textContent = d.principle;
      this.el.sciInjury.innerHTML = d.injury.map((t) => '<li>' + t + '</li>').join('');
      this.el.sciRehab.innerHTML = d.rehab.map((t) => '<li>' + t + '</li>').join('');
      this.el.sciNote.textContent = d.note;
    }

    /** 显示解剖结构说明 */
    showPart(partId) {
      const d = PART_INFO[partId];
      if (!d) return;
      this.el.partName.textContent = d.name;
      this.el.partTag.textContent = d.tag;
      this.el.partDesc.textContent = d.desc;
      this.el.partCard.hidden = false;
      // 滚动到卡片位置（小屏下更直观）
      this.el.partCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    hidePart() { this.el.partCard.hidden = true; }

    setModelBadge(text) { if (this.el.badge) this.el.badge.textContent = '模型：' + text; }

    setLoading(text, done) {
      if (this.el.loadingText && text) this.el.loadingText.textContent = text;
      if (done) this.el.loading.classList.add('is-hidden');
    }

    openModal() { this.el.modal.hidden = false; }
    closeModal() { this.el.modal.hidden = true; }

    /* 供 main.js 读取当前面板状态 */
    getState() {
      return {
        mode: (this.el.segMode.querySelector('.is-active') || {}).dataset?.mode || 'squat',
        pose: (this.el.poseGrid.querySelector('.is-active') || {}).dataset?.pose || 'correct',
        view: (this.el.segView.querySelector('.is-active') || {}).dataset?.view || 'single',
        heat: this.el.heat.checked,
        playing: this.el.btnPlay.textContent === '暂停',
        speed: parseFloat(this.el.speed.value)
      };
    }
  }

  return {
    UI: UI,
    INFO: INFO,
    PART_INFO: PART_INFO,
    PART_LABEL: PART_LABEL
  };
})();