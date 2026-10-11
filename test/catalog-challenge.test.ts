import { describe, expect, it } from "vitest";
import { Catalog } from "../src/domain/catalog.js";
import { CloudflareChallengeError, UpstreamError } from "../src/infra/errors.js";
import { assertNotChallenged, assertPageOk, type AlzaBrowser } from "../src/infra/browser.js";
import { resolveLocale } from "../src/infra/locale.js";
import type { Page, Response } from "playwright";

/** Headless Chromium on a Cloudflare-flagged IP, as reported 2026-10-11: every
 * navigation answers 403 + `cf-mitigated: challenge` and the "Okamžik…" page. */
function fakeBrowser(status: number, headers: Record<string, string> = {}, title = "") {
  const browser = {
    locale: resolveLocale("https://www.alza.cz"),
    async withPage<T>(fn: (p: unknown) => Promise<T>): Promise<T> {
      let current = "";
      const page = {
        goto: async (url: string) => {
          current = url;
          return { status: () => status, headers: () => headers };
        },
        url: () => current,
        title: async () => title,
        waitForLoadState: async () => {},
        waitForSelector: async () => null,
        waitForTimeout: async () => {},
        evaluate: async () => [],
      };
      return fn(page);
    },
  };
  return browser as unknown as AlzaBrowser;
}

const fakePage = (title: string) => ({ url: () => "https://www.alza.cz/search.htm", title: async () => title }) as unknown as Page;
const fakeRes = (status: number, headers: Record<string, string> = {}) => ({ status: () => status, headers: () => headers }) as unknown as Response;

describe("Cloudflare challenge is an error, not an empty catalog result", () => {
  it("assertNotChallenged: 403 + cf-mitigated: challenge", async () => {
    await expect(assertNotChallenged(fakeRes(403, { "cf-mitigated": "challenge" }), fakePage(""))).rejects.toBeInstanceOf(CloudflareChallengeError);
  });

  it("assertNotChallenged: 503 'Just a moment' page without the header", async () => {
    await expect(assertNotChallenged(fakeRes(503), fakePage("Just a moment..."))).rejects.toBeInstanceOf(CloudflareChallengeError);
  });

  it("assertNotChallenged: plain 200 and 404 pass; a 403 from Alza itself is not a challenge", async () => {
    await expect(assertNotChallenged(fakeRes(200), fakePage("Alza"))).resolves.toBeUndefined();
    await expect(assertNotChallenged(fakeRes(404), fakePage("Alza"))).resolves.toBeUndefined();
    await expect(assertNotChallenged(fakeRes(403, { server: "nginx" }), fakePage("Alza"))).resolves.toBeUndefined();
    await expect(assertNotChallenged(null, fakePage(""))).resolves.toBeUndefined();
  });

  it("assertPageOk: 5xx/429/non-challenge 403 are upstream errors, 404 is left to the caller", async () => {
    await expect(assertPageOk(fakeRes(502), fakePage("Alza"))).rejects.toBeInstanceOf(UpstreamError);
    await expect(assertPageOk(fakeRes(429), fakePage("Alza"))).rejects.toBeInstanceOf(UpstreamError);
    await expect(assertPageOk(fakeRes(403, { server: "nginx" }), fakePage("Alza"))).rejects.toBeInstanceOf(UpstreamError);
    await expect(assertPageOk(fakeRes(404), fakePage("Alza"))).resolves.toBeUndefined();
  });

  it("search fails with the challenge error and its remedies instead of 0 results", async () => {
    const catalog = new Catalog(fakeBrowser(403, { "cf-mitigated": "challenge", server: "cloudflare" }, "Okamžik…"));
    const err = await catalog.searchProducts({ query: "iphone", limit: 5 } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareChallengeError);
    expect((err as Error).message).toMatch(/HTTP 403, cf-mitigated: challenge/);
    expect((err as Error).message).toMatch(/ALZA_PROXY_URL/);
    expect((err as Error).message).toMatch(/ALZA_CDP_URL/);
  });

  it("get_product and list_categories fail the same way", async () => {
    const catalog = new Catalog(fakeBrowser(403, { "cf-mitigated": "challenge" }));
    await expect(catalog.getProduct("ABC123")).rejects.toBeInstanceOf(CloudflareChallengeError);
    await expect(catalog.listCategories()).rejects.toBeInstanceOf(CloudflareChallengeError);
  });

  it("an Alza 5xx on search is an upstream error, not 0 results", async () => {
    const catalog = new Catalog(fakeBrowser(503, { server: "nginx" }, "Alza"));
    await expect(catalog.searchProducts({ query: "iphone", limit: 5 } as never)).rejects.toBeInstanceOf(UpstreamError);
  });
});
