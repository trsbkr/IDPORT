// theme-engine.js - theme management
export const ThemeEngine = {
  current: 'default',
  modeMap: {
    'charcoal-crimson': 'liquid-mode'
    /* future themes map here, e.g. 'emerald-aurora': 'neon-mode' */
  },
  set(name) {
    this.current = name;
    const mode = this.modeMap[name] || 'normal-mode';

    document.body.classList.remove('liquid-mode', 'neon-mode', 'normal-mode');
    document.body.classList.add(mode);

    document.dispatchEvent(new CustomEvent('runtime:theme:changed', {
      detail: { theme: name, mode }
    }));
  }
};
