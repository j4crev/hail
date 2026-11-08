export const incidentHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Review identity change · PLC Monitor</title>
<link rel="stylesheet" href="/incidents/style.css"><script type="module" src="/incidents/app.js"></script></head>
<body><main><header><p class="eyebrow">PLC MONITOR</p><h1>Review your identity</h1>
<p>Understand a change, recognize it, or recover using your own keys.</p></header>
<p id="message" role="status" aria-live="polite"></p>
<section id="entry"><h2>Open your private incident</h2><p>Your email link grants access to this incident. No Hail login is required. Anyone with the link has the same access; do not forward it.</p>
<button id="open">Continue to incident</button> <button id="renew" class="secondary">Email a fresh link</button></section>
<section id="incident" hidden><h2>Current status</h2><p id="status"></p><p id="health"></p>
<button id="refresh" class="secondary">Refresh status</button>
<h2>What happened</h2><pre id="summary"></pre>
<details><summary>Complete current identity configuration</summary><pre id="current"></pre></details>
<section id="recognition"><h2>Was this change expected?</h2><p>Recognizing it updates the monitor's baseline for this exact current state. It does not undo the change or prove ownership of recovery keys.</p>
<label><input type="checkbox" id="recognize-confirm"> I reviewed this configuration and recognize the change.</label><button id="recognize">Recognize this change</button></section>
<section id="recovery"><h2>Reverse an unwanted change</h2><p>Recovery requires your saved recovery kit. Choose how to respond:</p>
<label class="choice"><input type="radio" name="mode" value="restore" checked> <strong>Restore the previous configuration</strong><br>Restore the configuration immediately before this change, including the previous provider keys and service. Intended for accidental changes. The provider may also need to repair its internal state. A compromised provider would retain its prior authority.</label>
<label class="choice"><input type="radio" name="mode" value="protect"> <strong>Protect identity and suspend Hail service</strong><br>Remove provider rotation authority and the Hail service and messaging key. Keep your recovery authority and use your kit's owner identity key. Normal Hail use will be interrupted. This does not transfer your account or data to another provider.</label>
<p>Both choices can nullify subsequent operations on the disputed branch. Messages or actions already taken are not undone. Other applications in the previous configuration are retained; removing shared rotation keys can affect their management.</p>
<label>Recovery kit (stays on this device)<input id="kit" type="file" accept=".json,application/json"></label>
<button id="prepare">Check kit and review recovery</button>
<section id="plan" hidden><h3>Review the exact correction</h3><p id="deadline"></p><pre id="proposed"></pre>
<label><input id="recover-confirm" type="checkbox"> I reviewed this correction and its consequences, including changes after the unwanted operation.</label>
<label>Separate recovery secret<input id="secret" type="password" autocomplete="off" spellcheck="false" maxlength="43"></label>
<p>Keys are unlocked and used only on this device. Use a trusted device and monitor site. If you suspect this site is compromised, use the repository's local recovery tool.</p>
<button id="submit">Sign and submit recovery</button></section></section>
<section id="outcome" hidden><h2>Recovery progress</h2><p id="result"></p><button id="retry" class="secondary">Retry the saved signed operation</button></section>
<details><summary>Technical evidence</summary><pre id="evidence"></pre></details>
</section><footer>Monitor-hosted recovery works without a provider session. Shared administration still means shared trust. Email authorization is not recovery-key ownership.</footer></main></body></html>`;
export const incidentStyles = `:root{font-family:system-ui,sans-serif;color:#dce7e4;background:#101b1b;color-scheme:dark}*{box-sizing:border-box}body{margin:0}main{max-width:850px;margin:0 auto;padding:40px 22px}header{padding-bottom:24px;border-bottom:1px solid #38514b}h1{font-size:2.4rem;letter-spacing:-.04em;margin:10px 0}h2{margin-top:24px}p,label{line-height:1.65}.eyebrow{font-size:.8rem;letter-spacing:.15em;color:#94d8bd}section{margin:24px 0;padding:20px;border:1px solid #38514b;border-radius:12px}section section{background:#142522}button{background:#afe5c9;color:#10241c;border:0;padding:12px 18px;border-radius:7px;font:inherit;font-weight:600;cursor:pointer;margin:10px 8px 8px 0}button.secondary{background:#29463c;color:#e0f2e9}button:disabled{opacity:.45;cursor:default}input:not([type=checkbox]):not([type=radio]){display:block;margin:8px 0;padding:10px;max-width:100%;width:100%}label{display:block;margin:16px 0}.choice{border:1px solid #38514b;border-radius:8px;padding:14px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.65}details pre{font-family:monospace;font-size:.85rem}summary{cursor:pointer;padding:8px}footer{font-size:.85rem;color:#a2b8ad;line-height:1.65}#message:not(:empty){padding:14px;border-left:4px solid #e7c472;background:#302d21}[hidden]{display:none!important}:focus-visible{outline:3px solid #e7c472;outline-offset:3px}`;
