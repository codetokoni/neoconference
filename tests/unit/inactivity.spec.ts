import { test, expect } from "@playwright/test";
import { INACTIVITY_DEFAULTS, resolveInactivityConfig } from "../../src/lib/inactivity";

/**
 * People were being "timed out": a meeting whose host never touched the
 * inactivity setting removed anyone idle for five minutes, while the
 * dashboard told the host auto-remove was off. 130 removals in a week.
 * Now a meeting nobody configured asks nothing; a host who switches the
 * prompt on gets twenty minutes' grace, and removal is a separate choice.
 */
test("a meeting with no saved setting has the prompt off", () => {
  for (const saved of [undefined, null, {}]) {
    const c = resolveInactivityConfig(saved);
    expect(c.enabled).toBe(false);
    expect(c.autoRemove).toBe(false);
    expect(c.exemptAdmins).toBe(true);
    expect(c.warningMs).toBe(20 * 60 * 1000);
    expect(c.responseMs).toBe(60 * 1000);
  }
  expect(INACTIVITY_DEFAULTS.enabled).toBe(false);
  expect(INACTIVITY_DEFAULTS.autoRemove).toBe(false);
});

test("switching the prompt on gives twenty minutes and still removes nobody", () => {
  const c = resolveInactivityConfig({ enabled: true });
  expect(c.enabled).toBe(true);
  expect(c.warningMs).toBe(20 * 60 * 1000);
  expect(c.autoRemove).toBe(false);
});

test("a host who asked for removal still gets it", () => {
  const c = resolveInactivityConfig({ enabled: true, autoRemove: true, warningMs: 10 * 60 * 1000 });
  expect(c.autoRemove).toBe(true);
  expect(c.warningMs).toBe(10 * 60 * 1000);
  // The rest stays as the defaults, not undefined.
  expect(c.responseMs).toBe(60 * 1000);
});

test("a saved 'enabled: false' stays off", () => {
  expect(resolveInactivityConfig({ enabled: false, autoRemove: true }).enabled).toBe(false);
});
