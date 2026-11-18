/* =========================================================================
 * bodyFigure.js —— 全身姿态示意（画中画）
 * -------------------------------------------------------------------------
 * 作用：主画布里的膝关节是「局部特写」，单独看会不知道它长在身体的哪个位置、
 *       当前动作全身是什么姿态。本模块在画布右上角渲染一个**真实人体解剖模型**
 *       （écorché：浅层肌肉 + 骨骼，来自 human-atlas / BodyParts3D），按当前
 *       模式 / 姿态 / 归一化时间摆出 15 类动作，右膝用高亮环标出，并叠加负重力线。
 *
 * 实现要点：
 *   - 真实人体 = THREE.SkinnedMesh + 17 根骨骼的线性混合蒙皮（资产 human.json/bin）；
 *     资产异步加载，加载期间 / 失败时回退到程序化「玻璃人」，保证开箱即用、永不白屏；
 *   - 两套骨架共用同一组「关节手柄」接口（hips/spine/head/right{hip,knee,ankle}/…），
 *     因此 update() 的姿态逻辑对玻璃人与真实人体完全一致；
 *   - 姿态曲线统一由 motions.js 的 bodyOf() 提供（30 段），与主视图共用归一化时间 t；
 *   - 负重力线（髋→膝→踝机械轴 + 竖直重力参考）用关节世界坐标实时绘制，
 *     膝偏离量映射为标记颜色，直观解释「膝内扣 → 内侧应力集中」的几何原因。
 * ======================================================================= */

