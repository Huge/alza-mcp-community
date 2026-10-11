import { assertPageOk, type AlzaBrowser } from "../infra/browser.js";
import { TtlCache } from "../infra/cache.js";
import type { MobileApi } from "../infra/mobile-api.js";
import { log } from "../infra/logger.js";
import type { Catalog } from "./catalog.js";
import type { ProductReview, ProductReviews } from "./types.js";

const REVIEW_EXTRACTOR = `(function() {
  // 1. Aggregate values from JSON-LD Product (the canonical source).
  var lds = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(function(s) {
    try { return JSON.parse(s.textContent || '{}'); } catch (e) { return null; }
  }).filter(Boolean);
  var product = null;
  for (var i = 0; i < lds.length; i++) {
    var b = lds[i];
    var t = b['@type'];
    if (t === 'Product' || (Array.isArray(t) && t.indexOf('Product') >= 0)) { product = b; break; }
    if (b['@graph']) {
      for (var j = 0; j < b['@graph'].length; j++) {
        var g = b['@graph'][j];
        if (g && (g['@type'] === 'Product' || (Array.isArray(g['@type']) && g['@type'].indexOf('Product') >= 0))) { product = g; break; }
      }
    }
    if (product) break;
  }
  var agg = product && product.aggregateRating ? product.aggregateRating : {};

  // 2. Individual review bodies live in the DOM (Alza renders them server-side).
  // Try several known selector patterns; first hit wins.
  var rootSels = [
    '.review-list .review',
    '.reviews .review',
    '.commentList .commentItem',
    '.userReview',
    '[data-review]',
    '.reviewItem'
  ];
  var reviews = [];
  for (var s = 0; s < rootSels.length; s++) {
    var nodes = document.querySelectorAll(rootSels[s]);
    if (nodes.length === 0) continue;
    for (var k = 0; k < nodes.length && k < 50; k++) {
      var n = nodes[k];
      function inner(sel) {
        var el = n.querySelector(sel);
        return el ? el.textContent.trim().replace(/\\s+/g, ' ') : null;
      }
      var ratingEl = n.querySelector('[data-rating], .rating, .stars');
      var ratingAttr = ratingEl ? ratingEl.getAttribute('data-rating') : null;
      var ratingText = inner('[data-rating]') || inner('.rating') || inner('.stars');
      var match = (ratingAttr || ratingText || '').match(/(\\d[,.]\\d?)/);
      reviews.push({
        author: inner('.author, .reviewerName, .commentAuthor, [itemprop="author"]'),
        date: inner('.date, .reviewDate, time, [itemprop="datePublished"]'),
        body: inner('.body, .reviewBody, .commentText, [itemprop="description"]') || (n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 600),
        rating: match ? parseFloat(match[1].replace(',', '.')) : null
      });
    }
    if (reviews.length > 0) break;
  }

  return {
    average: agg.ratingValue,
    count: agg.reviewCount || agg.ratingCount,
    reviews: reviews
  };
})()`;

interface ExtractedReviews {
  average?: number;
  count?: number;
  reviews: Array<{
    author: string | null;
    date: string | null;
    body: string | null;
    rating: number | null;
  }>;
}

/** Page size Alza's reviews endpoint accepts (live-verified 2026-10-06: limit=50 -> 200). */
const API_PAGE_SIZE = 50;
/**
 * Reviews fetched before ordering and cutting to the caller's `limit`. The API
 * returns Czech reviews first and storefront-by-storefront (newest first within
 * each), so cutting to `limit` first would drop the newest review of a later
 * block; one full page is ordered globally instead.
 */
const REVIEW_WINDOW = API_PAGE_SIZE;
/** Hard bound on pages fetched per call (cap is 50 reviews, so 1 page; guards a misbehaving `next`). */
const MAX_PAGES = 3;

