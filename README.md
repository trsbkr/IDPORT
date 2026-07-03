# ID Portfolio

Welcome to the IDPORT project.



# Site Map

```

IDPORT
│
├── APPLICATION SHELL
│   │
│   ├── Search Identity
│   ├── SEO Metadata
│   ├── Website Runtime Loader
│   ├── App Loader
│   ├── Header
│   ├── Homepage
│   └── Footer
│
├── WEBSITE RUNTIME
│   │
│   ├── Website State Engine
│   ├── Theme Engine
│   ├── Motion Engine
│   ├── Environment Engine
│   ├── Event Engine
│   ├── Scheduler
│   ├── Transition Engine
│   ├── Performance Engine
│   ├── Layout Engine
│   ├── Asset Manager
│   ├── Section Controller
│   ├── Rendering Services
│   ├── Theme Library
│   └── Component Registry
│
├── HOME
│   │
│   ├── Hero
│   │   ├── Portrait
│   │   ├── Quotes
│   │   ├── Theme (Charcoal Crimson)
│   │   ├── Navigation
│   │   └── Hero Engine
│   │
│   ├── About Preview
│   │
│   ├── Carousel Project Selector
│   │   └── Carousel Engine
│   │
│   ├── Featured Projects
│   │   └── Featured Engine
│   │
│   ├── Testimonials
│   │   └── Testimonials Engine
│   │
│   └── Services
│       └── Services Engine
│
├── ABOUT
│   │
│   ├── Biography
│   ├── Career
│   ├── Quotes
│   ├── Full Story
│   └── Timeline Engine
│
├── WORKS
│   │
│   ├── Carousel Archive
│   ├── Featured Projects
│   ├── Project Pages
│   ├── Media Gallery
│   └── Project Viewer Engine
│
├── AUTHENTICATION
│   │
│   ├── Register
│   ├── Login
│   ├── Account Recovery
│   └── Authentication Engine
│
├── EDITS
│   │
│   ├── Profile Editor
│   ├── Theme Editor
│   ├── Quote Manager
│   ├── Carousel Manager
│   ├── Project Manager
│   ├── Services Manager
│   └── Content Management Engine
│
└── USER PROFILE
    │
    ├── Permissions
    ├── Upload Capacity
    ├── Storage
    ├── Settings
    └── User State Engine



```

## Project Structure

```


ID-PORTFOLIO/
│
├── index.html                         # Application Shell (Website Entry)
│
├── assets/
│   │
│   ├── images/
│   ├── icons/
│   ├── videos/
│   └── fonts/
│
├── css/
│   │
│   ├── global.css
│   ├── variables.css
│   ├── responsive.css
│   │
│   ├── runtime/
│   │   ├── runtime.css
│   │   ├── themes.css
│   │   ├── transitions.css
│   │   └── layout.css
│   │
│   └── sections/
│       │
│       ├── hero.css
│       ├── about.css
│       ├── img-carousel.css
│       ├── featured-projects.css
│       ├── testimonials.css
│       ├── services.css
│       └── footer.css
│
├── js/
│   │
│   ├── app.js                         # Website Initialiser
│   │
│   ├── runtime/
│   │   │
│   │   ├── runtime.js                 # Website Runtime
│   │   ├── state-engine.js
│   │   ├── theme-engine.js
│   │   ├── motion-engine.js
│   │   ├── environment-engine.js
│   │   ├── event-engine.js
│   │   ├── scheduler.js
│   │   ├── transition-engine.js
│   │   ├── performance-engine.js
│   │   ├── layout-engine.js
│   │   ├── asset-manager.js
│   │   ├── section-controller.js
│   │   ├── rendering-services.js
│   │   ├── component-registry.js
│   │   ├── theme-library.js
│   │   └── plugins/
│   │
│   ├── sections/
│   │   │
│   │   ├── hero.js
│   │   ├── about.js
│   │   ├── img-carousel.js
│   │   ├── featured-projects.js
│   │   ├── testimonials.js
│   │   ├── services.js
│   │   └── viewer.js
│   │
│   └── utils/
│       │
│       ├── animations.js
│       ├── storage.js
│       ├── helpers.js
│       └── observers.js
│
├── data/
│   │
│   ├── config.json
│   ├── quotes.json
│   ├── themes.json
│   ├── homepage.json
│   └── projects.json
│
├── docs/
│   │
│   ├── architecture.md
│   ├── features.md
│   ├── milestones.md
│   ├── phase-history.md
│   ├── project-map.md
│   ├── roadmap.md
│   ├── sitemap.md
│   ├── runtime.md
│   └── theme-library.md
│
└── README.md





```

# IDPORT — Public API & Event Contract Reference

