# 把 Open3DModel 的完整右膝网格移植到本项目现有的「枢轴 + 4 段动画」骨架上，
# 输出可直接替换 assets/models/knee.glb 的新模型。
#
# 用法（在本项目根目录执行）：
#   blender -b -P tools/build_knee_from_open3dmodel.py \
#      -- <旧动画GLB> <Open3DModel完整GLB> <输出GLB>
#
# 原理：
#   旧 GLB 里动画通道只驱动 4 个空物体（KneeRoot / FemurPivot / TibiaPivot /
#   PatellaPivot）。因此先载入旧 GLB 拿到这 4 个节点与 NLA 动作，删掉它的旧网格，
#   再导入完整网格、按解剖归属重新挂到枢轴下即可 —— 动画完全不用重做。
#
# 坐标：
#   Blender 里 Z 向上；glTF 导出时自动转回 Y 向上。新网格在 Blender 里的竖直
#   范围是 z≈0.33~0.53（米制，真实尺寸 ~19 cm），先按关节线平移到 z=0，再整体
#   放大到与旧模型同量级（股骨远端 ~1.18 单位），相机/动画都不用改。
# =====================================================================
import bpy
import sys
import math
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
ANIM_GLB = argv[0]
FULL_GLB = argv[1]
OUT_GLB = argv[2]

# ---------------- 要保留的解剖部件 ----------------
# 名称来自 Open3DModel / Z-Anatomy（右侧 .r），括号里是本项目里的图层
KEEP = {
    # 骨
    'Femur.r': 'femur', 'Tibia.r': 'tibia', 'Fibula.r': 'tibia', 'Patella.r': 'patella',
    # 软骨
    'Articular cartilage of femur distal end.r': 'cartilage',
    'Articular cartilage of tibia proximal end.r': 'cartilage',
    'Articular cartilage of patella.r': 'cartilage',
    'Articular cartilage of fibula proximal tibiofibular joint.r': 'cartilage',
    # 半月板本体 + 前后角
    'Lateral meniscus.r.': 'meniscus_lateral',
    'Medial meniscus.r': 'meniscus_medial',
    'Anterior horn of Lateral meniscus.r': 'meniscus_lateral',
    'Posterior horn of Lateral meniscus.r': 'meniscus_lateral',
    'Anterior horn of Medial meniscus.r': 'meniscus_medial',
    'Posterior horn of Medial meniscus.r': 'meniscus_medial',
    # 交叉韧带 / 侧副韧带 / 髌腱 / 支持带 / 其他稳定结构
    'Anterior cruciate ligament.r': 'ligament',
    'Posterior cruciate ligament.r': 'ligament',
    'Fibular collateral ligament.r': 'ligament',
    'Medial collatertal ligament.r': 'ligament',
}

# 骨骼 → 枢轴（半月板/胫骨软骨随胫骨，股骨软骨/交叉韧带随股骨）
TO_FEMUR = ('Femur', 'PatellaPivot', 'cruciate', 'collateral', 'retinaculum',
            'patellar ligament', 'patellar tendon', 'Oblique', 'Transverse',
            'common tendon')
TO_TIBIA = ('Tibia', 'Fibula', 'meniscus', 'horn')

# 配色（Blender 预览用；前端会按图层重建材质，这里只为 Blender 检查图好看）
PALETTE = {
    'femur': (0.89, 0.85, 0.74, 1),
    'tibia': (0.89, 0.85, 0.74, 1),
    'patella': (0.97, 0.92, 0.74, 1),
    'cartilage': (0.62, 0.84, 0.94, 1),
    'meniscus_medial': (0.18, 0.60, 0.86, 1),
    'meniscus_lateral': (0.18, 0.60, 0.86, 1),
    'ligament': (0.84, 0.34, 0.28, 1),
}

