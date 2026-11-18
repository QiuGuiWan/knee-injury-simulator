// 从 human-atlas 公开几何（BodyParts3D 4.0, CC BY 4.0）重建网页用蒙皮人体资产。
// 用法: node tools/build_human_from_atlas.mjs <atlas目录> [输出目录]
//   atlas 目录需含 atlas.json 与 body-*.bin.gz（见 public/models/，GitHub API raw 可下载）
// 只保留 muscular + skeletal 两个系统，并剔除肌腱/韧带/筋膜/血管/神经等表面碎片，
// 得到与参考图谱一致的「红色肌肉 + 象牙骨」连贯形体；再做网格焊接减面、
// 平滑法线、按组织着色、对 17 根骨骼计算平滑蒙皮权重，bake 成 human.json/human.bin。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SRC = process.argv[2] || 'D:/github/knee-test/atlas';
const OUT = process.argv[3] || path.resolve('assets/models');
const CELL = 0.006; // 焊接网格 6mm：小窗渲染约 1px≈8mm，视觉无损

const atlas = JSON.parse(fs.readFileSync(path.join(SRC, 'atlas.json'), 'utf8'));
const oldMeta = JSON.parse(fs.readFileSync(path.join(OUT, 'human.json'), 'utf8'));
const BONES = oldMeta.bones;

const DROP = /\b(tendon|ligament|fascia|aponeurosis|retinaculum|sheath|bursa|membrane|raphe|nerve|artery|vein|duct|gland|trunk|plexus|tract)\b|tooth|teeth|gingiva|ossicle|hyoid|sesamoid|cartilage|eyeball|lens|cornea|iris|retina|tympanic|auditory|ossicular/i;
const keep = atlas.parts.filter(p => (p.system === 'muscular' || p.system === 'skeletal') && !DROP.test(p.name) && p.vertexCount >= 24);

const chunks = new Map();
function chunkBuf(i) {
  if (!chunks.has(i)) {
    const gz = fs.readFileSync(path.join(SRC, 'body-' + i + '.bin.gz'));
    chunks.set(i, zlib.gunzipSync(gz));
  }
  return chunks.get(i);
}

// ---- 1. 读取并合并原始顶点 ----
const pos = [], nrm = [], col = [], idx = [];
const tissueOf = [];
// 解剖语义分组（按 BodyParts3D 部位名 + 左右标签）：
// 手臂器官只绑该侧臂骨链；躯干/腿部器官完全排除臂骨——否则自然垂手贴髋时，
// 按最近距离会把 hand/fore 权重错绑到骨盆和大腿，摆臂时把人"拽"成怪物。
const ARM_RE = /\b(brachii|brachialis|coracobrachialis|deltoid|brachioradialis|pronator|supinator|palmaris|anconeus)\b|flexor carpi|extensor carpi|flexor digitorum(?! (longus|brevis))|extensor digitorum(?! (longus|brevis))|extensor digiti|extensor indicis|pollicis|opponens|abductor digiti|flexor digiti|of (right|left) hand|lumbrical|interossei|humerus|radius|ulna|metacarpal|\bcarpal\b|scaphoid|lunate|triquetr|pisiform|trapezium|trapezoid|capitate|hamate|phalanx of (right|left) (thumb|(index|little|middle|ring) finger)/i;
const TOE_RE = /\b(toe|hallucis|foot)\b/i;
const GIRDLE_RE = /scapula|clavicle|subscapularis|supraspinatus|infraspinatus|teres (major|minor)|rhomboid/i;
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
const catOf = [];   // 0=躯干/腿 1=臂 2=肩带
const sSideOf = []; // 'R'|'L'|''
for (const p of keep) {
  const buf = chunkBuf(p.chunk);
  const base = pos.length / 3;
  const pv = new Float32Array(buf.buffer, buf.byteOffset + p.positions, p.vertexCount * 3);
  const nv = new Int16Array(buf.buffer, buf.byteOffset + p.normals, p.vertexCount * 3);
  const iv = new Uint32Array(buf.buffer, buf.byteOffset + p.indices, p.indexCount);
  const h = hash(p.id);
  // 焊接键带类别与侧别：臂/肩带/躯干接缝处不得合并顶点。
  // 若跨类别焊接，躯干三角形会拿到一个臂绑定的顶点，摆臂时被拉成条刺。
  const cat = TOE_RE.test(p.name) ? 0 : (ARM_RE.test(p.name) ? 1 : (GIRDLE_RE.test(p.name) ? 2 : 0));
  const sd = /\bleft\b/i.test(p.name) ? 'L' : (/\bright\b/i.test(p.name) ? 'R' : '');
  const ckey = cat + (cat ? sd : '');
  let r, g, b;
  if (p.system === 'muscular') { r = 126 + h * 22; g = 34 + h * 10; b = 30 + h * 9; }
  else { r = 226 + h * 14; g = 214 + h * 12; b = 188 + h * 12; }
  for (let i = 0; i < p.vertexCount; i++) {
    pos.push(pv[i * 3], pv[i * 3 + 1], pv[i * 3 + 2]);
    nrm.push(nv[i * 3] / 32767, nv[i * 3 + 1] / 32767, nv[i * 3 + 2] / 32767);
    col.push(r, g, b);
    catOf.push(cat); sSideOf.push(sd);
  }
  for (let i = 0; i < p.indexCount; i++) idx.push(iv[i] + base);
}
console.log('parts', keep.length, 'raw verts', pos.length / 3, 'raw tris', idx.length / 3);

