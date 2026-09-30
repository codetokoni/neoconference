import { test, expect } from "@playwright/test";
import { INACTIVITY_DEFAULTS, resolveInactivityConfig } from "../../src/lib/inactivity";

/**
 * People were being "timed out": a meeting whose host never touched the
 * inactivity setting removed anyone idle for five minutes, while the
 * dashboard told the host auto-remove was off. 130 removals in a week.
 */
test("a meeting with no saved setting prompts but never removes anyone", () => {
  for (const saved of [undefined, null, {}]) {
    const c = resolveInactivityConfig(saved);
    expect(c.enabled).toBe(true);
    expect(c.autoRemove).toBe(false);
    expect(c.exemptAdmins).toBe(true);
    expect(c.warningMs).toBe(5 * 60 * 1000);
    expect(c.responseMs).toBe(60 * 1000);
  }
  expect(INACTIVITY_DEFAULTS.autoRemove).toBe(false);
});

test("a host who asked for removal still gets it", () => {
  const c = resolveInactivityConfig({ autoRemove: true, warningMs: 10 * 60 * 1000 });
  expect(c.autoRemove).toBe(true);
  expect(c.warningMs).toBe(10 * 60 * 1000);
  // The rest stays as the defaults, not undefined.
  expect(c.responseMs).toBe(60 * 1000);
  expect(c.enabled).toBe(true);
});

test("switching the prompt off is respected", () => {
  expect(resolveInactivityConfig({ enabled: false }).enabled).toBe(false);
});
