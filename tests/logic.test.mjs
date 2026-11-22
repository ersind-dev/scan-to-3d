import fs from 'fs';
import { readFiles, samplePhantom } from '../src/volume.js';
import { buildSurface, signedVolume, toSTL, otsu, surfaceNets } from '../src/mesh.js';
const n=64,g=new Float32Array(n*n*n);for(let z=0;z<n;z++)for(let y=0;y<n;y++)for(let x=0;x<n;x++)g[x+y*n+z*n*n]=20-Math.hypot(x-32,y-32,z-32);
const s=surfaceNets(g,[n,n,n],0);console.log('sphere vol',signedVolume(s.positions,s.indices).toFixed(0),'expected',(4/3*Math.PI*8000).toFixed(0));
const em=new Map();for(let i=0;i<s.indices.length;i+=3)for(let k=0;k<3;k++){const a=s.indices[i+k],b=s.indices[i+(k+1)%3];const key=a<b?a+'_'+b:b+'_'+a;em.set(key,(em.get(key)||0)+1);}
console.log('non-manifold edges',[...em.values()].filter(v=>v!==2).length);
const zip=fs.readFileSync('tests/scan.zip');
const {series,skipped}=await readFiles([{name:'scan.zip',buffer:zip.buffer.slice(zip.byteOffset,zip.byteOffset+zip.byteLength)}]);
console.log(series.map(s=>s.label),'skipped',skipped);
const v=await series[0].build();console.log(v.dims,v.spacing,v.orient,'otsu',otsu(v.data));
const m=buildSurface(v,otsu(v.data),160,true);
console.log('tris',m.indices.length/3,'vol mm3',signedVolume(m.positions,m.indices).toFixed(0),'expected ellipsoid',(4/3*Math.PI*30*38*50).toFixed(0),'stl bytes',toSTL(m.positions,m.indices).byteLength);
const p=samplePhantom();const pm=buildSurface(p,otsu(p.data),160,true);console.log('phantom otsu',otsu(p.data),'tris',pm.indices.length/3);
