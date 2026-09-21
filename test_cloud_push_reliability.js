// v1.80: two push-side cloud sync fixes, reported live -- data logged on an iPhone was still not
// reaching a PC even after the v1.78 pull-side fix. Root cause: pushToCloud() debounces 1.5s via
// setTimeout with nothing to flush it early, so backgrounding/closing the tab within that window
// (very normal on mobile: log a set, lock the phone) can silently drop the pending push before it
// ever fires -- the data stays safe locally but never reaches Firestore. This file covers:
// (1) flushPendingCloudPush() actually runs a pending push immediately instead of waiting,
// (2) the catastrophic-wipe circuit breaker refuses to push a near-total data loss over real
//     previously-synced cloud data, and can be bypassed with force=true,
// (3) a push-time throw (e.g. from the photo sync step) is caught and surfaced, never silent.
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync(__dirname + '/body-nutrition-analyzer.html', 'utf-8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

function makeClassList(){
  const set = new Set();
  return { toggle(cls,f){ if(f===undefined){set.has(cls)?set.delete(cls):set.add(cls);} else if(f){set.add(cls);} else {set.delete(cls);} },
    add(c){set.add(c);}, remove(c){set.delete(c);}, contains(c){return set.has(c);} };
}
const elements = new Map();
function fakeEl(id){
  if(elements.has(id)) return elements.get(id);
  const listeners = {};
  const el = { id, _value:"", checked:false, get value(){return this._value;}, set value(v){this._value=v;},
    innerHTML:"", textContent:"", style:{}, classList: makeClassList(), disabled:false, options:[], files:[], dataset:{},
    selectedOptions:[{value:"g", dataset:{}}],
    addEventListener(t,fn){(listeners[t]=listeners[t]||[]).push(fn);}, removeEventListener(){}, dispatchEvent(){},
    _trigger(t,e){ const fns=(listeners[t]||[]).slice(); return Promise.all(fns.map(fn=>fn(e||{target:el}))); },
    reset(){this._value=""; this.checked=false;}, appendChild(){}, removeChild(){}, querySelector(){return null;}, querySelectorAll(){return [];},
    closest(){return null;}, setAttribute(){}, getAttribute(){return null;}, focus(){}, click(){}, scrollIntoView(){} };
  elements.set(id, el); return el;
}
const storage = {};
const fakeLocalStorage = { getItem(k){return storage[k]||null;}, setItem(k,v){storage[k]=String(v);}, removeItem(k){delete storage[k];} };
let visibilityState = "visible";
const docListeners = {};
const fakeDocument = { getElementById(id){return fakeEl(id);}, createElement(tag){ return fakeEl('x'+Math.random()); },
  addEventListener(t,fn){(docListeners[t]=docListeners[t]||[]).push(fn);}, querySelector(){return null;}, querySelectorAll(){return [];},
  body: fakeEl('body'), head: fakeEl('head'), get visibilityState(){ return visibilityState; } };
const winListeners = {};
const sandbox = { document: fakeDocument, localStorage: fakeLocalStorage, console, Date, Math, JSON,
  navigator:{clipboard:{writeText(){return Promise.resolve();}}}, URL:{createObjectURL(){return 'x';},revokeObjectURL(){}},
  Blob:function(){}, alert(){}, setTimeout, clearTimeout, scrollTo(){},
  fetch: async()=>{throw new Error("x");}, AbortController: class{constructor(){this.signal={};} abort(){}}, URLSearchParams,
  SpeechRecognition: undefined, webkitSpeechRecognition: undefined };
sandbox.window = sandbox;
sandbox.window.addEventListener = (t,fn)=>{ (winListeners[t]=winListeners[t]||[]).push(fn); };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, {filename:'app.js'});
console.log("script loaded OK");

