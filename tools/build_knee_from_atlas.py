# -*- coding: utf-8 -*-
"""从 Z-Anatomy（BodyParts3D 血统）抽取右侧膝关节，生成网页用的分层 knee.glb。

为什么用它
----------
Z-Anatomy 是开源的 Blender 解剖图谱（CC BY-SA 4.0），骨面来自 BodyParts3D，
是按真实解剖标本轮廓建的；比程序化拼出来的几何体真实得多，而且半月板、
交叉韧带、侧副韧带、髌骨都是**独立网格**——这正是本项目的硬性要求。

用法
----
1) 下载 Z-Anatomy 模板（约 83 MB，解压后 Startup.blend 约 293 MB）：
      https://codeload.github.com/Nemo1999/The-blend/zip/refs/heads/master
   解压出 Z-Anatomy/Startup.blend，放到 tools/atlas/Startup.blend
2) 生成模型：
      blender -b tools/atlas/Startup.blend --python tools/build_knee_from_atlas.py
   可选：加 -- --preview 先渲一张预览图看形态
"""

import bpy
import bmesh
import math
import os
import sys
import json
import struct
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_knee_model as base          # 复用枢轴/动作/导出逻辑，避免两份动画定义

ROOT = os.path.dirname(HERE)
OUT_PATH = os.path.join(ROOT, 'assets', 'models', 'knee.glb')
PREVIEW = os.path.join(ROOT, 'docs', 'atlas-preview.png')

# 目标尺度：整段（股骨近端到胫骨远端）约 6.2 个单位，与内置模型保持一致
SCALE = 7.2
# 胫骨平台单独切出来的厚度（真实约 2 cm），用于「后跟硬落地」冲击高亮
PLATEAU_THICK = 0.022
# 股骨/胫骨各保留关节附近多长（缩放后的单位，1 单位≈0.14 m）
KEEP_FEMUR = 1.18
KEEP_TIBIA = 1.05
# 髌骨前后方向压缩比例（图谱里的髌骨过厚）
PATELLA_THICK = 0.165          # 髌骨厚度（约 2.3 cm）
PATELLA_HEIGHT = 0.345         # 髌骨上下高度（约 4.8 cm）
PATELLA_EMBED = 0.016          # 后表面压进股骨滑车的深度（约 2 mm，防悬空）
PATELLA_APEX_Z = -0.015        # 髌骨尖（下极）高度：关节线略下方约 2 mm
PATELLA_CONTACT_TOP = 0.285    # 滑车上缘：再往上股骨前表面就退回骨干了
MENISCUS_THICKEN = 1.5         # 半月板厚度夸张系数（真实太薄，投影上看不见）

# 源对象名（Z-Anatomy 的 .r 后缀表示右侧）
SOURCES = [
    # (atlas 对象名, 输出名, 材质键, 挂到哪个枢轴)
    ('Femur.r',                        'Femur_Body',        'bone',     'femur'),
    ('Tibia.r',                        'Tibia_Body',        'bone',     'tibia'),
    ('Patella.r',                      'Patella',           'patella',  'patella'),
    ('Medial meniscus.r',              'Meniscus_Medial',   'meniscus', 'tibia'),
    ('Lateral meniscus.r',             'Meniscus_Lateral',  'meniscus', 'tibia'),
    ('Anterior cruciate ligament.r',   'ACL',               'ligament', 'femur'),
    ('Posterior cruciate ligament.r',  'PCL',               'ligament', 'femur'),
    # 说明：这一版 Z-Anatomy 里的侧副韧带只有「深部」残片（10 面）和 3 面的
    # 退化网格，做成高亮反而更难看，所以只保留交叉韧带；侧副韧带用网页端
    # 的文字说明补足（拣选不到时 UI 会退回显示韧带层总述）。
    # ('Tibial collateral ligament.r', 'MCL', 'ligament', 'femur'),
    # ('Fibular collateral ligament.r', 'LCL', 'ligament', 'femur'),
]


# ---------------------------------------------------------------------------
# 1. 取件与归一化
# ---------------------------------------------------------------------------

def get_object(name):
    """按名字取对象，取不到返回 None（不同版本的 Z-Anatomy 命名略有差异）。"""
    ob = bpy.data.objects.get(name)
    if ob and ob.type == 'MESH':
        return ob
    return None