/** Newest first by ISO date; reviews without a date keep their relative order after the dated ones. */
export function sortReviewsNewestFirst(reviews: ProductReview[]): ProductReview[] {
  return reviews
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const da = a.r.date;
      const db = b.r.date;
      if (da && db) return da < db ? 1 : da > db ? -1 : a.i - b.i;
      if (da) return -1;
      if (db) return 1;
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/** Commodity id from a product URL: `...-d12999617.htm` or the variant form `/name?dq=7927612`. */
export function commodityIdFromUrl(url: string): number | undefined {
  const m = /[-/]d(\d+)\.htm/.exec(url) ?? /[?&]dq=(\d+)/.exec(url);
  return m ? Number(m[1]) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(str).filter((x): x is string => x !== undefined);
  return out.length ? out : undefined;
};

/** Map one `items[]` entry of the commodity reviews endpoint to a ProductReview. */
export function mapApiReview(raw: unknown): ProductReview | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  // `reviewDetail` reads "Hodnoceno 12.09.2026, varianta iPhone 15 128GB cerna".
  const detail = str(r.reviewDetail);
  const dm = detail ? /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:,\s*varianta\s+(.+))?/.exec(detail) : null;
  const date = dm ? `${dm[3]}-${dm[2]!.padStart(2, "0")}-${dm[1]!.padStart(2, "0")}` : undefined;
  return {
    author: str(r.name),
    date,
    rating: typeof r.rating === "number" ? r.rating : undefined,
    body: str(r.description),
    pros: strList(r.positives),
    cons: strList(r.negatives),
    verifiedPurchase: typeof r.verifiedPurchase === "boolean" ? r.verifiedPurchase : undefined,
    variant: dm?.[4]?.trim() || undefined,
    helpfulCount: typeof r.likeCount === "number" ? r.likeCount : undefined,
  };
}

export class Reviews {
  private readonly cache = new TtlCache<string, ProductReviews>(15 * 60 * 1000);

  constructor(
    private readonly browser: AlzaBrowser,
    private readonly catalog: Catalog,
    private readonly api?: Pick<MobileApi, "commodityReviews">
  ) {}

  /** Page through the reviews endpoint until `cap` reviews or no `next` link. */
  private async fetchApiReviews(commodityId: number, cap: number): Promise<ProductReview[]> {
    const out: ProductReview[] = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES && out.length < cap; page++) {
      const res = (await this.api!.commodityReviews(commodityId, {
        limit: Math.min(API_PAGE_SIZE, cap - out.length),
        offset,
      })) as { items?: unknown[]; paging?: { next?: unknown } } | null;
      const items = res && Array.isArray(res.items) ? res.items : [];
      for (const it of items) {
        const mapped = mapApiReview(it);
        if (mapped) out.push(mapped);
      }
      if (items.length === 0 || !res?.paging?.next) break;
      offset += items.length;
    }
    return out.slice(0, cap);
  }

  async getProductReviews(code: string, limit = 10): Promise<ProductReviews> {
    const trimmed = code.trim();
    const cap = Math.min(50, Math.max(1, limit));

    const key = `${trimmed}::${cap}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    // A transient reviews-API failure yields an aggregate-only result; don't memoize it for the full TTL.
    let apiFailed = false;
    const result = await (async (): Promise<ProductReviews> => {
      const url = await this.catalog.resolveProductUrl(trimmed);

      // Aggregate (+ legacy DOM reviews as fallback) from the product page.
      let data: ExtractedReviews | undefined;
      let pageUrl = url;
      let pageError: unknown;
      try {
        data = await this.browser.withPage(async (p) => {
          const res = await p.goto(url, { waitUntil: "commit", timeout: 30_000 });
          await assertPageOk(res, p);
          await p.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
          pageUrl = p.url();
          return (await p.evaluate(REVIEW_EXTRACTOR)) as ExtractedReviews;
        });
      } catch (e) {
        pageError = e;
      }

      // Individual reviews from the mobile reviews endpoint; any failure falls back to aggregate-only.
      let apiReviews: ProductReview[] | undefined;
      const id = commodityIdFromUrl(url) ?? commodityIdFromUrl(pageUrl);
      if (this.api && id !== undefined) {
        try {
          apiReviews = sortReviewsNewestFirst(await this.fetchApiReviews(id, Math.max(cap, REVIEW_WINDOW))).slice(0, cap);
        } catch (e) {
          apiFailed = true;
          log.debug("reviews.api failed; falling back to aggregate-only", { code: trimmed, error: String(e) });
        }
      }

      if (!data && !apiReviews) throw pageError ?? new Error(`could not load reviews for ${trimmed}`);

      const domReviews: ProductReview[] = (data?.reviews ?? []).slice(0, cap).map((r) => ({
        author: r.author ?? undefined,
        date: r.date ?? undefined,
        body: r.body ?? undefined,
        rating: r.rating ?? undefined,
      }));
      return {
        code: trimmed,
        ratingAverage: data?.average,
        reviewCount: data?.count,
        reviews: apiReviews && apiReviews.length > 0 ? apiReviews : domReviews,
      };
    })();
    if (!apiFailed) this.cache.set(key, result);
    return result;
  }
}
