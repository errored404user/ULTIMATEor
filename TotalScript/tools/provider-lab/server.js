const https = require("https"), fs = require("fs"), path = require("path");
const EXT = path.resolve(process.env.EXT || path.join(__dirname, "..", ".."));
const PAGE = path.resolve(process.env.PAGE || path.join(__dirname, "fake-notion.html"));
const key = fs.readFileSync(path.join(__dirname, "key.pem")), cert = fs.readFileSync(path.join(__dirname, "cert.pem"));
const types = { ".css": "text/css", ".js": "text/javascript", ".jpg": "image/jpeg", ".png": "image/png", ".html": "text/html", ".svg": "image/svg+xml" };
https.createServer({ key, cert }, (q, s) => {
  if (q.url.startsWith("/__ext/")) { const p = path.join(EXT, decodeURIComponent(q.url.slice(7)).split("?")[0]); if (!p.startsWith(EXT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { s.writeHead(404); return s.end(); } s.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }); return s.end(fs.readFileSync(p)); }
  s.writeHead(200, { "content-type": "text/html" }); s.end(fs.readFileSync(PAGE));
}).listen(8443, "127.0.0.1", () => console.log("serving", PAGE, "+ extension", EXT, "on https://127.0.0.1:8443"));