function check(desc, actual, expected){
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(desc + ':', pass, pass ? '' : `(got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// --- countLoggableEntries / looksLikeCatastrophicWipe -- pure helpers ---
const count1 = vm.runInContext(`countLoggableEntries({ foodLog: {"d1":[{id:"a"}],"d2":[{id:"b"},{id:"c"}]}, workoutLog: {"d1":[{id:"w"}]} })`, sandbox);
check('T1 countLoggableEntries sums food + workout entries across all dates', count1, 4);

const count2 = vm.runInContext(`countLoggableEntries({})`, sandbox);
check('T2 countLoggableEntries on an empty/missing user object is 0, no throw', count2, 0);

check('T3a a big drop from a meaningful count to near-zero IS a catastrophic wipe',
  vm.runInContext('looksLikeCatastrophicWipe(50, 0)', sandbox), true);
check('T3b dropping from 50 to 3 (well under 10%) IS a catastrophic wipe',
  vm.runInContext('looksLikeCatastrophicWipe(50, 3)', sandbox), true);
check('T3c dropping from 50 to 10 (right at the 20% mark, well above the 10% threshold) is NOT flagged',
  vm.runInContext('looksLikeCatastrophicWipe(50, 10)', sandbox), false);
check('T3d a small prior count (under 5) never trips the guard even if it drops to 0',
  vm.runInContext('looksLikeCatastrophicWipe(4, 0)', sandbox), false);
check('T3e a brand-new account (previousCount 0) never trips the guard',
  vm.runInContext('looksLikeCatastrophicWipe(0, 0)', sandbox), false);
check('T3f a modest, plausible deletion (50 -> 40) is NOT flagged',
  vm.runInContext('looksLikeCatastrophicWipe(50, 40)', sandbox), false);

// --- flushPendingCloudPush: a pending debounced push actually runs immediately ---
vm.runInContext(`
  currentUserEmail = "flushtest@x.com";
  saveUsers({ "flushtest@x.com": { foodLog: { "2026-09-20": [{id:"f1", name:"dinner"}] } } });
  fbUser = { uid: "u1", email: "flushtest@x.com" };
  window.__pushCount = 0;
  fbDb = { collection(){ return { doc(){ return {
    set: async (doc) => { window.__pushCount++; window.__lastPushedDoc = doc; },
  }; } }; } };
`, sandbox);
// pushToCloud() schedules a 1.5s debounce -- without flushing, it would NOT have fired yet.
vm.runInContext(`pushToCloud();`, sandbox);
const timerPending = vm.runInContext('cloudSyncTimer !== null', sandbox);
check('T4 pushToCloud() leaves a pending (not-yet-fired) timer', timerPending, true);

const flushed = vm.runInContext('flushPendingCloudPush()', sandbox);
Promise.resolve(flushed).then(async ()=>{
  // performCloudPush is async and isn't awaited by flushPendingCloudPush itself (fire-and-forget,
  // matching the original debounced behavior) -- give its internal awaits a tick to settle.
  await new Promise(r=>setTimeout(r, 20));
  const pushCount = vm.runInContext('window.__pushCount', sandbox);
  check('T5 flushPendingCloudPush() runs the pending push right away, without waiting 1.5s', pushCount, 1);
  const timerCleared = vm.runInContext('cloudSyncTimer === null', sandbox);
  check('T6 the timer is cleared after flushing', timerCleared, true);

  // --- Calling flushPendingCloudPush() again with nothing pending is a safe no-op ---
  vm.runInContext('flushPendingCloudPush();', sandbox);
  await new Promise(r=>setTimeout(r, 20));
  const pushCountAfterNoop = vm.runInContext('window.__pushCount', sandbox);
  check('T7 flushing with nothing pending does not trigger an extra push', pushCountAfterNoop, 1);

  // --- visibilitychange listener registered and actually wired to flush ---
  vm.runInContext(`
    currentUserEmail = "vistest@x.com";
    saveUsers({ "vistest@x.com": { foodLog: { "2026-09-20": [{id:"f2", name:"lunch"}] } } });
    fbUser = { uid: "u2", email: "vistest@x.com" };
    window.__pushCount2 = 0;
    fbDb = { collection(){ return { doc(){ return {
      set: async (doc) => { window.__pushCount2++; },
    }; } }; } };
    pushToCloud();
  `, sandbox);
  visibilityState = "hidden";
  const vcListeners = docListeners["visibilitychange"] || [];
  check('T8 a visibilitychange listener was registered', vcListeners.length > 0, true);
  vcListeners.forEach(fn=>fn());
  await new Promise(r=>setTimeout(r, 20));
  const pushCount2 = vm.runInContext('window.__pushCount2', sandbox);
  check('T9 backgrounding the tab (visibilitychange -> hidden) flushes the pending push immediately', pushCount2, 1);

  // --- pagehide listener registered too (covers an actual close that visibilitychange can miss) ---
  const phListeners = winListeners["pagehide"] || [];
  check('T10 a pagehide listener was registered too', phListeners.length > 0, true);

  // --- Catastrophic-wipe guard: a stale cloud .set() call is never made when local data collapsed. ---
  vm.runInContext(`
    currentUserEmail = "wipetest@x.com";
    const log = {};
    for(let i=0;i<10;i++){ log["2026-09-0"+(i%9+1)] = [{id:"e"+i, name:"meal"+i}]; }
    saveUsers({ "wipetest@x.com": { foodLog: log } });
    fbUser = { uid: "u3", email: "wipetest@x.com" };
    window.__pushCount3 = 0;
    fbDb = { collection(){ return { doc(){ return {
      set: async (doc) => { window.__pushCount3++; },
    }; } }; } };
    saveLastPushEntryCount("wipetest@x.com", 10);
    // Now simulate the accidental-wipe scenario: local data collapses to nothing.
    const users = getUsers();
    users["wipetest@x.com"].foodLog = {};
    saveUsers(users);
  `, sandbox);
  await new Promise(r=>setTimeout(r, 2000)); // let the real 1.5s debounce actually elapse
  const wipePushCount = vm.runInContext('window.__pushCount3', sandbox);
  check('T11 a near-total local wipe does NOT push (protects the cloud copy)', wipePushCount, 0);
  const wipeStatus = vm.runInContext('document.getElementById("cloudSyncStatus").textContent', sandbox);
  check('T12 the status message explains the sync was paused', /Sync paused/.test(wipeStatus), true);

  // --- force=true bypasses the guard (the manual "Sync now" escape hatch) ---
  const forced = vm.runInContext('performCloudPush(true)', sandbox);
  await Promise.resolve(forced);
  const wipePushCountForced = vm.runInContext('window.__pushCount3', sandbox);
  check('T13 force=true pushes through the guard when the user explicitly asks for it', wipePushCountForced, 1);

  // --- A throw during the push (e.g. photo sync failing unexpectedly) is caught, not silent. ---
  vm.runInContext(`
    currentUserEmail = "throwtest@x.com";
    saveUsers({ "throwtest@x.com": { foodLog: { "2026-09-20": [{id:"f3"}] } } });
    fbUser = { uid: "u4", email: "throwtest@x.com" };
    fbDb = { collection(){ return { doc(){ return {
      set: async () => { throw new Error("simulated Firestore outage"); },
    }; } }; } };
  `, sandbox);
  let threwT14 = false;
  try {
    await vm.runInContext('performCloudPush(true)', sandbox);
  } catch(err){ threwT14 = true; console.log("ERROR:", err.stack); }
  check('T14 a rejected push never throws out of performCloudPush (always caught)', threwT14, false);
  const throwStatus = vm.runInContext('document.getElementById("cloudSyncStatus").textContent', sandbox);
  check('T15 the failure is surfaced via the status message', /Sync error/.test(throwStatus), true);

  console.log("ALL DONE");
});
