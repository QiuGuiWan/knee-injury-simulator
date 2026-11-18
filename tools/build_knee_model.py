# -*- coding: utf-8 -*-
"""
build_knee_model.py —— 用 Blender 程序化生成「分层 + 带枢轴 + 4 段动作」的膝关节 GLB
=====================================================================================

为什么用脚本生成而不是手工建模：
  1. 参数化 → 尺寸/比例可复现，论文里可以写「模型由脚本按解剖尺寸生成」；
  2. 换电脑、重装 Blender 都能一键重新生成，答辩前不怕文件丢失；
  3. 每个部件都是独立对象、命名规范，正好满足网页端「单独显隐 / 单独高亮」的需求。

运行方式（无需打开 Blender 界面）：
    "D:/软件/Blender/blender.exe" -b --factory-startup --python tools/build_knee_model.py
输出：
    assets/models/knee.glb

坐标约定（脚本内部使用 Blender 的 Z 轴向上）：
    · 原点 = 膝关节屈伸中心（约在胫骨平台关节面高度）
    · +Z 指向股骨（近端），-Z 指向胫骨（远端）
    · -Y 为身体前方（anterior），+X 为外侧（lateral），-X 为内侧（medial）
    导出 glTF 时 Blender 会自动转成 Y 轴向上，网页端看到的仍是「股骨朝上、髌骨朝前」。

节点层级（网页端靠这套命名做分层识别，改名务必同步改 modelLoader.js）：
    KneeRoot                 ← 整体位移（跑步起伏）
      ├─ FemurPivot          ← 屈髋 / 内旋
      │    ├─ Femur_Shaft / Femur_Metaphysis / Femur_Condyle_Medial / ...
      │    ├─ PatellaPivot   ← 髌骨在滑车内的滑动
      │    │    └─ Patella
      │    └─ ACL / PCL / MCL / LCL
      └─ TibiaPivot          ← 屈膝 / 膝内扣（外翻）/ 胫骨内旋
           ├─ Tibia_Plateau / Tibia_Metaphysis / Tibia_Shaft / Tibia_Tuberosity
           └─ Meniscus_Medial / Meniscus_Lateral

动画（NLA 轨道名 = glTF 动画名，必须与 animationCtrl.js 的 key 完全一致）：
    anim_squat_correct / anim_squat_valgus / anim_run_correct / anim_run_heelstrike
"""

import bpy
import bmesh
import json
import math
import struct
from mathutils import Vector

OUT_PATH = 'D:/github/knee-sim/assets/models/knee.glb'
FPS = 30

# ---------------------------------------------------------------------------
# 0. 场景准备
# ---------------------------------------------------------------------------


