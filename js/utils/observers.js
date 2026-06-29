// observers.js - Mutation/Intersection observers
export function createObserver(cb, opts){ return new IntersectionObserver(cb, opts); }
