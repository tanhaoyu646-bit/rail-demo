export type RoomCollider = { name: string; minX: number; maxX: number; minZ: number; maxZ: number; enabled: () => boolean };
export function collidesWithRoom(x: number, z: number, proxies: readonly RoomCollider[], radius=.28): boolean {
  return proxies.some(p=>p.enabled()&&x>p.minX-radius&&x<p.maxX+radius&&z>p.minZ-radius&&z<p.maxZ+radius);
}
export function resolveRoomMove(current: {x:number;z:number}, desired: {x:number;z:number}, proxies: readonly RoomCollider[], radius=.28): {x:number;z:number} {
  // Substeps also prevent tunnelling across a thin leaf during a slow frame.
  let {x,z}=current;
  const steps=Math.max(1,Math.ceil(Math.hypot(desired.x-x,desired.z-z)/.10));
  const dx=(desired.x-x)/steps,dz=(desired.z-z)/steps;
  for(let i=0;i<steps;i++){
    if(!collidesWithRoom(x+dx,z,proxies,radius))x+=dx;
    if(!collidesWithRoom(x,z+dz,proxies,radius))z+=dz;
  }
  x=Math.max(-5.68,Math.min(5.68,x));z=Math.max(-10.2,Math.min(14.2,z));
  if(z< -4.3)x=Math.max(-5.68,Math.min(-3.28,x));
  if(z>8.3)x=Math.max(-1.32,Math.min(1.32,x));
  return {x,z};
}