# 前端 detectPart() 需要能认出来 → 重命名成含关键词的短名
RENAME = {
    'Femur.r': 'Femur_Body', 'Tibia.r': 'Tibia_Body', 'Fibula.r': 'Fibula',
    'Patella.r': 'Patella',
    'Articular cartilage of femur distal end.r': 'Femur_Cartilage',
    'Articular cartilage of tibia proximal end.r': 'Tibia_Cartilage',
    'Articular cartilage of patella.r': 'Patella_Cartilage',
    'Articular cartilage of fibula proximal tibiofibular joint.r': 'Fibula_Cartilage',
    'Lateral meniscus.r.': 'Meniscus_Lateral',
    'Medial meniscus.r': 'Meniscus_Medial',
    'Anterior horn of Lateral meniscus.r': 'Meniscus_Lateral_Horn_Ant',
    'Posterior horn of Lateral meniscus.r': 'Meniscus_Lateral_Horn_Post',
    'Anterior horn of Medial meniscus.r': 'Meniscus_Medial_Horn_Ant',
    'Posterior horn of Medial meniscus.r': 'Meniscus_Medial_Horn_Post',
    'Anterior cruciate ligament.r': 'ACL',
    'Posterior cruciate ligament.r': 'PCL',
    'Fibular collateral ligament.r': 'LCL',
    'Medial collatertal ligament.r': 'MCL',
    'Quadriceps common tendon + patellar ligament.r': 'Patellar_Tendon',
}

TARGET_FEMUR_HEIGHT = 1.18     # 与旧模型股骨远端一致


def verts_world(ob):
    return [ob.matrix_world @ Vector(v.co) for v in ob.data.vertices]


