膝关节模型放置说明
=====================================================================

0) 本目录的 knee.glb 是「开箱即用」的分层模型。几何来自开源解剖模型
   Open3DModel – Knee（CC BY-SA 4.0，基于 Z-Anatomy / BodyParts3D），
   经本项目归一化、重建盾形髌骨、移植到自有动画骨架后导出：
   18 个独立部件 + 4 段烘焙动画，约 3.7 万三角面 / 800 KB。

   重新生成（详见项目 README 第 4.0 节）：
       "D:/软件/Blender/blender.exe" -b -P tools/build_knee_from_open3dmodel.py -- \
         <带动画的旧GLB> <knee_complete_raw.glb> <输出GLB> [盾形髌骨来源GLB]

   早期方案（从 Z-Anatomy 直接抽取，部件较少）：
       "D:/软件/Blender/blender.exe" -b "D:/github/_atlas/Z-Anatomy-Startup.blend" \
           --python tools/build_knee_from_atlas.py

   备用方案（纯程序化、不依赖外部数据）：
       "D:/软件/Blender/blender.exe" -b --factory-startup --python tools/build_knee_model.py

   自带的节点层级（网页端靠这套命名做分层识别，改名务必同步改 modelLoader.js）：

   KneeRoot                   整体位移（跑步起伏）
     ├─ FemurPivot            屈髋 / 内旋
     │    ├─ Femur_Body / Femur_Cartilage
     │    ├─ PatellaPivot     髌骨在滑车内的滑动
     │    │    └─ Patella     （盾形，按图谱尺寸重建）
     │    └─ ACL / PCL / MCL / LCL
     └─ TibiaPivot            屈膝 / 膝内扣（外翻）/ 胫骨内旋
          ├─ Tibia_Body / Tibia_Cartilage / Fibula / Fibula_Cartilage
          └─ Meniscus_Medial / Meniscus_Lateral （各含前/后角）

   材质说明：骨骼/软骨默认半透明（关闭深度写入），半月板与韧带较实，
   这样关节腔内部才看得见。基准不透明度定义在 js/modelLoader.js 的 LAYERS 里。

   许可：模型几何 CC BY-SA 4.0，衍生模型同样以 CC BY-SA 共享；
   请在论文/展示中保留 Open3DModel、Z-Anatomy、BodyParts3D 署名。

1) 换成自己的模型：命名为 knee.glb 放在本目录，刷新页面即可自动加载。
   文件路径：assets/models/knee.glb

2) 模型必须是「分层」的：每个解剖结构是独立对象，且对象名包含下列关键词
   （大小写不敏感，含关键词即可识别）：

   股骨              Femur
   胫骨              Tibia
   胫骨平台          Tibia_Plateau  （可选，没有就用整个胫骨做冲击高亮）
   髌骨              Patella
   内侧半月板        Meniscus_Medial（含 _Horn_Ant / _Horn_Post 前后角）
   外侧半月板        Meniscus_Lateral（含 _Horn_Ant / _Horn_Post 前后角）
   关节软骨          Femur_Cartilage / Tibia_Cartilage / Fibula_Cartilage
   前交叉韧带        ACL
   后交叉韧带        PCL
   内侧副韧带        MCL
   外侧副韧带        LCL

3) 动画 clip 名称（必须包含关键词，推荐直接用下面的名字）：

   anim_squat_correct      标准深蹲
   anim_squat_valgus       膝内扣错误深蹲
   anim_run_correct        前掌落地跑步
   anim_run_heelstrike     后跟硬落地跑步

   导出设置：Animation Mode = NLA Tracks（每个 Action 压一条同名轨道）。
   用 Actions 模式只会导出当前激活的那一个动作。

4) 本目录下的 sample_knee_test.glb 是一个「几何体拼的测试模型」，
   只用来验证 GLB 加载通路是否正常（含 4 段动画与全部命名部件）。
   访问  index.html?model=assets/models/sample_knee_test.glb  可以查看效果。
   确认你自己的模型没问题后，可以把这个测试文件删掉。

5) 常见问题：
   - 页面显示「内置解析模型」→ 说明 knee.glb 没加载成功，检查路径/文件名大小写；
   - 半月板不会变红 → 半月板没有独立命名，被合并进了胫骨网格；
   - 有模型但不动 → GLB 里没有动画，或导出时 Animation Mode 没选 NLA Tracks；
   - 切动作后姿态残留 → 某个关节的属性没在每段动画里都打关键帧。

6) 全身人体资产（human.json / human.bin / human-data.js）：
   几何来自 human-atlas 公开的 BodyParts3D 4.0 分批网格（CC BY 4.0），
   只保留 muscular + skeletal 两个系统并剔除肌腱/韧带/筋膜/血管/神经等表面碎片，
   再经网格焊接减面（6mm）、面积加权平滑法线、按组织着色（肌肉深红/骨象牙白）、
   对 17 根骨骼计算平滑蒙皮权重后 bake 而成：约 7.96 万顶点 / 27.4 万三角面。
   顶点色以 sRGB 存储，js/bodyFigure.js 解析时转线性（渲染器为 sRGB 输出 + ACES）。

   重新生成（需先下载 atlas.json 与 body-*.bin.gz 到同一目录）：
       node tools/build_human_from_atlas.mjs <atlas目录> assets/models
   脚本同时产出 human-data.js（base64 内嵌副本）。

   加载链路（js/bodyFigure.js / js/modelLoader.js / js/embed.js）：
   优先 fetch human.json+human.bin 与 knee.glb；fetch 失败（如 file:// 双击打开
   被浏览器禁止本地 fetch）时自动注入 human-data.js / knee-data.js 内嵌副本；
   两者都失败才回退程序化玻璃人 / 内置解析膝关节，永不白屏。
   human-data.js / knee-data.js 仅在回退时下载，不增加正常首屏流量。
