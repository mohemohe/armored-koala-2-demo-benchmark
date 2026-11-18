import * as T from 'three';

// A painted industrial ceiling reflected in rough armor and exposed joints.
// Linear RGB radiance, with warm overhead strips and cool inspection windows.
export function factoryReflections() {
  const width=256,height=128,data=new Uint16Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const az=(x+.5)/width,alt=(y+.5)/height;
    const strip=alt>.63&&alt<.68&&Math.cos(az*Math.PI*6)>-.45;
    const window=alt>.46&&alt<.59&&Math.abs(az-.69)<.095;
    const sky=.035+.13*Math.sin(Math.PI*alt)**4;
    const rgb=strip?[3.7,2.7,1.7]:window?[1.15,1.67,1.9]:[sky*.94,sky,sky*1.04];
    const i=(y*width+x)*4;
    for(let j=0;j<3;j++)data[i+j]=T.DataUtils.toHalfFloat(rgb[j]);
    data[i+3]=T.DataUtils.toHalfFloat(1);
  }
  const tex=new T.DataTexture(data,width,height,T.RGBAFormat,T.HalfFloatType);
  tex.mapping=T.EquirectangularReflectionMapping;tex.needsUpdate=true;return tex;
}

let finish;
export function armorFinish() {
 if(finish)return finish;
 const n=128,data=new Uint8Array(n*n*4);let seed=271;
 const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
 for(let i=0;i<n*n;i++){
   const shade=238+Math.floor(rand()*17);
   data.set([shade,shade,shade,255],i*4);
 }
 for(let i=0;i<160;i++){
   const x=Math.floor(rand()*n),y=Math.floor(rand()*n),len=1+Math.floor(rand()**3*14),slope=rand()-.5;
   const value=rand()>.4?209:224;
   for(let k=0;k<len;k++){const j=(((y+Math.round(k*slope)+n)%n)*n+(x+k)%n)*4;data.set([value,value,value,255],j)}
 }
 finish=new T.DataTexture(data,n,n);finish.colorSpace=T.SRGBColorSpace;finish.wrapS=finish.wrapT=T.RepeatWrapping;
 finish.generateMipmaps=true;finish.minFilter=T.LinearMipMapLinearFilter;finish.magFilter=T.LinearFilter;finish.needsUpdate=true;
 return finish;
}
