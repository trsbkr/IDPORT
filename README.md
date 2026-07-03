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




