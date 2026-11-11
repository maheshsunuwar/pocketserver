'use strict';
// Preloaded into apps' Node processes on Android (NODE_OPTIONS=--require ...).
// termux-exec can start programs through Android's loader, so process.execPath becomes
// /apex/.../linker64. Tools that start Node again with it (npm-run-all, concurrently, code-server...)
// then fail with "bad ELF magic". The real path is in TERMUX_EXEC__PROC_SELF_EXE.
const real = process.env.TERMUX_EXEC__PROC_SELF_EXE;
if (real && /linker(64)?$/.test(process.execPath) && !/linker(64)?$/.test(real)) process.execPath = real;

// Packages built with napi-rs fall back to WebAssembly when there's no Android build. Their loader
// gives WASI the whole filesystem ("/"), which Android doesn't let apps open (UVWASI_EACCES).
// Hand it Termux's own folder instead, which holds everything an app can reach.
if (process.env.PREFIX && process.env.PREFIX.includes('com.termux')) {
  const path = require('path');
  const base = path.dirname(process.env.PREFIX); // /data/data/com.termux/files
  const quiet = process.emitWarning;
  process.emitWarning = () => {}; // requiring wasi prints an "experimental" warning in every process
  let wasi;
  try { wasi = require('wasi'); } catch {} finally { process.emitWarning = quiet; }
  if (wasi && wasi.WASI && !wasi.WASI.__android) {
    const Original = wasi.WASI;
    class WASI extends Original {
      constructor(options = {}) {
        const pre = options.preopens;
        if (pre && pre['/'] === '/') {
          const fixed = { ...pre };
          delete fixed['/'];
          fixed[base] = base;
          options = { ...options, preopens: fixed };
        }
        super(options);
      }
    }
    WASI.__android = true;
    wasi.WASI = WASI;
    require('module').syncBuiltinESMExports(); // so `import { WASI } from 'node:wasi'` gets it too
  }
}
