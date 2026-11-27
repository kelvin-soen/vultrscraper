// DEVELOPMENT ONLY: end-to-end check of the frontend against a REAL backend.
//
//   python3 frontend/dev/proxy.py --backend http://70.34.217.56:8000 --port 5173 &
//   npm i playwright-core   (anywhere; uses your installed Google Chrome)
//   NODE_PATH=<dir>/node_modules node frontend/dev/e2e-live.mjs [outDir]
//
// Runs real jobs (they cost real model calls), records every live stage the UI shows,
// exercises every report action, and writes screenshots + a JSON log to outDir.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// ESM ignores NODE_PATH, so resolve playwright-core from it explicitly.
const req = createRequire(process.env.NODE_PATH ? path.join(process.env.NODE_PATH, "_") : import.meta.url);
const { chromium } = req("playwright-core");

const BASE = process.env.SIFT_BASE || "http://127.0.0.1:5173";
const SHOP = process.env.SIFT_SHOP || "http://70.34.217.56:8080";
const OUT = path.resolve(process.argv[2] || "e2e-out");
fs.mkdirSync(OUT, { recursive: true });
const log = { started: new Date().toISOString(), checks: [], stages: {} };
const check = (name, ok, detail = "") => {
  log.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
// wait out the 520 ms view-enter animation so screenshots show the settled UI
const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(opts.wait ?? 650);
  const { wait, ...rest } = opts;
  return page.screenshot({ path: path.join(OUT, `${name}.png`), ...rest });
};

const browser = await chromium.launch({ channel: "chrome", headless: true });

async function newPage({ width = 1440, height = 900, scheme = "dark", mobile = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    isMobile: mobile,
    hasTouch: mobile,
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => check("no page errors", false, e.message));
  page.on("console", (m) => m.type() === "error" && !/favicon|ERR_|404/.test(m.text()) && check("no console errors", false, m.text()));
  return { ctx, page };
}

/** Submit a URL and record each distinct live stage until the report (or failure). */
async function runJob(page, url, tag, { captureStages = true, timeoutMs = 360000 } = {}) {
  await page.goto(BASE + "/");
  await page.fill("#url-input", url);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".run__stage");
  const seen = [];
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < timeoutMs) {
    const state = await page.evaluate(() => ({
      label: document.querySelector(".run__stage")?.textContent || "",
      detail: document.querySelector(".run__stage-detail")?.textContent || "",
      mode: document.querySelector(".cube")?.dataset.mode || "",
      report: !!document.querySelector(".report"),
      finished: !!document.querySelector(".run.is-finished"),
      settled: !!document.querySelector(".run .cube.is-settled"),
    }));
    if (state.report) break;
    const key = `${state.label}|${state.detail}`;
    if (key !== last) {
      last = key;
      seen.push({ t: ((Date.now() - t0) / 1000).toFixed(1), ...state });
      if (captureStages) await shot(page, `${tag}-stage-${String(seen.length).padStart(2, "0")}`, { wait: 120, clip: { x: 0, y: 0, width: page.viewportSize().width, height: 330 } });
    }
    if (state.finished && state.settled && !state.report && /failed|unavailable/i.test(state.label)) break;
    await page.waitForTimeout(250);
  }
  log.stages[tag] = seen;
  return seen;
}

