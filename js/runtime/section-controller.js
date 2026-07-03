// section-controller.js
// The real implementation lives inline in runtime.js (window.Runtime.SectionController).
// This file re-exports that single source of truth rather than duplicating it,
// so any future ES-module consumer gets the live object, not a stale stand-in.
export const SectionController = window.Runtime?.SectionController || null;
