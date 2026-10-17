// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (id) => `<svg class="ic"><use href="#i-${id}"/></svg>`;
const fmt = (n) => +(+n).toFixed(2);

let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

// ---------- state ----------
const STORE_KEY = "sarvam-check-scheme-v2";
let scheme = loadScheme();
let files = [];
let selectedFile = null;
let currentJob = null;
let jobStartedAt = 0;
let pollTimer = null;
let lastResults = [];
let config = { workers: 4 };

function loadScheme() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.questions && s.questions.length) return s;
  } catch (e) {}
  return { questions: [newQuestion(1)] };
}
function saveScheme() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(scheme)); } catch (e) {}
  $("#saved-flag").textContent = "Saved";
}
function newQuestion(n) {
  return { id: "Q" + n, title: "", text: "", points: [newPoint()] };
}
function newPoint() { return { text: "", desc: "", marks: 1 }; }
const qMax = (q) => q.points.reduce((s, p) => s + (parseFloat(p.marks) || 0), 0);
const schemeTotal = () => scheme.questions.reduce((s, q) => s + qMax(q), 0);

// ---------- step navigation (single page, scroll-spy) ----------
function setActiveStep(n) {
  $$(".step").forEach((s) => s.classList.toggle("active", s.dataset.step == n));
}
function onScroll() {
  let active = 1;
  for (const n of [1, 2, 3]) {
    if ($("#step-" + n).getBoundingClientRect().top < window.innerHeight * 0.45) active = n;
  }
  if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) active = 3;
  setActiveStep(active);
}
window.addEventListener("scroll", onScroll, { passive: true });

// ---------- step 1: marking scheme ----------
function renderScheme() {
  const wrap = $("#questions");
  wrap.innerHTML = "";
  scheme.questions.forEach((q, qi) => {
    const card = document.createElement("div");
    card.className = "q-card";
    card.innerHTML = `
      <div class="q-top">
        <span class="q-badge"><input type="text" class="q-id" value="${esc(q.id)}" title="Question label (as written on answer sheets)"></span>
        <div class="q-main">
          <input type="text" class="bare q-title" value="${esc(q.title)}" placeholder="Question title, e.g. Integration of functions">
          <input type="text" class="pill-input q-text" value="${esc(q.text)}" placeholder="(optional) Question text or hints for the grader">
        </div>
        <span class="q-max">Max: <b class="q-max-val">${fmt(qMax(q))}</b></span>
        <button class="circle danger del-q" title="Delete question">${icon("trash")}</button>
      </div>
      <div class="points"></div>
      <div class="q-foot">
        <span class="muted">Question total: <b class="q-max-val">${fmt(qMax(q))}</b></span>
        <span class="spacer"></span>
        <button class="btn outline add-point">${icon("plus")}Add point</button>
        <button class="btn primary remove-q">${icon("trash")}Remove question</button>
      </div>`;

    const pts = $(".points", card);
    q.points.forEach((p, pi) => {
      const row = document.createElement("div");
      row.className = "point";
      row.innerHTML = `
        <span class="p-num">${pi + 1}.</span>
        <div class="p-body">
          <input type="text" class="bare p-text" value="${esc(p.text)}" placeholder="Expected point, e.g. Correct substitution and limits">
          <input type="text" class="bare p-desc" value="${esc(p.desc)}" placeholder="Grading note (optional), e.g. Partial credit for correct steps">
        </div>
        <input type="number" class="marks" value="${esc(p.marks)}" min="0" step="0.5" title="Marks">
        <button class="circle danger del-p" title="Remove point">${icon("x")}</button>`;
      $(".p-text", row).oninput = (e) => { p.text = e.target.value; changed(); };
      $(".p-desc", row).oninput = (e) => { p.desc = e.target.value; changed(); };
      $(".marks", row).oninput = (e) => { p.marks = e.target.value; changed(); };
      $(".del-p", row).onclick = () => {
        if (q.points.length > 1) q.points.splice(pi, 1); else q.points[0] = newPoint();
        changed(true);
      };
      pts.appendChild(row);
    });

    $(".q-id", card).oninput = (e) => { q.id = e.target.value; changed(); };
    $(".q-title", card).oninput = (e) => { q.title = e.target.value; changed(); };
    $(".q-text", card).oninput = (e) => { q.text = e.target.value; changed(); };
    $(".add-point", card).onclick = () => {
      q.points.push(newPoint());
      changed(true);
      $$(".q-card")[qi].querySelectorAll(".p-text")[q.points.length - 1].focus();
    };
    const del = () => {
      if (scheme.questions.length > 1 && !confirm(`Delete ${q.id || "this question"}?`)) return;
      scheme.questions.splice(qi, 1);
      if (!scheme.questions.length) scheme.questions.push(newQuestion(1));
      changed(true);
    };
    $(".del-q", card).onclick = del;
    $(".remove-q", card).onmousedown = (e) => e.preventDefault(); // keep focus-within so the click lands
    $(".remove-q", card).onclick = del;
    wrap.appendChild(card);
  });
  updateTotals();
}

