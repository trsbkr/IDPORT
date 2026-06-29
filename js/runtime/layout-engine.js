// layout-engine.js
export const LayoutEngine = { reflow(){ window.dispatchEvent(new Event('resize')); } };
