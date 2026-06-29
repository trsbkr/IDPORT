// state-engine.js - basic state container
export const State = (function(){
  const state = {};
  return {
    get(k){ return state[k]; },
    set(k,v){ state[k]=v; },
  };
})();