```

**Purpose:** single source of truth for every public method name and custom event name in use across the codebase. Before any file calls a method or listens for an event owned by another file, the name must appear here first. If it doesn't exist yet, add it here before implementing it — never after.

**Last verified against live repo:** commit `6205591` (direct grep of committed source, not memory).

**Update rule:** whenever a file that owns a method or event changes, re-verify this document against the actual code before trusting it. This document describes what IS committed, not what is planned or intended.

---

## 1. `window.Hero` — Public API (frozen, exposed after `hero:initialized`)

| Method | Signature | Notes |
|---|---|---|
| `Hero.info()` | `() => {name, version, protocol}` | |
| `Hero.version()` | `() => string` | |
| `Hero.isInitialized()` | `() => boolean` | |
| `Hero.getStatus()` | `() => "uninitialized"\|"initializing"\|"active"\|"suspended"\|"destroyed"` | |
| `Hero.getState()` | `() => object` (shallow copy) | |
| `Hero.on(eventName, cb)` | | wraps `document.addEventListener` |
| `Hero.off(eventName, cb)` | | |
| `Hero.once(eventName, cb)` | | |
| `Hero.ready()` | `() => Promise<publicAPI>` | resolves on `hero:initialized` |
| `Hero.engine(name)` | `(string) => frozen shallow clone \| null` | never returns the live internal object |
| `Hero.engines()` | `() => string[]` | list of registered engine keys |
| `Hero.init()` | | no-op if already initialized |
| `Hero.destroy()` | | |
| `Hero.refresh()` | | destroy + init |
| `Hero.suspend()` | | |
| `Hero.resume()` | | |
| `Hero.reset()` | | → `engines.stateReset.reset()` |
| `Hero.navigate(target)` | `(string)` | → `engines.navigation.navigateTo()` |
| `Hero.theme(name?)` | `(string?) => currentThemeName` | get/set |
| `Hero.menu.open()` / `.close()` / `.toggle()` / `.isOpen()` | | |
| `Hero.portrait.requestChange(src, opts?)` | | |
| `Hero.portrait.get()` | `() => string \| null` | |
| `Hero.quotes.next()` / `.previous()` / `.pause()` / `.resume()` / `.togglePause()` | | |
| `Hero.quotes.loadQuotes(arr)` | `(string[])` | ⚠️ NOT `.load()` |
| `Hero.quotes.getCurrent()` | | |
| `Hero.bridge.send(type, data)` | | |
| `Hero.bridge.receive(type, data)` | | |
| `Hero.bridge.isConnected()` | `() => boolean` | |
| `Hero.diagnostics()` | `() => object` | aggregates engine diagnostics |

---

## 2. Internal `engines.*` objects (not exposed directly — only via `Hero.engine()` as a frozen clone)

| Engine key | Notable methods other engines/Bridge call |
|---|---|
| `engines.navigation` | `navigateTo(target)`, `getActiveTarget()` |
| `engines.stateReset` | `reset(force?)`, `resetMenu()` |
| `engines.menu` | `open()`, `close()`, `toggle()`, `isOpen()` |
| `engines.liquidPointer` | `pause()`, `resume()`, `refreshBounds()` |
| `engines.liquidState` | `updateFromState(btn)`, `suspend()`, `resume()` |
| `engines.theme` | `apply(name)`, `register(name, config)`, `getCurrent()`, `getAvailable()` |
| `engines.portrait` | `requestChange(src, opts)` ⚠️ NOT `.set()` · `load()` · `updateLighting(env)` · `pause()` / `resume()` |
| `engines.quote` | `loadQuotes(arr)` ⚠️ NOT `.load()` · `request(index)` · `pause()` / `resume()` / `togglePause()` |
| `engines.animation` | `enter()`, `exit(cb)`, `pause()`, `resume()`, `diagnostics()` |
| `engines.runtimeBridge` | `send(type, data)`, `receive(type, data)`, `notifyNavigate(target)`, `isConnected()`, `diagnostics()` |

**⚠️ Historical bug this table exists to prevent:** an earlier draft of the Runtime Bridge called `engines.quote.load()` and `engines.portrait.set()` — neither ever existed under those names. Always check this table before writing a cross-engine call.

---

## 3. Custom Events — dispatched via `dispatchHeroEvent()` on `document`

| Event name | Dispatched by | Consumed by (currently) |
|---|---|---|
| `hero:initialized` | Engine 1 (init) | Runtime (`runtime.js` → `SectionController.adopt`), Bridge (forwards to Runtime) |
| `hero:destroying` / `hero:destroyed` | Engine 1 (destroy) | — |
| `hero:navigation:started` / `:beforeNavigate` / `:completed` | Engine 2 | `liquidState` (on `:completed`), Bridge forwards `:started`/`:completed` |
| `hero:state:reset` | Engine 3 | Bridge forwards |
| `hero:menu:opened` / `hero:menu:closed` | Engine 4 | Bridge forwards |
| `hero:theme:changed` | Engine 7 | Bridge forwards |
| `hero:portrait:loading` / `:loaded` / `:error` | Engine 8 | Bridge forwards `:loaded` only |
| `hero:portrait:change-request` | Engine 8 | Animation Engine (crossfade envelope) |
| `hero:environment:update` | Bridge (Engine 11, relaying Runtime's `environment:update` message) | Portrait Engine (`updateLighting`) — ⚠️ currently registered **twice**, needs dedup. Animation Engine (stub only). Theme Engine — **not yet wired**. |
| `hero:quote:render` | Engine 9 | Animation Engine (crossfade), Bridge forwards |
| `hero:quote:suspended` / `hero:quote:resumed` | Engine 9 | — |
| `hero:quotes:loaded` | Engine 9 | — |
| `hero:animation:entering` / `:entered` / `:exiting` / `:exited` | Engine 10 | Bridge forwards `:entered`/`:exited` |
| `hero:bridge:connected` | Engine 11 | — |

## 4. Custom Events — listened for by `hero.js` but dispatched elsewhere

| Event name | Listened by | Expected dispatcher |
|---|---|---|
| `runtime:theme:changed` | Engine 7 (Theme) | `theme-engine.js` `set()` — ✅ confirmed live |
| `runtime:quote:set` | Engine 9 (Quote) | Runtime — ❌ nothing dispatches this yet |
| `runtime:locale:changed` | Engine 9 (Quote) | Runtime — ❌ nothing dispatches this yet |

---

## 5. Runtime Bridge Message Protocol (`Hero.bridge.send/receive`, NOT DOM CustomEvents)

These are payloads passed through `runtime.receive(type, packet)` and `window.__heroReceive(type, payload)` — a separate channel from the DOM events above. Full envelope shape: `{id, type, data, source, timestamp, protocolVersion}`. **The second argument received by `runtime.receive()` is the FULL envelope — access real content via `payload.data.x`, not `payload.x`.**

### Hero → Runtime (via `sendToRuntime`, requires `window.Runtime.receive` to exist)
All names in section 3's "Bridge forwards" column, plus:
| Type | Data shape |
|---|---|
| `hero:heartbeat` | `{ heartbeat: timestamp }` |
| `hero:navigation:request` | `{ target }` |

### Runtime → Hero (via `window.__heroReceive(type, payload)`, exposed by Bridge)
| Type | Routes to | Data shape |
|---|---|---|
| `theme:change` | `engines.theme.apply(payload.theme)` | `{ theme }` |
| `hero:reset` | `engines.stateReset.reset()` | — |
| `hero:enter` | `engines.animation.enter()` | — |
| `hero:exit` | `engines.animation.exit(payload.callback)` | `{ callback }` |
| `quotes:load` | `engines.quote.loadQuotes(payload.quotes)` | `{ quotes }` |
| `portrait:set` | `engines.portrait.requestChange(payload.src, {animate})` | `{ src, animate }` |
| `environment:update` | dispatches `hero:environment:update` DOM event | `{ x, y, intensity, depth, ... }` |

**⚠️ Status: this entire Runtime→Hero direction is currently non-functional.** Nothing on the Runtime side calls `window.__heroReceive(...)`. This table documents the contract Hero is *ready* to receive, not a working pipeline yet.

---

## 6. `window.Runtime` — Public API (`runtime.js`)

| Method | Signature | Notes |
|---|---|---|
| `Runtime.init()` | | called automatically at bottom of file |
| `Runtime.SectionController.adopt(name, instance)` | `(string, object) => boolean` | validates `typeof instance.getStatus === "function"` |
| `Runtime.SectionController.get(name)` | `(string) => instance \| null` | |
| `Runtime.receive(type, payload)` | ❌ **does not exist yet** | required for Hero's outbound queue to ever flush |

**⚠️ Known duplication:** `js/runtime/section-controller.js` (separate ES module file) still exports a different, stale `SectionController` (`{register(){}, mount(){}}`) that nothing imports. The real, working one lives inline inside `runtime.js`. Not yet reconciled.

---

## 7. Other Runtime files — current state (verified empty/stub, not yet part of any contract)

| File | Status |
|---|---|
| `js/runtime/theme-engine.js` | ✅ Live — `ThemeEngine.set(name)`, dispatches `runtime:theme:changed` |
| `js/runtime/event-engine.js` | Functional pub/sub (`EventEngine.on/emit`) but **unused by anything else** — not yet part of any real contract |
| `js/runtime/environment-engine.js` | Stub — `{ isTouch }` only, no origination logic |
| `js/runtime/section-controller.js` | Stub, orphaned (see §6) |
| `state-engine.js`, `motion-engine.js`, `scheduler.js`, `transition-engine.js`, `performance-engine.js`, `layout-engine.js`, `asset-manager.js`, `rendering-services.js`, `theme-library.js`, `component-registry.js` | Not re-verified since early session — re-audit before building against them |

---

*When a new method or event is added anywhere in the codebase, add its row here in the same commit. When in doubt about whether a name already exists, grep the actual repo — don't rely on memory or a prior version of this document.*



```










