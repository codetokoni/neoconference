import { test, expect } from "@playwright/test";
import {
  POPULAR_TRANSLATION_CODES,
  TRANSLATION_LANGUAGES,
  deeplTarget,
  matchesLanguage,
  translationLanguage,
} from "../../src/lib/translationLanguages";

/**
 * Live translation offered thirteen languages while DeepL, which does the
 * translating, had over a hundred — Hindi and Arabic among them, refused
 * here as "not supported". Every DeepL target is offered now.
 */
test("every DeepL target is offered, once each", () => {
  expect(TRANSLATION_LANGUAGES.length).toBeGreaterThanOrEqual(110);
  const codes = TRANSLATION_LANGUAGES.map((l) => l.code);
  expect(new Set(codes).size).toBe(codes.length);
  for (const l of TRANSLATION_LANGUAGES) {
    // What the create route accepts as a meeting language.
    expect(l.code).toMatch(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/);
    expect(l.native.length).toBeGreaterThan(0);
  }
});

test("codes the room already stores keep translating the same way", () => {
  expect(deeplTarget("en")).toBe("EN-US");
  expect(deeplTarget("pt")).toBe("PT-PT");
  expect(deeplTarget("zh")).toBe("ZH-HANS");
  expect(deeplTarget("es")).toBe("ES");
});

test("Hindi, Arabic and the long tail translate now", () => {
  expect(deeplTarget("hi")).toBe("HI");
  expect(deeplTarget("ar")).toBe("AR");
  expect(deeplTarget("sw")).toBe("SW");
  expect(deeplTarget("ha")).toBe("HA");
  expect(deeplTarget("ig")).toBe("IG");
  expect(deeplTarget("pt-br")).toBe("PT-BR");
  expect(deeplTarget("zh-hant")).toBe("ZH-HANT");
});

test("a region we fold away still finds its language; nonsense finds nothing", () => {
  expect(deeplTarget("en-GB")).toBe("EN-US");
  expect(deeplTarget("es-419")).toBe("ES");
  expect(deeplTarget("xx")).toBeNull();
  expect(deeplTarget("")).toBeNull();
  expect(translationLanguage(null)).toBeUndefined();
});

test("search finds a language by either name", () => {
  const sw = translationLanguage("sw")!;
  expect(matchesLanguage(sw, "swa")).toBe(true);
  expect(matchesLanguage(sw, "kiswahili")).toBe(true);
  expect(matchesLanguage(sw, "french")).toBe(false);
  expect(matchesLanguage(sw, "")).toBe(true);
});

test("the popular picks are all real languages", () => {
  for (const c of POPULAR_TRANSLATION_CODES) expect(translationLanguage(c)?.code).toBe(c);
});
