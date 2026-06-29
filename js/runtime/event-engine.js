// event-engine.js - event pub/sub
const _events = {};
export const EventEngine = {
  on(k,cb){ (_events[k] = _events[k]||[]).push(cb); },
  emit(k,p){ (_events[k]||[]).forEach(cb=>cb(p)); }
};
