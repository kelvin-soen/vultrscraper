/**
 * Adapter selection.
 *
 * Production always uses the real HTTP adapter. The development mock is
 * loaded ONLY when the page URL carries `?mock=<scenario>`, it lives in
 * frontend/dev/, and the UI shows a persistent "Development fixture" badge
 * whenever it is active so mock data can never pass as a real run.
 */

import { createHttpAdapter } from "./client.js";

export async function resolveAdapter(search = location.search) {
  const params = new URLSearchParams(search);
  const scenario = params.get("mock");
  if (scenario !== null) {
    const { createMockAdapter } = await import("../../dev/mock-adapter.js");
    return createMockAdapter(scenario || "heal");
  }
  return createHttpAdapter("");
}
