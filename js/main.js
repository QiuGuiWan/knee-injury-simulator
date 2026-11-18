/* =========================================================================
 * main.js —— 应用主入口
 * -------------------------------------------------------------------------
 * 职责：
 *   1) 初始化渲染器 / 相机 / 灯光 / 轨道控制器；
 *   2) 用同一个模板创建两个三维视图（单视图只用 0 号，分屏时 0=正确 1=错误），
 *      两个视图共用一台相机的位置姿态，但各自独立渲染到画布的左右半边；
 *   3) 每帧驱动动画 → 采样应力 → 更新热力材质 → 渲染；
 *   4) 把 UI 事件翻译成场景操作，把场景状态回填到 UI 读数。
 *
 * 画面构成（2026-11 调整）：
 *   主画面默认 = 真实人体全身姿态（可拖拽旋转 / 滚轮缩放）；
 *   右上角 = 正在仿真的膝关节特写小窗（分屏时左右各一），点击其内部件可查看解剖说明；
 *   点击小窗空白处可把两个视图对调（关节成为主画面、人体回到右上角小窗），再点即切回；
 *   人体与膝关节特写都可以拖拽旋转 / 滚轮缩放，两者按同一世界视角实时联动（见 syncKneeView）。
 *
 * 分屏实现说明（答辩常被问）：
 *   不是复制两个 canvas，而是「一个 canvas + scissor 视口 + 两套 scene/camera」，
 *   性能更好、也避免了两张画布同步拖动的问题。左右相机每帧同步 position 与
 *   quaternion，因此拖动左侧旋转时右侧会同步跟随。
 * ======================================================================= */

