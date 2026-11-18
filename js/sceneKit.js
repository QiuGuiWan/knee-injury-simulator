/* 场景化道具：15 类动作各配一套程序化低模场景，挂在全身小窗里帮助直观理解动作。
 * 设计原则：道具只做"语境"，不遮挡人体；楼梯/跑道用跑步机式滚动与进度 t 同步，
 * 杠铃跟手、单车踏板跟脚，保证道具与姿态严格联动。颜色低饱和，突出深红人体。
 * 场景名与动作的对应关系唯一来源是 motions.js 的 sceneOf()；本模块只负责几何。 */
window.KneeScene = (function () {
  'use strict';
  const FWD = -1; // 人体迈步方向（与髋屈曲摆动方向一致）

  function mat(color, rough) {
    return new THREE.MeshStandardMaterial({ color: color, roughness: rough === undefined ? 0.85 : rough, metalness: 0.0 });
  }
  function box(g, w, h, d, color, x, y, z) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
    m.position.set(x, y, z); g.add(m); return m;
  }
  function cyl(g, r, h, color, x, y, z, axis) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), mat(color, 0.6));
    m.position.set(x, y, z);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    g.add(m); return m;
  }
  function tube(g, a, b, r, color) {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const m = cyl(g, r, d.length(), color, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    m.rotation.x = Math.atan2(d.z, d.y);
    return m;
  }
  function ground(g, color, r) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r || 1.45, 40), mat(color, 0.95));
    m.rotation.x = -Math.PI / 2; m.position.y = -0.002; g.add(m); return m;
  }
  function shadow(g) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(0.3, 24),
      new THREE.MeshBasicMaterial({ color: 0x2a3438, transparent: true, opacity: 0.16, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.004; g.add(m); return m;
  }
  function cone(g, x, z) {
    const m = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 12), mat(0xe8722c, 0.7));
    m.position.set(x, 0.08, z); g.add(m);
    box(g, 0.16, 0.02, 0.16, 0xd8621c, x, 0.01, z);
  }
  function tree(g, x, z, s, y) {
    const b = y || 0;
    cyl(g, 0.035 * s, 0.22 * s, 0x8a6a4c, x, b + 0.11 * s, z);
    const m = new THREE.Mesh(new THREE.ConeGeometry(0.16 * s, 0.42 * s, 10), mat(0x5d8f66, 0.9));
    m.position.set(x, b + 0.42 * s, z); g.add(m);
  }
  function dashes(g, color, n, span) {
    const grp = new THREE.Group();
    for (let i = 0; i < n; i++) box(grp, 0.05, 0.012, 0.22, color, 0.42, 0.006, -span / 2 + span * i / (n - 1));
    g.add(grp); return grp;
  }
  // 把单位圆柱摆到 a→b（用于曲柄/把立等随姿态伸缩的连杆）
  const _sa = new THREE.Vector3(), _sb = new THREE.Vector3(), _sd = new THREE.Vector3(), _sUp = new THREE.Vector3(0, 1, 0);
  function span(mesh, a, b) {
    _sa.set(a[0], a[1], a[2]); _sb.set(b[0], b[1], b[2]);
    _sd.subVectors(_sb, _sa);
    const len = _sd.length() || 0.001;
    mesh.position.copy(_sa).add(_sb).multiplyScalar(0.5);
    mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(_sUp, _sd.normalize());
  }

  /* 骑行几何：与人体的踩踏 IK 共用同一组数字，保证脚掌严格落在踏板上。
   * 座垫高 = 髋高 - 0.085（臀底贴座垫），车把高 = 髋高 + 0.02（手握在把上），
   * 低座姿态时整车不动、只降座垫，腿更屈——与真实“座过低”一致。 */
  const CYCLE = {
    bbY: 0.27, bbZ: -0.02, crankR: 0.163, setback: 0.13,
    saddleDrop: 0.085, barRise: 0.02, ankleUp: 0.072, ankleBack: 0.10
  };
  function cycleFit(hips) {
    return {
      x: hips.x, z: hips.z - CYCLE.setback,
      bbY: CYCLE.bbY, bbZ: hips.z - CYCLE.setback + CYCLE.bbZ,
      saddleY: Math.max(0.60, hips.y - CYCLE.saddleDrop),
      barY: hips.y + CYCLE.barRise,
      r: CYCLE.crankR
    };
  }
  function cyclePedal(fit, phi) {
    return { y: fit.bbY + fit.r * Math.cos(phi), z: fit.bbZ - fit.r * Math.sin(phi) };
  }

  /* 楼梯：整段梯段作为一个均匀"梯链"整体滚动（跑步机式），脚掌用 IK 落在真实踏面上。
   * 链条每循环滚动 2 级 → 回卷正好 1 级，均匀图形下不可见；人不动、台阶向下(上)流走，
   * 与跑道的滚动语言一致。落点固定为"踏面前缘(=梯级鼻)后方 0.15m 的踏面中部"，
   * 相位/高度由该约束反解，因此脚与踏面严格贴合、鞋尖不悬出梯级鼻。 */
  const STAIR = {
    rise: 0.16, run: 0.28, width: 1.5,
    stepsPerLoop: 2,   // 每个 1.5s 循环滚过 2 级台阶
    stance: 0.56,      // 支撑相占一步的比例
    lift: 0.08,        // 摆动相抬脚高度
    ankleUp: 0.072,
    // phase/Y0 由"落点在踏面中部"反解（kz=15, 落点距前缘 0.15, 支撑相滚动 0.56*2 级）
    up: { landSole: 0.21, landZ: -0.10, phase: 0.761, Y0: -2.0586, Z0: 4.0 },
    down: { landSole: 0.10, landZ: -0.10, phase: 0.761, Y0: 2.3686, Z0: 4.0 }
  };
  // 梯链表面高度：与 stairChain 的 build + tick 完全一致（脚/踏面共用同一函数）
  function stairSurface(z, t, dir) {
    const S = STAIR, D = dir > 0 ? S.up : S.down;
    const s = (t * S.stepsPerLoop + D.phase) % 1;
    const k = Math.floor((D.Z0 + s * S.run - z) / S.run);
    return D.Y0 + dir * S.rise * k - dir * S.rise * s;
  }
  // 第 i 只脚在时刻 t 的踝关节目标（世界系）。支撑相随踏面滚动并贴合踏面高度；
  // 摆动相抬回同一点（梯链已卷过一级，视觉上即落到上一级），并逐点避让踏面。
  function stairFoot(t, i, dir) {
    const S = STAIR, D = dir > 0 ? S.up : S.down;
    const t0 = i === 0 ? 0.03 : 0.53;
    const local = (t - t0 + 1) % 1;
    const vZ = S.stepsPerLoop * S.run;
    const zToe = D.landZ + vZ * S.stance;
    let y, z;
    if (local < S.stance) {
      z = D.landZ + vZ * local;
      y = stairSurface(z, t, dir) + S.ankleUp;
    } else {
      const q = (local - S.stance) / (1 - S.stance);
      const e = Math.pow(q, 0.6);
      z = zToe + (D.landZ - zToe) * e;
      const yToe = stairSurface(zToe, t, dir) + S.ankleUp;
      const yLand = stairSurface(D.landZ, t, dir) + S.ankleUp;
      y = yToe + (yLand - yToe) * e + S.lift * Math.sin(Math.PI * q);
      const clear = Math.max(
        stairSurface(z - 0.13, t, dir),
        stairSurface(z + 0.04, t, dir)
      ) + S.ankleUp + 0.012;
      if (y < clear) y = clear;
    }
    return { x: i === 0 ? 0.10 : -0.10, y: y, z: z };
  }
  function stairChain(g, dir) {
    const S = STAIR, D = dir > 0 ? S.up : S.down;
    const ch = new THREE.Group();
    const N = 44;
    for (let k = 0; k < N; k++) {
      const top = D.Y0 + dir * S.rise * k;
      const h = Math.max(0.08, top + 3.4);
      const zc = D.Z0 - S.run * k - S.run / 2;
      box(ch, S.width, h, S.run, k % 2 ? 0xa7b1b4 : 0xa2adb1, 0, top - h / 2, zc);
      // 每级一根立柱：均匀图形保证 1 级回卷后完全重合
      if (k % 1 === 0) {
        cyl(ch, 0.014, 0.9, 0x7d888c, -S.width / 2 + 0.06, top + 0.45, zc);
      }
    }
    const yFar = D.Y0 + dir * S.rise * (N - 1);
    // 只保留远侧扶手（镜头在 +x 侧，近侧扶手会横穿人体遮挡视线）
    tube(ch, [-S.width / 2 + 0.06, D.Y0 + 0.9, D.Z0], [-S.width / 2 + 0.06, yFar + 0.9, D.Z0 - S.run * (N - 1)], 0.02, 0x7d888c);
    g.add(ch);
    return { chain: ch, chainDir: dir, chainPhase: D.phase, surface: 0.16 };
  }

  /* 上坡步态：支撑脚沿坡面匀速后移（跑步机式），摆动脚抬起前摆，
   * 步幅/抬脚高度参照上楼梯，观感是明确的向前迈步而不是原地踏步。 */
  const UPSLOPE = { zFront: -0.33, zBack: 0.09, stance: 0.6, lift: 0.15, ankleUp: 0.078 };
  function slopeFoot(t, i, surf) {
    const U = UPSLOPE;
    const t0 = i === 0 ? 0.02 : 0.52;
    const local = (t - t0 + 1) % 1;
    let z, y;
    if (local < U.stance) {
      z = U.zFront + (U.zBack - U.zFront) * (local / U.stance);
      y = surf(z) + U.ankleUp;
    } else {
      const q = (local - U.stance) / (1 - U.stance);
      const e = q * q * (3 - 2 * q);
      z = U.zBack + (U.zFront - U.zBack) * e;
      y = surf(z) + U.ankleUp + U.lift * Math.sin(Math.PI * q);
    }
    return { z: z, y: y };
  }

  const BUILD = {
    walk: function (g) {
      ground(g, 0xb9c2c6);
      box(g, 1.5, 0.05, 2.6, 0x9fa8ac, -0.35, 0.02, 0);
      box(g, 0.08, 0.09, 2.6, 0x8b9498, 0.44, 0.045, 0);
      const d = dashes(g, 0xe8ecec, 9, 3.2);
      return { scroll: d, span: 2.4, speed: 1, surface: 0.045 };
    },
    stairsUp: function (g) { return stairChain(g, 1); },
    stairsDown: function (g) { return stairChain(g, -1); },
    sitStand: function (g) {
      ground(g, 0xc2cacc);
      const chair = new THREE.Group();
      // 人体脸朝 -Z：椅面在臀下、靠背在身后(+Z)
      // 座面高度按"坐姿骨盆底"反解：模型小腿≈0.35 + 足高，座面过高会把臀部顶穿
      const S = 0.375;
      box(chair, 0.42, 0.05, 0.4, 0x4f6d7a, 0, S - 0.025, 0.05);
      [[-0.18, 0.21], [0.18, 0.21], [-0.18, -0.11], [0.18, -0.11]].forEach(function (p) {
        cyl(chair, 0.02, S - 0.05, 0x3d5560, p[0], (S - 0.05) / 2, p[1]);
      });
      box(chair, 0.42, 0.46, 0.04, 0x4f6d7a, 0, S + 0.23, 0.25);
      g.add(chair);
      return { surface: 0 };
    },
    uphill: function (g) {
      const slope = box(g, 2.6, 0.1, 3.0, 0x9db08f, 0, -0.05, 0);
      slope.rotation.x = -FWD * 0.16;
      const surf = function (z) { return FWD * 0.159 * z; };
      tree(g, -1.3, FWD * 0.9, 1.0, surf(FWD * 0.9));
      tree(g, 1.35, FWD * 0.3, 0.75, surf(FWD * 0.3));
      return { surface: 0, surfaceAt: surf, ankleTilt: FWD * 0.16, footAt: slopeFoot };
    },
    downhill: function (g) {
      const slope = box(g, 2.6, 0.1, 3.0, 0x9db08f, 0, -0.05, 0);
      slope.rotation.x = FWD * 0.16;
      const surf = function (z) { return -FWD * 0.159 * z; };
      tree(g, -1.3, FWD * 0.5, 0.85, surf(FWD * 0.5));
      tree(g, 1.35, FWD * 1.0, 1.05, surf(FWD * 1.0));
      return { surface: 0, surfaceAt: surf, ankleTilt: -FWD * 0.16 };
    },
    squat: function (g) {
      ground(g, 0x8f9aa0);
      box(g, 1.3, 0.04, 1.1, 0x54646c, 0, 0.02, 0);
      [-0.62, 0.62].forEach(function (x) {
        box(g, 0.07, 1.5, 0.07, 0x37474f, x, 0.75, -FWD * 0.42);
      });
      box(g, 1.31, 0.06, 0.06, 0x37474f, 0, 1.46, -FWD * 0.42);
      [0.16, 0.13, 0.1].forEach(function (r, i) {
        cyl(g, r, 0.05, 0x455a64, 0.86, r, 0.35 + i * 0.0, 'x');
      });
      return { surface: 0.04 };
    },
    lunge: function (g) {
      ground(g, 0x8f9aa0);
      box(g, 1.5, 0.04, 1.2, 0x54646c, 0, 0.02, 0);
      [-0.3, 0.3].forEach(function (x) {
        cyl(g, 0.02, 0.24, 0x9aa4ad, x + 0.75, 0.09, 0.4, 'z');
        cyl(g, 0.08, 0.05, 0x37474f, x + 0.75, 0.09, 0.28, 'z');
        cyl(g, 0.08, 0.05, 0x37474f, x + 0.75, 0.09, 0.52, 'z');
      });
      return { surface: 0.04 };
    },
    // 哑铃握在手里而不是长杠铃：手柄跟手、配重块在两侧，杠身不会穿过骨盆
    deadlift: function (g) {
      ground(g, 0x8f9aa0);
      box(g, 1.6, 0.05, 1.2, 0x6b7a82, 0, 0.025, 0);
      function dumbbell() {
        const grp = new THREE.Group();
        cyl(grp, 0.017, 0.15, 0x9aa4ad, 0, 0, 0, 'x');
        [-0.085, 0.085].forEach(function (x) {
          cyl(grp, 0.062, 0.045, 0x37474f, x, 0, 0, 'x');
          cyl(grp, 0.048, 0.05, 0x455a64, x + (x > 0 ? 0.045 : -0.045), 0, 0, 'x');
        });
        return grp;
      }
      const dbs = [dumbbell(), dumbbell()];
      dbs.forEach(function (m) { g.add(m); });
      return { dumbbells: dbs, surface: 0.05 };
    },
    /* 真实尺度公路车（座垫/车把高度随髋高动态调整）：
     * 轮径 0.67m、五通高 0.27m、曲柄 0.163m——与 1.5m 级人体腿长匹配，
     * 人体腿由 bodyFigure 的踩踏 IK 精确落在曲柄圆周上，不再悬空或穿入车架。 */
    cycle: function (g) {
      ground(g, 0x9aa4a8);
      const bike = new THREE.Group();
      const wheels = [];
      [-0.44, 0.50].forEach(function (z) {
        const w = new THREE.Mesh(new THREE.TorusGeometry(0.335, 0.026, 10, 30), mat(0x37474f, 0.6));
        w.rotation.y = Math.PI / 2; w.position.set(0, 0.335, z); bike.add(w); wheels.push(w);
      });
      const C = [0, 0.27, -0.02];       // 五通
      const S0 = [0, 0.665, 0.10];      // 座管束
      const H = [0, 0.76, -0.30];       // 头管上端（低于座垫，顶管从骨盆下方穿过）
      const H0 = [0, 0.58, -0.32];      // 头管下端
      const FW = [0, 0.335, -0.44];
      const RW = [0, 0.335, 0.50];
      tube(bike, C, S0, 0.022, 0x2f6f74);
      tube(bike, C, H0, 0.024, 0x2f6f74);
      tube(bike, S0, H, 0.016, 0x2f6f74);
      tube(bike, H0, H, 0.028, 0x2f6f74);
      tube(bike, H0, FW, 0.018, 0x263238);
      tube(bike, C, RW, 0.016, 0x2f6f74);
      tube(bike, S0, RW, 0.014, 0x2f6f74);
      cyl(bike, 0.095, 0.012, 0x37474f, C[0], C[1], C[2], 'x');
      const saddle = box(bike, 0.14, 0.035, 0.27, 0x263238, 0, 0.815, 0.13);
      const seatPost = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 10), mat(0x263238, 0.5));
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 1, 10), mat(0x263238, 0.5));
      const bar = cyl(bike, 0.016, 0.72, 0x263238, 0, 0.935, -0.18, 'x');
      bike.add(seatPost); bike.add(stem);
      const cranks = [0, 1].map(function () {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 1, 8), mat(0x263238, 0.5));
        bike.add(m); return m;
      });
      g.add(bike);
      const pedals = [0, 1].map(function () { return box(g, 0.085, 0.02, 0.13, 0x263238, 0, 0.2, 0); });
      return { wheels: wheels, pedals: pedals, cranks: cranks, bike: bike, saddle: saddle, seatPost: seatPost, stem: stem, bar: bar, surface: 0 };
    },
    run: function (g) {
      ground(g, 0xb06a5a);
      box(g, 1.5, 0.03, 2.8, 0xa85f50, 0, 0.012, 0);
      [-0.5, 0.5].forEach(function (x) { box(g, 0.04, 0.014, 2.8, 0xe8ecec, x, 0.03, 0); });
      const d = dashes(g, 0xe8ecec, 10, 3.4);
      d.children.forEach(function (m) { m.position.x = 0; });
      return { scroll: d, span: 2.6, speed: 2, surface: 0.027 };
    },
    jump: function (g) {
      ground(g, 0x8f9aa0);
      box(g, 1.4, 0.04, 1.2, 0x54646c, 0, 0.02, 0);
      box(g, 0.5, 0.42, 0.45, 0x7a5c44, -0.72, 0.21, FWD * 0.2);
      box(g, 0.52, 0.03, 0.47, 0x93705a, -0.72, 0.435, FWD * 0.2);
      return { surface: 0.04 };
    },
    hop: function (g) {
      ground(g, 0x8f9aa0);
      box(g, 1.4, 0.04, 1.2, 0x54646c, 0, 0.02, 0);
      box(g, 0.44, 0.24, 0.4, 0x7a5c44, -0.68, 0.12, FWD * 0.15);
      return { surface: 0.04 };
    },
    cut: function (g) {
      ground(g, 0x6f9a72);
      const arc = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.02, 6, 30, Math.PI * 0.8), mat(0xe8ecec, 0.9));
      arc.rotation.x = -Math.PI / 2; arc.rotation.z = Math.PI * 0.1; arc.position.y = 0.006; g.add(arc);
      cone(g, 0.62, FWD * 0.5); cone(g, -0.55, FWD * 0.85);
      return { surface: 0 };
    },
    kick: function (g) {
      ground(g, 0x6f9a72);
      box(g, 0.05, 0.5, 0.05, 0xe8ecec, -0.45, 0.25, FWD * 1.25);
      box(g, 0.05, 0.5, 0.05, 0xe8ecec, 0.45, 0.25, FWD * 1.25);
      box(g, 0.95, 0.05, 0.05, 0xe8ecec, 0, 0.5, FWD * 1.25);
      const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 1), mat(0xf2f4f4, 0.5));
      ball.position.set(0.06, 0.11, FWD * 0.42); g.add(ball);
      return { ball: ball, z0: FWD * 0.42, surface: 0 };
    }
  };

  // 每个小窗视图独立构建一套（THREE 对象单父级，不能跨视图共享同一根节点）
  function get(mode) {
    const g = new THREE.Group();
    const sh = shadow(g);
    const fn = BUILD[mode] || BUILD.squat;
    const handles = fn(g) || {};
    handles.root = g; handles.shadow = sh; handles.mode = mode;
    if (handles.chain) sh.visible = false;
    return handles;
  }
  function dispose(k) {
    if (!k || !k.root) return;
    k.root.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
    });
  }

  const _v = new THREE.Vector3();
  function tick(k, t, ctx) {
    // 接触阴影随重心高度收缩变淡
    const h = Math.max(0, ctx.hips ? ctx.hips.y : 0.9);
    const f = Math.max(0.35, 1.25 - h * 0.55);
    k.shadow.scale.setScalar(f);
    k.shadow.material.opacity = 0.05 + 0.13 * f;
    if (ctx.hips) { k.shadow.position.x = ctx.hips.x; k.shadow.position.z = ctx.hips.z; }

    if (k.scroll) {
      const spacing = k.span / (k.scroll.children.length - 1);
      k.scroll.position.z = -FWD * ((t * k.speed) % 1) * spacing;
    }
    if (k.chain) {
      const s = (t * STAIR.stepsPerLoop + k.chainPhase) % 1;
      k.chain.position.y = -k.chainDir * s * STAIR.rise;
      k.chain.position.z = s * STAIR.run;
    }
    if (k.dumbbells && ctx.hands) {
      k.dumbbells.forEach(function (m, i) {
        const h = ctx.hands[i];
        m.position.set(h.x, h.y - 0.045, h.z);
      });
    }
    if (k.bar && ctx.hands) {
      _v.copy(ctx.hands[0]).add(ctx.hands[1]).multiplyScalar(0.5);
      k.bar.position.set(_v.x, Math.max((k.surface || 0) + 0.18, _v.y), _v.z);
    }
    if (k.bike && (ctx.hipsCenter || ctx.hips)) {
      const fit = cycleFit(ctx.hipsCenter || ctx.hips);
      k.bike.position.set(fit.x, 0, fit.z);
      k.bike.updateMatrixWorld(true);
      // 座垫/把立随髋高伸缩：低座姿态整车不缩，只把座垫降下来
      k.saddle.position.y = fit.saddleY - 0.0175;
      span(k.seatPost, [0, 0.70, 0.10], [0, fit.saddleY - 0.03, 0.13]);
      // 车把对准双手：手握哪里，把横就伸到哪里（把立拉长补上车架到头管的距离），杜绝手悬空
      if (ctx.hands) {
        _v.copy(ctx.hands[0]).add(ctx.hands[1]).multiplyScalar(0.5);
        k.bar.position.set(_v.x - fit.x, _v.y, _v.z - fit.z);
        span(k.stem, [0, 0.76, -0.30], [k.bar.position.x, k.bar.position.y - 0.01, k.bar.position.z]);
      } else {
        k.bar.position.y = fit.barY;
        span(k.stem, [0, 0.76, -0.30], [0, fit.barY, -0.19]);
      }
      const phi = (t % 1) * Math.PI * 2;
      k.pedals.forEach(function (p, i) {
        const ped = cyclePedal(fit, phi + i * Math.PI);
        const foot = ctx.feet && ctx.feet[i];
        const px = foot ? foot.x : (i ? 0.09 : -0.09);
        p.position.set(px, ped.y - 0.01, ped.z);
        span(k.cranks[i], [0, CYCLE.bbY, CYCLE.bbZ], [px - fit.x, ped.y - 0.01, ped.z - fit.z]);
      });
      k.wheels.forEach(function (w) { w.rotation.x = phi * 3; });
    }
    if (k.ball) {
      const u = Math.max(0, Math.min(1, (t - 0.66) / 0.34));
      k.ball.position.z = k.z0 + FWD * u * u * 0.85;
      k.ball.position.y = 0.11 + Math.sin(Math.min(1, u) * Math.PI) * 0.12;
      k.ball.rotation.x = -FWD * u * 6;
    }
  }

  return { get: get, tick: tick, dispose: dispose, cycleFit: cycleFit, cyclePedal: cyclePedal, CYCLE: CYCLE, STAIR: STAIR, stairFoot: stairFoot, stairSurface: stairSurface, slopeFoot: slopeFoot };
})();