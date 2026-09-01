"""Read-only source audit; optionally export an independently optimized GLB."""
import argparse, json, sys
from pathlib import Path
import bpy
from mathutils import Vector

parser=argparse.ArgumentParser()
parser.add_argument('--source',required=True)
parser.add_argument('--directory',required=True)
parser.add_argument('--optimize',action='store_true')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
out=Path(args.directory).resolve();out.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(Path(args.source).resolve()))
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
points=[o.matrix_world@Vector(v) for o in meshes for v in o.bound_box]
lo=Vector(tuple(min(p[i] for p in points) for i in range(3)))
hi=Vector(tuple(max(p[i] for p in points) for i in range(3)))
center=(lo+hi)/2;size=hi-lo
for o in meshes:o.data.calc_loop_triangles()
report={'source':args.source,'bbox_blender':{'min':list(lo),'max':list(hi),'size':list(size)},
 'meshes':[{'name':o.name,'vertices':len(o.data.vertices),'triangles':len(o.data.loop_triangles),'uv_layers':len(o.data.uv_layers)} for o in meshes],
 'armatures':len([o for o in bpy.context.scene.objects if o.type=='ARMATURE']),
 'animations':len(bpy.data.actions),
 'images':[{'name':i.name,'size':list(i.size)} for i in bpy.data.images],
 'base_color_bound':sum(1 for m in bpy.data.materials if m.use_nodes for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED' and n.inputs['Base Color'].is_linked)}
if args.optimize:
 for o in meshes:
  bpy.context.view_layer.objects.active=o
  modifier=o.modifiers.new('Preview decimation preserving source copy','DECIMATE')
  modifier.ratio=.04
  bpy.ops.object.modifier_apply(modifier=modifier.name)
  for polygon in o.data.polygons:polygon.use_smooth=True
 for image in bpy.data.images:
  if image.type=='IMAGE' and max(image.size)>2048:
   factor=2048/max(image.size);image.scale(max(1,round(image.size[0]*factor)),max(1,round(image.size[1]*factor)))
 bpy.ops.object.select_all(action='DESELECT')
 for o in meshes:o.select_set(True)
 bpy.ops.export_scene.gltf(filepath=str(out/'uploaded-hand-lite.glb'),export_format='GLB',use_selection=True,export_animations=False)
 report['optimized_triangles']=sum(len(o.data.polygons) for o in meshes)
 report['output']=str(out/'uploaded-hand-lite.glb')

scene=bpy.context.scene
scene.render.engine='BLENDER_EEVEE'
scene.eevee.taa_render_samples=16
scene.render.resolution_x=640;scene.render.resolution_y=640;scene.render.resolution_percentage=100
scene.world=bpy.data.worlds.new('AuditWorld');scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.45,.45,.45,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.5
scene.view_settings.view_transform='Standard';scene.view_settings.look='Medium High Contrast';scene.view_settings.exposure=0
for name,loc,energy in [('Key',(2,-3,4),400),('Fill',(-2,-2,1),250),('Rim',(1,2,2),350)]:
 data=bpy.data.lights.new(name,'AREA');data.energy=energy;data.size=3
 light=bpy.data.objects.new(name,data);scene.collection.objects.link(light);light.location=center+Vector(loc)
 light.rotation_euler=(center-light.location).to_track_quat('-Z','Y').to_euler()
data=bpy.data.cameras.new('AuditCamera');camera=bpy.data.objects.new('AuditCamera',data);scene.collection.objects.link(camera);scene.camera=camera
data.type='ORTHO';data.ortho_scale=max(size)*1.25
for name,offset in [('front',(0,-3,0)),('back',(0,3,0)),('left',(-3,0,0)),('right',(3,0,0)),('top',(0,0,3)),('oblique',(2,-3,1.2))]:
 camera.location=center+Vector(offset)
 camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
 scene.render.filepath=str(out/(name+'.png'));bpy.ops.render.render(write_still=True)
(out/'audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print('HAND_AUDIT',json.dumps(report,ensure_ascii=False),flush=True)
