/* =========================================================================
 * modelLoader.js —— 模型加载 / 分层解析模块
 * -------------------------------------------------------------------------
 * 职责：
 *   1) 优先加载 assets/models/knee.glb（Blender 导出的分层模型 + 4 段动画）；
 *   2) 若模型不存在 / 解析失败（例如直接双击打开 html 被浏览器拦截本地文件），
 *      自动回退到「内置解析模型」——用几何体在代码里搭一个可动的膝关节，
 *      保证任何环境打开都能演示，答辩现场不翻车；
 *   3) 统一对外输出「实例」结构，让上层代码（动画、热力、拾取、UI）不关心
 *      模型到底来自 GLB 还是内置几何体。
 *
 * 实例数据结构（重要，其他模块都依赖它）：
 *   {
 *     kind: 'glb' | 'procedural',
 *     root: THREE.Group,                  // 场景根节点
 *     parts: { femur:[mesh], tibia:[mesh], patella:[mesh], meniscus:[mesh], ligament:[mesh] },
 *     stressTargets: { meniscus_medial:[mesh], meniscus_lateral:[mesh], tibia_plateau:[mesh] },
 *     pickables: [mesh, ...],             // 参与射线拾取的所有网格
 *     rig: { femur, tibia, patella },     // 用于读取屈膝角度、动画绑定的关节节点
 *     clips: AnimationClip[]              // 4 段动作（GLB 自带或程序生成）
 *   }
 *
 * GLB 命名约定（大小写不敏感，包含关键词即可）：
 *   Femur / Tibia / Tibia_Plateau / Patella / Meniscus_Medial / Meniscus_Lateral
 *   ACL / PCL / MCL / LCL
 * ======================================================================= */