def main():
    # ---------- 1. 载入旧 GLB：保留枢轴与动画，删掉旧网格 ----------
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=ANIM_GLB)
    pivots = {}
    for n in ('KneeRoot', 'FemurPivot', 'TibiaPivot', 'PatellaPivot'):
        ob = bpy.data.objects.get(n)
        if ob is None:
            raise RuntimeError('动画源里缺少枢轴 ' + n)
        pivots[n] = ob
    pat_pivot_loc = pivots['PatellaPivot'].matrix_world.translation.copy()

    for ob in list(bpy.data.objects):
        if ob.type == 'MESH':
            bpy.data.objects.remove(ob, do_unlink=True)
    print('[1] 已载入动画骨架，保留枢轴：%s' % ', '.join(pivots))

    # ---------- 2. 导入完整网格 ----------
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=FULL_GLB)
    imported = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    print('[2] 导入 %d 个网格' % len(imported))

    kept = {}
    for ob in imported:
        if ob.name not in KEEP:
            bpy.data.objects.remove(ob, do_unlink=True)
            continue
        ob.name = RENAME.get(ob.name, ob.name)
        ob.data.name = ob.name + '_mesh'
        kept[ob.name] = ob
    print('[3] 保留 %d 个解剖部件' % len(kept))
    missing = set(KEEP.values()) - set(RENAME.get(k, k) for k in KEEP)
    if missing:
        print('    警告：未找到 %s' % ', '.join(sorted(missing)))

    # ---------- 3. 量关节线，算缩放 ----------
    femur = kept['Femur_Body']
    fpts = verts_world(femur)
    f_top = max(p.z for p in fpts)
    f_bot = min(p.z for p in fpts)
    joint_z = f_bot                      # 股骨髁最低点就是关节线
    scale = TARGET_FEMUR_HEIGHT / max(f_top - joint_z, 1e-6)

    # 横向也要居中：图谱取的是右膝，整体在 x≈-0.08 处，直接缩放会偏离原点一格
    bpts = fpts + verts_world(kept['Tibia_Body'])
    cx = (min(p.x for p in bpts) + max(p.x for p in bpts)) / 2
    cy = (min(p.y for p in bpts) + max(p.y for p in bpts)) / 2
    print('[4] 关节线 z=%.4f  股骨段高=%.4f  缩放=%.2f  横向中心=(%.3f, %.3f)'
          % (joint_z, f_top - joint_z, scale, cx, cy))

    # 变换：先移到原点再缩放
    xf = Matrix.Scale(scale, 4) @ Matrix.Translation((-cx, -cy, -joint_z))
    for ob in kept.values():
        # 把导入时的对象变换烘进顶点（导入的网格通常 location=0，但保险起见）
        ob.data.transform(ob.matrix_world)
        ob.matrix_world = Matrix.Identity(4)
        ob.data.transform(xf)
        ob.data.update()

    # 髌骨额外平移：让它的质心落在 PatellaPivot 上（动画会驱动这个枢轴）
    pat = kept['Patella']
    pp = verts_world(pat)
    pat_center = Vector(tuple((min(p[i] for p in pp) + max(p[i] for p in pp)) / 2 for i in range(3)))
    shift = pat_pivot_loc - pat_center
    for n in ('Patella', 'Patella_Cartilage'):
        if n in kept:
            kept[n].data.transform(Matrix.Translation(shift))
            kept[n].data.update()
    print('[5] 髌骨质心 %s → 枢轴 %s（位移 %s）'
          % (tuple(round(x, 3) for x in pat_center),
             tuple(round(x, 3) for x in pat_pivot_loc),
             tuple(round(x, 3) for x in shift)))

    # ---------- 3.6 用旧版盾形髌骨替换图谱的圆球髌骨 ----------
    # 图谱原髌骨是颗球，读图时一眼就出戏；旧项目里按滑车面调过的盾形髌骨
    # 形态正确，这里按新模型的实际尺寸缩放过来。髌骨软骨跟着球形走，对不上，删掉。
    if len(argv) > 3 and argv[3]:
        pat = kept['Patella']
        pts = verts_world(pat)
        p_lo = [min(p[i] for p in pts) for i in range(3)]
        p_hi = [max(p[i] for p in pts) for i in range(3)]
        new_size = [p_hi[i] - p_lo[i] for i in range(3)]
        new_center = Vector(tuple((p_hi[i] + p_lo[i]) / 2 for i in range(3)))

        bpy.data.objects.remove(pat, do_unlink=True)
        if 'Patella_Cartilage' in kept:
            bpy.data.objects.remove(kept['Patella_Cartilage'], do_unlink=True)
            del kept['Patella_Cartilage']
            KEEP.pop('Articular cartilage of patella.r', None)

        before2 = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=argv[3])
        old = next((o for o in bpy.data.objects
                    if o not in before2 and o.type == 'MESH' and o.name == 'Patella'), None)
        if old is None:
            raise RuntimeError('旧模型里没找到 Patella：' + argv[3])
        opts = verts_world(old)
        o_lo = [min(p[i] for p in opts) for i in range(3)]
        o_hi = [max(p[i] for p in opts) for i in range(3)]
        old_size = [o_hi[i] - o_lo[i] for i in range(3)]
        old_center = Vector(tuple((o_hi[i] + o_lo[i]) / 2 for i in range(3)))

        old.data.transform(old.matrix_world)
        old.matrix_world = Matrix.Identity(4)
        sc = (new_size[0] / old_size[0],
              new_size[1] / old_size[1] * 0.85,   # 略薄一点，更接近真实髌骨 ~2 cm
              new_size[2] / old_size[2])
        old.data.transform(Matrix.Diagonal((sc[0], sc[1], sc[2], 1)))
        old.data.transform(Matrix.Translation(
            new_center - Vector((old_center.x * sc[0], old_center.y * sc[1], old_center.z * sc[2]))))
        old.data.update()
        old.name = 'Patella'
        old.data.name = 'Patella_mesh'
        kept['Patella'] = old
        print('[5b] 盾形髌骨替换完成：%s → %s（厚度 ×0.85）'
              % (tuple(round(x, 3) for x in old_size), tuple(round(x, 3) for x in new_size)))

    # ---------- 4. 挂枢轴 + 统一材质/标记 ----------
    for name, ob in kept.items():
        if name.startswith('Patella'):
            parent = pivots['PatellaPivot']
        elif any(k.lower() in name.lower() for k in TO_FEMUR):
            parent = pivots['FemurPivot']
        elif any(k.lower() in name.lower() for k in TO_TIBIA):
            parent = pivots['TibiaPivot']
        else:
            parent = pivots['FemurPivot']

        # 顶点已经是世界坐标；设置 parent 时抵消枢轴的世界变换，保持位置不动
        ob.parent = parent
        ob.matrix_parent_inverse = parent.matrix_world.inverted()

        layer = KEEP[RENAME_INV[name]]
        c = PALETTE[layer]
        mat = bpy.data.materials.new('mat_' + name)
        mat.diffuse_color = c
        mat.use_nodes = True
        p = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if p:
            p.inputs['Base Color'].default_value = c
            p.inputs['Roughness'].default_value = 0.55
        ob.data.materials.clear()
        ob.data.materials.append(mat)
        ob['layer'] = layer
        print('    %-30s → %-14s [%s]' % (name, parent.name, layer))

    # ---------- 5. 导出（NLA_TRACKS 才会把 4 段动作全写进 GLB） ----------
    bpy.ops.object.select_all(action='DESELECT')
    for ob in bpy.data.objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = pivots['KneeRoot']
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_animation_mode='NLA_TRACKS',
        export_yup=True,
        export_apply=False,
    )
    print('[6] 导出完成：%s' % OUT_GLB)


RENAME_INV = {v: k for k, v in RENAME.items()}

main()
