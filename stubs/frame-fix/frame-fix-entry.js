// Load frame fix first, then the patched main app
require('./frame-fix-wrapper.js');
require('../.vite/build/index.js');
