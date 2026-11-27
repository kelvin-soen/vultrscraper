/** Product-level constants. Change the wordmark here only (the mark itself is brandMark() in dom.js). */
export const BRAND = {
  name: "siftform.",
  tagline: "Structured data from any website",
};

/**
 * Demo targets shown as quick links on the homepage. These are passed to the
 * backend as ordinary URLs; the frontend never contacts them itself.
 */
export const DEMO_TARGETS = [
  { label: "Demo shop", url: "http://70.34.217.56:8080/shop" },
  { label: "Changed layout", url: "http://70.34.217.56:8080/shop?v=2" },
  { label: "Hostile page", url: "http://70.34.217.56:8080/shop?v=evil" },
];

/** Delay before the finished run morphs into the report. */
export const REPORT_HANDOFF_MS = 900;
