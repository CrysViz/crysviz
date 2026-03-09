import * as THREE from './three/three.module.js';

export function superquadricGeometry(alpha, beta, scale=1, nu=64, nv=32) {
  const pos = [];
  const idx = [];

  const spow = (x,e)=>Math.sign(x)*Math.pow(Math.abs(x),e);

  for (let i=0;i<=nv;i++) {
    const u = -Math.PI/2 + i*Math.PI/nv;
    for (let j=0;j<=nu;j++) {
      const v = -Math.PI + j*2*Math.PI/nu;

      const cu=Math.cos(u), su=Math.sin(u);
      const cv=Math.cos(v), sv=Math.sin(v);

      pos.push(
        scale * spow(cu,beta) * spow(cv,alpha),
        scale * spow(cu,beta) * spow(sv,alpha),
        scale * spow(su,beta)
      );
    }
  }

  for (let i=0;i<nv;i++)
    for (let j=0;j<nu;j++) {
      const a=i*(nu+1)+j;
      const b=a+1;
      const c=a+(nu+1);
      const d=c+1;
      idx.push(a,b,d, a,d,c);
    }

  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.computeVertexNormals();
  return g;
}