def reset_scene():
    """清空默认场景（立方体/灯光/相机），只留一个空场景。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 1
    scene.frame_end = 120
    # glTF 导出的是「当前视角可见」的对象，隐藏的集合会被跳过，这里保证主集合可见
    scene.collection.hide_viewport = False


def make_material(name, rgb, roughness=0.62):
    """Principled BSDF 材质。网页端会按图层统一替换颜色，这里主要方便在 Blender 里预览。"""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
        bsdf.inputs['Roughness'].default_value = roughness
        bsdf.inputs['Metallic'].default_value = 0.0
    return mat


MAT = {}


def build_materials():
    MAT['bone'] = make_material('M_Bone', (0.82, 0.78, 0.68), 0.62)
    MAT['patella'] = make_material('M_Patella', (0.80, 0.75, 0.64), 0.58)
    MAT['meniscus'] = make_material('M_Meniscus', (0.26, 0.48, 0.58), 0.42)
    MAT['ligament'] = make_material('M_Ligament', (0.50, 0.64, 0.72), 0.52)


# ---------------------------------------------------------------------------
# 1. 网格工具
# ---------------------------------------------------------------------------


def _finish(name, verts, faces, mat, smooth=True, subdiv=0):
    """把顶点/面写成 Blender 对象，重算法线，可选加一级细分后烘焙。"""
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    me.update()

    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if mat:
        me.materials.append(mat)

    # 统一重算法线，避免手工排面时正反面不一致（glTF 是单面渲染，反了会「透」）
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()

    if smooth:
        for poly in me.polygons:
            poly.use_smooth = True

    if subdiv > 0:
        mod = ob.modifiers.new('subsurf', 'SUBSURF')
        mod.levels = subdiv
        mod.render_levels = subdiv
        dg = bpy.context.evaluated_depsgraph_get()
        dg.update()
        ev = ob.evaluated_get(dg)
        baked = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
        ob.modifiers.clear()
        old = ob.data
        ob.data = baked
        bpy.data.meshes.remove(old)
        for poly in ob.data.polygons:
            poly.use_smooth = True

    return ob


def bake_stack(ob):
    """把对象上的修改器栈（布尔 / 细分）一次性烘进网格。"""
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    ev = ob.evaluated_get(dg)
    baked = bpy.data.meshes.new_from_object(ev, depsgraph=dg)
    ob.modifiers.clear()
    old = ob.data
    ob.data = baked
    bpy.data.meshes.remove(old)
    for poly in ob.data.polygons:
        poly.use_smooth = True
    return ob


def merge_into(body, tools, subdiv=1):
    """把若干「凸起」（上髁、胫骨结节）用布尔并集融进主体。

    直接叠一个球体上去，接缝处会有一圈生硬的交线，看起来像贴了块橡皮泥；
    布尔并集后再细分，凸起就长在骨头上了 —— 这是模型像不像解剖标本的分水岭。
    """
    for t in tools:
        mod = body.modifiers.new('bool_' + t.name, 'BOOLEAN')
        mod.operation = 'UNION'
        mod.solver = 'EXACT'
        mod.object = t
    if subdiv:
        mod = body.modifiers.new('subsurf', 'SUBSURF')
        mod.levels = subdiv
        mod.render_levels = subdiv
    bake_stack(body)
    for t in tools:
        bpy.data.objects.remove(t, do_unlink=True)
    return body


def loft(name, sections, mat, seg=64, caps=True, subdiv=1):
    """沿 Z 轴放样：整根骨的骨干→干骺端→关节头，用**一个连续曲面**做出来。

    sections: [(z, cx, cy, rx, ry, lobe, groove), ...]
        z        截面高度
        cx, cy   截面中心（cy 用来做股骨前弓、髁部后移）
        rx, ry   椭圆半轴
        lobe     双叶形调制：>0 时截面变成「花生形」，中间收腰、两侧鼓出
                 —— 股骨远端两个髁就是靠它从一个曲面里「分」出来的，
                 比另外贴两个球体自然得多
        groove   前方纵向凹槽深度：滑车沟、髁间窝都用它压出来

    只用一个曲面而不是拼积木，是这套模型看起来像「解剖模型」而不是
    「几个球堆在一起」的关键。
    """
    verts, faces = [], []
    rings = len(sections)

    for s in sections:
        z, cx, cy, rx, ry = s[0], s[1], s[2], s[3], s[4]
        lobe = s[5] if len(s) > 5 else 0.0
        groove = s[6] if len(s) > 6 else 0.0
        for i in range(seg):
            a = 2.0 * math.pi * i / seg
            k = 1.0
            if lobe:
                # 前后方向的收腰程度不同：后方（髁间窝一侧）收得深，
                # 前方（滑车一侧）收得浅，这样两个髁在前方仍是连着的
                bias = 0.16 + 0.42 * (math.sin(a) + 1.0)
                k += lobe * math.cos(2.0 * a) * bias
            if groove:
                # 与正前方（-Y，即 a=-90°）的角距离，用高斯窗压出纵向凹槽
                d = abs(((a + math.pi / 2.0) + math.pi) % (2.0 * math.pi) - math.pi)
                if d < 1.2:
                    k -= groove * math.exp(-((d / 0.32) ** 2))
            verts.append((cx + rx * k * math.cos(a), cy + ry * k * math.sin(a), z))

    for k in range(rings - 1):
        base0 = k * seg
        base1 = (k + 1) * seg
        for i in range(seg):
            j = (i + 1) % seg
            faces.append((base0 + i, base0 + j, base1 + j, base1 + i))

    if caps:
        faces.append(tuple(range(seg - 1, -1, -1)))
        faces.append(tuple(range((rings - 1) * seg, rings * seg)))

    return _finish(name, verts, faces, mat, True, subdiv)


def ellipsoid(name, center, radii, mat, seg=36, rings=20, subdiv=0, tilt=0.0):
    """椭球：上髁、髌骨、胫骨结节等「圆隆」结构都用它。

    tilt: 绕 X 轴倾斜的角度（度）。髌骨要顺着滑车的斜度「仰起」，靠它实现。
    """
    cx, cy, cz = center
    rx, ry, rz = radii
    verts = [(cx, cy, cz + rz)]           # 北极
    for j in range(1, rings):
        theta = math.pi * j / rings
        st, ct = math.sin(theta), math.cos(theta)
        for i in range(seg):
            phi = 2.0 * math.pi * i / seg
            verts.append((cx + rx * st * math.cos(phi),
                          cy + ry * st * math.sin(phi),
                          cz + rz * ct))
    verts.append((cx, cy, cz - rz))       # 南极

    faces = []
    top = 0
    bottom = len(verts) - 1
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((top, 1 + i, 1 + j))
    for k in range(rings - 2):
        b0 = 1 + k * seg
        b1 = 1 + (k + 1) * seg
        for i in range(seg):
            j = (i + 1) % seg
            faces.append((b0 + i, b1 + i, b1 + j, b0 + j))
    last = 1 + (rings - 2) * seg
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((bottom, last + j, last + i))

    if tilt:
        a = math.radians(tilt)
        ca, sa = math.cos(a), math.sin(a)
        out = []
        for (x, y, z) in verts:
            dy, dz = y - cy, z - cz
            out.append((x, cy + dy * ca - dz * sa, cz + dy * sa + dz * ca))
        verts = out

    return _finish(name, verts, faces, mat, True, subdiv)


def meniscus_ring(name, center, r_out, r_in, height, a0, a1, mat, seg=72):
    """半月板：楔形截面的环带（外缘厚、内缘薄），开口角度决定是 C 形还是 O 形。

    center: (cx, cy, z_top) —— 环带上表面所在高度
    r_out / r_in: (rx, ry) 椭圆半径
    a0 / a1: 起止角度（度），顺时针绕 +X 方向量起
    """
    cx, cy, z_top = center
    rx_o, ry_o = r_out
    rx_i, ry_i = r_in
    h_out = height
    h_in = height * 0.26            # 内缘只有外缘 1/4 厚 → 典型楔形
    drop_in = height * 0.52         # 内缘上表面明显低于外缘，形成承重凹面

    verts = []
    for k in range(seg + 1):
        t = a0 + (a1 - a0) * k / seg
        a = math.radians(t)
        ca, sa = math.cos(a), math.sin(a)
        ox, oy = cx + rx_o * ca, cy + ry_o * sa
        ix, iy = cx + rx_i * ca, cy + ry_i * sa
        # 每个角度上四个点：外上、外下、内上、内下
        verts.append((ox, oy, z_top))
        verts.append((ox, oy, z_top - h_out))
        verts.append((ix, iy, z_top - drop_in))
        verts.append((ix, iy, z_top - drop_in - h_in))

    faces = []
    for k in range(seg):
        a = k * 4
        b = (k + 1) * 4
        faces.append((a + 0, b + 0, b + 2, a + 2))      # 上表面
        faces.append((a + 1, a + 3, b + 3, b + 1))      # 下表面
        faces.append((a + 0, a + 1, b + 1, b + 0))      # 外壁
        faces.append((a + 2, b + 2, b + 3, a + 3))      # 内壁
    # 两端封口
    faces.append((0, 2, 3, 1))
    e = seg * 4
    faces.append((e + 1, e + 3, e + 2, e + 0))

    return _finish(name, verts, faces, mat, True, 0)


def band(name, p1, p2, radius, mat, flatten=1.0, seg=20, subdiv=1):
    """两点之间的韧带（两端收窄成圆头），flatten<1 时压扁成带状（侧副韧带）。"""
    a = Vector(p1)
    b = Vector(p2)
    axis = (b - a)
    length = axis.length
    axis = axis.normalized()

    ref = Vector((0.0, 0.0, 1.0))
    if abs(axis.dot(ref)) > 0.95:
        ref = Vector((0.0, 1.0, 0.0))
    u = axis.cross(ref).normalized()
    v = axis.cross(u).normalized()

    # 沿轴向的收窄曲线：两端圆头、中段等粗
    profile = [(0.00, 0.42), (0.10, 0.92), (0.50, 1.00), (0.90, 0.92), (1.00, 0.42)]

    verts = []
    for (t, k) in profile:
        c = a + axis * (length * t)
        for i in range(seg):
            ang = 2.0 * math.pi * i / seg
            r1 = radius * k
            r2 = radius * k * flatten
            verts.append(tuple(c + u * (r1 * math.cos(ang)) + v * (r2 * math.sin(ang))))

    faces = []
    n = len(profile)
    for s in range(n - 1):
        b0 = s * seg
        b1 = (s + 1) * seg
        for i in range(seg):
            j = (i + 1) % seg
            faces.append((b0 + i, b0 + j, b1 + j, b1 + i))
    faces.append(tuple(range(seg - 1, -1, -1)))
    faces.append(tuple(range((n - 1) * seg, n * seg)))

    return _finish(name, verts, faces, mat, True, subdiv)


def make_empty(name, location=(0, 0, 0), parent=None, size=0.12):
    """关节枢轴：glTF 里会导出成空节点，网页端直接对它的 rotation 做动画。"""
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = size
    ob.location = location
    bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


# ---------------------------------------------------------------------------
# 2. 解剖结构
# ---------------------------------------------------------------------------


def build_femur(pivot):
    """股骨：一根连续曲面 + 两个上髁。

    关键在远端：截面从圆逐渐变成「花生形」（lobe），并在前方压出滑车沟
    （groove）。这样两个髁是从同一个曲面里鼓出来的，而不是贴上去的球。
    """
    parts = []

    parts.append(loft('Femur_Body', [
        (3.14, 0.0,  0.010, 0.115, 0.112, 0.00, 0.00),   # 近端截断（略收口）
        (3.06, 0.0,  0.010, 0.168, 0.162, 0.00, 0.00),
        (2.70, 0.0,  0.005, 0.182, 0.176, 0.00, 0.00),
        (2.20, 0.0, -0.015, 0.173, 0.167, 0.00, 0.00),   # 骨干最细处
        (1.75, 0.0, -0.020, 0.182, 0.174, 0.00, 0.00),
        (1.35, 0.0, -0.012, 0.214, 0.198, 0.00, 0.00),
        (1.10, 0.0,  0.000, 0.264, 0.222, 0.02, 0.00),
        (0.95, 0.0,  0.000, 0.334, 0.248, 0.06, 0.04),
        (0.82, 0.0, -0.010, 0.386, 0.278, 0.14, 0.11),   # 滑车沟开始出现
        (0.70, 0.0, -0.020, 0.405, 0.310, 0.24, 0.15),
        (0.58, 0.0, -0.025, 0.409, 0.362, 0.34, 0.13),
        (0.46, 0.0, -0.030, 0.406, 0.412, 0.42, 0.07),
        (0.36, 0.0, -0.030, 0.399, 0.437, 0.46, 0.02),   # 两个髁最饱满处（前后最深）
        (0.28, 0.0, -0.028, 0.383, 0.440, 0.48, 0.00),
        (0.22, 0.0, -0.026, 0.347, 0.410, 0.46, 0.00),
        (0.16, 0.0, -0.024, 0.268, 0.326, 0.36, 0.00),   # 关节面下缘
        (0.11, 0.0, -0.020, 0.170, 0.178, 0.16, 0.00),
    ], MAT['bone'], subdiv=0))

    # 上髁：侧副韧带的附着点，布尔并集进骨干，成为骨头上的一个圆隆
    body = parts[0]
    merge_into(body, [
        ellipsoid('EpiMed', (-0.395, -0.035, 0.470), (0.135, 0.145, 0.135), MAT['bone']),
        ellipsoid('EpiLat', (0.388, -0.030, 0.482), (0.125, 0.135, 0.125), MAT['bone']),
    ], subdiv=1)
    body.name = 'Femur_Body'

    for ob in parts:
        ob.parent = pivot
    return parts


def build_tibia(pivot):
    """胫骨：平台单独一块（后跟硬落地要单独高亮）+ 一根连续骨干。"""
    parts = []

    # 胫骨平台：关节面这一圈单独成对象，冲击应力就显示在它上面
    parts.append(loft('Tibia_Plateau', [
        (0.048, 0.0, 0.0, 0.388, 0.300),
        (0.010, 0.0, 0.0, 0.412, 0.320),
        (-0.06, 0.0, 0.0, 0.418, 0.322),
        (-0.13, 0.0, 0.0, 0.406, 0.312),
        (-0.20, 0.0, 0.0, 0.380, 0.296),
        (-0.26, 0.0, 0.0, 0.336, 0.268),
    ], MAT['bone'], subdiv=1))

    parts.append(loft('Tibia_Body', [
        (-0.15, 0.0,  0.000, 0.398, 0.304),
        (-0.28, 0.0,  0.000, 0.350, 0.274),
        (-0.42, 0.0,  0.000, 0.298, 0.244),
        (-0.58, 0.0,  0.000, 0.256, 0.220),
        (-0.80, 0.0, -0.005, 0.222, 0.198),
        (-1.20, 0.0, -0.005, 0.196, 0.182),
        (-1.80, 0.0,  0.000, 0.176, 0.166),
        (-2.40, 0.0,  0.005, 0.162, 0.155),
        (-2.90, 0.0,  0.008, 0.150, 0.145),
        (-3.02, 0.0,  0.008, 0.112, 0.108),
    ], MAT['bone'], subdiv=0))

    # 胫骨结节：髌韧带止点，同样布尔合并成脊状凸起
    body = parts[1]
    merge_into(body, [
        ellipsoid('Tuberosity', (0.0, -0.236, -0.300), (0.092, 0.062, 0.170), MAT['bone']),
    ], subdiv=1)
    body.name = 'Tibia_Body'

    for ob in parts:
        ob.parent = pivot
    return parts


def build_menisci(pivot):
    """内外侧半月板：夹在股骨髁与胫骨平台之间的一圈楔形纤维软骨。

    内侧更接近 C 形（开口朝外侧）、活动度小，膝内扣时最容易被股骨髁挤压；
    外侧接近 O 形、活动度大。两种形态的差异本身就是解剖知识点。
    """
    parts = []
    parts.append(meniscus_ring(
        'Meniscus_Medial', (-0.198, -0.045, 0.106),
        (0.196, 0.186), (0.112, 0.104), 0.074, 40, 320, MAT['meniscus']))
    parts.append(meniscus_ring(
        'Meniscus_Lateral', (0.198, -0.040, 0.104),
        (0.188, 0.178), (0.106, 0.098), 0.070, 202, 502, MAT['meniscus']))

    for ob in parts:
        ob.parent = pivot
    return parts


def build_ligaments(pivot):
    """交叉韧带（ACL/PCL）+ 侧副韧带（MCL/LCL）。

    挂在股骨枢轴上：股骨转角远小于胫骨，韧带随动后与骨面的错位最小。
    """
    parts = [
        # 前交叉：股骨髁间窝后外侧 → 胫骨髁间前区
        band('ACL', (0.062, 0.115, 0.500), (0.048, -0.045, 0.045), 0.042, MAT['ligament']),
        # 后交叉：股骨髁间窝前内侧 → 胫骨后方
        band('PCL', (-0.058, 0.055, 0.480), (-0.030, 0.170, 0.000), 0.045, MAT['ligament']),
        # 内侧副韧带：股骨内上髁 → 胫骨内侧，扁带状
        band('MCL', (-0.472, -0.030, 0.445), (-0.296, -0.020, -0.285), 0.062, MAT['ligament'], flatten=0.50),
        # 外侧副韧带：股骨外上髁 → 腓骨头方向，细索状
        band('LCL', (0.462, -0.020, 0.468), (0.298, 0.010, -0.262), 0.046, MAT['ligament'], flatten=0.68),
    ]
    for ob in parts:
        ob.parent = pivot
    return parts


def build_patella(pivot):
    """髌骨：截面放样成「盾形」——上宽下尖、前面隆起后面有关节面。

    用椭球会得到一个鹅蛋，一眼假；按 z 逐层收窄才像一块真正的籽骨。
    各截面的 cy 依次后移，等于给髌骨一个自然的后仰角，正好贴合股骨滑车。
    """
    parts = []
    parts.append(loft('Patella', [
        (0.250, 0.0, 0.048, 0.082, 0.036),
        (0.180, 0.0, 0.035, 0.150, 0.070),
        (0.090, 0.0, 0.018, 0.192, 0.087),
        (0.000, 0.0, 0.000, 0.206, 0.093),
        (-0.090, 0.0, -0.012, 0.190, 0.086),
        (-0.170, 0.0, -0.020, 0.145, 0.066),
        (-0.225, 0.0, -0.026, 0.072, 0.038),
        (-0.258, 0.0, -0.030, 0.028, 0.016),
    ], MAT['patella'], seg=40, subdiv=1))

    for ob in parts:
        ob.parent = pivot
    return parts


# ---------------------------------------------------------------------------
# 3. 动画
# ---------------------------------------------------------------------------

# 每段动作的关键帧：(归一化时间, (x, y, z))
#   · 屈膝 = TibiaPivot 绕 X 正转；膝内扣（外翻）= TibiaPivot 绕 Y 负转
#   · 骨绕自身长轴旋转 = 绕 Z，用于表现股骨/胫骨的内旋（半月板剪切载荷的来源）
CLIP_DATA = {
    'anim_squat_correct': {
        'frames': 108,
        'FemurPivot': {'rot': [(0.00, (0.00, 0, 0)), (0.38, (0.10, 0, 0)),
                               (0.62, (0.17, 0, 0)), (0.80, (0.17, 0, 0)), (1.00, (0.00, 0, 0))]},
        'TibiaPivot': {'rot': [(0.00, (0.00, 0, 0)), (0.38, (0.82, 0, 0)),
                               (0.62, (1.55, 0, 0)), (0.80, (1.55, 0, 0)), (1.00, (0.00, 0, 0))]},
        'PatellaPivot': {'loc': [(0.00, (0.000, 0.000, 0.000)), (0.40, (-0.008, 0.030, -0.045)),
                                 (0.62, (-0.012, 0.042, -0.070)), (0.80, (-0.012, 0.042, -0.070)),
                                 (1.00, (0.000, 0.000, 0.000))]},
        'KneeRoot': {'loc': [(0.00, (0, 0, 0.000)), (0.38, (0, 0, -0.030)),
                             (0.62, (0, 0, -0.055)), (0.80, (0, 0, -0.055)), (1.00, (0, 0, 0.000))]},
    },

    'anim_squat_valgus': {
        'frames': 114,
        'FemurPivot': {'rot': [(0.00, (0.00, 0.00, 0.00)), (0.40, (0.115, 0.075, 0.045)),
                               (0.64, (0.175, 0.135, 0.080)), (0.82, (0.175, 0.132, 0.078)),
                               (1.00, (0.00, 0.00, 0.00))]},
        # 膝内扣的核心：胫骨相对股骨外翻（绕 Y 负转）+ 内旋（绕 Z 正转）
        'TibiaPivot': {'rot': [(0.00, (0.00, 0.00, 0.00)), (0.40, (0.85, -0.150, 0.070)),
                               (0.64, (1.58, -0.345, 0.140)), (0.82, (1.56, -0.330, 0.132)),
                               (1.00, (0.00, 0.00, 0.00))]},
        'PatellaPivot': {'loc': [(0.00, (0.000, 0.000, 0.000)), (0.40, (-0.022, 0.028, -0.045)),
                                 (0.64, (-0.035, 0.040, -0.072)), (0.82, (-0.034, 0.038, -0.070)),
                                 (1.00, (0.000, 0.000, 0.000))]},
        'KneeRoot': {'loc': [(0.00, (0, 0, 0.000)), (0.40, (0, 0, -0.028)),
                             (0.64, (0, 0, -0.058)), (0.82, (0, 0, -0.056)), (1.00, (0, 0, 0.000))]},
    },

    'anim_run_correct': {
        'frames': 36,
        'FemurPivot': {'rot': [(0.00, (0.06, 0, 0)), (0.20, (0.20, 0, 0)), (0.45, (0.16, 0, 0)),
                               (0.70, (0.18, 0, 0)), (0.88, (0.12, 0, 0)), (1.00, (0.06, 0, 0))]},
        # 落地缓冲（轻度屈膝）→ 支撑 → 摆动期大幅屈膝 → 回到下次触地
        'TibiaPivot': {'rot': [(0.00, (0.20, 0, 0)), (0.16, (0.62, 0, 0)), (0.30, (0.50, 0, 0)),
                               (0.50, (0.24, 0, 0)), (0.72, (1.15, 0, 0)), (0.88, (0.60, 0, 0)),
                               (1.00, (0.20, 0, 0))]},
        'PatellaPivot': {'loc': [(0.00, (0, 0.000, 0.000)), (0.50, (0, 0.005, -0.012)),
                                 (0.72, (0, 0.035, -0.058)), (1.00, (0, 0.000, 0.000))]},
        'KneeRoot': {'loc': [(0.00, (0, 0, 0.000)), (0.18, (0, 0, -0.100)), (0.45, (0, 0, 0.030)),
                             (0.72, (0, 0, 0.055)), (1.00, (0, 0, 0.000))]},
    },

    'anim_run_heelstrike': {
        'frames': 36,
        'FemurPivot': {'rot': [(0.00, (0.04, 0, 0)), (0.12, (0.10, 0, 0)), (0.34, (0.25, 0, 0)),
                               (0.62, (0.12, 0, 0)), (1.00, (0.04, 0, 0))]},
        # 触地瞬间膝几乎伸直（0.06→0.20 rad，缓冲不足），随后被冲击「压」下去
        'TibiaPivot': {'rot': [(0.00, (0.06, 0, 0)), (0.10, (0.18, 0, 0)), (0.28, (0.92, 0, 0)),
                               (0.46, (0.52, 0, 0)), (0.70, (1.12, 0, 0)), (0.88, (0.45, 0, 0)),
                               (1.00, (0.06, 0, 0))]},
        'PatellaPivot': {'loc': [(0.00, (0, 0.000, 0.000)), (0.28, (0, 0.030, -0.052)),
                                 (0.70, (0, 0.028, -0.048)), (1.00, (0, 0.000, 0.000))]},
        # 纵向「顿挫」：比标准跑更深的突然下沉，视觉上就是硬砸地面
        'KneeRoot': {'loc': [(0.00, (0, 0, 0.000)), (0.06, (0, 0, -0.040)), (0.20, (0, 0, -0.235)),
                             (0.34, (0, 0, -0.120)), (0.70, (0, 0, -0.035)), (1.00, (0, 0, 0.000))]},
    },
}


def build_actions(nodes):
    """为每段动作建一个 Action（多个 slot 分别绑到各个枢轴），再推进 NLA 轨道。

    注意：Blender 4.4+ 的 action 是「多 slot」结构，一个 action 可以同时装
    好几个对象的动画；而 glTF 导出器在 ACTIONS 模式下只会导出**当前激活**的
    action，所以必须把每个 action 各自压成一条同名 NLA 轨道再导出。
    """
    actions = {}
    # 先记下各枢轴的静止位置：关键帧里的位移是「相对静止位置的增量」，
    # 直接赋值会把 PatellaPivot 的偏移量清零（髌骨会掉进关节里）
    rest_loc = {name: node.location.copy() for name, node in nodes.items()}

    for clip_name, data in CLIP_DATA.items():
        act = bpy.data.actions.new(clip_name)
        act.use_fake_user = True
        length = data['frames']

        for node_name, node in nodes.items():
            tracks = data.get(node_name, {})
            ad = node.animation_data_create()
            ad.action = act
            if getattr(ad, 'action_slot', None) is None:
                ad.action_slot = act.slots.new(id_type='OBJECT', name=node_name)

            # 即使这段动作里该节点不动，也要打上关键帧：
            # 否则切换动画后它会保留上一段动作的残留姿态（网页端最容易踩的坑）
            rot_keys = tracks.get('rot', [(0.0, (0.0, 0.0, 0.0)), (1.0, (0.0, 0.0, 0.0))])
            loc_keys = tracks.get('loc', [(0.0, (0.0, 0.0, 0.0)), (1.0, (0.0, 0.0, 0.0))])

            for (t, rot) in rot_keys:
                node.rotation_euler = rot
                node.keyframe_insert('rotation_euler', frame=frame_of(t, length))
            for (t, loc) in loc_keys:
                node.location = rest_loc[node_name] + Vector(loc)
                node.keyframe_insert('location', frame=frame_of(t, length))

        # 关键帧插值统一用 auto-clamped 贝塞尔：动作顺滑又不会过冲
        for fc in action_fcurves(act):
            for kp in fc.keyframe_points:
                kp.interpolation = 'BEZIER'
                kp.handle_left_type = 'AUTO_CLAMPED'
                kp.handle_right_type = 'AUTO_CLAMPED'

        actions[clip_name] = act

    # 清空 active action，把每个 action 压成同名 NLA 轨道
    for node_name, node in nodes.items():
        ad = node.animation_data
        for clip_name, act in actions.items():
            track = ad.nla_tracks.new()
            track.name = clip_name
            strip = track.strips.new(clip_name, 1, act)
            slot = None
            for s in act.slots:
                if s.name_display == node_name or s.identifier.endswith(node_name):
                    slot = s
                    break
            if slot is not None and hasattr(strip, 'action_slot'):
                strip.action_slot = slot
            track.mute = False
        ad.action = None

    return actions


def frame_of(t, length):
    """归一化时间 → 帧号（从 1 开始，保证首帧落在 0 秒）。"""
    return 1 + int(round(t * (length - 1)))


def action_fcurves(act):
    """兼容 4.4+ 的 slot/layer 结构，把所有 fcurve 摊平出来。"""
    out = []
    if hasattr(act, 'layers') and len(act.layers):
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out.extend(bag.fcurves)
    elif hasattr(act, 'fcurves'):
        out.extend(act.fcurves)
    return out


# ---------------------------------------------------------------------------
# 4. 组装与导出
# ---------------------------------------------------------------------------


def assemble():
    root = make_empty('KneeRoot', (0, 0, 0), size=0.30)
    femur = make_empty('FemurPivot', (0, 0, 0), parent=root, size=0.22)
    tibia = make_empty('TibiaPivot', (0, 0, 0), parent=root, size=0.22)
    patella = make_empty('PatellaPivot', (0.0, -0.345, 0.698), parent=femur, size=0.12)

    build_femur(femur)
    build_tibia(tibia)
    build_menisci(tibia)
    build_ligaments(femur)
    build_patella(patella)

    nodes = {'KneeRoot': root, 'FemurPivot': femur,
             'TibiaPivot': tibia, 'PatellaPivot': patella}
    return nodes


def export_glb():
    kwargs = dict(
        filepath=OUT_PATH,
        export_format='GLB',
        export_apply=False,
        export_animations=True,
        export_animation_mode='NLA_TRACKS',
        export_frame_range=False,
        export_force_sampling=True,
        export_optimize_animation_size=False,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_materials='EXPORT',
        export_texcoords=False,
        export_normals=True,
        use_selection=False,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError as e:
        # 不同小版本的参数名会变，逐项剔除后重试
        print('[export] 参数不兼容，降级重试：', e)
        for k in ('export_optimize_animation_size', 'export_frame_range',
                  'export_force_sampling', 'export_texcoords'):
            kwargs.pop(k, None)
        bpy.ops.export_scene.gltf(**kwargs)


def report():
    """导出后直接解析 GLB，把关键信息打出来，方便一眼确认是否正常。"""
    with open(OUT_PATH, 'rb') as f:
        data = f.read()
    json_len = struct.unpack('<I', data[12:16])[0]
    doc = json.loads(data[20:20 + json_len].decode('utf-8'))

    print('\n=== knee.glb 生成报告 ===')
    print('文件大小: %.1f KB' % (len(data) / 1024.0))
    print('节点数: %d  网格数: %d  动画数: %d'
          % (len(doc.get('nodes', [])), len(doc.get('meshes', [])),
             len(doc.get('animations', []))))
    print('动画:')
    for a in doc.get('animations', []):
        print('  - %-22s 通道 %d' % (a.get('name'), len(a.get('channels', []))))
    print('网格对象:')
    for n in doc.get('nodes', []):
        if 'mesh' in n:
            print('  - %s' % n.get('name'))

    # 三角面统计
    tris = 0
    for m in doc.get('meshes', []):
        for p in m.get('primitives', []):
            if 'indices' in p:
                tris += doc['accessors'][p['indices']]['count'] // 3
    print('三角面总数: %d' % tris)


def main():
    reset_scene()
    build_materials()
    nodes = assemble()
    build_actions(nodes)
    bpy.context.scene.frame_set(1)     # 导出前归位：NLA 在第 1 帧即中立姿态
    export_glb()
    report()


if __name__ == '__main__':
    main()