window.KneeBody = (function () {
  'use strict';

  /* 玻璃人尺寸（单位：m，回退方案用） */
  const HIP_Y = 0.95;
  const THIGH = 0.43;
  const SHIN = 0.43;
  const TORSO = 0.52;
  const UPPER_ARM = 0.30;
  const FOREARM = 0.27;

  const COL = {
    body: 0x9fc7d8,
    bodyDeep: 0x5b93ad,
    joint: 0x3f7e99,
    bone: 0x2a5c74,
    knee: 0xffb347,
    kneeGlow: 0xff8a3d
  };

  /* ---------------- 关键帧插值（smoothstep，动作不生硬） ---------------- */
  function curve(keys, t) {
    if (!keys || !keys.length) return 0;
    if (t <= keys[0][0]) return keys[0][1];
    const last = keys[keys.length - 1];
    if (t >= last[0]) return last[1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const a = keys[i - 1], b = keys[i];
        const f = (t - a[0]) / Math.max(b[0] - a[0], 1e-6);
        const s = f * f * (3 - 2 * f);
        return a[1] + (b[1] - a[1]) * s;
      }
    }
    return last[1];
  }

  /* ---------------- 几何小工具（玻璃人回退用） ---------------- */
  function capsule(radius, length, mat, seg) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(length - radius * 2, 0.01), seg || 10), mat);
    g.add(body);
    const capA = new THREE.Mesh(new THREE.SphereGeometry(radius, seg || 10, 7), mat);
    capA.position.y = (length - radius * 2) / 2;
    const capB = capA.clone();
    capB.position.y = -capA.position.y;
    g.add(capA, capB);
    return g;
  }
  function ball(r, mat) { return new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), mat); }
  function limbDown(radius, len, mat) {
    const c = capsule(radius, len, mat);
    c.position.y = -len / 2;
    return c;
  }

  /* ---------------- 玻璃人（回退方案） ---------------- */
  function buildFigure(highlight) {
    const root = new THREE.Group();
    const skin = new THREE.MeshPhysicalMaterial({
      color: COL.body, roughness: 0.42, metalness: 0.0,
      transparent: true, opacity: 0.48, depthWrite: false,
      side: THREE.DoubleSide, clearcoat: 0.25
    });
    const skinDeep = skin.clone();
    skinDeep.color.setHex(COL.bodyDeep);
    skinDeep.opacity = 0.55;
    const jointMat = new THREE.MeshStandardMaterial({
      color: COL.joint, roughness: 0.4, transparent: true, opacity: 0.82, depthWrite: false
    });

    const hips = new THREE.Group();
    hips.position.y = HIP_Y;
    root.add(hips);
    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 9), skinDeep);
    pelvis.scale.set(1.18, 0.68, 0.78);
    hips.add(pelvis);

    const spine = new THREE.Group();
    hips.add(spine);
    const torso = capsule(0.15, TORSO, skin, 12);
    torso.position.y = TORSO / 2;
    torso.scale.z = 0.68;
    spine.add(torso);
    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), skin);
    chest.position.y = TORSO * 0.78;
    chest.scale.set(1.25, 0.7, 0.7);
    spine.add(chest);

    const head = new THREE.Group();
    head.position.y = TORSO + 0.10;
    spine.add(head);
    head.add(ball(0.115, skin));
    head.children[0].scale.set(0.92, 1.05, 0.95);
    const neck = capsule(0.052, 0.13, skinDeep, 8);
    neck.position.y = -0.10;
    head.add(neck);

    function makeLeg(side, isHighlight) {
      const hip = new THREE.Group();
      hip.position.set(0.105 * side, 0, 0);
      hips.add(hip);
      hip.add(ball(0.075, jointMat));
      hip.add(limbDown(0.10, THIGH, skin, 11));
      const knee = new THREE.Group();
      knee.position.y = -THIGH;
      hip.add(knee);
      knee.add(ball(0.072, jointMat));
      if (isHighlight) attachHighlight(knee);
      knee.add(limbDown(0.078, SHIN, skin, 11));
      const ankle = new THREE.Group();
      ankle.position.y = -SHIN;
      knee.add(ankle);
      ankle.add(ball(0.055, jointMat));
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.055, 0.21), skinDeep);
      foot.position.set(0, -0.028, 0.062);
      ankle.add(foot);
      return { hip: hip, knee: knee, ankle: ankle };
    }
    const right = makeLeg(1, true);
    const left = makeLeg(-1, false);

    function makeArm(side) {
      const shoulder = new THREE.Group();
      shoulder.position.set(0.19 * side, TORSO * 0.88, 0);
      spine.add(shoulder);
      shoulder.add(ball(0.06, jointMat));
      shoulder.add(limbDown(0.068, UPPER_ARM, skin, 9));
      const elbow = new THREE.Group();
      elbow.position.y = -UPPER_ARM;
      shoulder.add(elbow);
      elbow.add(ball(0.05, jointMat));
      elbow.add(limbDown(0.055, FOREARM, skinDeep, 9));
      const hand = ball(0.058, skin);
      hand.position.y = -FOREARM;
      elbow.add(hand);
      return { shoulder: shoulder, elbow: elbow };
    }
    const armR = makeArm(1);
    const armL = makeArm(-1);

    // 脚底采样点（踝关节局部）：落地约束用最低点判断是否触地
    const GLASS_SOLE = [
      [0, -0.0555, 0.15], [0, -0.0555, -0.03],
      [0.04, -0.0555, 0.06], [-0.04, -0.0555, 0.06]
    ];
    const _soleV = new THREE.Vector3();
    function soleY() {
      let m = Infinity;
      [right.ankle, left.ankle].forEach(function (a) {
        GLASS_SOLE.forEach(function (p) {
          _soleV.set(p[0], p[1], p[2]);
          a.localToWorld(_soleV);
          if (_soleV.y < m) m = _soleV.y;
        });
      });
      return m;
    }

    return { root: root, hips: hips, spine: spine, head: head, right: right, left: left, armR: armR, armL: armL, soleY: soleY };
  }

  /** 在膝关节手柄上挂高亮环 + 光晕（玻璃人与真实人体共用） */
  function attachHighlight(kneeHandle) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.105, 0.014, 8, 24),
      new THREE.MeshBasicMaterial({ color: COL.knee, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false })
    );
    ring.rotation.x = Math.PI / 2;
    ring.renderOrder = 11;
    kneeHandle.add(ring);
    const halo = ball(0.095, new THREE.MeshBasicMaterial({
      color: COL.kneeGlow, transparent: true, opacity: 0.20, depthWrite: false, depthTest: false
    }));
    halo.renderOrder = 10;
    kneeHandle.add(halo);
    kneeHandle.userData.highlight = { ring: ring, halo: halo };
  }

  /* =======================================================================
   * 真实人体资产：异步加载 + 解析（模块级缓存，两个小窗共享同一份几何）
   * ===================================================================== */
  let _assetPromise = null;
  function loadAsset() {
    if (_assetPromise) return _assetPromise;
    _assetPromise = fetch('assets/models/human.json?v=20261117m')
      .then(function (r) { if (!r.ok) throw new Error('human.json ' + r.status); return r.json(); })
      .then(function (meta) {
        return fetch('assets/models/human.bin?v=20261117m')
          .then(function (r) { if (!r.ok) throw new Error('human.bin ' + r.status); return r.arrayBuffer(); })
          .then(function (buf) { return parseAsset(meta, buf); });
      })
      .catch(function () {
        // file:// 双击打开时 fetch 被浏览器禁止：改走内嵌 base64 脚本
        return window.KneeEmbed.load('assets/models/human-data.js?v=20261117m', '__HUMAN_EMBED__')
          .then(function (em) { return parseAsset(em.meta, window.KneeEmbed.b64ToBuf(em.b64)); });
      });
    return _assetPromise;
  }

  /* 源模型里夹带若干 <100 顶点的小岛（左右前臂、胸口的游离碎片）：
   * 蒙皮后它们随单骨刚性移动、从体表弹出，像“两块肌肉掉下来”。
   * 它们是切面残留，剔除其三角形即可，主体是封闭曲面不受影响。 */
  function stripIslets(geom) {
    const idx = geom.index.array;
    const N = geom.attributes.position.count;
    const par = new Int32Array(N);
    for (let i = 0; i < N; i++) par[i] = i;
    function find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
    for (let i = 0; i < idx.length; i += 3) {
      let a = find(idx[i]), b = find(idx[i + 1]);
      if (a !== b) par[a] = b;
      a = find(idx[i + 1]); b = find(idx[i + 2]);
      if (a !== b) par[a] = b;
    }
    const size = new Int32Array(N);
    for (let i = 0; i < N; i++) size[find(i)]++;
    const keep = [];
    for (let i = 0; i < idx.length; i += 3) {
      if (size[find(idx[i])] >= 100) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    }
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(keep), 1));
  }

  function parseAsset(meta, buf) {
    const vc = meta.vertexCount, ic = meta.indexCount, o = meta.offsets;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, o.positions, vc * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int16Array(buf, o.normals, vc * 3), 3, true));
    // bin 里存的是 sRGB 色；渲染器输出 sRGB + ACES，顶点色需先转线性，否则肌肉发粉白
    const cRaw = new Uint8Array(buf, o.colors, vc * 3);
    const cLin = new Float32Array(vc * 3);
    for (let i = 0; i < vc * 3; i++) {
      const c = cRaw[i] / 255;
      cLin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    g.setAttribute('color', new THREE.BufferAttribute(cLin, 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint8Array(buf, o.skinIndex, vc * 4), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(new Uint8Array(buf, o.skinWeight, vc * 4), 4, true));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, o.indices, ic), 1));
    stripIslets(g);
    g.computeBoundingSphere();
    return { geometry: g, boneDefs: meta.bones, bounds: meta.bounds };
  }

  /** 用共享几何构建一具独立骨架的真实人体，挂到 container（=fig.root）下 */
  function buildHuman(asset, container, highlight) {
    const defs = asset.boneDefs;
    const bones = defs.map(function (d) {
      const b = new THREE.Bone();
      b.name = d.name;
      b.position.fromArray(d.pos);
      return b;
    });
    const byName = {};
    bones.forEach(function (b) { byName[b.name] = b; });
    defs.forEach(function (d, i) {
      if (d.parent && byName[d.parent]) byName[d.parent].add(bones[i]);
    });

    // 先在原点临时根下算出骨骼世界矩阵，供 Skeleton 求骨逆矩阵
    const tmp = new THREE.Group();
    tmp.add(bones[0]);
    tmp.updateMatrixWorld(true);
    const footBind = {};
    ['footR', 'footL'].forEach(function (n) {
      footBind[n] = new THREE.Vector3();
      byName[n].getWorldPosition(footBind[n]);
    });
    const skeleton = new THREE.Skeleton(bones);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.58, metalness: 0.0, side: THREE.DoubleSide
    });
    const mesh = new THREE.SkinnedMesh(asset.geometry, mat);
    mesh.add(bones[0]);
    mesh.updateMatrixWorld(true);
    mesh.bind(skeleton);          // bindMatrix = 单位阵（此时 mesh 仍在原点）
    mesh.frustumCulled = false;   // 变形后包围球不准，小窗里直接关掉剔除
    container.add(mesh);

    if (highlight) attachHighlight(byName.shinR);

    // 脚底四点（脚跟/脚掌/内外侧）在对应 foot 骨局部坐标下的位置：
    // 绑定时网格在原点，骨矩阵×骨逆矩阵即为蒙皮矩阵，可精确跟随踝关节旋转
    const SOLE_OFF = [[0, -0.068, 0.13], [0, -0.068, -0.04], [0.04, -0.068, 0.06], [-0.04, -0.068, 0.06]];
    const footSoles = ['footR', 'footL'].map(function (n) {
      const bone = byName[n];
      const inv = skeleton.boneInverses[bones.indexOf(bone)];
      const pts = SOLE_OFF.map(function (o) {
        return new THREE.Vector3(
          footBind[n].x + o[0], footBind[n].y + o[1], footBind[n].z + o[2]
        ).applyMatrix4(inv);
      });
      return { bone: bone, pts: pts };
    });
    const _soleV = new THREE.Vector3();
    function soleY() {
      let m = Infinity;
      footSoles.forEach(function (f) {
        f.pts.forEach(function (p) {
          _soleV.copy(p).applyMatrix4(f.bone.matrixWorld);
          if (_soleV.y < m) m = _soleV.y;
        });
      });
      return m;
    }
    // 逐点贴地：按每个脚底点自身位置的支撑面高度求最大抬升量，
    // 斜坡上脚掌不能只看最低点（前后脚掌下方的坡面高度不同）
    function soleShift(surfAt) {
      let sh = -Infinity;
      footSoles.forEach(function (f) {
        f.pts.forEach(function (p) {
          _soleV.copy(p).applyMatrix4(f.bone.matrixWorld);
          const d = surfAt(_soleV.z) - _soleV.y;
          if (d > sh) sh = d;
        });
      });
      return sh;
    }

    // 关节手柄 → 骨骼（与玻璃人同名同语义，update() 无需区分）
    return {
      root: container,
      hips: byName.hips,
      spine: byName.spine,
      head: byName.head,
      right: { hip: byName.legR, knee: byName.shinR, ankle: byName.footR },
      left: { hip: byName.legL, knee: byName.shinL, ankle: byName.footL },
      armR: { shoulder: byName.armR, elbow: byName.foreR },
      armL: { shoulder: byName.armL, elbow: byName.foreL },
      handR: byName.handR, handL: byName.handL,
      soleY: soleY,
      soleShift: soleShift,
      // 大腿/小腿骨长（含容器缩放），供骑行踩踏 IK 使用
      legLen: (function () {
        const defByName = {};
        defs.forEach(function (d) { defByName[d.name] = d; });
        const s = container.scale.x;
        return {
          thigh: new THREE.Vector3().fromArray(defByName.shinR.pos).length() * s,
          shin: new THREE.Vector3().fromArray(defByName.footR.pos).length() * s
        };
      })(),
      isHuman: true
    };
  }

  /* ---------------- 对外：创建一个全身示意视图 ---------------- */
  function create(highlight) {
    const wantHighlight = highlight !== false;
    const scene = new THREE.Scene();
    const fig = buildFigure(wantHighlight);   // 立即可用的玻璃人回退
    scene.add(fig.root);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c9d5, 0.45));
    const key = new THREE.DirectionalLight(0xffffff, 0.72);
    key.position.set(2.5, 4, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xd8ecff, 0.35);
    rim.position.set(-3, 1, -3);
    scene.add(rim);
    const fill = new THREE.DirectionalLight(0xffe9cf, 0.18);
    fill.position.set(-2, -1, 3);
    scene.add(fill);

    /* --- 负重力线（生物力学核心可视化）--- */
    const _cylUp = new THREE.Vector3(0, 1, 0);
    function makeRod(color, radius) {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 1, 8),
        new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.92, depthTest: false })
      );
      m.renderOrder = 10;
      scene.add(m);
      return m;
    }
    function setRod(mesh, a, b) {
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.scale.set(1, Math.max(len, 0.001), 1);
      mesh.quaternion.setFromUnitVectors(_cylUp, dir.normalize());
    }
    const rodUpper = makeRod(0x156a8a, 0.011);
    const rodLower = makeRod(0x156a8a, 0.011);
    const axisMat = rodUpper.material;

    const devMarker = ball(0.024, new THREE.MeshBasicMaterial({
      color: 0xf0322a, transparent: true, opacity: 0.95, depthTest: false
    }));
    devMarker.renderOrder = 12;
    scene.add(devMarker);

    function worldPos(obj, out) { obj.getWorldPosition(out); return out; }

    const camera = new THREE.PerspectiveCamera(34, 0.72, 0.05, 30);
    const CAM = { x: 2.35, y: 1.35, z: -3.15, look: 0.78 };
    // 踢球摆腿平面朝 -Z：用偏侧机位避免大腿正对镜头缩成一团
    const KICK_CAM = { x: 3.6, y: 1.25, z: -1.7, look: 0.8 };
    camera.position.set(CAM.x, CAM.y, CAM.z);
    camera.lookAt(0, CAM.look, 0);
    fig.root.scale.setScalar(0.92);

    /* --- 场景化道具：按动作模式切换，挂在场景根（不随人体缩放）--- */
    const sceneHolder = new THREE.Group();
    scene.add(sceneHolder);
    let curKit = null, curMode = null;
    function swapScene(mode) {
      if (mode === curMode) return;
      curMode = mode;
      if (curKit && window.KneeScene) window.KneeScene.dispose(curKit);
      while (sceneHolder.children.length) sceneHolder.remove(sceneHolder.children[0]);
      curKit = window.KneeScene ? window.KneeScene.get(mode) : null;
      if (curKit) sceneHolder.add(curKit.root);
    }

    /* --- 当前生效的骨架：先玻璃人，真实人体加载完成后无缝替换 --- */
    let rig = fig;
    loadAsset().then(function (asset) {
      // 释放玻璃人几何/材质，避免 GPU 资源泄漏
      fig.root.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
      });
      while (fig.root.children.length) fig.root.remove(fig.root.children[0]);
      rig = buildHuman(asset, fig.root, wantHighlight);
    }).catch(function (err) {
      console.warn('[bodyFigure] 真实人体加载失败，沿用玻璃人回退：', err && err.message ? err.message : err);
    });

    const DEFAULT_BODY = window.KneeMotions.bodyOf('anim_squat_correct');

    function update(clipKey, t, stressLevel) {
      const c = window.KneeMotions.bodyOf(clipKey) || DEFAULT_BODY;
      swapScene(window.KneeMotions.modeOf(clipKey));
      const phase = c.phase || 0;
      const tL = (t + phase) % 1;
      const tR = t;

      const hipR = curve(c.hip, tR), kneeR = curve(c.knee, tR), ankR = curve(c.ankle, tR);
      // 对侧腿：有 other 曲线（弓步/硬拉/踢球等不对称动作）用它，否则按相位差复用同曲线
      const o = c.other;
      const hipL = o ? curve(o.hip, t) : curve(c.hip, tL);
      const kneeL = o ? curve(o.knee, t) : curve(c.knee, tL);
      const ankL = o ? curve(o.ankle, t) : curve(c.ankle, tL);
      const spread = curve(c.hipSpread, t);
      const valgus = c.valgus ? curve(c.valgus, t) : 0;
      const lean = curve(c.lean, t);
      const sideLean = c.sideLean ? curve(c.sideLean, t) : 0;

      rig.root.position.y = curve(c.rootY, t);
      rig.root.position.z = c.rootZ ? curve(c.rootZ, t) : 0;
      // 模型脸朝 +Z，而髋屈曲把腿摆向 -Z：根部转 π 使脸与运动方向一致（道具 FWD=-Z 即正前方）
      rig.root.rotation.y = Math.PI + (c.turn ? curve(c.turn, t) : 0);

      // 躯干前倾 / 侧倾
      rig.spine.rotation.x = lean;
      rig.spine.rotation.z = sideLean + valgus * 0.35;

      // 目标腿（右）：与主视图股骨/胫骨角度一致
      rig.right.hip.rotation.x = hipR;
      rig.right.hip.rotation.z = spread + valgus;
      rig.right.knee.rotation.x = kneeR;
      rig.right.knee.rotation.z = -valgus * 0.8;
      rig.right.ankle.rotation.x = ankR;

      // 对侧腿
      rig.left.hip.rotation.x = hipL;
      rig.left.hip.rotation.z = -spread;
      rig.left.knee.rotation.x = kneeL;
      rig.left.knee.rotation.z = 0;
      rig.left.ankle.rotation.x = ankL;

      // 手臂：按 armMode 区分前平举 / 摆动 / 侧展平衡 / 持握
      const armMode = c.armMode || 'forward';
      const armRv = curve(c.arm, tR);
      const armLv = curve(c.arm, tL);
      const elbow = c.elbow === undefined ? -0.35 : c.elbow;
      if (armMode === 'balance') {
        rig.armR.shoulder.rotation.x = armRv * 0.4;
        rig.armL.shoulder.rotation.x = armLv * 0.4;
        rig.armR.shoulder.rotation.z = -0.72 - Math.abs(armRv) * 0.25;
        rig.armL.shoulder.rotation.z = 0.72 + Math.abs(armLv) * 0.25;
      } else {
        rig.armR.shoulder.rotation.x = armRv;
        rig.armL.shoulder.rotation.x = armLv;
        rig.armR.shoulder.rotation.z = -0.12;
        rig.armL.shoulder.rotation.z = 0.12;
      }
      rig.armR.elbow.rotation.x = elbow;
      rig.armL.elbow.rotation.x = elbow;
      rig.head.rotation.x = -lean * 0.45;

      const modeId = window.KneeMotions.modeOf(clipKey);
      const isStair = modeId === 'stairsUp' || modeId === 'stairsDown';
      const isSlope = !isStair && (modeId === 'uphill' || modeId === 'downhill') &&
        curKit && curKit.surfaceAt;

      /* --- 两连杆矢状面逆解：给定踝点目标（世界系），解髋/膝/踝角。
             骨骼局部有少量偏移，一轮解析解差 1–2cm：按实测踝点残差修正再解一次。 --- */
      function ikLeg(leg, wantY, wantZ, extraAnkle) {
        const L1 = rig.legLen.thigh, L2 = rig.legLen.shin;
        rig.root.updateMatrixWorld(true);
        const hipW = worldPos(leg.hip, new THREE.Vector3());
        let ty = wantY, tz = wantZ;
        for (let it = 0; it < 2; it++) {
          const down = hipW.y - ty, fwd = hipW.z - tz;
          let d = Math.sqrt(down * down + fwd * fwd);
          d = Math.min((L1 + L2) * 0.995, Math.max(Math.abs(L1 - L2) + 0.015, d));
          const delta = Math.atan2(fwd, down);
          const cb = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
          const ci = Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2)));
          const A = delta + Math.acos(cb);          // 大腿前摆角
          const flex = Math.PI - Math.acos(ci);     // 膝屈角
          const B = A - flex;                       // 小腿前摆角
          leg.hip.rotation.x = -A;
          leg.knee.rotation.x = flex;
          leg.ankle.rotation.x = B - 0.10 + (extraAnkle || 0);
          if (it === 0) {
            rig.root.updateMatrixWorld(true);
            const ank = worldPos(leg.ankle, new THREE.Vector3());
            ty -= ank.y - wantY;
            tz -= ank.z - wantZ;
          }
        }
      }

      /* --- 骑行踩踏 IK：曲柄圆周与车架共用 cycleFit/cyclePedal，
             脚掌由两连杆逆解精确落在踏板上（含踝部抬高的 6cm 踏面偏移），
             膝角随曲柄相位自然变化，而不是靠手调曲线。 --- */
      if (modeId === 'cycle' && rig.legLen && window.KneeScene && window.KneeScene.cycleFit) {
        rig.root.updateMatrixWorld(true);
        const hipsW = worldPos(rig.hips, new THREE.Vector3());
        const fit = window.KneeScene.cycleFit(hipsW);
        const C = window.KneeScene.CYCLE;
        const phi = t * Math.PI * 2;
        [rig.right, rig.left].forEach(function (leg, i) {
          const ped = window.KneeScene.cyclePedal(fit, phi + i * Math.PI);
          ikLeg(leg, ped.y + C.ankleUp, ped.z + C.ankleBack);
        });
        rig.root.updateMatrixWorld(true);
      }

      /* --- 楼梯 IK：脚踝目标由梯链几何直接给出（sceneKit.stairFoot），
             支撑脚随踏面滚动、摆动脚抬回下一级，脚-踏面严格贴合。 --- */
      if (isStair && rig.legLen && window.KneeScene && window.KneeScene.stairFoot) {
        const dir = modeId === 'stairsUp' ? 1 : -1;
        [rig.right, rig.left].forEach(function (leg, i) {
          const tgt = window.KneeScene.stairFoot(t, i, dir);
          ikLeg(leg, tgt.y, tgt.z);
        });
        rig.root.updateMatrixWorld(true);
      }

      /* --- 斜坡 IK：上坡用"支撑脚沿坡面后移、摆动脚抬起前摆"的步态目标，
             下坡保留按姿态贴坡。先把骨盆压到支撑腿微屈的高度（否则根部起伏
             让支撑腿够不到目标，落地约束又会把抬脚高度吃掉），解完再贴一次坡。 --- */
      if (isSlope && rig.legLen) {
        const tilt = curKit.ankleTilt || 0;
        if (curKit.footAt) {
          const tg = [0, 1].map(function (i) { return curKit.footAt(t, i, curKit.surfaceAt); });
          const hipW = worldPos(rig.right.hip, new THREE.Vector3());
          const stanceY = Math.min(tg[0].y, tg[1].y);
          const wantHip = stanceY + 0.72;
          if (hipW.y > wantHip) {
            rig.root.position.y -= hipW.y - wantHip;
            rig.root.updateMatrixWorld(true);
          }
          [rig.right, rig.left].forEach(function (leg, i) {
            ikLeg(leg, tg[i].y, tg[i].z, tilt);
          });
          rig.root.updateMatrixWorld(true);
        } else {
          [rig.right, rig.left].forEach(function (leg) {
            rig.root.updateMatrixWorld(true);
            const ank = worldPos(leg.ankle, new THREE.Vector3());
            const surf = curKit.surfaceAt(ank.z);
            const lift = Math.max(0, ank.y - (surf + 0.078));
            ikLeg(leg, surf + 0.078 + lift, ank.z, tilt);
          });
          rig.root.updateMatrixWorld(true);
        }
        if (rig.soleShift) {
          rig.root.position.y += rig.soleShift(curKit.surfaceAt);
          rig.root.updateMatrixWorld(true);
        }
      }

      // 斜坡：脚掌随坡面微调俯仰（正负号按骨骼 +x 旋转方向确定）
      if (curKit && curKit.ankleTilt && !isStair && !isSlope) {
        rig.right.ankle.rotation.x += curKit.ankleTilt;
        rig.left.ankle.rotation.x += curKit.ankleTilt;
      }

      /* --- 落地约束：脚底各点贴住支撑面（平地/斜坡）——身体不再悬空或陷入地面。
         跳跃类动作在腾空段（rootY > 0.03）保留腾空高度，落地帧仍被压回地面；
         骑行/楼梯例外：脚由 IK 精确落在踏面/踏板上，身体不再兜底贴地。 --- */
      const authoredY = curve(c.rootY, t);
      const airborne = (modeId === 'jump' || modeId === 'hop') && authoredY > 0.03;
      if (modeId !== 'cycle' && !isStair && !isSlope && rig.soleY) {
        const groundY = (curKit && curKit.surface) || 0;
        const surfAt = (curKit && curKit.surfaceAt) || function () { return groundY; };
        rig.root.updateMatrixWorld(true);
        if (airborne) {
          const soleY = rig.soleY();
          if (soleY < groundY) rig.root.position.y += groundY - soleY;
        } else {
          const shift = rig.soleShift ? rig.soleShift(surfAt) : groundY - rig.soleY();
          rig.root.position.y += shift;
          rig.root.updateMatrixWorld(true);
          // 弓步/深蹲等深姿态：膝关节同样不能插入地面
          const kR = worldPos(rig.right.knee, new THREE.Vector3());
          const kL = worldPos(rig.left.knee, new THREE.Vector3());
          const kNear = kR.y <= kL.y ? kR : kL;
          const kneeDeficit = kNear.y - 0.055 - surfAt(kNear.z);
          if (kneeDeficit < 0) rig.root.position.y -= kneeDeficit;
        }
      }

      // 高亮环随主视图应力变化：橙 → 红，光晕同步增强
      const hl = rig.right.knee.userData.highlight;
      if (hl) {
        const s = Math.max(0, Math.min(1, stressLevel || 0));
        const col = new THREE.Color(COL.knee).lerp(new THREE.Color(0xf0322a), s);
        hl.ring.material.color.copy(col);
        hl.halo.material.color.copy(col);
        hl.halo.material.opacity = 0.18 + s * 0.5;
        const pulse = 1 + s * 0.18 * (0.6 + 0.4 * Math.sin(performance.now() * 0.006));
        hl.ring.scale.setScalar(pulse);
      }

      // --- 负重力线：用关节世界坐标，确保与姿态严格一致 ---
      rig.root.updateMatrixWorld(true);
      const pHip = worldPos(rig.right.hip, new THREE.Vector3());
      const pKnee = worldPos(rig.right.knee, new THREE.Vector3());
      const pAnk = worldPos(rig.right.ankle, new THREE.Vector3());
      setRod(rodUpper, pHip, pKnee);
      setRod(rodLower, pKnee, pAnk);

      const devX = Math.abs(pKnee.x - pHip.x);
      devMarker.position.set(pKnee.x, pKnee.y, pKnee.z);
      const devRatio = Math.min(1, devX / 0.16);
      devMarker.material.color.setRGB(0.1 + devRatio * 0.85, 0.55 - devRatio * 0.48, 0.75 - devRatio * 0.68);
      axisMat.color.setRGB(0.10 + devRatio * 0.80, 0.42 - devRatio * 0.36, 0.55 - devRatio * 0.47);

      // --- 场景道具联动：杠铃跟手 / 踏板跟脚 / 楼梯跑道滚动 / 接触阴影 ---
      if (curKit && window.KneeScene) {
        const pAnkL = worldPos(rig.left.ankle, new THREE.Vector3());
        const hands = (rig.handR && rig.handL)
          ? [worldPos(rig.handR, new THREE.Vector3()), worldPos(rig.handL, new THREE.Vector3())]
          : null;
        const hipsCenter = worldPos(rig.hips, new THREE.Vector3());
        window.KneeScene.tick(curKit, t, { hips: pHip, hipsCenter: hipsCenter, feet: [pAnk, pAnkL], hands: hands });
      }

      // 相机由 main.js 的 OrbitControls 接管；这里只回传重心高度供跟随取景
      api.focusY = rig.root.position.y;
    }

    const api = { scene: scene, camera: camera, root: fig.root, update: update, figure: fig, focusY: 0 };
    return api;
  }

  return { create: create };
})();