function changed(rerender = false) {
  saveScheme();
  if (rerender) renderScheme(); else updateTotals();
}

function updateTotals() {
  $$(".q-card").forEach((card, i) => {
    $$(".q-max-val", card).forEach((el) => (el.textContent = fmt(qMax(scheme.questions[i]))));
  });
  $$(".scheme-total").forEach((el) => (el.textContent = fmt(schemeTotal())));
  $("#q-count").textContent = scheme.questions.length;
  $("#summary-list").innerHTML = scheme.questions
    .map((q) => `<li><span>${esc(q.id)}${q.title ? ` <span class="muted">· ${esc(q.title)}</span>` : ""}</span><b>${fmt(qMax(q))}</b></li>`)
    .join("");
}

function validateScheme() {
  const ids = new Set();
  for (const q of scheme.questions) {
    q.id = q.id.trim();
    if (!q.id) return fail("Every question needs a label (e.g. Q1).");
    if (ids.has(q.id.toLowerCase())) return fail(`Duplicate question label "${q.id}".`);
    ids.add(q.id.toLowerCase());
    const filled = q.points.filter((p) => p.text.trim());
    if (!filled.length) return fail(`${q.id} needs at least one expected point.`);
    if (filled.some((p) => !(parseFloat(p.marks) > 0))) return fail(`Every point in ${q.id} needs marks greater than 0.`);
  }
  return true;
  function fail(msg) {
    toast(msg, "err");
    $("#step-1").scrollIntoView();
    return false;
  }
}
// Payload sent to the server: drop empty points
const cleanScheme = () => ({
  questions: scheme.questions.map((q) => ({ ...q, points: q.points.filter((p) => p.text.trim()) })),
});

$("#add-question").onclick = () => {
  scheme.questions.push(newQuestion(scheme.questions.length + 1));
  changed(true);
  $$(".q-card").at(-1).querySelector(".q-title").focus();
};
$("#save-scheme").onclick = () => { saveScheme(); toast("Scheme saved in this browser", "ok"); };
$$(".export-scheme").forEach((b) => b.onclick = () => {
  const blob = new Blob([JSON.stringify(scheme, null, 2)], { type: "application/json" });
  Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "marking-scheme.json" }).click();
});
$$(".import-scheme").forEach((inp) => inp.onchange = async (e) => {
  try {
    const s = JSON.parse(await e.target.files[0].text());
    if (!Array.isArray(s.questions)) throw new Error();
    s.questions.forEach((q) => {
      q.title ??= ""; q.text ??= "";
      q.points = (q.points || []).map((p) => ({ text: p.text || "", desc: p.desc || "", marks: p.marks ?? 1 }));
    });
    scheme = s;
    changed(true);
    toast("Scheme imported", "ok");
  } catch { toast("That file is not a valid marking scheme", "err"); }
  e.target.value = "";
});

$("#dry-check").onclick = async () => {
  if (!validateScheme()) return;
  const btn = $("#dry-check");
  btn.disabled = true;
  try {
    const res = await fetch("/api/dry-check", { method: "POST" });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    toast(`Scheme valid (${fmt(schemeTotal())} marks) · Sarvam API reachable ✓`, "ok");
  } catch (err) {
    toast(err.message || "Dry-check failed", "err");
  } finally { btn.disabled = false; }
};

// ---------- step 2: upload ----------
const dz = $("#dropzone");
const ACCEPT = /\.(pdf|zip|png|jpe?g)$/i;
const kindOf = (f) => (/\.zip$/i.test(f.name) ? "zip" : /\.pdf$/i.test(f.name) ? "pdf" : "img");

function addFiles(list) {
  let skipped = 0;
  for (const f of list) {
    if (!ACCEPT.test(f.name)) { skipped++; continue; }
    if (!files.some((x) => x.name === f.name && x.size === f.size)) files.push(f);
  }
  if (skipped) toast(`${skipped} file(s) skipped – only PDF, PNG, JPG and ZIP are supported`, "err");
  if (!selectedFile && files.length) preview(files.find((f) => kindOf(f) !== "zip") || files[0]);
  renderFiles();
}