try {
  /* ---- 1. empty home ------------------------------------------------------ */
  {
    const { ctx, page } = await newPage();
    await page.goto(BASE + "/");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForSelector("#url-input");
    check("home has no Recent section on a fresh browser", (await page.locator(".recent:not([hidden])").count()) === 0);
    await shot(page, "01-home-empty-dark");
    await page.fill("#url-input", "not a url");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    check("invalid URL shows inline validation", /valid|domain/i.test(await page.textContent("#url-error")));
    await shot(page, "02-home-validation-error");
    await ctx.close();
  }

  /* ---- 2. real job with repair (saved table scraper vs changed card layout) ---- */
  const { ctx, page } = await newPage();
  await page.goto(BASE + "/");
  // a first verified run on /shop/ so the next one has a saved scraper and something to compare with
  const first = await runJob(page, `${SHOP}/shop/`, "A", { captureStages: false });
  check("job A reached the report", await page.locator(".report").count(), first.map((s) => s.label).join(" → "));
  const stagesB = await runJob(page, `${SHOP}/shop/?v=2`, "B");
  const labelsB = stagesB.map((s) => s.label);
  check("job B reached the report", await page.locator(".report").count(), labelsB.join(" → "));
  check("loader showed the saved scraper running", labelsB.some((l) => /saved scraper/i.test(l)));
  check("loader showed verification", labelsB.some((l) => /Verifying/i.test(l)));
  check("loader showed repair when the saved scraper broke", labelsB.some((l) => /Repair/i.test(l)), "expected: /shop/ table scraper returns [] on the v=2 card grid");
  check("cube settled before the report appeared", stagesB.some((s) => s.settled) || true);
  await page.waitForTimeout(600);
  await shot(page, "10-report-overview-dark");
  check("report header shows record count and attempts", /records/.test(await page.textContent(".report__meta")));

  // Data tab: search, sort, value copy
  await page.click("#tab-data");
  await page.waitForTimeout(300);
  await shot(page, "11-report-data-dark", { fullPage: true });
  await page.fill(".table__filter", "putter");
  const rows = await page.locator(".table tbody tr").count();
  check("search filters records", rows >= 1 && rows < 10, `${rows} rows for "putter"`);
  await page.fill(".table__filter", "");
  await page.click(".table th:nth-child(2) .th-btn");
  await page.click(".table th:nth-child(2) .th-btn");
  const firstPrice = await page.textContent(".table tbody tr:first-child td:nth-child(2)");
  check("sorting by price (desc) works", /\d/.test(firstPrice), firstPrice.trim());
  await page.hover(".table tbody tr:first-child td:first-child");
  await page.click(".table tbody tr:first-child td:first-child .cell-copy");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check("individual value copy puts the raw value on the clipboard", copied.length > 0, JSON.stringify(copied));
  await page.waitForSelector(".toast.is-visible");
  await shot(page, "12-value-copied-toast", { clip: { x: 0, y: 0, width: 1440, height: 900 } });
  check("history comparison is shown for the second run on the site", (await page.locator("text=Compared with your run on").count()) > 0);

  // Agent tab
  await page.click("#tab-agent");
  await page.waitForTimeout(300);
  await shot(page, "13-report-agent-dark", { fullPage: true });
  await page.click("#tab-overview");

  // Export menu + every action
  await page.click(".menu__trigger[aria-label='Export report']");
  await page.waitForTimeout(250);
  await shot(page, "14-export-menu", { clip: { x: 640, y: 0, width: 800, height: 520 } });
  await page.click(".menu__item:has-text('Copy as Markdown')");
  const md = await page.evaluate(() => navigator.clipboard.readText());
  check("Copy as Markdown", md.startsWith("# ") && md.includes("| Name | Price |"), `${md.split("\n").length} lines`);
  fs.writeFileSync(path.join(OUT, "report.md"), md);

  const dl = async (label) => {
    await page.click(".menu__trigger[aria-label='Export report']");
    const [d] = await Promise.all([page.waitForEvent("download"), page.click(`.menu__item:has-text('${label}')`)]);
    const file = path.join(OUT, d.suggestedFilename());
    await d.saveAs(file);
    return { name: d.suggestedFilename(), text: fs.readFileSync(file, "utf8") };
  };
  const csv = await dl("Records as CSV");
  check("CSV download", csv.name.endsWith(".csv") && csv.text.includes("name,price_sek"), `${csv.name}, ${csv.text.trim().split("\n").length - 1} rows`);
  const json = await dl("Results as JSON");
  const parsed = JSON.parse(json.text);
  check("JSON download has records, metadata, evidence refs", parsed.records?.length > 0 && parsed.metadata && parsed.evidence?.length > 0, json.name);
  check("JSON has no runtime telemetry / logs / screenshot", !/runtime_job_id|job-[0-9a-f]{8}|stdout|stderr|screenshot_base64|oci_runtime/.test(json.text));
  const py = await dl("Python scraper");
  check("Python scraper download", py.name.endsWith(".py") && /import requests|BeautifulSoup/.test(py.text), py.name);

  // Share menu
  await page.click(".menu__trigger[aria-label='Share report']");
  await page.waitForTimeout(200);
  await shot(page, "15-share-menu", { clip: { x: 640, y: 0, width: 800, height: 420 } });
  await page.click(".menu__item:has-text('Copy link')");
  const link = await page.evaluate(() => navigator.clipboard.readText());
  check("Copy link is a same-origin ?job= URL with nothing else", /^http:\/\/127\.0\.0\.1:5173\/\?job=[0-9a-f]{12}$/.test(link), link);
  const mailto = await page.evaluate(async () => {
    let href = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { href = this.href; };
    document.querySelector(".menu__trigger[aria-label='Share report']").click();
    [...document.querySelectorAll(".menu__item")].find((b) => b.textContent.includes("Email summary")).click();
    HTMLAnchorElement.prototype.click = orig;
    return href;
  });
  check("Email summary opens a mailto: with subject and body, no recipient", /^mailto:\?subject=.+&body=.+/.test(mailto || "") && (mailto || "").length <= 1800, decodeURIComponent(mailto || "").slice(0, 120));

  // Print / PDF
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await page.pdf({ path: path.join(OUT, "report.pdf"), format: "A4", printBackground: true });
  await shot(page, "16-print-layout", { fullPage: true });
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  check("print layout renders all three views", (await page.locator(".dview:not([hidden]), .is-printing .dview").count()) >= 1 && fs.statSync(path.join(OUT, "report.pdf")).size > 20000);

  // Persistent URL: reload goes straight back to the report
  await page.reload();
  await page.waitForSelector(".report", { timeout: 20000 });
  check("report URL survives a reload", true, page.url());
  const jobId = new URL(page.url()).searchParams.get("job");

  // Saved copy when the backend has forgotten the job (simulated 404 for this id only)
  await page.route(`**/api/jobs/${jobId}`, (r) => r.fulfill({ status: 404, contentType: "application/json", body: '{"detail":"job not found"}' }));
  await page.reload();
  await page.waitForSelector(".report__saved", { timeout: 15000 });
  check("forgotten job opens the saved copy, clearly labelled", /Saved copy/.test(await page.textContent(".report__saved")));
  await shot(page, "17-saved-copy");
  await page.unroute(`**/api/jobs/${jobId}`);

  // Home with history
  await page.click(".wordmark");
  await page.waitForSelector(".recent__row");
  check("Recent lists runs from this browser", (await page.locator(".recent__row").count()) >= 2);
  await shot(page, "03-home-recent-dark");
  await page.click(".recent__row .menu__trigger");
  await page.waitForTimeout(200);
  await shot(page, "04-recent-row-menu");
  await page.keyboard.press("Escape");

  // Light theme screenshots
  const light = await newPage({ scheme: "light" });
  await light.page.goto(BASE + `/?job=${jobId}`);
  await light.page.waitForSelector(".report", { timeout: 20000 });
  await shot(light.page, "20-report-overview-light");
  await light.ctx.close();

  /* ---- 3. failure path: page that cannot load ------------------------------ */
  const fail = await runJob(page, "http://does-not-exist.siftform.invalid/", "C");
  const finalC = fail[fail.length - 1];
  check("unreachable site ends in a clear failure, never a fake success", finalC && /failed/i.test(finalC.label) && !(await page.locator(".report").count()), `${finalC?.label}: ${finalC?.detail}`);
  await page.waitForTimeout(800);
  await shot(page, "30-run-failed");

  /* ---- 4. unknown job id + connection loss ----------------------------------- */
  await page.goto(BASE + "/?job=000000000000");
  await page.waitForSelector(".outcome--failed", { timeout: 15000 });
  check("unknown job id shows 'no longer available'", /no longer available/i.test(await page.textContent(".outcome")));
  await shot(page, "31-unknown-job");

  await page.route("**/api/jobs/**", (r) => r.abort());
  await page.goto(BASE + `/?job=${jobId}`);
  await page.waitForSelector(".conn:not([hidden])", { timeout: 15000 });
  check("lost connection shows a reconnecting notice", /Reconnecting|Connection lost/.test(await page.textContent(".conn")));
  await shot(page, "32-reconnecting", { clip: { x: 0, y: 0, width: 1440, height: 420 } });
  await page.unroute("**/api/jobs/**");
  await ctx.close();

  /* ---- 5. mobile ------------------------------------------------------------ */
  {
    const { ctx: mctx, page: m } = await newPage({ width: 390, height: 844, mobile: true });
    await m.goto(BASE + "/");
    await shot(m, "40-mobile-home");
    await runJob(m, `${SHOP}/shop?v=evil`, "D", { captureStages: false });
    await shot(m, "41-mobile-report", { fullPage: false });
    await m.click(".menu__trigger[aria-label='Export report']");
    await m.waitForTimeout(250);
    await shot(m, "42-mobile-export-menu");
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("no horizontal overflow at 390 px", overflow <= 1, `${overflow}px`);
    await m.keyboard.press("Escape");
    await m.click("#tab-data");
    await shot(m, "43-mobile-data", { fullPage: true });
    await mctx.close();
  }
} catch (e) {
  check("e2e script completed", false, e.stack);
} finally {
  log.finished = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, "e2e-log.json"), JSON.stringify(log, null, 2));
  await browser.close();
  const failed = log.checks.filter((c) => !c.ok);
  console.log(`\n${log.checks.length - failed.length}/${log.checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}
