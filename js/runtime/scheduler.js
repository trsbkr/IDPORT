// scheduler.js - simple task scheduling
export const Scheduler = {
  next(fn){ requestAnimationFrame(fn); }
};