function renderFiles() {
  const ul = $("#file-list");
  ul.innerHTML = "";
  files.forEach((f, i) => {
    const k = kindOf(f);
    const li = document.createElement("li");
    li.className = f === selectedFile ? "selected" : "";
    li.innerHTML = `
      <span class="badge ${k}">${k.toUpperCase()}</span>
      <div class="file-meta"><div class="name">${esc(f.name)}</div><div class="muted small">${(f.size / 1048576).toFixed(1)} MB</div></div>
      <button class="circle preview-btn" title="Preview">${icon("eye")}</button>
      <button class="circle danger" title="Remove">${icon("trash")}</button>`;
    $(".preview-btn", li).onclick = () => { preview(f); renderFiles(); };
    $(".danger", li).onclick = () => {
      files.splice(i, 1);
      if (f === selectedFile) preview(null);
      renderFiles();
    };
    ul.appendChild(li);
  });
  $("#start-grading").disabled = !files.length;
}

async function preview(f) {
  selectedFile = f;
  const box = $("#preview");
  const cap = $("#preview-caption");
  if (!f) {
    box.innerHTML = `<span class="muted small">Click the ${icon("eye")} on a file to preview it</span>`;
    cap.textContent = "Single-page preview for the selected file";
    return;
  }
  cap.textContent = f.name;
  const k = kindOf(f);
  if (k === "img") {
    box.innerHTML = `<img alt="" src="${URL.createObjectURL(f)}">`;
  } else if (k === "zip") {
    box.innerHTML = `<span class="muted small">ZIP archive – each PDF/image inside becomes one student</span>`;
  } else if (window.pdfjsLib) {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      const pdf = await pdfjsLib.getDocument({ data: await f.arrayBuffer() }).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (320 / base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      if (selectedFile !== f) return;
      box.innerHTML = "";
      box.appendChild(canvas);
      cap.textContent = `${f.name} · page 1 of ${pdf.numPages}`;
    } catch {
      box.innerHTML = `<span class="muted small">Could not render this PDF</span>`;
    }
  } else {
    box.innerHTML = `<span class="muted small">PDF preview unavailable offline</span>`;
  }
}

$("#file-input").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

