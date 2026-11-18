"""导入 GLB 并按部件着色，渲染多视角预览图，用于检查解剖形态。

用法：
    blender -b -P tools/inspect_glb.py -- <glb> <out_dir>
"""
import sys
import os
import math
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
GLB = argv[0] if argv else 'assets/models/knee.glb'
OUT = os.path.abspath(argv[1] if len(argv) > 1 else 'tools/_inspect')

PALETTE = {
    'femur':     (0.86, 0.80, 0.70, 1.0),
    'tibia':     (0.72, 0.66, 0.56, 1.0),
    'plateau':   (0.62, 0.56, 0.48, 1.0),
    'patella':   (0.95, 0.90, 0.78, 1.0),
    'meniscus':  (0.16, 0.55, 0.78, 1.0),
    'ligament':  (0.85, 0.28, 0.28, 1.0),
}
DEFAULT = (0.8, 0.8, 0.8, 1.0)


def color_for(name):
    n = name.lower()
    if 'plateau' in n:
        return PALETTE['plateau']
    if 'meniscus' in n:
        return PALETTE['meniscus']
    if 'acl' in n or 'pcl' in n or 'mcl' in n or 'lcl' in n or 'lig' in n:
        return PALETTE['ligament']
    if 'patella' in n:
        return PALETTE['patella']
    if 'tibia' in n:
        return PALETTE['tibia']
    if 'femur' in n:
        return PALETTE['femur']
    return DEFAULT


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(GLB))

    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    print('MESHES:', [(o.name, len(o.data.polygons)) for o in meshes])

    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector((min(lo[i], w[i]) for i in range(3)))
            hi = Vector((max(hi[i], w[i]) for i in range(3)))
    center = (lo + hi) / 2
    size = hi - lo
    print('BOUNDS lo=%s hi=%s size=%s' % (tuple(round(v, 4) for v in lo),
                                          tuple(round(v, 4) for v in hi),
                                          tuple(round(v, 4) for v in size)))

    # 每个部件一种颜色
    for o in meshes:
        col = color_for(o.name)
        mat = bpy.data.materials.get('c_' + o.name) or bpy.data.materials.new('c_' + o.name)
        mat.use_nodes = True
        bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf:
            bsdf.inputs['Base Color'].default_value = col
            if 'Roughness' in bsdf.inputs:
                bsdf.inputs['Roughness'].default_value = 0.62
        mat.diffuse_color = col
        o.data.materials.clear()
        o.data.materials.append(mat)
        for p in o.data.polygons:
            p.use_smooth = True

    scn = bpy.context.scene
    scn.use_nodes = False
    scn.render.engine = 'BLENDER_WORKBENCH'
    sh = scn.display.shading
    sh.light = 'STUDIO'
    sh.color_type = 'MATERIAL'
    sh.show_shadows = True
    sh.show_cavity = True
    sh.cavity_type = 'BOTH'
    sh.show_object_outline = False
    scn.render.film_transparent = False
    scn.world = scn.world or bpy.data.worlds.new('W')
    scn.world.color = (0.16, 0.17, 0.19)
    scn.render.resolution_x = 760
    scn.render.resolution_y = 900
    scn.render.resolution_percentage = 100
    scn.render.image_settings.file_format = 'PNG'

    cam_data = bpy.data.cameras.new('Cam')
    cam_data.type = 'ORTHO'
    cam = bpy.data.objects.new('Cam', cam_data)
    scn.collection.objects.link(cam)
    scn.camera = cam

    r = max(size) * 0.62
    cam_data.ortho_scale = r * 2.05

    views = {
        'front': (0.0, 0.0),      # 正前（-Y 看向 +Y）
        'back':  (180.0, 0.0),
        'side':  (90.0, 0.0),     # 右侧
        'med':   (-90.0, 0.0),    # 左侧
        '34':    (35.0, 0.0),
    }
    os.makedirs(OUT, exist_ok=True)
    d = max(size) * 3.0
    for name, (yaw, pitch) in views.items():
        ya = math.radians(yaw)
        pa = math.radians(pitch)
        cam.location = center + Vector((
            math.sin(ya) * math.cos(pa) * d,
            -math.cos(ya) * math.cos(pa) * d,
            math.sin(pa) * d,
        ))
        direction = center - cam.location
        cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
        scn.render.filepath = os.path.join(OUT, name + '.png')
        bpy.ops.render.render(write_still=True)
        print('RENDERED', scn.render.filepath)


main()
