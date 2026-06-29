// asset-manager.js
export const AssetManager = {
  loadImage(src){ return new Promise((resolve)=>{ const i=new Image(); i.onload=()=>resolve(i); i.src=src; }); }
};