$("#start-grading").onclick = async () => {
  if (!validateScheme()) return;
  const btn = $("#start-grading");
  btn.disabled = true;
  btn.textContent = "Uploading…";
  const fd = new FormData();
  fd.append("scheme", JSON.stringify(cleanScheme()));
  fd.append("split_pages", $("#opt-split").checked ? "1" : "0");
  fd.append("detect_name", $("#opt-name").checked ? "1" : "0");
  files.forEach((f) => fd.append("files", f));
  try {
    const res = await fetch("/api/jobs", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Upload failed");
    currentJob = data.job_id;
    jobStartedAt = Date.now();
    $("#dl-csv").href = `/api/jobs/${currentJob}/export?format=csv`;
    $("#dl-xlsx").href = `/api/jobs/${currentJob}/export?format=xlsx`;
    files = [];
    preview(null);
    renderFiles();
    toast(`Grading ${data.count} submission(s)…`);
    $("#step-3").scrollIntoView();
    poll();
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.textContent = "Start grading";
    btn.disabled = !files.length;
  }
};

// ---------- step 3: results ----------
const STATUS_LABEL = { queued: "Queued", reading: "Reading", grading: "Grading", done: "Graded", error: "Error" };
const isFinished = (r) => r.status === "done" || r.status === "error";

async function poll() {
  clearTimeout(pollTimer);
  try {
    const res = await fetch(`/api/jobs/${currentJob}`);
    if (!res.ok) throw new Error("Job not found (was the server restarted?)");
    const data = await res.json();
    renderResults(data);
    if (data.results.some((r) => !isFinished(r))) pollTimer = setTimeout(poll, 2000);
    else finishJob(data);
  } catch (err) {
    toast(err.message, "err");
    setEngine("Idle");
  }
}

function renderResults(data) {
  lastResults = data.results;
  const max = data.scheme.questions.reduce((s, q) => s + qMax(q), 0);
  const qids = data.scheme.questions.map((q) => q.id);
  $("#results-body").innerHTML = data.results.map((r, i) => {
    const g = r.grade;
    const byId = Object.fromEntries((g?.questions || []).map((q) => [q.question_id, q.score]));
    const perQ = g ? qids.map((id) => fmt(byId[id] ?? 0)).join(", ") : qids.map(() => "–").join(", ");
    return `<tr data-i="${i}">
      <td><span class="stu-name">${esc(r.student)}</span><span class="per-q">Score per Q: <b>${perQ}</b></span>
        ${r.student !== r.file.replace(/\.[^.]+$/, "") ? `<div class="muted small">${esc(r.file)}</div>` : ""}</td>
      <td class="total-cell">${g ? fmt(g.total_score) : "–"} / ${fmt(max)}</td>
      <td class="status-cell"><span class="pill ${r.status}" ${r.error ? `title="${esc(r.error)}"` : ""}>${STATUS_LABEL[r.status] || r.status}</span></td>
    </tr>`;
  }).join("");
  $$("#results-body tr").forEach((tr) => (tr.onclick = () => openStudent(lastResults[tr.dataset.i], max)));

  const done = data.results.filter(isFinished).length;
  const total = data.results.length;
  const pct = Math.round((100 * done) / total);
  $("#progress-bar").style.width = pct + "%";
  $("#progress-pct").textContent = pct + "%";
  $("#progress-text").textContent = done === total
    ? `All ${total} submission(s) processed.`
    : `Processing ${done}/${total} · reading handwriting with Sarvam Vision, then grading with ${config.model || "Sarvam LLM"}.`;

  // ETA from observed throughput
  const elapsed = (Date.now() - jobStartedAt) / 1000;
  let eta = "–";
  if (done && done < total) {
    const secs = (elapsed / done) * (total - done);
    eta = secs < 60 ? `~${Math.ceil(secs)}s` : `~${Math.ceil(secs / 60)}m`;
  } else if (!done) eta = "estimating…";
  $("#eng-eta").textContent = done === total ? "–" : eta;
  setEngine(done === total ? "Idle" : "Active");
  $("#dl-csv").classList.toggle("disabled", !done);
  $("#dl-xlsx").classList.toggle("disabled", !done);
}

function finishJob(data) {
  const errs = data.results.filter((r) => r.status === "error").length;
  toast(errs ? `Done – ${errs} submission(s) failed. Click them to see why.` : "All submissions graded ✓", errs ? "err" : "ok");
}

function openStudent(r, max) {
  const g = r.grade;
  $("#drawer-body").innerHTML = `
    <h2>${esc(r.student)}</h2>
    <div class="muted small">${esc(r.file)}${g?.roll_number ? ` · Roll no. ${esc(g.roll_number)}` : ""}</div>
    ${g ? `
      <div class="score-hero"><span class="big">${fmt(g.total_score)}</span><span class="muted">/ ${fmt(g.max_total)} marks</span></div>
      <p>${esc(g.overall_feedback)}</p>
      <h3>Per-question breakdown</h3>
      ${g.questions.map((q) => `
        <div class="qcard">
          <div class="qcard-top"><span>${esc(q.question_id)}</span><span>${fmt(q.score)} / ${fmt(q.max_score)}</span></div>
          <div class="bar"><div style="width:${q.max_score ? (100 * q.score) / q.max_score : 0}%"></div></div>
          <div class="muted">${esc(q.feedback)}</div>
        </div>`).join("")}`
      : `<p><span class="pill ${r.status}">${STATUS_LABEL[r.status]}</span></p>${r.error ? `<p class="muted">${esc(r.error)}</p>` : ""}`}
    <h3>Text read from the answer sheet (Sarvam Vision)</h3>
    <pre class="ocr">${esc(r.ocr_text || "(not available yet)")}</pre>`;
  openDrawer();
}

// ---------- drawer & help ----------
function openDrawer() { $("#drawer").classList.remove("hidden"); }
function closeDrawer() { $("#drawer").classList.add("hidden"); }
$("#drawer-close").onclick = closeDrawer;
$("#drawer").onclick = (e) => { if (e.target.id === "drawer") closeDrawer(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

$("#help-btn").onclick = () => {
  $("#drawer-body").innerHTML = `<div class="help">
    <h2>How Sarvam Check works</h2>
    <ol>
      <li><b>Marking scheme</b> – add each question with the label students use on their sheets (Q1, Q2…). List the points a correct answer must contain and the marks for each. Add a grading note under a point to say when partial credit is allowed.</li>
      <li><b>Upload</b> – one PDF per student (the file name becomes the student's name), or a ZIP holding a whole class. Turn on "each PDF page as a separate student" if you scanned the whole class into one PDF with one page each.</li>
      <li><b>Grading</b> – Sarvam Vision reads the handwriting. ${esc(config.model || "sarvam-105b")} then matches each answer to its question and awards marks only for rubric points that are present. Scores are capped at each question's maximum.</li>
      <li><b>Review &amp; export</b> – click a student to see per-question feedback and the text that was read from the sheet. Download the score sheet as Excel or CSV.</li>
    </ol>
    <p class="muted small">Run dry-check first to confirm your Sarvam API key works.</p></div>`;
  openDrawer();
};

// ---------- engine status ----------
function setEngine(state) {
  const el = $("#eng-status");
  if (config.key_configured === false) { el.textContent = "API key missing"; el.className = "bad"; return; }
  el.textContent = state;
  el.className = state === "Offline" ? "bad" : "ok";
}
fetch("/api/config").then((r) => r.json()).then((c) => {
  config = c;
  $("#eng-model").textContent = c.model;
  $("#eng-workers").textContent = c.workers;
  $("#model-chip").textContent = `Sarvam Vision + ${c.model}`;
  setEngine("Idle");
}).catch(() => setEngine("Offline"));

renderScheme();
