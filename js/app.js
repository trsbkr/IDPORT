// app.js - Website Initialiser
import './runtime/runtime.js';

(function init(){
  const app = document.getElementById('app');
  app.innerHTML = '<main>Welcome to IDPORT</main>';
  // initialize runtime
  if(window.Runtime && typeof window.Runtime.init === 'function'){
    window.Runtime.init();
  }
})();