// ---- 2. 网格焊接减面 ----
const cellMap = new Map();
const remap = new Uint32Array(pos.length / 3);
const wPos = [], wCol = [], wAcc = [], wCat = [], wSide = [];
for (let i = 0; i < pos.length / 3; i++) {
  const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
  const key = catOf[i] + (catOf[i] ? sSideOf[i] : '') + '|' + Math.round(x / CELL) + ',' + Math.round(y / CELL) + ',' + Math.round(z / CELL);
  let t = cellMap.get(key);
  if (t === undefined) {
    t = wPos.length / 3;
    cellMap.set(key, t);
    wPos.push(x, y, z); wCol.push(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]); wAcc.push(1);
    wCat.push(catOf[i]); wSide.push(sSideOf[i]);
  } else {
    wCol[t * 3] += col[i * 3]; wCol[t * 3 + 1] += col[i * 3 + 1]; wCol[t * 3 + 2] += col[i * 3 + 2]; wAcc[t]++;
    const pr = { 0: 0, 2: 1, 1: 2 }; // 合并优先：臂 > 肩带 > 躯干
    if (pr[catOf[i]] > pr[wCat[t]]) { wCat[t] = catOf[i]; wSide[t] = sSideOf[i]; }
  }
  remap[i] = t;
}
const wIdx = [];
for (let i = 0; i < idx.length; i += 3) {
  const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]];
  if (a !== b && b !== c && a !== c) wIdx.push(a, b, c);
}
const VC = wPos.length / 3;
for (let i = 0; i < VC; i++) { const n = wAcc[i]; wCol[i * 3] /= n; wCol[i * 3 + 1] /= n; wCol[i * 3 + 2] /= n; }
console.log('welded verts', VC, 'tris', wIdx.length / 3);

// ---- 3. 平滑法线（面积加权） ----
const nAcc = new Float64Array(VC * 3);
for (let i = 0; i < wIdx.length; i += 3) {
  const a = wIdx[i] * 3, b = wIdx[i + 1] * 3, c = wIdx[i + 2] * 3;
  const e1x = wPos[b] - wPos[a], e1y = wPos[b + 1] - wPos[a + 1], e1z = wPos[b + 2] - wPos[a + 2];
  const e2x = wPos[c] - wPos[a], e2y = wPos[c + 1] - wPos[a + 1], e2z = wPos[c + 2] - wPos[a + 2];
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  for (const v of [a, b, c]) { nAcc[v] += nx; nAcc[v + 1] += ny; nAcc[v + 2] += nz; }
}
const nOut = new Int16Array(VC * 3);
for (let i = 0; i < VC; i++) {
  const x = nAcc[i * 3], y = nAcc[i * 3 + 1], z = nAcc[i * 3 + 2];
  const l = Math.hypot(x, y, z) || 1;
  nOut[i * 3] = Math.round(x / l * 32767); nOut[i * 3 + 1] = Math.round(y / l * 32767); nOut[i * 3 + 2] = Math.round(z / l * 32767);
}

