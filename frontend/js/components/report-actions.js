/**
 * Report action toolbar: one primary action, two compact menus.
 *
 *   [ Run again ]  [ Share ▾ ]  [ Export ▾ ]
 *
 * Share:  Copy link · Email summary
 * Export: Copy as Markdown · Download CSV · Download JSON · Python scraper · Print / Save as PDF
 *
 * Every action reports its result in a toast; failures say so (never a silent no-op).
 */

import { h, copyText, downloadText } from "../dom.js";
import { button } from "./ui.js";
import { menuButton, toast } from "./menu.js";
import { baseName, emailSummary, scraperFile, toCSV, toJSON, toMarkdown } from "../model/export.js";

/** Shareable URL of this report: same origin, only the job id (no mock flag, no hash). */
export function reportLink(job) {
  if (!job?.id) return null;
  const u = new URL(location.pathname, location.origin);
  u.searchParams.set("job", job.id);
  return u.href;
}

export function reportActions(job, { onRerun, observed, isMock = false, fromSnapshot = false, onBeforePrint } = {}) {
  const link = isMock ? null : reportLink(job);
  const hasRecords = job.results.length > 0;
  const scraper = scraperFile(job);
  const name = baseName(job);

  const rerunMsg = h("p", { class: "report__notice t-small c-2", role: "status", "aria-live": "polite", hidden: true });

  const run = button("Run again", {
    variant: "secondary",
    size: "sm",
    iconName: "refresh",
    attrs: { title: job.attempts[0]?.source === "saved" || job.finalCode ? "Runs the saved scraper for this site; repairs it if the page changed" : "Start a new run on this URL" },
    onClick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      rerunMsg.hidden = true;
      try {
        await onRerun();
      } catch (err) {
        rerunMsg.hidden = false;
        rerunMsg.textContent = err?.message || "Couldn’t start a new run.";
      } finally {
        btn.disabled = false;
      }
    },
  });

  const share = menuButton(
    "Share",
    [
      {
        label: "Copy link",
        icon: "link",
        disabled: !link,
        title: link ? null : "Links are not available for mock data",
        onSelect: async () => {
          const ok = await copyText(link);
          toast(ok ? "Report link copied" : "Couldn’t copy the link", { tone: ok ? "ok" : "error" });
        },
      },
      {
        label: "Email summary",
        icon: "mail",
        onSelect: () => {
          const { href } = emailSummary(job, { link });
          // mailto: opens the user's own mail client; nothing is sent by siftform.
          const a = document.createElement("a");
          a.href = href;
          a.rel = "noopener";
          document.body.append(a);
          a.click();
          a.remove();
          toast("Opening your email app");
        },
      },
    ],
    { iconName: "share", ariaLabel: "Share report" }
  );

  const exp = menuButton(
    "Export",
    [
      {
        label: "Copy as Markdown",
        icon: "copy",
        onSelect: async () => {
          const ok = await copyText(toMarkdown(job, { observed, link }));
          toast(ok ? "Report copied as Markdown" : "Couldn’t copy — try Download instead", { tone: ok ? "ok" : "error" });
        },
      },
      { separator: true },
      {
        label: "Records as CSV",
        icon: "download",
        hint: hasRecords ? `${job.results.length}` : "none",
        disabled: !hasRecords,
        onSelect: () => {
          downloadText(`${name}.csv`, toCSV(job), "text/csv;charset=utf-8");
          toast(`Downloaded ${name}.csv`);
        },
      },
      {
        label: "Results as JSON",
        icon: "file",
        hint: "data + evidence",
        onSelect: () => {
          downloadText(`${name}.json`, toJSON(job, observed), "application/json;charset=utf-8");
          toast(`Downloaded ${name}.json`);
        },
      },
      {
        label: "Python scraper",
        icon: "code",
        hint: scraper ? (scraper.verified ? ".py" : "unverified") : "none",
        disabled: !scraper,
        title: scraper ? null : fromSnapshot ? "The saved copy has no scraper code" : "No scraper was produced",
        onSelect: () => {
          downloadText(scraper.name, scraper.text, "text/x-python;charset=utf-8");
          toast(`Downloaded ${scraper.name}`);
        },
      },
      { separator: true },
      {
        label: "Print or save as PDF",
        icon: "print",
        onSelect: () => {
          onBeforePrint?.();
          // Let the full-report print layout render before the dialog opens.
          requestAnimationFrame(() => setTimeout(() => window.print(), 50));
        },
      },
    ],
    { iconName: "download", ariaLabel: "Export report" }
  );

  return { el: h("div", { class: "report__actions" }, run, share, exp), notice: rerunMsg };
}