window.KneeApp = (function () {
  'use strict';

  /* ---------------- 全局状态 ---------------- */
  const state = {
    mode: 'squat',          // squat | run
    pose: 'correct',        // correct | wrong
    view: 'single',         // single | split
    layout: 'body',         // body = 人体主画面 | knee = 膝关节主画面（点击右上角小窗对调）
    playing: true,
    heat: true,
    body: true,          // 全身姿态小窗
    speed: 0.8,
    layers: {}              // { femur:{visible,opacity}, ... } 由 init 填充
  };

  let renderer = null;
  let clock = null;
  let controls = null;          // 人体视角轨道控制器
  let kneeControls = null;      // 膝关节特写轨道控制器（与人体视角联动）
  let orbitDriver = 'body';     // 最近一次拖拽作用在哪一侧：body | knee
  let template = null;
  let ui = null;
  let picker = null;
  let envMap = null;        // PMREM 生成的室内环境贴图，给 PBR 材质提供柔和反射
  let insetBg = null;       // 膝关节特写窗的冷灰渐变背景（半透明骨骼需要深一点的衬底）
  const views = [];         // 膝关节特写 [viewA, viewB]
  const bodyViews = [];     // 主画面：全身姿态（与膝关节共用归一化时间）
  const bodyEls = [];       // 特写窗边框 / 标题 DOM
  let insetSpecs = [];      // 膝关节特写视口（CSS px，画布内）
  let sceneBadgeMode = '';
  let swapLockUntil = 0;    // 主视角对调后的短暂锁，避免一次点击被拾取器与监听各触发一次

  // 视角联动用的临时量（避免每帧分配）
  const _qDelta = new THREE.Quaternion();
  const _qInv = new THREE.Quaternion();
  const _qDst = new THREE.Quaternion();
  const _vBack = new THREE.Vector3();
  const _axisZ = new THREE.Vector3(0, 0, 1);

  // 全身主画面的默认 / 踢球机位（单位方向，前方 = -Z）
  const BODY_DIR = new THREE.Vector3(0.58, 0.145, -0.80).normalize();
  const BODY_DIR_KICK = new THREE.Vector3(0.89, 0.10, -0.42).normalize();
  // 楼梯/坡道：偏侧机位才能看清"台阶/坡面"与脚的相对关系（正面会把纵深压扁）
  const BODY_DIR_SIDE = new THREE.Vector3(0.90, 0.12, -0.40).normalize();
  const BODY_TARGET_Y = 0.86;
  const KNEE_MAIN_ZOOM = 1.9;   // 膝关节当主画面时的取景余量（小窗保持紧凑）

  /* =======================================================================
   * 一、初始化
   * ===================================================================== */
  function boot() {
    const wrap = document.getElementById('canvas-wrap');

    // --- UI 先建好，加载过程中的提示才有地方显示 ---
    ui = new KneeUI.UI(buildActions());
    ui.init();
    ui.setPlaying(state.playing);
    ui.setHeat(state.heat);
    ui.setView(state.view);

    KneeModel.LAYERS.forEach(function (l) {
      state.layers[l.key] = { visible: true, opacity: l.opacity };
    });

    // --- 渲染器 ---
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (err) {
      ui.setLoading('当前浏览器不支持 WebGL，请更换 Chrome / Edge 后重试', false);
      console.error(err);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
    // 电影级色调映射：避免浅色骨骼在多点布光下过曝成一片白
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    // 开启自阴影：股骨髁、半月板、胫骨平台之间的相互遮挡能显著增强体积感
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.touchAction = 'none';
    wrap.appendChild(renderer.domElement);

    // 室内环境贴图：PBR 骨骼靠它得到柔和的明暗过渡，比单纯点光源更像解剖图谱
    try { envMap = buildEnvironment(); } catch (e) { console.warn('[main] 环境贴图生成失败，使用纯灯光', e); }

    clock = new THREE.Clock();

    // --- 加载模型（GLB 优先，失败回退内置模型） ---
    KneeModel.load(function (msg) {
      ui.setLoading(msg, false);
    }).then(function (tpl) {
      template = tpl;
      ui.setModelBadge(tpl.label);

      views.push(createView(0));
      views.push(createView(1));

      // 全身姿态小窗：两套，分屏时左右各一；与主视图按同一进度驱动
      bodyViews.push(KneeBody.create(), KneeBody.create());
      bodyEls.push(document.getElementById('body-inset-0'),
                   document.getElementById('body-inset-1'));

      // 轨道控制器绑定主画面（全身人体）；右侧分屏相机跟随它
      controls = new THREE.OrbitControls(bodyViews[0].camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
      controls.rotateSpeed = 0.85;
      controls.zoomSpeed = 0.9;
      controls.panSpeed = 0.7;
      controls.screenSpacePanning = true;
      applyLayerStyle();
      layout(true);

      // 膝关节特写同样可拖拽旋转 / 滚轮缩放（围绕关节中心），并与人体视角联动
      kneeControls = new THREE.OrbitControls(views[0].camera, renderer.domElement);
      kneeControls.enableDamping = true;
      kneeControls.dampingFactor = 0.075;
      kneeControls.rotateSpeed = 0.85;
      kneeControls.zoomSpeed = 0.9;
      kneeControls.enablePan = false;
      kneeControls.target.copy(views[0].home.center);
      kneeControls.minDistance = Math.max(0.02, views[0].home.distance * 0.4);
      kneeControls.maxDistance = views[0].home.distance * 5;
      kneeControls.enabled = false;
      kneeControls.update();

      applyLayoutUI();

      // 初始动作
      views[0].anim.setClip(currentKey(), { fade: 0, norm: 0 });
      views[1].anim.setClip(KneeAnim.keyOf(state.mode, 'wrong'), { fade: 0, norm: 0 });
      views.forEach(function (v) { v.anim.play(); });
      views[0].anim.speed = state.speed;
      views[1].anim.speed = state.speed;

      // --- 射线拾取：人体主视角时只拾取右上角膝关节特写；关节主视角时拾取主画面 ---
      picker = new RayPick.Picker({
        canvas: renderer.domElement,
        getViews: function () { return views; },
        getViewports: function () {
          if (state.layout === 'body') return insetSpecs;
          const size = canvasSize();
          if (state.view === 'split') {
            const half = Math.floor(size.w / 2);
            return [
              { left: 0, top: 0, w: half, h: size.h, index: 0 },
              { left: half, top: 0, w: size.w - half, h: size.h, index: 1 }
            ];
          }
          return [{ left: 0, top: 0, w: size.w, h: size.h, index: 0 }];
        },
        getBlockRects: function () {
          return state.layout === 'body' ? [] : insetSpecs;
        },
        onPick: function (partId) { ui.showPart(partId); },
        onEmpty: function (e) {
          // 点在小窗空白处 = 切换主视角；其余空白处仅关闭说明卡片
          if (state.layout === 'body' && e && pointInInset(e)) { swapLayout(); return; }
          ui.hidePart();
        }
      });

      bindLayoutSwap();
      bindOrbitRouting();
      bindResize();
      ui.setLoading('', true);
      renderer.domElement.style.cursor = 'grab';

      tick();
    }).catch(function (err) {
      console.error('[main] 初始化失败', err);
      ui.setLoading('模型加载失败：' + (err && err.message ? err.message : err), false);
    });
  }

  /* =======================================================================
   * 二、创建单视图（scene + camera + 模型实例 + 动画 + 应力）
   * ===================================================================== */
  function createView(index) {
    const scene = new THREE.Scene();
    if (envMap) scene.environment = envMap;
    if (!insetBg) insetBg = makeInsetBackground();
    scene.background = insetBg;
    buildLights(scene);

    const instance = template.create();
    instance.clips = template.clips;      // GLB 与内置模型共用同一批 clip
    scene.add(instance.root);

    const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 300);

    const anim = new KneeAnim.AnimationController(instance);
    const stress = new KneeStress.StressController(instance);

    const view = {
      index: index,
      scene: scene,
      camera: camera,
      model: instance,
      anim: anim,
      stress: stress,
      home: { center: new THREE.Vector3(), radius: 1, distance: 8 },
      homeQuat: new THREE.Quaternion()   // 默认机位朝向，视角联动以它为基准
    };
    return view;
  }

  /** 特写窗背景：冷灰径向渐变，让半透明的象牙骨与浅蓝软骨有足够对比 */
  function makeInsetBackground() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(128, 58, 12, 128, 132, 250);
    grd.addColorStop(0, '#f4f9fc');
    grd.addColorStop(0.55, '#dde9f0');
    grd.addColorStop(1, '#c2d3de');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  /** 生成一个极简「摄影棚」环境贴图：几个发光面经 PMREM 卷积后作为 IBL。
   *  比加载外部 HDR 轻得多，效果足够让半透明骨骼有柔和的高光过渡。 */
  function buildEnvironment() {
    if (!THREE.PMREMGenerator) return null;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new THREE.Scene();
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(10, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xece8e0, side: THREE.BackSide })
    );
    room.add(shell);
    const panel = function (color, power, x, y, z, w, h) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power) })
      );
      m.position.set(x, y, z);
      m.lookAt(0, 0, 0);
      room.add(m);
    };
    panel(0xffffff, 2.2, -3, 4, 3, 5, 5);
    panel(0xffe9cf, 1.4, 4, 2, -2, 4, 4);
    panel(0xd8ecff, 1.0, 0, -3, 4, 5, 3);
    const tex = pmrem.fromScene(room, 0.04).texture;
    pmrem.dispose();
    return tex;
  }

  /** 三点布光：环境贴图 + 半球光 + 主光 + 补光 + 轮廓光 */
  function buildLights(scene) {
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c9d5, 0.12));

    // 主光（右上前方）：塑造主要的明暗交界线，并投射阴影
    const key = new THREE.DirectionalLight(0xffffff, 0.72);
    key.position.set(4.5, 6.5, 6.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 30;
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 5;
    key.shadow.camera.bottom = -5;
    key.shadow.bias = -0.0012;
    key.shadow.radius = 2;
    scene.add(key);

    // 补光（左下）：抬亮暗部，但不破坏体积感
    const fill = new THREE.DirectionalLight(0xdcecff, 0.12);
    fill.position.set(-6, 1.5, 4);
    scene.add(fill);

    // 轮廓光（后下方）：把模型边缘从背景里“抠”出来
    const rim = new THREE.DirectionalLight(0xffffff, 0.3);
    rim.position.set(-1.5, -5, -6);
    scene.add(rim);

    // 极弱环境光：避免背面纯黑
    scene.add(new THREE.AmbientLight(0xffffff, 0.03));
  }

  /* =======================================================================
   * 三、布局与相机取景
   * ===================================================================== */
  function canvasSize() {
    const el = renderer.domElement;
    return { w: el.clientWidth || 1, h: el.clientHeight || 1 };
  }

  /** 根据包围盒自动取景（膝关节特写窗用）。
   *  模型含整根股骨/胫骨长骨（包围球约 1.5m），直接按球取景关节会很小；
   *  这里限制取景半径，只框住关节区（股骨髁 + 胫骨平台 + 半月板）。 */
  function fitCamera(view, aspect, zoom) {
    zoom = zoom || 1;
    const box = new THREE.Box3().setFromObject(view.model.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    let center = sphere.center.clone();
    const radius = Math.min(Math.max(sphere.radius, 0.001), 0.62);

    // 观察点优先取「膝关节中心」：屈膝后整体包围盒会往胫骨一侧偏，
    // 直接用它居中会让关节跑到画面角落
    const tibiaNode = view.model.rig && view.model.rig.tibia;
    if (tibiaNode) {
      const joint = new THREE.Vector3();
      tibiaNode.getWorldPosition(joint);
      if (isFinite(joint.x) && joint.length() < sphere.radius * 3) center = joint;
    }

    const vFov = view.camera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const distance = radius / Math.sin(Math.min(vFov, hFov) / 2) * 1.02 * zoom;

    // 前方略偏内侧上方：既能看清内侧半月板（本项目的受力主角），
    // 又不会把髌骨甩到模型侧边去——偏太多时髌骨看起来像「贴在侧面的一块石头」
    const dir = new THREE.Vector3(0.34, 0.20, 1).normalize();
    view.camera.position.copy(center).addScaledVector(dir, distance);
    view.camera.near = Math.max(distance * 0.02, 0.01);
    view.camera.far = distance * 12;
    view.camera.aspect = aspect;
    view.camera.lookAt(center);
    view.camera.updateProjectionMatrix();

    view.home.center.copy(center);
    view.home.radius = radius;
    view.home.distance = distance;
    view.homeQuat.copy(view.camera.quaternion);

    // 膝关节轨道控制器围绕关节中心旋转，缩放范围随取景距离走
    if (view.index === 0 && kneeControls) {
      kneeControls.target.copy(center);
      kneeControls.minDistance = Math.max(0.02, distance * 0.4);
      kneeControls.maxDistance = distance * 5;
    }
  }

  /** 视口尺寸变化 / 视图切换 / 主视角对调时调用 */
  function layout(refit) {
    const size = canvasSize();
    renderer.setSize(size.w, size.h, false);

    const split = state.view === 'split';
    const mainAspect = split ? (size.w / 2) / size.h : size.w / size.h;
    const bodyMain = state.layout === 'body';

    updateInsetSpecs(size);
    const insetAspect = insetSpecs.length ? insetSpecs[0].w / insetSpecs[0].h : mainAspect;

    /* 全身人体：主画面时按画布取景，变成小窗时按小窗取景 */
    bodyViews.forEach(function (v) {
      v.camera.aspect = bodyMain ? mainAspect : insetAspect;
      v.camera.updateProjectionMatrix();
    });
    if (refit && bodyViews.length) refitBodyCameras(bodyMain ? mainAspect : insetAspect);
    if (controls) controls.enabled = bodyMain;
    if (kneeControls) kneeControls.enabled = !bodyMain;

    /* 膝关节：主画面时铺满画布（分屏按半宽），小窗时按小窗取景 */
    if (bodyMain) {
      views.forEach(function (v, i) {
        const s = insetSpecs.filter(function (x) { return x.idx === i; })[0];
        const aspect = s ? s.w / s.h : insetAspect;
        v.camera.aspect = aspect;
        v.camera.updateProjectionMatrix();
        if (refit) fitCamera(v, aspect);
      });
    } else {
      views.forEach(function (v) {
        v.camera.aspect = mainAspect;
        v.camera.updateProjectionMatrix();
        // 主画面留出取景余量：关节居中，同时能看到股骨/胫骨骨段，不贴边
        if (refit) fitCamera(v, mainAspect, KNEE_MAIN_ZOOM);
      });
    }
  }

  /** 按人体包围球把人体相机放到默认机位（主画面与小窗按各自宽高比取景） */
  function refitBodyCameras(aspect) {
    if (!bodyViews.length) return;
    aspect = aspect || bodyViews[0].camera.aspect || 1;
    const vFov = bodyViews[0].camera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    // 骑行道具横跨 ~1m（两轮），比人体取景多留一档余量，避免车轮贴边
    const sideModes = state.mode === 'stairsUp' || state.mode === 'stairsDown' ||
      state.mode === 'uphill' || state.mode === 'downhill';
    const zoomOut = state.mode === 'cycle' ? 1.24 : (sideModes ? 1.06 : 1);
    const dist = 0.95 / Math.sin(Math.min(vFov, hFov) / 2) * 1.06 * zoomOut;

    const dir = state.mode === 'kick' ? BODY_DIR_KICK : (sideModes ? BODY_DIR_SIDE : BODY_DIR);
    const target = new THREE.Vector3(0, BODY_TARGET_Y, 0);
    bodyViews.forEach(function (bv) {
      if (!bv.homeQuat) bv.homeQuat = new THREE.Quaternion();
      bv.camera.position.copy(target).addScaledVector(dir, dist);
      bv.camera.near = 0.05;
      bv.camera.far = 30;
      bv.camera.lookAt(target);
      bv.camera.updateProjectionMatrix();
      bv.homeQuat.copy(bv.camera.quaternion);
    });

    if (controls) {
      controls.target.copy(target);
      controls.minDistance = dist * 0.35;
      controls.maxDistance = dist * 3.2;
      controls.update();
    }
  }

  /** 计算膝关节特写视口位置（CSS px，相对画布左上角），并同步 DOM 边框 */
  function updateInsetSpecs(size) {
    const split = state.view === 'split';
    const half = Math.floor(size.w / 2);
    if (split) {
      const w = Math.max(120, Math.min(280, Math.floor(half * 0.40)));
      const h = Math.round(w * 1.02);
      insetSpecs = [
        { left: half - 12 - w, top: 92, w: w, h: h, idx: 0 },
        { left: size.w - 12 - w, top: 92, w: w, h: h, idx: 1 }
      ];
    } else {
      const narrow = size.w < 560;
      const w = narrow
        ? Math.max(118, Math.floor(size.w * 0.30))
        : Math.max(150, Math.min(360, Math.floor(size.w * 0.32)));
      const h = Math.round(w * 1.02);
      insetSpecs = [{ left: size.w - 16 - w, top: 52, w: w, h: h, idx: 0 }];
    }
    bodyEls.forEach(function (el, i) {
      if (!el) return;
      const s = insetSpecs.filter(function (x) { return x.idx === i; })[0];
      el.hidden = !s || !state.body;
      if (!s) return;
      el.style.left = s.left + 'px';
      el.style.top = s.top + 'px';
      el.style.width = s.w + 'px';
      el.style.height = s.h + 'px';
      el.classList.toggle('is-small', split);
      el.classList.toggle('is-tiny', s.w < 130);
    });
  }

  /** 小窗文案、面板开关、提示语随「谁在主画面」切换 */
  function applyLayoutUI() {
    const kneeInset = state.layout === 'body';
    bodyEls.forEach(function (el) {
      if (!el) return;
      const sc = el.querySelector('.body-inset-scene');
      const ti = el.querySelector('.body-inset-title');
      const su = el.querySelector('.body-inset-sub');
      if (sc) sc.textContent = kneeInset ? '膝关节特写' : '全身人体';
      if (ti) ti.textContent = kneeInset ? '受力关节特写' : '全身姿态';
      if (su) su.textContent = kneeInset ? '点击空白处切换主视角' : '点击切回人体主视角';
    });
    const hint = document.getElementById('stage-hint');
    if (hint) {
      hint.textContent = kneeInset
        ? '拖拽旋转人体 · 右上角小窗可拖拽查看膝关节 · 点击小窗空白切换主视角'
        : '拖拽旋转膝关节 · 滚轮缩放 · 点击右上角全身小窗切回人体主视角';
    }
    const row = document.getElementById('body-toggle-row');
    if (row) row.hidden = !kneeInset;
    const label = document.getElementById('body-toggle-label');
    if (label) label.textContent = kneeInset ? '显示膝关节特写' : '显示全身小窗';
    const tip = document.getElementById('body-tip');
    if (tip) {
      tip.textContent = kneeInset
        ? '主画面为真实人体解剖模型，可拖拽旋转查看姿态与场景；右上角小窗是正在仿真的膝关节特写，可拖拽旋转、滚轮缩放，角度与全身实时联动，点击部件可查看解剖说明。'
        : '主画面为膝关节受力特写，可拖拽旋转、滚轮缩放，人体小窗视角实时跟随；点击右上角全身小窗即可切回人体主视角。';
    }
  }

  /** 点击点是否落在右上角小窗内（CSS px，画布坐标） */
  function pointInInset(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return insetSpecs.some(function (s) {
      return x >= s.left && x <= s.left + s.w && y >= s.top && y <= s.top + s.h;
    });
  }

  /** 对调主画面与小窗：人体主视角 ⇄ 膝关节主视角 */
  function swapLayout() {
    state.layout = state.layout === 'body' ? 'knee' : 'body';
    swapLockUntil = Date.now() + 300;   // 同一次点击的拾取器与对调监听只会生效一次
    if (!state.body) {
      state.body = true;
      const t = document.getElementById('body-toggle');
      if (t) t.checked = true;
    }
    if (controls) controls.enabled = state.layout === 'body';
    if (kneeControls) kneeControls.enabled = state.layout !== 'body';
    if (picker) picker.clear();
    ui.hidePart();
    applyLayoutUI();
    layout(true);
    renderer.domElement.style.cursor = 'grab';
  }

  /** 关节主视角下，点击右上角人体小窗切回人体主视角 */
  function bindLayoutSwap() {
    const el = renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', function (e) {
      const d = down;
      down = null;
      if (!d || e.button !== 0) return;
      if (Math.abs(e.clientX - d.x) > 6 || Math.abs(e.clientY - d.y) > 6) return;
      if (Date.now() < swapLockUntil) return;
      if (state.layout === 'knee' && pointInInset(e)) swapLayout();
    });
    el.addEventListener('pointermove', function (e) {
      if (e.buttons) return;
      if (pointInInset(e)) el.style.cursor = 'pointer';
      else if (state.layout === 'knee') el.style.cursor = 'grab';
    });
  }

  /* -----------------------------------------------------------------------
   * 鼠标落在主画面还是小窗 → 决定这次拖拽/滚轮转的是「人体」还是「膝关节」
   * 两个视图各有轨道控制器，任何时刻只激活指针所在的那一个；
   * 人体主画面时小窗内 = 膝关节，膝关节主画面时小窗以外 = 膝关节。
   * --------------------------------------------------------------------- */
  function routeOrbit(e) {
    if (!renderer || !controls || !kneeControls) return;
    if (e.target !== renderer.domElement) return;
    const overInset = state.body && pointInInset(e);
    const useKnee = state.layout === 'body' ? overInset : !overInset;
    orbitDriver = useKnee ? 'knee' : 'body';
    controls.enabled = state.layout === 'body' && !useKnee;
    kneeControls.enabled = useKnee;
  }

  function bindOrbitRouting() {
    // 用捕获阶段先于轨道控制器自带的监听执行，确保只有正确的控制器响应
    window.addEventListener('pointerdown', routeOrbit, true);
    window.addEventListener('wheel', routeOrbit, { capture: true, passive: true });
  }

  function bindResize() {
    let t = null;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { layout(false); }, 120);
    });
    // 容器尺寸变化（侧栏滚动条出现等）
    if (window.ResizeObserver) {
      new ResizeObserver(function () { layout(false); }).observe(document.getElementById('canvas-wrap'));
    }
  }

  /* =======================================================================
   * 四、主循环
   * ===================================================================== */
  let readoutAcc = 0;
  let lastPartLabel = '—';

  function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;
    const split = state.view === 'split';

    /* ---- 1. 动作分配 ----
       单视图：跟随面板选择的姿态
       分屏：左视图固定正确姿态，右视图固定错误姿态 */
    const keyA = split ? KneeAnim.keyOf(state.mode, 'correct') : currentKey();
    const keyB = KneeAnim.keyOf(state.mode, 'wrong');

    ensureClip(views[0], keyA);
    if (split) ensureClip(views[1], keyB);

    /* ---- 2. 推进动画 ----
       分屏时右视图不自行计时，而是跟随左视图的归一化进度，保证严格同步 */
    views[0].anim.speed = state.speed;
    views[0].anim.playing = state.playing;
    views[0].anim.update(dt);

    if (split) {
      views[1].anim.speed = state.speed;
      views[1].anim.playing = false;
      views[1].anim.syncTo(views[0].anim.normalized);
    }

    /* ---- 3. 应力采样 + 热力材质更新 ---- */
    let maxStress = 0;
    let partLabel = '—';
    const active = split ? views : [views[0]];
    active.forEach(function (v) {
      const map = KneeAnim.sampleStress(v.anim.currentKey, v.anim.normalized);
      const m = v.stress.update(map, state.heat, time);
      if (m > maxStress) {
        maxStress = m;
        partLabel = v.stress.dominantPart(KneeUI.PART_LABEL);
      }
    });
    lastPartLabel = partLabel;

    /* ---- 3.5 主画面全身姿态：按同一动作与进度摆姿势 ---- */
    if (bodyViews.length) {
      bodyViews.forEach(function (bv, i) {
        const v = views[i];
        // 膝环用该视图的当前应力染色，分屏时左标准/右错误一眼可分
        const sMap = KneeAnim.sampleStress(v.anim.currentKey, v.anim.normalized);
        const sLevel = Math.max(sMap.meniscus_medial || 0, sMap.tibia_plateau || 0);
        bv.update(v.anim.currentKey, v.anim.normalized, state.heat ? sLevel : 0);
      });
    }

    /* ---- 3.6 场景名 badge（挂在本体主画面上） ---- */
    if (state.mode !== sceneBadgeMode) {
      sceneBadgeMode = state.mode;
      const badge = document.getElementById('scene-badge');
      if (badge) badge.textContent = window.KneeMotions.sceneOf(state.mode);
    }

    /* ---- 4. 相机跟随 + 同步 + 渲染 ---- */
    // 蹲起/跳跃时重心升降：目标点跟着走，相机平移同样的量，保留用户旋转角度
    if (controls && bodyViews.length) {
      const targetY = BODY_TARGET_Y + bodyViews[0].focusY * 0.6;
      const dy = targetY - controls.target.y;
      if (Math.abs(dy) > 0.0005) {
        controls.target.y = targetY;
        controls.object.position.y += dy;
      }
      controls.update();
    }

    /* ---- 4.5 膝关节视角与人体视角实时联动 ---- */
    syncKneeView();

    if (split && bodyViews.length > 1 && controls) {
      bodyViews[1].camera.position.copy(bodyViews[0].camera.position);
      bodyViews[1].camera.quaternion.copy(bodyViews[0].camera.quaternion);
      bodyViews[1].camera.projectionMatrix.copy(bodyViews[0].camera.projectionMatrix);
      bodyViews[1].camera.projectionMatrixInverse.copy(bodyViews[0].camera.projectionMatrixInverse);
    }

    render();

    /* ---- 5. 面板读数（限流 10Hz，避免频繁重排） ---- */
    readoutAcc += dt;
    if (readoutAcc > 0.1) {
      readoutAcc = 0;
      const angle = views[0].anim.flexionDeg;
      ui.setReadouts({
        clip: split ? '正误对比' : KneeAnim.labelOf(keyA),
        angle: angle,
        stress: maxStress,
        part: partLabel
      });
      // 力学证据：单视图读当前动作；分屏固定展示"错误侧"以突出损伤机制
      const mechClip = split ? KneeAnim.keyOf(state.mode, 'wrong') : keyA;
      ui.setMech(KneeBioMech.compute(mechClip, views[0].anim.normalized, angle));
      ui.setProgress(views[0].anim.normalized);
    }
  }

  /** 当前需要播放的动作（单视图按 模式 + 姿态 查表） */
  function currentKey() {
    return KneeAnim.keyOf(state.mode, state.pose);
  }

  /** 膝关节特写与人体视角实时同步：
   *  谁被拖拽谁做主，另一视角按相同的世界方位/俯仰跟随；
   *  两者各自保留自己的缩放距离（小窗缩放不影响人体取景）。 */
  function syncKneeView() {
    if (!controls || !kneeControls || !views.length || !bodyViews.length) return;
    const bv = bodyViews[0];
    const kv = views[0];
    if (!bv.homeQuat) bv.homeQuat = new THREE.Quaternion().copy(bv.camera.quaternion);

    if (orbitDriver === 'knee' && kneeControls.enabled) {
      kneeControls.update();
      _qDelta.copy(kv.camera.quaternion).multiply(_qInv.copy(kv.homeQuat).invert());
      _qDst.copy(_qDelta).multiply(bv.homeQuat);
      const d = bv.camera.position.distanceTo(controls.target);
      bv.camera.quaternion.copy(_qDst);
      bv.camera.position.copy(controls.target)
        .addScaledVector(_vBack.copy(_axisZ).applyQuaternion(_qDst), d);
      bv.camera.updateMatrixWorld();
    } else {
      _qDelta.copy(bv.camera.quaternion).multiply(_qInv.copy(bv.homeQuat).invert());
      _qDst.copy(_qDelta).multiply(kv.homeQuat);
      const d = kv.camera.position.distanceTo(kneeControls.target);
      kv.camera.quaternion.copy(_qDst);
      kv.camera.position.copy(kneeControls.target)
        .addScaledVector(_vBack.copy(_axisZ).applyQuaternion(_qDst), d);
      kv.camera.updateMatrixWorld();
    }

    // 分屏：右窗膝关节跟随左窗同一角度
    if (state.view === 'split' && views.length > 1) {
      views[1].camera.position.copy(kv.camera.position);
      views[1].camera.quaternion.copy(kv.camera.quaternion);
    }
  }

  /** 保证某视图正在播放指定动作；切换时保留进度，避免画面跳回起点 */
  function ensureClip(view, key) {
    if (!key) return;
    if (view.anim.currentKey === key) return;
    view.anim.setClip(key, {
      fade: 0.28,
      norm: view.anim.normalized,
      restart: false
    });
  }

  function render() {
    const size = canvasSize();
    if (!bodyViews.length || !views.length) return;
    const split = state.view === 'split';
    const bodyMain = state.layout === 'body';
    const mainSet = bodyMain ? bodyViews : views;
    const insetSet = bodyMain ? views : bodyViews;

    if (split && mainSet.length > 1) {
      const halfW = Math.floor(size.w / 2);
      renderer.setScissorTest(true);

      renderer.setViewport(0, 0, halfW, size.h);
      renderer.setScissor(0, 0, halfW, size.h);
      renderer.render(mainSet[0].scene, mainSet[0].camera);

      renderer.setViewport(halfW, 0, size.w - halfW, size.h);
      renderer.setScissor(halfW, 0, size.w - halfW, size.h);
      renderer.render(mainSet[1].scene, mainSet[1].camera);

      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size.w, size.h);
    } else {
      renderer.setViewport(0, 0, size.w, size.h);
      renderer.render(mainSet[0].scene, mainSet[0].camera);
    }

    renderInset(size, insetSet);
  }

  /** 在画布右上角（分屏时各自右上角）用小视口渲染画中画。
   *  谁当画中画由主视角决定：人体主视角 → 膝关节特写；关节主视角 → 全身人体。
   *  只清这一小块的颜色/深度，主画面不受影响；DOM 浮层负责边框和标题。 */
  function renderInset(size, set) {
    if (!state.body || !set.length) return;
    renderer.setScissorTest(true);
    insetSpecs.forEach(function (s) {
      const v = set[s.idx];
      if (!v) return;
      const y = size.h - s.top - s.h;
      v.camera.aspect = s.w / s.h;
      v.camera.updateProjectionMatrix();
      renderer.setViewport(s.left, y, s.w, s.h);
      renderer.setScissor(s.left, y, s.w, s.h);
      renderer.render(v.scene, v.camera);
    });
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.w, size.h);
  }

  /* =======================================================================
   * 五、图层显隐 / 透明度
   * ===================================================================== */
  function applyLayerStyle() {
    views.forEach(function (v) {
      KneeModel.LAYERS.forEach(function (layer) {
        const st = state.layers[layer.key];
        const meshes = v.model.parts[layer.key] || [];
        meshes.forEach(function (mesh) {
          mesh.visible = st.visible;

          // st.opacity 是绝对不透明度（UI 滑块直接给 0~1），不要再乘材质初值
          const base = st.opacity;
          mesh.userData.baseOpacity = base;      // 应力模块会以此为基准做半透红

          if (mesh.material) {
            // 热力部件必须保持 transparent（要显示半透红），不能在这里被关掉
            mesh.material.transparent = mesh.userData.heatTarget ? true : (base < 0.999);
            mesh.material.opacity = base;
            mesh.material.depthWrite = base > 0.55;
            mesh.material.needsUpdate = false;
          }
        });
      });
    });
  }

  /* =======================================================================
   * 六、UI 回调
   * ===================================================================== */
  function buildActions() {
    return {
      setMode: function (mode) {
        state.mode = mode;
        // 先切动作，再换文案，保证两者对应
        if (views.length) {
          ensureClip(views[0], currentKey());
          ensureClip(views[1], KneeAnim.keyOf(state.mode, 'wrong'));
        }
        // 换动作时回到该动作的默认机位（踢球用侧向机位）
        if (bodyViews.length) refitBodyCameras();
        ui.setScience(currentKey());
        ui.setPose(state.pose);
      },

      setPose: function (pose) {
        state.pose = pose;
        if (views.length) ensureClip(views[0], currentKey());
        ui.setScience(currentKey());
      },

      togglePlay: function () {
        state.playing = !state.playing;
        ui.setPlaying(state.playing);
      },

      reset: function () {
        state.playing = true;
        views.forEach(function (v) {
          v.anim.reset();
          v.stress.reset();
          v.anim.speed = state.speed;
        });
        ui.setPlaying(true);
        ui.setReadouts({ angle: 0, stress: 0, part: '—' });
      },

      seek: function (n) {
        state.playing = false;
        ui.setPlaying(false);
        views[0].anim.setNormalized(n);
        if (state.view === 'split') views[1].anim.syncTo(views[0].anim.normalized);
      },

      setSpeed: function (v) {
        state.speed = v;
        views.forEach(function (v2) { v2.anim.speed = v; });
      },

      setView: function (view) {
        state.view = view;
        layout(true);
        ui.setView(view);
      },

      setLayerVisible: function (key, visible) {
        if (state.layers[key]) state.layers[key].visible = visible;
        applyLayerStyle();
        if (picker) picker.clear();
      },

      setLayerOpacity: function (key, opacity) {
        if (state.layers[key]) state.layers[key].opacity = opacity;
        applyLayerStyle();
      },

      setAllLayers: function () {
        KneeModel.LAYERS.forEach(function (l) {
          state.layers[l.key] = { visible: true, opacity: 1 };
        });
        applyLayerStyle();
      },

      soloBones: function () {
        // 只看骨性结构：隐藏半月板与韧带，方便讲解剖
        state.layers.meniscus.visible = false;
        state.layers.ligament.visible = false;
        applyLayerStyle();
        if (picker) picker.clear();
        ui.hidePart();
      },

      setHeat: function (on) {
        state.heat = on;
        ui.setHeat(on);
        if (!on) views.forEach(function (v) { v.stress.reset(); });
      },

      setBody: function (on) {
        state.body = on;
        if (!bodyViews.length) return;
        updateInsetSpecs(canvasSize());
        layout(false);
      },

      clearPick: function () {
        if (picker) picker.clear();
      }
    };
  }

  return { boot: boot, state: state, get views() { return views; }, get bodyViews() { return bodyViews; } };
})();

/* 页面就绪后启动 */
window.addEventListener('DOMContentLoaded', function () {
  KneeApp.boot();
});
