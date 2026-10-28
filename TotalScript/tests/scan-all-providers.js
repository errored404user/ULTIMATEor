const fs = require('fs');
const path = require('path');
const vm = require('vm');

const providerFiles = [
  'src/providers/arena.js', 'src/providers/chatgpt.js', 'src/providers/claude.js',
  'src/providers/deepseek.js', 'src/providers/gemini.js', 'src/providers/glm.js',
  'src/providers/kimi.js', 'src/providers/meta.js', 'src/providers/vani.js',
  'src/providers/qwen.js',
  ['src/providers/multichat.js','overchat.ai'],
  ['src/providers/multichat.js','overchat.ai'],
  ['src/providers/multichat.js','huggingface.co'],
  // Extension-hosted chat page (no content_scripts entry: loaded by codecraft.html).
  ['src/providers/codecraft.js', 'codecraftapi.com', 'codecraft.html'],
];

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const background = fs.readFileSync('background.js', 'utf8');
const popup = fs.readFileSync('popup.js', 'utf8');
const main = fs.readFileSync('src/core/main.js', 'utf8');
const overlayCss = fs.readFileSync('overlay.css', 'utf8');

function createMockDom() {
  const listeners = {};
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    getElementsByClassName: () => [],
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      style: {},
      classList: { add: () => {}, remove: () => {}, contains: () => false },
      setAttribute: () => {},
      getAttribute: () => null,
      appendChild: (c) => c,
      addEventListener: () => {},
      removeEventListener: () => {},
      children: [],
      childNodes: []
    }),
    body: {
      appendChild: () => {},
      removeChild: () => {},
      querySelector: () => null,
      querySelectorAll: () => []
    },
    documentElement: {
      setAttribute: () => {},
      getAttribute: () => null
    },
    activeElement: null,
    execCommand: () => true
  };

  const win = {
    document: doc,
    window: null,
    location: { href: 'https://example.com/', hostname: 'example.com', origin: 'https://example.com' },
    navigator: { userAgent: 'Mozilla/5.0' },
    addEventListener: (evt, fn) => { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn); },
    removeEventListener: () => {},
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 1,
    clearInterval: () => {},
    MutationObserver: class {
      constructor() {}
      observe() {}
      disconnect() {}
    },
    InputEvent: class {},
    KeyboardEvent: class {},
    Event: class {},
    CustomEvent: class {},
    HTMLElement: class {},
    HTMLTextAreaElement: class {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  };
  win.window = win;
  return { win, doc };
}

console.log(`=== SCANNING ALL ${providerFiles.length} PROVIDERS ===\n`);

const results = {};

for (const providerEntry of providerFiles) {
  const file = Array.isArray(providerEntry) ? providerEntry[0] : providerEntry;
  const testHost = Array.isArray(providerEntry) ? providerEntry[1] : null;
  const hostPage = Array.isArray(providerEntry) ? providerEntry[2] : null;
  const name = testHost ? testHost.replace(/[^a-z0-9]+/gi, "-") : path.basename(file, ".js");
  const pPath = path.join(__dirname, '..', file);
  const issues = [];

  if (!fs.existsSync(pPath)) {
    results[name] = { status: 'NOT WORKS', issues: ['File missing'] };
    continue;
  }

  const { win, doc } = createMockDom();
  if (testHost) win.location = { href: `https://${testHost}/`, hostname: testHost, origin: `https://${testHost}`, pathname: testHost === "huggingface.co" ? "/chat/" : "/" };
  let code = fs.readFileSync(pPath, 'utf8');

  // append window.RSProvider assignment for test evaluation if missing
  if (!code.includes('window.RSProvider = RSProvider')) {
    code += '\nif (typeof window !== "undefined") window.RSProvider = RSProvider;';
  }

  try {
    const context = vm.createContext(win);
    vm.runInContext(code, context);
  } catch (err) {
    issues.push(`Load error: ${err.message}`);
  }

  const provider = win.RSProvider;

  if (!provider) {
    issues.push('window.RSProvider not exported or null');
    results[name] = { status: 'NOT WORKS', issues };
    continue;
  }

  // 1. Interface Checks
  if (!provider.id) issues.push('Missing provider.id');
  if (!provider.displayName) issues.push('Missing provider.displayName');
  if (!provider.timings) issues.push('Missing provider.timings');
  if (typeof provider.getEditor !== 'function') issues.push('Missing getEditor()');
  if (typeof provider.typeAndSend !== 'function') issues.push('Missing typeAndSend()');
  if (typeof provider.allItems !== 'function') issues.push('Missing allItems()');
  if (typeof provider.readAssistant !== 'function') issues.push('Missing readAssistant()');
  if (typeof provider.ensureComposerReady !== 'function') issues.push('Missing ensureComposerReady()');
  if (typeof provider.scanError !== 'function') issues.push('Missing scanError()');
  if (typeof provider.barAnchor !== 'function' && typeof provider.barMount !== 'function') {
    issues.push('Missing barAnchor() or barMount()');
  }

  // 2. CSS Class check
  const id = provider.id || name;
  const cssClass = `rs-prov-${id}`;
  if (!overlayCss.includes(cssClass)) {
    issues.push(`Missing CSS rule .${cssClass} in overlay.css`);
  }

  // 3. Manifest content script check
  let manifestMatches = false;
  for (const cs of manifest.content_scripts || []) {
    if ((cs.js || []).some(j => j.includes(file))) {
      manifestMatches = true;
      break;
    }
  }
  if (hostPage) {
    const html = fs.existsSync(path.join(__dirname, '..', hostPage)) ? fs.readFileSync(path.join(__dirname, '..', hostPage), 'utf8') : '';
    if (!html.includes(`<script src="${file}"></script>`)) issues.push(`Provider script ${file} not loaded by ${hostPage}`);
    if (manifestMatches) issues.push(`Extension-page provider ${file} must not also be a content script`);
  } else if (!manifestMatches) {
    issues.push(`Provider script ${file} not registered in manifest.json content_scripts`);
  }

  // 4. Background URL check
  if (!background.includes(id) && !background.includes(file)) {
    // Check if provider host is matched in background
  }

  // 5. Check if window.RSProvider assignment is present at bottom of file
  const rawCode = fs.readFileSync(pPath, 'utf8');
  if (!rawCode.includes('window.RSProvider = RSProvider')) {
    issues.push('Missing window.RSProvider = RSProvider export statement');
  }

  results[name] = {
    id,
    displayName: provider.displayName || name,
    status: issues.length === 0 ? 'WORKS' : 'NOT WORKS',
    issues,
    provider
  };
}

console.log('--- AUDIT SUMMARY ---');
for (const [name, res] of Object.entries(results)) {
  const statusSymbol = res.status === 'WORKS' ? '✅ WORKS' : '❌ NOT WORKS';
  console.log(`${res.displayName || name} (${name}): ${statusSymbol}`);
  if (res.issues.length > 0) {
    res.issues.forEach(iss => console.log(`   - ${iss}`));
  }
}