window.KneeModel = (function () {
  'use strict';

  const DEFAULT_URL = 'assets/models/knee.glb';

  /* 部件 ID → 所属图层 */
  const PART_LAYER = {
    femur: 'femur',
    femur_cartilage: 'cartilage',
    tibia: 'tibia',
    tibia_plateau: 'tibia',
    tibia_cartilage: 'cartilage',
    fibula: 'tibia',
    fibula_cartilage: 'cartilage',
    patella: 'patella',
    patella_cartilage: 'cartilage',
    meniscus_medial: 'meniscus',
    meniscus_lateral: 'meniscus',
    acl: 'ligament',
    pcl: 'ligament',
    mcl: 'ligament',
    lcl: 'ligament',
    ligament: 'ligament',
    tendon: 'ligament',
    retinaculum: 'ligament'
  };

  /* 图层元数据（UI 侧栏直接使用）
     骨骼默认做成半透明，让关节腔内的半月板/软骨/韧带能被看见 —— 这是
     Open3DModel 那套解剖可视化最关键的呈现方式，比不透明骨骼更像教科书图。 */
  const LAYERS = [
    { key: 'femur',    name: '股骨',            en: 'Femur',            opacity: 0.50 },
    { key: 'tibia',    name: '胫骨 + 腓骨',      en: 'Tibia / Fibula',    opacity: 0.50 },
    { key: 'patella',  name: '髌骨',            en: 'Patella',          opacity: 0.88 },
    { key: 'cartilage',name: '关节软骨',        en: 'Cartilage',        opacity: 0.38 },
    { key: 'meniscus', name: '内 / 外侧半月板',  en: 'Menisci',          opacity: 0.94 },
    { key: 'ligament', name: '交叉 / 侧副韧带',  en: 'Ligaments',        opacity: 0.86 }
  ];

  /* 材质基色：暖象牙白骨 + 浅蓝软骨 + 深青半月板 + 珊瑚红韧带 */
  const COLORS = {
    bone: 0xeadfc9,
    patella: 0xf2e7c8,
    cartilage: 0x9fd3e8,
    meniscus: 0x2e96c8,
    ligament: 0xd4604a
  };

  /* -----------------------------------------------------------------------
   * 一、通用工具
   * --------------------------------------------------------------------- */

  /** 名称 → 部件 ID（GLB 分层识别的核心） */
  function detectPart(rawName) {
    const n = String(rawName || '').toLowerCase().replace(/[\s\-.]/g, '_');
    if (!n) return null;

    // 交叉 / 侧副韧带要先判，它们的名字里也带 femur/tibia 之外的解剖词
    if (/(^|_)acl($|_)/.test(n) || n.indexOf('anterior_cruciate') >= 0) return 'acl';
    if (/(^|_)pcl($|_)/.test(n) || n.indexOf('posterior_cruciate') >= 0) return 'pcl';
    if (/(^|_)mcl($|_)/.test(n) || n.indexOf('medial_collat') >= 0) return 'mcl';
    if (/(^|_)lcl($|_)/.test(n) || n.indexOf('fibular_collat') >= 0 ||
        n.indexOf('lateral_collat') >= 0) return 'lcl';

    if (n.indexOf('meniscus') >= 0 || n.indexOf('menisci') >= 0 || n.indexOf('半月板') >= 0) {
      if (/(medial|inner|inside|内侧)/.test(n)) return 'meniscus_medial';
      if (/(lateral|outer|outside|外侧)/.test(n)) return 'meniscus_lateral';
      return 'meniscus_lateral';
    }
    if (/(plateau|platform)/.test(n)) return 'tibia_plateau';

    // 关节软骨：按所属骨细分，方便将来单独调透明度
    if (n.indexOf('cartilage') >= 0 || n.indexOf('软骨') >= 0) {
      if (n.indexOf('patella') >= 0 || n.indexOf('髌') >= 0) return 'patella_cartilage';
      if (n.indexOf('fibula') >= 0 || n.indexOf('腓') >= 0) return 'fibula_cartilage';
      if (n.indexOf('tibia') >= 0 || n.indexOf('胫') >= 0) return 'tibia_cartilage';
      if (n.indexOf('femur') >= 0 || n.indexOf('股') >= 0) return 'femur_cartilage';
      return 'cartilage';
    }
    if (n.indexOf('retinaculum') >= 0) return 'retinaculum';
    if (n.indexOf('tendon') >= 0 || n.indexOf('肌腱') >= 0) return 'tendon';
    if (n.indexOf('ligament') >= 0 || n.indexOf('韧带') >= 0) return 'ligament';

    if (n.indexOf('patella') >= 0 || n.indexOf('kneecap') >= 0 || n.indexOf('髌骨') >= 0) return 'patella';
    if (n.indexOf('fibula') >= 0 || n.indexOf('腓骨') >= 0) return 'fibula';
    if (n.indexOf('femur') >= 0 || n.indexOf('股骨') >= 0) return 'femur';
    if (n.indexOf('tibia') >= 0 || n.indexOf('胫骨') >= 0) return 'tibia';
    return null;
  }

  function normalizeName(raw) {
    return String(raw || '').toLowerCase().replace(/[\s\-.]/g, '_');
  }

  function makeBoneMaterial(color, opts) {
    opts = opts || {};
    const mat = new THREE.MeshPhysicalMaterial({
      color: color,
      roughness: opts.roughness === undefined ? 0.55 : opts.roughness,
      metalness: 0.0,
      clearcoat: 0.22,
      clearcoatRoughness: 0.42,
      envMapIntensity: 0.75,
      transparent: opts.transparent !== false,
      opacity: opts.opacity === undefined ? 1 : opts.opacity,
      side: THREE.DoubleSide,
      // 半透明骨骼必须关闭深度写入，否则会挡住关节腔里的半月板/软骨
      depthWrite: opts.depthWrite === undefined ? (opts.opacity === undefined || opts.opacity > 0.95) : opts.depthWrite
    });
    return mat;
  }

  /** 图层默认参数（新建材质时读取，UI 滑块随后会覆盖） */
  const LAYER_STYLE = {
    femur:     { roughness: 0.58 },
    tibia:     { roughness: 0.58 },
    patella:   { roughness: 0.52 },
    cartilage: { roughness: 0.30 },
    meniscus:  { roughness: 0.36 },
    ligament:  { roughness: 0.48 }
  };

  /** 创建网格 + 打上部件标记，方便拾取与图层控制 */
  function makeMesh(geo, mat, partId, name) {
    const m = new THREE.Mesh(geo, mat);
    m.name = name || partId;
    // 骨骼投射并接收阴影；半月板/韧带只接收阴影，避免半透材质投射出怪异黑影
    const isSoft = (partId === 'meniscus_medial' || partId === 'meniscus_lateral' ||
                    PART_LAYER[partId] === 'ligament' || partId === 'tibia_plateau');
    m.castShadow = !isSoft;
    m.receiveShadow = true;
    m.userData.part = partId;
    m.userData.layer = PART_LAYER[partId] || 'femur';
    return m;
  }

  /** 两点之间生成一根圆头韧带（Capsule 会自动沿 Y 轴，这里做朝向对齐） */
  function makeBand(p1, p2, radius, partId, name) {
    const a = new THREE.Vector3().fromArray(p1);
    const b = new THREE.Vector3().fromArray(p2);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const geo = new THREE.CapsuleGeometry(radius, Math.max(len - radius * 2, 0.02), 6, 12);
    const mesh = makeMesh(geo, makeBoneMaterial(COLORS.ligament, { transparent: true, opacity: 0.92, roughness: 0.5 }), partId, name);
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return mesh;
  }

  /**
   * 生成半月板几何：C 形（马蹄形）环带，外厚内薄
   * @param {number} rOut 外半径
   * @param {number} rIn  内半径
   * @param {number} h    外周厚度
   * @param {number} a0   起始角（度）
   * @param {number} a1   结束角（度），可大于 360
   * @param {number} seg  分段数
   */
  function createMeniscusGeometry(rOut, rIn, h, a0, a1, seg) {
    const pos = [];
    const hIn = h * 0.45;          // 内缘更薄，符合真实半月板楔形截面

    function pt(r, y, deg) {
      const rad = deg * Math.PI / 180;
      return [Math.cos(rad) * r, y, Math.sin(rad) * r];
    }
    function quad(p1, p2, p3, p4) {
      pos.push.apply(pos, p1); pos.push.apply(pos, p2); pos.push.apply(pos, p3);
      pos.push.apply(pos, p1); pos.push.apply(pos, p3); pos.push.apply(pos, p4);
    }

    for (let i = 0; i < seg; i++) {
      const t0 = a0 + (a1 - a0) * (i / seg);
      const t1 = a0 + (a1 - a0) * ((i + 1) / seg);

      const oTop0 = pt(rOut, 0, t0), oTop1 = pt(rOut, 0, t1);
      const oBot0 = pt(rOut, -h, t0), oBot1 = pt(rOut, -h, t1);
      const iTop0 = pt(rIn, 0, t0), iTop1 = pt(rIn, 0, t1);
      const iBot0 = pt(rIn, -hIn, t0), iBot1 = pt(rIn, -hIn, t1);

      quad(oTop0, iTop0, iTop1, oTop1);          // 上表面
      quad(oBot0, oBot1, iBot1, iBot0);          // 下表面
      quad(oTop0, oTop1, oBot1, oBot0);          // 外壁
      quad(iTop0, iBot0, iBot1, iTop1);          // 内壁
    }
    // 两个断面封口
    quad(pt(rOut, 0, a0), pt(rOut, -h, a0), pt(rIn, -h * 0.45, a0), pt(rIn, 0, a0));
    quad(pt(rOut, 0, a1), pt(rIn, 0, a1), pt(rIn, -h * 0.45, a1), pt(rOut, -h, a1));

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return geo;
  }

  /* -----------------------------------------------------------------------
   * 二、内置解析模型（没有 GLB 时的兜底，也是默认演示模型）
   * --------------------------------------------------------------------- */
  function buildProcedural() {
    const root = new THREE.Group();
    root.name = 'KneeRoot';

    // ---- 关节节点 ----
    const femurPivot = new THREE.Group(); femurPivot.name = 'FemurPivot';
    const tibiaPivot = new THREE.Group(); tibiaPivot.name = 'TibiaPivot';
    const patellaPivot = new THREE.Group(); patellaPivot.name = 'PatellaPivot';
    patellaPivot.position.set(0, 0.12, 0.66);
    root.add(femurPivot, tibiaPivot);
    femurPivot.add(patellaPivot);

    const boneMat = () => makeBoneMaterial(COLORS.bone);
    const plateMat = () => makeBoneMaterial(COLORS.bone, { transparent: true, opacity: 1 });
    const mensMat = () => makeBoneMaterial(COLORS.meniscus, { transparent: true, opacity: 0.96, roughness: 0.38 });

    /* ---------------- 股骨 ----------------
       坐标约定：膝关节屈伸中心位于世界原点；股骨向 +Y，胫骨向 -Y
       （比例参考真实膝关节：股骨髁宽约 8cm，胫骨平台宽约 7cm，这里等比例缩放） */
    // 骨干
    const femurShaft = makeMesh(
      new THREE.CylinderGeometry(0.30, 0.37, 2.2, 28, 1),
      boneMat(), 'femur', 'Femur_Shaft'
    );
    femurShaft.position.set(0, 1.9, 0);
    femurPivot.add(femurShaft);

    // 近端封口（上方截断处，视觉上收成正圆弧）
    const femurTop = makeMesh(new THREE.SphereGeometry(0.30, 22, 16), boneMat(), 'femur', 'Femur_Top');
    femurTop.position.set(0, 3.0, 0);
    femurPivot.add(femurTop);

    // 远端干骺端膨大（向两侧张开的“喇叭口”）
    const femurFlare = makeMesh(
      new THREE.CylinderGeometry(0.34, 0.63, 0.6, 26, 1),
      boneMat(), 'femur', 'Femur_Metaphysis'
    );
    femurFlare.position.set(0, 0.78, 0);
    femurPivot.add(femurFlare);

    // 内外侧髁（真正与半月板/胫骨平台接触的关节面，两个圆隆）
    [-1, 1].forEach(function (side) {
      const condyle = makeMesh(
        new THREE.SphereGeometry(0.39, 30, 22),
        boneMat(), 'femur', side < 0 ? 'Femur_Condyle_Medial' : 'Femur_Condyle_Lateral'
      );
      condyle.position.set(side * 0.27, 0.45, 0.02);
      condyle.scale.set(1.04, 0.92, 1.02);
      femurPivot.add(condyle);

      // 上髁（侧副韧带附着点，也让外形更像真实股骨）
      const epi = makeMesh(new THREE.SphereGeometry(0.17, 18, 14), boneMat(), 'femur', 'Femur_Epicondyle');
      epi.position.set(side * 0.76, 0.5, -0.02);
      femurPivot.add(epi);
    });

    // 滑车（髌骨滑动的“轨道”）
    const trochlea = makeMesh(
      new THREE.SphereGeometry(0.42, 26, 20),
      boneMat(), 'femur', 'Femur_Trochlea'
    );
    trochlea.position.set(0, 0.7, 0.32);
    trochlea.scale.set(1.18, 0.72, 0.7);
    femurPivot.add(trochlea);

    /* ---------------- 胫骨 ---------------- */
    // 胫骨平台（单独网格 → 后跟硬着陆时可以做冲击应力高亮）
    const plateau = makeMesh(
      new THREE.CylinderGeometry(0.70, 0.62, 0.26, 30, 1),
      plateMat(), 'tibia_plateau', 'Tibia_Plateau'
    );
    plateau.position.set(0, -0.19, 0);
    tibiaPivot.add(plateau);

    // 干骺端
    const tibiaFlare = makeMesh(
      new THREE.CylinderGeometry(0.55, 0.33, 0.62, 26, 1),
      boneMat(), 'tibia', 'Tibia_Metaphysis'
    );
    tibiaFlare.position.set(0, -0.66, 0);
    tibiaPivot.add(tibiaFlare);

    // 骨干
    const tibiaShaft = makeMesh(
      new THREE.CylinderGeometry(0.29, 0.22, 2.1, 26, 1),
      boneMat(), 'tibia', 'Tibia_Shaft'
    );
    tibiaShaft.position.set(0, -2.0, 0);
    tibiaPivot.add(tibiaShaft);

    // 胫骨结节（髌韧带附着点）
    const tuberosity = makeMesh(
      new THREE.SphereGeometry(0.17, 18, 14),
      boneMat(), 'tibia', 'Tibia_Tuberosity'
    );
    tuberosity.position.set(0, -0.68, 0.27);
    tuberosity.scale.set(0.9, 1.5, 0.7);
    tibiaPivot.add(tuberosity);

    // 远端封口
    const tibiaBottom = makeMesh(new THREE.SphereGeometry(0.225, 20, 14), boneMat(), 'tibia', 'Tibia_Bottom');
    tibiaBottom.position.set(0, -3.05, 0);
    tibiaPivot.add(tibiaBottom);

    /* ---------------- 半月板 ----------------
       夹在股骨髁与胫骨平台之间的一圈楔形纤维软骨：
       外缘厚、内缘薄，颜色偏冷蓝灰，正常状态下也清晰可辨 */
    // 内侧半月板：C 形开口朝外侧（+X），活动度小、最易被挤压
    const medial = makeMesh(
      createMeniscusGeometry(0.46, 0.26, 0.16, 54, 306, 44),
      mensMat(), 'meniscus_medial', 'Meniscus_Medial'
    );
    medial.position.set(-0.28, 0.10, 0.02);
    tibiaPivot.add(medial);

    // 外侧半月板：更接近 O 形，开口更小、活动度大
    const lateral = makeMesh(
      createMeniscusGeometry(0.44, 0.24, 0.15, 212, 508, 46),
      mensMat(), 'meniscus_lateral', 'Meniscus_Lateral'
    );
    lateral.position.set(0.28, 0.10, 0.02);
    tibiaPivot.add(lateral);

    /* ---------------- 韧带（交叉 + 侧副） ----------------
       放在股骨节点下：股骨旋转幅度小，韧带随动后不会明显穿模 */
    femurPivot.add(makeBand([0.1, 0.32, 0.26], [0.14, -0.16, -0.1], 0.05, 'acl', 'ACL'));
    femurPivot.add(makeBand([-0.08, 0.3, -0.14], [-0.04, -0.18, 0.12], 0.048, 'pcl', 'PCL'));
    femurPivot.add(makeBand([-0.78, 0.46, -0.02], [-0.56, -0.3, 0.0], 0.042, 'mcl', 'MCL'));
    femurPivot.add(makeBand([0.78, 0.46, -0.02], [0.58, -0.3, 0.0], 0.04, 'lcl', 'LCL'));

    /* ---------------- 髌骨 ---------------- */
    const patella = makeMesh(
      new THREE.SphereGeometry(0.3, 24, 18),
      makeBoneMaterial(COLORS.patella),
      'patella', 'Patella'
    );
    patella.scale.set(1.05, 1.28, 0.3);      // 扁平盾形：宽 > 高 > 厚
    patella.position.set(0, 0.18, -0.02);
    patellaPivot.add(patella);

    // 说明：髌韧带在大角度屈膝时会与胫骨分离得很明显，为了画面干净这里不建模，
    // 只保留髌骨本身（如果换成真实 GLB 模型，这条韧带通常已经在模型里了）。

    return collect(root, 'procedural');
  }

  /* -----------------------------------------------------------------------
   * 三、GLB 模型解析
   * --------------------------------------------------------------------- */

  /** 遍历模型，把网格按部件归档到实例结构里 */
  function collect(root, kind) {
    const parts = { femur: [], tibia: [], patella: [], cartilage: [], meniscus: [], ligament: [] };
    const stressTargets = { meniscus_medial: [], meniscus_lateral: [], tibia_plateau: [] };
    const pickables = [];
    const rig = { femur: null, tibia: null, patella: null };

    root.traverse(function (obj) {
      // 关节节点识别（动画与角度读数用）
      const nm = normalizeName(obj.name);
      if (nm.indexOf('tibia') === 0 || nm === 'tibia' || /(^|_)tibia($|_)/.test(nm)) {
        if (!rig.tibia && (obj.isBone || obj.type === 'Group' || obj.type === 'Object3D')) rig.tibia = obj;
      }
      // 空节点（Blender 导出的空物体）在 three.js 里是 Object3D，不是 Group，
      // 两种都要认，否则 GLB 模型的 rig 只能拿到胫骨
      const isNode = obj.isBone || obj.type === 'Group' || obj.type === 'Object3D';
      if (!rig.femur && (nm === 'femur' || nm.indexOf('femur') === 0) && isNode) rig.femur = obj;
      if (!rig.patella && nm.indexOf('patella') === 0 && isNode) rig.patella = obj;

      if (!obj.isMesh) return;

      // 部件归属：优先 userData.part（内置模型已写好），否则按名称匹配
      let partId = obj.userData.part || detectPart(obj.name) || detectPart(obj.parent && obj.parent.name);
      if (!partId) return;

      obj.userData.part = partId;
      obj.userData.layer = PART_LAYER[partId] || 'femur';
      // 半透明材质不再投射阴影（否则关节腔里会出现大片黑影）
      obj.castShadow = false;
      obj.receiveShadow = false;
      if (parts[obj.userData.layer]) parts[obj.userData.layer].push(obj);
      pickables.push(obj);
      if (stressTargets[partId]) stressTargets[partId].push(obj);

      // 统一材质观感（SkinnedMesh 需要保留蒙皮属性，因此克隆原材质而不是重建）
      const layer = obj.userData.layer;
      const style = LAYER_STYLE[layer] || LAYER_STYLE.femur;
      const meta = LAYERS.find(function (l) { return l.key === layer; });
      const baseOpacity = meta ? meta.opacity : 1;
      const applyLook = function (mat) {
        if (!mat) return mat;
        let c;
        if (obj.isSkinnedMesh) c = mat.clone();
        else c = makeBoneMaterial(COLORS[layer] || COLORS.bone, style);
        if (c.color) c.color.setHex(COLORS[layer] || COLORS.bone);
        c.transparent = true;
        c.opacity = baseOpacity;
        c.depthWrite = baseOpacity > 0.95;
        c.side = THREE.DoubleSide;
        if (c.clearcoat !== undefined) c.clearcoat = 0.22;
        return c;
      };
      if (Array.isArray(obj.material)) obj.material = obj.material.map(applyLook);
      else obj.material = applyLook(obj.material);
    });

    return { kind: kind, root: root, parts: parts, stressTargets: stressTargets, pickables: pickables, rig: rig };
  }

  /** 克隆 GLB 场景并让每个实例拥有独立材质（否则透明度会互相影响） */
  function cloneForInstance(templateRoot) {
    let clone;
    if (THREE.SkeletonUtils && THREE.SkeletonUtils.clone) {
      clone = THREE.SkeletonUtils.clone(templateRoot);   // 支持骨骼蒙皮
    } else {
      clone = templateRoot.clone(true);
    }
    clone.traverse(function (o) {
      if (!o.isMesh) return;
      if (Array.isArray(o.material)) o.material = o.material.map(function (m) { return m.clone(); });
      else if (o.material) o.material = o.material.clone();
    });
    return clone;
  }

  /** 从 GLB 的动画列表里，按关键词匹配出 4 段动作，并统一改名为内部 key */
  function mapClips(animations) {
    const pairs = [
      { key: 'anim_squat_correct',   test: (n) => /squat/.test(n) && /(correct|right|normal|good|标准|正确)/.test(n) },
      { key: 'anim_squat_valgus',    test: (n) => /squat/.test(n) && /(valgus|wrong|bad|knock|内扣|错误)/.test(n) },
      { key: 'anim_run_correct',     test: (n) => /(run|jog|sprint)/.test(n) && /(correct|right|normal|good|前掌|forefoot|midfoot|标准)/.test(n) },
      { key: 'anim_run_heelstrike',  test: (n) => /(run|jog|sprint)/.test(n) && /(heel|wrong|bad|strike|后跟|错误)/.test(n) }
    ];
    const list = (animations || []).slice();

    // 先按精确 key 匹配
    list.forEach(function (clip) {
      const n = normalizeName(clip.name);
      if (/^anim_/.test(n)) clip.name = n;
    });
    // 再按关键词补配
    pairs.forEach(function (p) {
      if (list.some(function (c) { return c.name === p.key; })) return;
      const hit = list.find(function (c) {
        const n = normalizeName(c.name);
        return n !== p.key && p.test(n);
      });
      if (hit && !list.some(function (c) { return c.name === p.key; })) {
        hit.name = p.key;
        return;
      }
      // 兜底：按顺序补齐（只有 4 段且命名不规范时）
      if (pairs.length === list.length) {
        const idx = pairs.indexOf(p);
        if (list[idx] && !list[idx].__mapped) { list[idx].name = p.key; list[idx].__mapped = true; }
      }
    });

    return list;
  }

  /* -----------------------------------------------------------------------
   * 四、对外接口
   * --------------------------------------------------------------------- */

  /** 读取 URL 参数里的模型地址（支持 ?model=xxx.glb 临时替换） */
  function resolveUrl() {
    try {
      const q = new URLSearchParams(window.location.search);
      const m = q.get('model');
      if (m) return m;
    } catch (e) { /* 忽略 */ }
    return DEFAULT_URL;
  }

  function loadEmbeddedKnee() {
    return window.KneeEmbed.load('assets/models/knee-data.js', '__KNEE_EMBED__')
      .then(function (b64) {
        return new Promise(function (resolve, reject) {
          new THREE.GLTFLoader().parse(window.KneeEmbed.b64ToBuf(b64), '', resolve, reject);
        });
      });
  }

  function loadGLB(url) {
    return new Promise(function (resolve, reject) {
      if (!THREE.GLTFLoader) return reject(new Error('GLTFLoader 未加载'));
      const loader = new THREE.GLTFLoader();
      loader.load(
        url,
        function (gltf) { resolve(gltf); },
        undefined,
        function (err) {
          // file:// 下 XHR 被禁：默认模型改走内嵌 base64 脚本
          if (url !== DEFAULT_URL || !window.KneeEmbed) return reject(err || new Error('GLB 加载失败'));
          loadEmbeddedKnee().then(resolve, function () { reject(err || new Error('GLB 加载失败')); });
        }
      );
    });
  }

  /**
   * 加载模型模板
   * @returns {Promise<{kind, label, create:Function, clips}>}
   */
  async function load(onStatus) {
    const url = resolveUrl();
    const status = typeof onStatus === 'function' ? onStatus : function () {};

    status('正在加载膝关节模型…');
    try {
      const gltf = await loadGLB(url);
      const template = gltf.scene || gltf.scenes[0];
      const probe = collect(template, 'glb');
      if (!probe.pickables.length) throw new Error('GLB 中未识别到任何可命名部件');

      const clips = mapClips(gltf.animations);
      // 动作库共 30 段：GLB 自带的 legacy clips 优先，其余用相同关节节点轨道合成补齐，
      // 保证换用任意分层 GLB 后全部模式仍可播放（节点名需符合 FemurPivot/TibiaPivot 约定）。
      const have = {};
      clips.forEach(function (c) { have[c.name] = true; });
      KneeAnim.buildProceduralClips().forEach(function (c) {
        if (!have[c.name]) clips.push(c);
      });
      const hasRig = !!(probe.rig.tibia || probe.rig.femur);

      return {
        kind: 'glb',
        label: 'GLB 分层模型（' + url.split('/').pop() + '）',
        clips: clips,
        hasClips: clips.length > 0,
        rendererRoot: template,
        create: function () {
          const clone = cloneForInstance(template);
          return collect(clone, 'glb');
        }
      };
    } catch (err) {
      // 静默回退：内置模型保证页面可用
      console.warn('[modelLoader] GLB 不可用，回退到内置解析模型：', err && err.message ? err.message : err);
      status('未找到 GLB 模型，已启用内置解析模型');

      const clips = KneeAnim.buildProceduralClips();
      return {
        kind: 'procedural',
        label: '内置解析模型（代码生成）',
        clips: clips,
        hasClips: true,
        create: function () {
          const inst = buildProcedural();
          inst.clips = clips;
          return inst;
        }
      };
    }
  }

  return {
    load: load,
    LAYERS: LAYERS,
    PART_LAYER: PART_LAYER,
    COLORS: COLORS,
    detectPart: detectPart
  };
})();
