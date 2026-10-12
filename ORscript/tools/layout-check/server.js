// HTTPS stand-in for chat.deepseek.com: serves fake-deepseek.html at / and the
// extension tree under /__ext/ (what the chrome.runtime.getURL shim points at).
const https = require("https"), fs = require("fs"), path = require("path");
const HERE = __dirname, EXT = process.env.EXT || path.resolve(HERE, "..", "..");
const key = fs.readFileSync(path.join(HERE, "key.pem")), cert = fs.readFileSync(path.join(HERE, "cert.pem"));
const types = { ".css": "text/css", ".js": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png", ".html": "text/html" };
https.createServer({ key, cert }, (q, s) => {
  if (q.url.startsWith("/__ext/")) {
    const p = path.join(EXT, decodeURIComponent(q.url.slice(7)).split("?")[0]);
    if (!p.startsWith(EXT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }); return s.end(fs.readFileSync(p));
  }
  s.writeHead(200, { "content-type": "text/html" }); s.end(fs.readFileSync(path.join(HERE, "fake-deepseek.html")));
}).listen(8443, "127.0.0.1", () => console.log("layout-check: https://chat.deepseek.com -> 127.0.0.1:8443 (EXT=" + EXT + ")"));
