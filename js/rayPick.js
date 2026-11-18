/* =========================================================================
 * rayPick.js —— 鼠标拾取（点击解剖部位 → 右侧显示说明）
 * -------------------------------------------------------------------------
 * 关键点：
 *   1) 分屏模式下画布被切成左右两块，需要先判断鼠标落在哪一半，
 *      再把屏幕坐标换算成「该视口内」的 NDC 坐标，否则射线会偏移；
 *   2) 拖拽旋转时不应触发拾取，用按下/抬起的位移阈值区分“点击”与“拖拽”；
 *   3) 选中后给部件加一层青色轮廓线（EdgesGeometry），不用改材质颜色，
 *      避免和热力红色互相干扰。
 * ======================================================================= */

window.RayPick = (function () {
  'use strict';

  const CLICK_MOVE_TOL = 6;   // 像素：移动超过该值视为拖拽

  class Picker {
    /**
     * @param {Object} opt
     *   opt.canvas      THREE.WebGLRenderer 的 domElement
     *   opt.getViews    () => [{camera, model}, ...]（0=左/单视图，1=右）
     *   opt.isSplit     () => boolean
     *   opt.onPick      (partId, viewIndex) => void
     *   opt.onEmpty     () => void
     */
    constructor(opt) {
      this.canvas = opt.canvas;
      this.getViews = opt.getViews;
      this.isSplit = opt.isSplit || function () { return false; };
      this.getViewports = opt.getViewports || null;   // 优先：[{left,top,w,h,index}]（CSS px，画布内）
      this.getBlockRects = opt.getBlockRects || null; // [{left,top,w,h}]：落在这些画中画上时不拾取
      this.onPick = opt.onPick || function () {};
      this.onEmpty = opt.onEmpty || function () {};

      this.raycaster = new THREE.Raycaster();
      this.ndc = new THREE.Vector2();
      this._down = null;
      this._selected = [];      // 当前高亮的轮廓对象
      this.selectedPart = null;

      this._bind();
    }

    _bind() {
      const el = this.canvas;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;                    // 只响应左键
        this._down = { x: e.clientX, y: e.clientY, t: Date.now() };
      });

      el.addEventListener('pointerup', (e) => {
        if (e.button !== 0 || !this._down) return;
        const dx = e.clientX - this._down.x;
        const dy = e.clientY - this._down.y;
        const moved = Math.sqrt(dx * dx + dy * dy);
        const dt = Date.now() - this._down.t;
        this._down = null;
        if (moved > CLICK_MOVE_TOL || dt > 700) return;  // 拖拽 / 长按不算点击
        this.pick(e);
      });

      // 鼠标样式提示
      el.addEventListener('pointermove', (e) => {
        if (e.buttons) { el.style.cursor = 'grabbing'; return; }
        el.style.cursor = this._hitTest(e) ? 'pointer' : 'grab';
      });
    }

    /** 屏幕坐标 → {viewIndex, view, ndc} */
    _resolve(e) {
      const views = this.getViews();
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const w = rect.width;
      const h = rect.height;

      // 画中画（如人体小窗）覆盖在主画面上：点击它不参与主画面拾取
      if (this.getBlockRects) {
        const blocks = this.getBlockRects() || [];
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (x >= b.left && x <= b.left + b.w && y >= b.top && y <= b.top + b.h) return null;
        }
      }

      let index = 0, localX = x, localY = y, vw = w, vh = h;
      if (this.getViewports) {
        // 主画面是全身模型；膝关节改为画布右上角小视口，只有落在小视口内才拾取
        const specs = this.getViewports() || [];
        const s = specs.filter(function (s2) {
          return x >= s2.left && x <= s2.left + s2.w && y >= s2.top && y <= s2.top + s2.h;
        })[0];
        if (!s) return null;
        index = (s.index !== undefined) ? s.index : (s.idx || 0);
        localX = x - s.left;
        localY = y - s.top;
        vw = s.w;
        vh = s.h;
      } else if (this.isSplit() && views.length > 1) {
        vw = w / 2;
        if (x >= w / 2) { index = 1; localX = x - w / 2; }
      }
      const view = views[index];
      if (!view) return null;

      this.ndc.set(
        (localX / vw) * 2 - 1,
        -(localY / vh) * 2 + 1
      );
      return { index: index, view: view, ndc: this.ndc };
    }

    /** 射线检测，返回 {mesh, partId, viewIndex} 或 null */
    _hitTest(e) {
      const hit = this._resolve(e);
      if (!hit) return null;
      const view = hit.view;
      if (!view.model || !view.model.pickables.length) return null;

      this.raycaster.setFromCamera(hit.ndc, view.camera);
      const list = view.model.pickables.filter(function (m) {
        return isVisibleChain(m);
      });
      const hits = this.raycaster.intersectObjects(list, false);
      if (!hits.length) return null;
      const mesh = hits[0].object;
      return { mesh: mesh, partId: mesh.userData.part, viewIndex: hit.index };
    }

    pick(e) {
      const result = this._hitTest(e);
      if (!result) {
        this.clear();
        this.onEmpty(e);
        return;
      }
      this.clear();
      this.selectedPart = result.partId;
      this._highlight(result.mesh);
      this.onPick(result.partId, result.viewIndex);
    }

    /** 给选中的网格加轮廓线 */
    _highlight(mesh) {
      if (!mesh.geometry) return;
      let edges;
      try {
        edges = new THREE.EdgesGeometry(mesh.geometry, 42);
      } catch (err) {
        return;
      }
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({
          color: 0x0f8b8d,
          transparent: true,
          opacity: 0.95,
          depthTest: true
        })
      );
      line.name = '__pick_outline';
      line.renderOrder = 2;
      // 略微放大，避免与本体 z-fighting
      line.scale.setScalar(1.008);
      mesh.add(line);
      this._selected.push(line);
    }

    clear() {
      this._selected.forEach((line) => {
        if (line.parent) line.parent.remove(line);
        if (line.geometry) line.geometry.dispose();
        if (line.material) line.material.dispose();
      });
      this._selected = [];
      this.selectedPart = null;
    }
  }

  /** 网格自身及其所有父节点都可见，才算可拾取 */
  function isVisibleChain(obj) {
    let o = obj;
    while (o) {
      if (!o.visible) return false;
      o = o.parent;
    }
    return true;
  }

  return { Picker: Picker };
})();