def mesh_world_copy(ob):
    """复制一份网格，并把世界变换烘进顶点，这样后续不用管父级/旋转。"""
    me = ob.data.copy()
    me.transform(ob.matrix_world)
    return me


def bounds(me):
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    return (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))


def plate_center(me, top_z, depth=0.012):
    """取胫骨平台顶面附近顶点的质心 —— 作为膝关节中心（也就是屈膝轴位置）。"""
    pts = [v.co for v in me.vertices if v.co.z > top_z - depth]
    if not pts:
        return Vector((0, 0, top_z))
    c = Vector((0, 0, 0))
    for p in pts:
        c += p
    c /= len(pts)
    c.z = top_z
    return c


# ---------------------------------------------------------------------------
# 2. 网格处理小工具
# ---------------------------------------------------------------------------

def clean_mesh(me, weld=1e-5, smooth=True, subdiv=0):
    """焊接重复顶点、统一法线、平滑着色，必要时做一次细分（半月板细化用）。"""
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=weld)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if subdiv:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges, cuts=subdiv,
                                  use_grid_fill=True, smooth=0.6)
    bm.to_mesh(me)
    bm.free()
    me.update()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    return me


def cut_at_z(me, z_cut, keep_above):
    """沿水平面切开网格，只保留一侧，并把切面补上（否则会看到空心）。"""
    bm = bmesh.new()
    bm.from_mesh(me)
    geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
    res = bmesh.ops.bisect_plane(
        bm, geom=geom,
        plane_co=(0, 0, z_cut), plane_no=(0, 0, 1),
        # bmesh 里 clear_inner 清的是法线负方向（平面下方），clear_outer 反之
        clear_inner=keep_above, clear_outer=not keep_above,
    )
    cut_edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
    if cut_edges:
        bmesh.ops.edgeloop_fill(bm, edges=cut_edges)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    return me


def split_by_plane(me_upper, z_cut):
    """把胫骨沿水平面切开：上半做「胫骨平台」，下半保留为「胫骨体」。

    两个部分都补上切面，避免出现漏空的开口（半透明材质下会看穿）。
    """
    lower = me_upper.copy()
    cut_at_z(me_upper, z_cut, True)
    cut_at_z(lower, z_cut, False)
    return lower


