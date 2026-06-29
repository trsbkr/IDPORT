// theme-engine.js - theme management
export const ThemeEngine = {
  current: 'default',
  set(name){ this.current = name; document.documentElement.dataset.theme = name; }
};
