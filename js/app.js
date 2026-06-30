// app.js - Website Initialiser
/* import './runtime/runtime.js';

(function init(){
  const app = document.getElementById('app');
  app.innerHTML = '<main>Welcome to IDPORT</main>';
  // initialize runtime
  if(window.Runtime && typeof window.Runtime.init === 'function'){
    window.Runtime.init();
  }
})(); */






/* ========================
   THE HOME LUANCH LOGIC OF
   THE ACTIVE STATE OF BOTH 
   THE DOT AND KNOB RESIDING 
   WITHIN THE MAIN SWITCH 
   ======================== */

document
.querySelectorAll(
    ".switch-btn[data-target]"
)
.forEach(btn => {

    btn.addEventListener(

        "click",
        () => {

            btn.classList.add(
                "active"
            );

            setTimeout(() => {
            window.location.href =
            btn.dataset.target;
              /*  btn.classList.remove(
                    "active"
                ); */

            }, 450);

        }
    ); 

});





window.addEventListener("pageshow", () => {

    document
        .querySelectorAll(".switch-btn")
        .forEach(btn => {

            btn.classList.remove("active");

        });

    const dropdown =
        document.getElementById(
            "dropdown-menu"
        );

    if (dropdown) {

        dropdown.classList.remove(
            "active"
        );

    }

});









/* ========================
   THE MENU LUANCH LOGIC OF
   THE ACTIVE STATE OF BOTH 
   THE DOT AND KNOB RESIDING 
   WITHIN THE MAIN SWITCH 
   ======================== */

const menuSwitch =
document.getElementById(
    "menu-switch"
);

const dropdown =
document.getElementById(
    "dropdown-menu"
);

menuSwitch.addEventListener(
    "click",
    () => {

        menuSwitch.classList.toggle(
            "active"
        );

        dropdown.classList.toggle(
            "active"
        );

    }
);




/* =====================================================
   🌊 LIQUID METAL REACTIVE MOVEMENT ENGINE (NEW LAYER)
===================================================== */

const liquidSwitches = document.querySelectorAll(".switch-btn");

liquidSwitches.forEach((btn) => {

    let rect;

    const updateBounds = () => {
        rect = btn.getBoundingClientRect();
    };

    updateBounds();
    window.addEventListener("resize", updateBounds);


    /* --------------------------------
       POINTER TRACKING (FLOW FIELD)
    -------------------------------- */

    btn.addEventListener("pointermove", (e) => {
       

        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;

        // clamp 0 → 1
        const mx = Math.min(Math.max(x, 0), 1);
        const my = Math.min(Math.max(y, 0), 1);

        btn.style.setProperty("--mx", mx.toFixed(3));
        btn.style.setProperty("--my", my.toFixed(3));

       

         

    });


    /* --------------------------------
       TOUCH / PRESS INTENSITY
    -------------------------------- */

    btn.addEventListener("pointerdown", () => {
        btn.classList.add("pressing");
        btn.style.setProperty("--glow", "1");
    });

    btn.addEventListener("pointerup", () => {
        btn.classList.remove("pressing");
        btn.style.setProperty("--glow", "0");
    });

    btn.addEventListener("pointerleave", () => {
        btn.classList.remove("pressing");
        btn.style.setProperty("--glow", "0");
    });

});



/*=============================
  JS — LIQUID METAL REACTIVE
  ENGINE (KNOB-AWARE)
  (CSS --liq dynamically LINK)
===============================*/


/* =========================================
   LIQUID METAL REACTIVE ENGINE (KNOB-AWARE)
   ========================================= */

/*const liquidSwitches =
document.querySelectorAll(".switch-btn");*/

function setLiquidState(btn, progress) {

    // Clamp value between 0 and 1
    progress = Math.max(0, Math.min(1, progress));

    // Push to CSS custom property
    btn.style.setProperty("--liq", progress);

}


/* =========================================
   CALCULATE KNOB POSITION BASED ON ACTIVE
   ========================================= */

function updateLiquidFromState(btn) {

    const isActive = btn.classList.contains("active");

    // 0 = left, 1 = right
    const progress = isActive ? 1 : 0;

    setLiquidState(btn, progress);

}


/* =========================================
   INIT ALL SWITCHES
   ========================================= */

liquidSwitches.forEach(btn => {

    // initial state
    updateLiquidFromState(btn);

    // watch click interaction
    btn.addEventListener("click", () => {

        // delay sync to match your animation timing
        setTimeout(() => {

            updateLiquidFromState(btn);

        }, 350);

    });

});
























/*

document
.querySelectorAll(
    ".switch-btn[data-target]"
)
.forEach(btn => {

    btn.addEventListener(
        "click",
        () => {

            btn.classList.add(
                "active"
            );

            setTimeout(() => {

                window.location.href =
                btn.dataset.target;

            }, 450);

        }
    );

});  */


/* ========================
   THE MENU LUANCH LOGIC OF
   THE ACTIVE STATE OF BOTH 
   THE DOT AND KNOB RESIDING 
   WITHIN THE MAIN SWITCH 
   ======================== */
/*
const menuSwitch =
document.getElementById(
    "menu-switch"
);

const dropdown =
document.getElementById(
    "dropdown-menu"
);

menuSwitch.addEventListener(
    "click",
    () => {

        menuSwitch.classList.toggle(
            "active"
        );

        dropdown.classList.toggle(
            "active"
        );

    }
);  */