def make_material(name, rgb, roughness=0.62, opaque=True):
    """新建 Principled 材质。

    注意：在 Z-Anatomy 的 Startup.blend 里 `use_nodes=True` 不一定会自动生成
    名为 'Principled BSDF' 的节点（默认节点树来自该文件的启动配置），所以要按
    节点类型查找，找不到就手动建一个。
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf is None:
        nodes.clear()
        out = nodes.new('ShaderNodeOutputMaterial')
        bsdf = nodes.new('ShaderNodeBsdfPrincipled')
        mat.node_tree.links.new(bsdf.outputs[0], out.inputs['Surface'])

    bsdf.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    # Workbench 预览读的是视口显示色（diffuse_color），不是节点里的 Base Color
    mat.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    bsdf.inputs['Roughness'].default_value = roughness
    if 'Metallic' in bsdf.inputs:
        bsdf.inputs['Metallic'].default_value = 0.0
    mat.blend_method = 'OPAQUE' if opaque else 'BLEND'
    return mat


def srgb(hexv):
    r = ((hexv >> 16) & 255) / 255.0
    g = ((hexv >> 8) & 255) / 255.0
    b = (hexv & 255) / 255.0
    # sRGB → 线性（Blender 的 Base Color 是线性值）
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (f(r), f(g), f(b))


# ---------------------------------------------------------------------------
# 3. 主流程
# ---------------------------------------------------------------------------

# 髌骨盾形截面表：(z, cx, cy, rx, ry)
#   上宽下尖、前面（-Y）隆起，**后缘对齐成一条直线**（下面 cy + ry 恒等于 0.066）。
#   这一点很关键：如果各截面后缘不在同一平面上，髌骨就变成一块前倾的楔子，
#   下极会翘出去 1 cm 以上，渲染出来像「悬空的一块石头」。
PATELLA_SECTIONS = [
    # 上极：窄而薄
    (0.270, 0.0, 0.040, 0.062, 0.026),
    (0.215, 0.0, 0.016, 0.132, 0.050),
    # 最宽处在上 1/3（真实髌骨就是这样，不是中间最宽）
    (0.135, 0.0, 0.004, 0.182, 0.062),
    (0.040, 0.0, 0.000, 0.196, 0.066),
    (-0.060, 0.0, 0.002, 0.186, 0.064),
    (-0.150, 0.0, 0.011, 0.152, 0.055),
    (-0.230, 0.0, 0.026, 0.104, 0.040),
    # 下极：收成一个尖（髌骨尖），尖略向后（+Y）——正常髌骨尖就朝后下方
    (-0.290, 0.0, 0.042, 0.052, 0.024),
    (-0.325, 0.0, 0.056, 0.018, 0.010),
]


def front_profile(me, cx, x_win=0.10, z_lo=0.0, z_hi=0.34, bands=17):
    """量出股骨前表面轮廓 y = f(z)，返回一个可在任意 z 上求值的函数。

    只统计 x 在髌骨宽度范围内（|x-cx| < x_win）、z 在滑车区间内的顶点，
    每层取最小的 y（-Y 是前方，最小 y 即最靠前的骨面）。这样得到的就是
    髌骨实际会压住的那条「滑车沟—内/外侧嵴」轮廓。
    """
    table = []
    step = (z_hi - z_lo) / bands
    for i in range(bands):
        a, b = z_lo + step * i, z_lo + step * (i + 1)
        band = [v.co.y for v in me.vertices
                if a <= v.co.z < b and abs(v.co.x - cx) < x_win]
        if band:
            table.append(((a + b) / 2, min(band)))
    if not table:
        return None
    zs = [t[0] for t in table]
    ys = [t[1] for t in table]

    def f(z, _zs=zs, _ys=ys):
        if z <= _zs[0]:
            return _ys[0]
        if z >= _zs[-1]:
            return _ys[-1]
        for i in range(len(_zs) - 1):
            if _zs[i] <= z <= _zs[i + 1]:
                t = (z - _zs[i]) / max(_zs[i + 1] - _zs[i], 1e-9)
                return _ys[i] * (1 - t) + _ys[i + 1] * t
        return _ys[-1]

    print('[front] 股骨前表面轮廓 z=%.2f→%.2f  y=%.3f→%.3f'
          % (zs[0], zs[-1], ys[0], ys[-1]))
    return f


def fit_front(front, z0, z1, n=9):
    """在 [z0, z1] 上对前表面轮廓做一次最小二乘直线拟合，返回 (斜率 k, 截距 c)。

    为什么要拟合而不是直接用两个端点：股骨滑车是个「鼓包」，最前点在
    z≈0.15 附近，往上往下都往后退。拿端点连线会得出错误的倾角；拟合出的
    直线才是髌骨那块平直后表面应该对齐的参考面。
    """
    zs = [z0 + (z1 - z0) * i / (n - 1) for i in range(n)]
    ys = [front(z) for z in zs]
    mz = sum(zs) / n
    my = sum(ys) / n
    den = sum((z - mz) ** 2 for z in zs)
    k = (sum((z - mz) * (y - my) for z, y in zip(zs, ys)) / den) if den else 0.0
    return k, my - k * mz


class PatellaFit(object):
    """髌骨贴合参数：用一个平面近似股骨滑车面。

    平面过「最靠前的骨点」(z_peak, y_min)——那是内外侧嵴最凸的地方，也就是
    髌骨真正压住的位置；斜率取轮廓拟合值，再整体压进 PATELLA_EMBED。

    不用拟合直线直接当参考面：股骨滑车是个「鼓包」，最前点在 z≈0.19，
    上下都往后退，用直线对齐会让髌骨整块往后缩，中段反而裂出 6 mm 缝。
    过最前点 + 平面近似，才是「贴着嵴、两极稍微让开」的真实关系。
    """

    def __init__(self, y_min, z_peak, tilt):
        self.y_min = y_min
        self.z_peak = z_peak
        self.tilt = tilt

    def back(self, z):
        return (self.y_min + PATELLA_EMBED
                - math.tan(self.tilt) * (z - self.z_peak))

    def __str__(self):
        return ('前凸点 y=%.3f@z=%.2f 倾角=%.1f°'
                % (self.y_min, self.z_peak, math.degrees(self.tilt)))


def patella_shield(src_me, mat, anchor, fit=None):
    """按图谱髌骨的尺寸，造一块盾形的髌骨网格（世界坐标）。

    图谱里的髌骨是个圆椭球，缺「上宽下尖」的盾形特征，但它的**横向尺寸**
    是准确的。摆位不用它的包围盒，而是由股骨滑车表面反算（fit）。

    因为股骨前表面本身是斜的（越往上越靠前，落差 ~5 cm），只做平移的话，
    平直的后表面必然一头贴、一头翘，看起来就像悬空的一块石头。所以这里
    先按拟合斜率把髌骨绕 X 轴转一下，让后表面与滑车面平行，再整体压进去
    PATELLA_EMBED，保证上下两极都咬进骨面里。
    """
    b = bounds(src_me)
    width = max(b[1] - b[0], 0.01)
    height = PATELLA_HEIGHT
    cx, back_y, top_z = anchor

    ob = base.loft('Patella_shape', PATELLA_SECTIONS, mat, seg=40, subdiv=1)
    me = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)

    sb = bounds(me)
    sx = width / max(sb[1] - sb[0], 1e-6)
    sz = height / max(sb[5] - sb[4], 1e-6)
    sy = PATELLA_THICK / max(sb[3] - sb[2], 1e-6)
    me.transform(Matrix.Diagonal((sx, sy, sz, 1.0)))
    me.transform(Matrix.Translation((cx, 0, 0)))          # 先摆到目标 x 上

    # --- 按股骨前面的斜率把后表面转成平行 ---
    if fit is not None:
        me.transform(Matrix.Rotation(fit.tilt, 4, 'X'))   # 顶部向 -Y 倒
        # 旋转会把已经排好的 z 拉走，这里重新量后缘再对齐
        nb = bounds(me)
        z_mid = (nb[4] + nb[5]) / 2
        back_mid = max(v.co.y for v in me.vertices
                       if abs(v.co.z - z_mid) < height * 0.08)
        me.transform(Matrix.Translation((0, fit.back(z_mid) - back_mid, 0)))
        nb = bounds(me)
        me.transform(Matrix.Translation((0, 0, top_z - nb[5])))
    else:
        nb = bounds(me)
        me.transform(Matrix.Translation((cx - (nb[0] + nb[1]) / 2,
                                         back_y - nb[3],
                                         top_z - nb[5])))

    me.update()
    return clean_mesh(me, smooth=True)


def add_collaterals(fem_pivot, mat):
    """补上内 / 外侧副韧带。

    这一版 Z-Anatomy 的侧副韧带只有碎片（MCL 10 面、LCL 3 面），做出来既难看
    也无法高亮，干脆按真实起止点重新生成两条束带：起点直接取骨面上最外侧的
    顶点，所以一定贴在骨面上，不会悬空。
    """
    fem = bpy.data.objects.get('Femur_Body')
    tib = bpy.data.objects.get('Tibia_Body')
    if fem is None or tib is None:
        return []

    fpts = [v.co.copy() for v in fem.data.vertices]
    tpts = [v.co.copy() for v in tib.data.vertices]

    # 上髁：关节线附近、内外方向最突出的点
    near_joint = [p for p in fpts if 0.04 < p.z < 0.26]
    med_epi = max(near_joint, key=lambda p: p.x)
    lat_epi = min(near_joint, key=lambda p: p.x)

    # 胫骨侧附着点：平台下方 3~9 cm 的内侧缘 / 外侧缘
    shaft = [p for p in tpts if -0.55 < p.z < -0.12]
    med_tib = max(shaft, key=lambda p: p.x)
    lat_pool = [p for p in shaft if p.y > med_tib.y]      # 腓骨头在偏后外侧
    lat_tib = min(lat_pool or shaft, key=lambda p: p.x)

    out = []
    out.append(base.band('MCL', (med_epi.x - 0.02, med_epi.y, med_epi.z),
                         (med_tib.x - 0.02, med_tib.y + 0.02, med_tib.z + 0.02),
                         0.046, mat, flatten=0.45))
    out.append(base.band('LCL', (lat_epi.x + 0.02, lat_epi.y, lat_epi.z),
                         (lat_tib.x + 0.02, lat_tib.y - 0.03, lat_tib.z + 0.02),
                         0.034, mat, flatten=0.62))
    for ob in out:
        ob.parent = fem_pivot
    return out


def build():
    # --- 3.1 收集源网格 ---
    raw = {}
    for src, dst, matkey, side in SOURCES:
        ob = get_object(src)
        if ob is None:
            print('[skip] 找不到对象：%s' % src)
            continue
        raw[dst] = (mesh_world_copy(ob), matkey, side)
        print('[take] %-30s tris=%-5d -> %s' % (src, len(ob.data.polygons), dst))

    # 材质先建好：后面重做髌骨时要传给 loft
    mats = {
        'bone':     make_material('M_Bone',     srgb(0xD9CCB4), 0.66),
        'patella':  make_material('M_Patella',  srgb(0xD3C5AB), 0.68),
        'meniscus': make_material('M_Meniscus', srgb(0x5E97B8), 0.42),
        'ligament': make_material('M_Ligament', srgb(0x8FB5CF), 0.55),
    }

    if 'Femur_Body' not in raw or 'Tibia_Body' not in raw:
        raise RuntimeError('必须至少拿到股骨与胫骨，检查 atlas 文件是否正确')

    # --- 3.2 膝关节坐标系：原点放在胫骨平台中心 ---
    fem_me = raw['Femur_Body'][0]
    tib_me = raw['Tibia_Body'][0]
    fb = bounds(fem_me)
    tb = bounds(tib_me)
    knee = plate_center(tib_me, tb[5])

    print('[frame] 胫骨平台顶 z=%.4f 股骨髁底 z=%.4f 间隙=%.4f m'
          % (tb[5], fb[4], fb[4] - tb[5]))

    # 平移 + 缩放：把膝关节中心搬到原点，整段缩放到与内置模型同一量级
    mtx = (Matrix.Scale(SCALE, 4) @ Matrix.Translation(-knee))

    for dst, (me, _matkey, _side) in list(raw.items()):
        me.transform(mtx)
        raw[dst] = (clean_mesh(me, subdiv=1 if _matkey == 'meniscus' else 0),
                    _matkey, _side)

    # --- 3.2b 截断骨段：整根股骨+胫骨会让关节在画面里只剩一小截 ---
    # 真实的膝关节教学模型也都是短骨段，这里保留关节附近约 1/3：
    #   股骨留远端 1.15 单位、胫骨留近端 1.05 单位（约 15 / 14 cm 真实尺度）
    # 股骨要「远端」（关节那头，z 小），胫骨要「近端」（z 大），别留反了
    cut_at_z(raw['Femur_Body'][0], KEEP_FEMUR, keep_above=False)
    cut_at_z(raw['Tibia_Body'][0], -KEEP_TIBIA, keep_above=True)

    # --- 3.2c 半月板适度加厚 ---
    # 真实半月板只有 5 mm 厚，投影和 1080p 屏幕上几乎看不见；作为教学可视化
    # 适度夸张一点厚度（约 1.5 倍），既不影响形态判读，又能让受力高亮看得清。
    for key in ('Meniscus_Medial', 'Meniscus_Lateral'):
        if key in raw:
            m = raw[key][0]
            mb = bounds(m)
            cz = (mb[4] + mb[5]) / 2
            m.transform(Matrix.Translation((0, 0, cz)))
            m.transform(Matrix.Diagonal((1.0, 1.0, MENISCUS_THICKEN, 1.0)))
            m.transform(Matrix.Translation((0, 0, -cz)))
            raw[key] = (m, 'meniscus', 'tibia')

    # --- 3.2d 髌骨：改用放样的盾形 ---
    # 图谱里的髌骨是一颗圆润的「鹅蛋」，没有前面隆起、下面收尖的特征，
    # 放到画面里一眼像块石子。这里按图谱给出的横向尺寸与位置，换成一个
    # 上宽下尖的盾形放样体，前后位置由股骨滑车面反算（见 patella_shield）。
    if 'Patella' in raw:
        fem_me = raw['Femur_Body'][0]
        pb = bounds(raw['Patella'][0])
        cx = (pb[0] + pb[1]) / 2
        half_w = max((pb[1] - pb[0]) / 2, 0.06)
        # 高度不用图谱的：图谱髌骨偏扁（0.295），真实约 4.8 cm（0.345）。
        # 加高的部分全部长在上极；下极（髌骨尖）按解剖常识摆在关节线略下方
        # ——图谱那颗椭球的位置偏低 1 cm，照搬会让髌骨像堵在关节缝里。
        top_z = PATELLA_APEX_Z + PATELLA_HEIGHT
        print('[patella] 图谱髌骨 x=[%.3f,%.3f] z=[%.3f,%.3f] → cx=%.3f top_z=%.3f'
              % (pb[0], pb[1], pb[4], pb[5], cx, top_z))

        # 前后方向不靠猜：量出股骨滑车轮廓，让髌骨后表面顺着它走。
        # 量测区间只取「髌骨真正压住滑车」的那段：下界 z≈0.06（再往下是
        # 髁间窝，不是接触面），上界 min(top_z, 0.285)（滑车上缘以上股骨
        # 前表面已经往后退到骨干，髌骨上极本来就悬在那儿，算进去会把倾角
        # 拉到 20°，上极反而翘起来）。
        z_lo_prof = max(0.06, top_z - PATELLA_HEIGHT)
        z_hi_prof = min(top_z, PATELLA_CONTACT_TOP)
        front = front_profile(fem_me, cx, x_win=half_w + 0.05,
                              z_lo=z_lo_prof, z_hi=z_hi_prof, bands=12)
        fit = None
        if front is not None:
            k, _c = fit_front(front, z_lo_prof, z_hi_prof)
            zone = [v for v in fem_me.vertices
                    if z_lo_prof <= v.co.z <= z_hi_prof
                    and abs(v.co.x - cx) < half_w + 0.05]
            if zone:
                y_min = min(v.co.y for v in zone)
                # 最前点是一条嵴而不是一个尖，取 3 mm 内所有顶点的平均高度
                near = [v for v in zone if v.co.y < y_min + 0.003]
                z_peak = sum(v.co.z for v in near) / len(near)
                fit = PatellaFit(y_min, z_peak, math.atan(-k))
                print('[patella] %s；髌骨后表面 y: z=%.2f→%.3f  z=%.2f→%.3f'
                      % (fit, z_lo_prof, fit.back(z_lo_prof),
                         top_z, fit.back(top_z)))
        anchor = (cx, pb[2], top_z)          # 只用 x / 上极，前后由 fit 决定
        raw['Patella'] = (patella_shield(raw['Patella'][0], mats['patella'],
                                         anchor, fit=fit),
                          'patella', 'patella')

    # --- 3.3 切出胫骨平台 ---
    tib_me = raw['Tibia_Body'][0]
    z_cut = -PLATEAU_THICK * SCALE
    lower = split_by_plane(tib_me, z_cut)
    raw['Tibia_Plateau'] = (tib_me, 'bone', 'tibia')
    raw['Tibia_Body'] = (lower, 'bone', 'tibia')

    # --- 3.4 清场：只保留还要用的网格 ---
    keep = set()
    created = []
    for dst, (me, matkey, _side) in raw.items():
        ob = bpy.data.objects.new(dst, me)
        bpy.context.scene.collection.objects.link(ob)
        created.append(ob)
        keep.add(ob.name)

    for ob in list(bpy.data.objects):
        if ob.name not in keep:
            bpy.data.objects.remove(ob, do_unlink=True)

    # --- 3.5 材质 ---
    for ob in created:
        mk = raw[ob.name][1]
        ob.data.materials.clear()
        ob.data.materials.append(mats[mk])

    # --- 3.6 枢轴层级 ---
    root = base.make_empty('KneeRoot', (0, 0, 0), size=0.30)
    femur = base.make_empty('FemurPivot', (0, 0, 0), parent=root, size=0.22)
    tibia = base.make_empty('TibiaPivot', (0, 0, 0), parent=root, size=0.22)

    # 髌骨枢轴放在髌骨质心：旋转/平移时绕自身中心动，形态不会错位
    pat_me = raw['Patella'][0]
    pb = bounds(pat_me)
    pat_c = Vector(((pb[0] + pb[1]) / 2, (pb[2] + pb[3]) / 2, (pb[4] + pb[5]) / 2))
    patella = base.make_empty('PatellaPivot', tuple(pat_c), parent=femur, size=0.12)
    pat_me.transform(Matrix.Translation(-pat_c))

    pivots = {'femur': femur, 'tibia': tibia, 'patella': patella}
    for ob in created:
        side = raw[ob.name][2]
        ob.parent = pivots[side]

    # 侧副韧带（放样束带，挂在股骨枢轴下）
    add_collaterals(femur, mats['ligament'])

    nodes = {'KneeRoot': root, 'FemurPivot': femur,
             'TibiaPivot': tibia, 'PatellaPivot': patella}

    # --- 3.7 动作（复用内置模型那 4 段关键帧） ---
    base.build_actions(nodes)
    bpy.context.scene.frame_set(1)

    return nodes, created


def export():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    base.OUT_PATH = OUT_PATH
    base.export_glb()
    base.report()


def preview():
    """渲 3 个视角（正 / 侧 / 3/4）的预览图，用来判断形态是否可信。

    用 Workbench 的 studio 光照 + 材质色：不依赖场景灯光，出图快、明暗稳定，
    最适合判断骨面形态对不对。
    """
    from mathutils import Vector
    scn = bpy.context.scene
    scn.render.engine = 'BLENDER_WORKBENCH'
    scn.display.shading.light = 'STUDIO'
    scn.display.shading.color_type = 'MATERIAL'
    scn.display.shading.show_cavity = True
    scn.display.shading.cavity_type = 'BOTH'
    scn.display.shading.show_shadows = True
    scn.render.resolution_x = 720
    scn.render.resolution_y = 900
    scn.render.film_transparent = False
    scn.render.use_freestyle = False
    # 图谱场景挂了合成节点（会把输出替换成纯色），预览必须关掉
    scn.use_nodes = False
    scn.world.node_tree.nodes['Background'].inputs[0].default_value = (0.87, 0.90, 0.92, 1)

    # Workbench 走的是视口显示色，这里把它同步成材质的 Base Color，
    # 这样看预览就知道半月板/韧带有没有到位（不必重建缓存）
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        n = next((x for x in mat.node_tree.nodes if x.type == 'BSDF_PRINCIPLED'), None)
        if n:
            c = n.inputs['Base Color'].default_value
            mat.diffuse_color = (c[0], c[1], c[2], 1.0)

    pts = []
    for ob in bpy.data.objects:
        if ob.type == 'MESH':
            pts += [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    radius = (hi - lo).length / 2 * 1.12          # 留一点边距，别把股骨头切掉

    cam_data = bpy.data.cameras.new('Cam')
    cam_data.lens = 62
    cam = bpy.data.objects.new('Cam', cam_data)
    scn.collection.objects.link(cam)
    scn.camera = cam
    dist = radius / math.sin(math.radians(17))

    views = [
        ('front', Vector((0.0, -1.0, 0.0))),      # 正前（看髌骨、平台、半月板）
        ('side',  Vector((1.0, 0.0, 0.0))),       # 侧方（看髁的滚动面）
        ('34',    Vector((0.66, -1.0, 0.16))),    # 3/4（整体观感）
        ('joint', Vector((0.35, -1.0, 0.05))),    # 关节区特写
        ('top',   Vector((0.12, -0.25, 1.0))),    # 俯视（看半月板是否扣在平台上）
    ]
    for name, direction in views:
        d = direction.normalized()
        scale = 0.42 if name in ('joint', 'top') else 1.0
        tgt = center if name != 'joint' else center + Vector((0, 0, 0.35))
        cam.location = tgt + d * dist * scale
        cam.rotation_euler = (tgt - cam.location).normalized().to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = PREVIEW.replace('.png', '-%s.png' % name)
        bpy.ops.render.render(write_still=True)
        print('[preview] %s' % scn.render.filepath)


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []

    # 从整份解剖图谱里抽件 + 建动作需要加载 293 MB 的 Startup.blend，很慢；
    # 抽完先把「只有膝关节」的轻量副本存下来，之后调形态/渲预览直接用它：
    #   blender -b tools/atlas/_knee_parts.blend --python tools/build_knee_from_atlas.py -- --preview
    cache = os.path.join(HERE, 'atlas', '_knee_parts.blend')
    built = 'KneeRoot' in bpy.data.objects

    if not built:
        nodes, created = build()
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        # 图谱里其余 4500 个网格已经删除，但 datablock 还挂在文件里；
        # 清一遍孤儿数据，缓存文件才不会被撑到 100 MB
        for _ in range(3):
            bpy.ops.outliner.orphans_purge(do_recursive=True)
        bpy.ops.wm.save_as_mainfile(filepath=cache, compress=True)
        print('[cache] %s' % cache)
    else:
        print('[cache] 使用已抽取的膝关节副本')

    if '--preview' in argv:
        preview()
    if '--no-export' not in argv:
        export()


if __name__ == '__main__':
    main()