// ---- 4. 骨骼世界关节点 + 平滑蒙皮权重 ----
const world = {};
for (const d of BONES) {
  const p = d.parent ? world[d.parent] : [0, 0, 0];
  world[d.name] = [p[0] + d.pos[0], p[1] + d.pos[1], p[2] + d.pos[2]];
}
const EXT = { head: [0, 0.14, 0.02], handR: [-0.03, -0.12, 0.03], handL: [0.03, -0.12, 0.03], footR: [0, -0.04, 0.16], footL: [0, -0.04, 0.16] };
const CHILD = { hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head', armR: 'foreR', armL: 'foreL', foreR: 'handR', foreL: 'handL', legR: 'shinR', legL: 'shinL', shinR: 'footR', shinL: 'footL' };
const segs = BONES.map((d, i) => {
  const a = world[d.name];
  const b = CHILD[d.name] ? world[CHILD[d.name]] : [a[0] + EXT[d.name][0], a[1] + EXT[d.name][1], a[2] + EXT[d.name][2]];
  return { i, a, b };
});
function segDist(px, py, pz, s) {
  const ax = s.a[0], ay = s.a[1], az = s.a[2];
  const bx = s.b[0] - ax, by = s.b[1] - ay, bz = s.b[2] - az;
  const L2 = bx * bx + by * by + bz * bz || 1e-9;
  let t = ((px - ax) * bx + (py - ay) * by + (pz - az) * bz) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + bx * t), dy = py - (ay + by * t), dz = pz - (az + bz * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
const sIdx = new Uint8Array(VC * 4), sW = new Uint8Array(VC * 4);
const hipY = world.legR[1];
const TORSO = new Set(['hips', 'spine', 'chest', 'neck', 'head']);
const segByName = {};
segs.forEach(s => { segByName[BONES[s.i].name] = s; });
function pick(idxList, px, py, pz) {
  // 三次方衰减：权重更贴近所属骨骼，减小关节过渡带内"跟不上"的肌肉面积，
  // 避免大幅屈髋时肌群与股骨错位露出大片骨面
  const d = idxList.map(s => ({ i: s.i, w: 1 / Math.pow(segDist(px, py, pz, s) + 0.015, 3) }));
  d.sort((a, b) => b.w - a.w);
  const top = d.slice(0, 3);
  const sum = top.reduce((s, t) => s + t.w, 0) || 1;
  return top.map(t => ({ i: t.i, q: t.w / sum }));
}
for (let i = 0; i < VC; i++) {
  const px = wPos[i * 3], py = wPos[i * 3 + 1], pz = wPos[i * 3 + 2];
  const side = px < 0 ? 'R' : 'L';
  const cat = wCat[i], sd = wSide[i] || side;
  let cand;
  if (cat === 1) {
    // 手臂器官：只绑该侧 臂→前臂→手
    cand = ['arm' + sd, 'fore' + sd, 'hand' + sd].map(n => segByName[n]);
  } else if (cat === 2) {
    // 肩带（肩胛/锁骨/肩袖）：胸 + 该侧臂链
    cand = ['chest', 'arm' + sd, 'fore' + sd].map(n => segByName[n]);
  } else {
    // 躯干/腿：绝不允许臂骨参与；只排除对侧腿，同侧腿按距离自然过渡
    // （硬性中线截断会在骨盆/臀接缝处造成权重跳变，摆腿时拉出尖刺）
    cand = ['hips', 'spine', 'chest', 'neck', 'head'].map(n => segByName[n])
      .concat(['leg' + side, 'shin' + side, 'foot' + side].map(n => segByName[n]));
  }
  const top = pick(cand, px, py, pz);
  let acc = 0;
  for (let k = 0; k < 4; k++) {
    if (k < top.length) {
      const q = k === top.length - 1 ? 255 - acc : Math.round(top[k].q * 255);
      sIdx[i * 4 + k] = top[k].i; sW[i * 4 + k] = q; acc += q;
    } else { sIdx[i * 4 + k] = 0; sW[i * 4 + k] = 0; }
  }
}

// ---- 5. bake bin / json（与 bodyFigure.parseAsset 布局一致） ----
const pB = new Float32Array(wPos);
const cB = new Uint8Array(VC * 3);
for (let i = 0; i < VC * 3; i++) cB[i] = Math.max(0, Math.min(255, Math.round(wCol[i])));
const iB = new Uint32Array(wIdx);
const align = n => (n + 3) & ~3;
const o = {};
o.positions = 0;
o.normals = align(o.positions + pB.byteLength);
o.colors = align(o.normals + nOut.byteLength);
o.skinIndex = align(o.colors + cB.byteLength);
o.skinWeight = align(o.skinIndex + sIdx.byteLength);
o.indices = align(o.skinWeight + sW.byteLength);
const total = align(o.indices + iB.byteLength);
const bin = Buffer.alloc(total);
Buffer.from(pB.buffer).copy(bin, o.positions);
Buffer.from(nOut.buffer).copy(bin, o.normals);
Buffer.from(cB.buffer).copy(bin, o.colors);
Buffer.from(sIdx.buffer).copy(bin, o.skinIndex);
Buffer.from(sW.buffer).copy(bin, o.skinWeight);
Buffer.from(iB.buffer).copy(bin, o.indices);
let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
for (let i = 0; i < VC; i++) for (let k = 0; k < 3; k++) { const v = wPos[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
const meta = { vertexCount: VC, indexCount: wIdx.length, offsets: o, bones: BONES, bounds: [mn, mx], parts: keep.length, source: 'BodyParts3D 4.0 via ashemag/human-atlas (CC BY 4.0)' };
fs.writeFileSync(path.join(OUT, 'human.bin'), bin);
fs.writeFileSync(path.join(OUT, 'human.json'), JSON.stringify(meta));
fs.writeFileSync(path.join(OUT, 'human-data.js'), 'window.__HUMAN_EMBED__=' + JSON.stringify({ meta, b64: bin.toString('base64') }) + ';\n');
console.log('written human.bin', bin.length, 'human-data.js', fs.statSync(path.join(OUT, 'human-data.js')).size);