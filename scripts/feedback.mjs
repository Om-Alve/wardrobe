// Personal signals derived per request from stylist.json: wear recency, underuse, learned pair scores, and rejections.
// The weights start from wardrowbe's learning service (MIT); wears count most because they are the strongest evidence.

const DAY = 86400000;
const HALF_LIFE_DAYS = 90;
const AVOID_DAYS = 7;
const SIGNALS = { saved: 0.3, up: 0.3, down: -0.5, worn: 0.4, swapIn: 0.2, swapOut: -0.2 };

export function today(now = Date.now()) {
  return new Date(now).toLocaleDateString("en-CA");
}

export function signature(ids) {
  return [...ids].sort().join("|");
}

function pairKey(first, second) {
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function daysSince(date, now) {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date) : Date.parse(today(Date.parse(date)));
  return Math.round((Date.parse(today(now)) - value) / DAY);
}

export function deriveFeedback(state = {}, items = [], now = Date.now()) {
  const parts = new Map(items.map((item) => [item.id, item.part]));
  const core = (ids = []) => ids.filter((id) => parts.has(id) && parts.get(id) !== "accessories_up");
  const pairs = new Map();
  const weigh = (signal, at) => Math.abs(signal) * 0.5 ** (Math.max(0, daysSince(at, now)) / HALF_LIFE_DAYS);
  const credit = (first, second, signal, at) => {
    const key = pairKey(first, second);
    const entry = pairs.get(key) || { positive: 0, negative: 0 };
    entry[signal > 0 ? "positive" : "negative"] += weigh(signal, at);
    pairs.set(key, entry);
  };
  const creditAll = (ids, signal, at) => {
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) credit(ids[i], ids[j], signal, at);
  };

  const liked = new Map();
  const rejectedSets = new Set();
  const rejectedPairs = new Set();
  const shownRecently = new Set();
  for (const look of state.looks || []) {
    const ids = look.garmentIds || [];
    const key = signature(core(ids));
    if (look.savedAt) { creditAll(ids, SIGNALS.saved, look.savedAt); liked.set(key, "saved before"); }
    if (look.verdict === "up") { creditAll(ids, SIGNALS.up, look.verdictAt); liked.set(key, "liked before"); }
    if (look.verdict === "down") {
      creditAll(ids, SIGNALS.down, look.verdictAt);
      rejectedSets.add(key);
      const top = ids.find((id) => parts.get(id) === "upperbody");
      const bottom = ids.find((id) => parts.get(id) === "lowerbody");
      if (top && bottom && daysSince(look.verdictAt, now) <= 30) rejectedPairs.add(pairKey(top, bottom));
    }
    if (look.createdAt && daysSince(look.createdAt, now) <= 3 && look.verdict !== "down") shownRecently.add(key);
  }
  for (const entry of state.hidden || []) {
    creditAll(entry.garmentIds, SIGNALS.down, entry.at);
    rejectedSets.add(signature(core(entry.garmentIds)));
  }

  const lastWorn = new Map();
  const wearCount = new Map(items.map((item) => [item.id, 0]));
  const wornSets = new Map();
  for (const wear of state.wears || []) {
    creditAll(wear.garmentIds, SIGNALS.worn, wear.date);
    const days = daysSince(wear.date, now);
    for (const id of wear.garmentIds) {
      wearCount.set(id, (wearCount.get(id) || 0) + 1);
      if (!lastWorn.has(id) || days < lastWorn.get(id)) lastWorn.set(id, days);
    }
    const key = signature(core(wear.garmentIds));
    if (days <= AVOID_DAYS && (!wornSets.has(key) || days < wornSets.get(key))) wornSets.set(key, days);
  }
  for (const swap of state.swaps || []) {
    for (const other of swap.rest || []) {
      credit(swap.in, other, SIGNALS.swapIn, swap.at);
      credit(swap.out, other, SIGNALS.swapOut, swap.at);
    }
  }

  const counts = [...wearCount.values()].sort((a, b) => a - b);
  const median = Math.max(1, counts.length ? counts[Math.floor(counts.length / 2)] : 0);
  return {
    // 0.1 when worn today, rising to 1 after a week; never-worn items are 1.
    recency(id) {
      if (!lastWorn.has(id)) return 1;
      const days = lastWorn.get(id);
      return days < 1 ? 0.1 : Math.min(1, 0.1 + (0.9 * days) / AVOID_DAYS);
    },
    // Items worn far less than the wardrobe's median get a small lift; heavily worn ones a small drop.
    underuse(id) {
      const ratio = (wearCount.get(id) || 0) / median;
      return ratio <= 0.3 ? 1.15 : ratio <= 0.7 ? 1.05 : ratio <= 1.5 ? 1 : 0.9;
    },
    // Beta(2, 2)-smoothed preference for wearing two items together, from -1 to 1; null without evidence.
    pairScore(first, second) {
      const entry = pairs.get(pairKey(first, second));
      if (!entry) return null;
      return (2 * (entry.positive + 2)) / (entry.positive + entry.negative + 4) - 1;
    },
    lastWornDays: (id) => lastWorn.get(id) ?? null,
    wearCount: (id) => wearCount.get(id) || 0,
    liked,
    rejectedSets,
    rejectedPairs,
    shownRecently,
    wornSets,
  };
}
