import { cardsForFile, sortCards } from "../core/cards";
import type { Card, Outcome } from "../core/types";
import type { Memento } from "./stats";
import type { Store } from "./store";

export interface Entry {
  /** Unique across workspace folders. */
  key: string;
  store: Store;
  card: Card;
  /** Set while an answered card is still on screen. */
  outcome?: Outcome;
  picked?: number;
}

interface Resolution {
  file: string;
  outcome: Outcome;
  picked?: number;
  at: string;
}

const KEY = "kenning.resolved";
const MAX_BYTES = 1_500_000;

const looksBinary = (s: string | null) => s !== null && (s.length > MAX_BYTES || s.includes("\u0000"));

/**
 * The deck: every unreviewed change across the workspace. A file's baseline
 * is dropped once all of its changes are reviewed, so the next agent edit
 * starts a fresh comparison from the reviewed state.
 */
export class Review {
  private resolved: Record<string, Resolution>;
  /** Answered cards kept on screen until the developer moves on. */
  private showing = new Set<string>();

  constructor(
    private stores: () => Store[],
    private memo: Memento,
  ) {
    this.resolved = memo.get<Record<string, Resolution>>(KEY) ?? {};
  }

  private keyFor(store: Store, card: Card) {
    return `${store.root}::${card.hunk.id}`;
  }

  /** Recomputes the deck from disk. */
  entries(): Entry[] {
    const out: Entry[] = [];
    let dirty = false;
    for (const store of this.stores()) {
      for (const base of store.listBaselines()) {
        const current = store.readCurrent(base.file);
        if (looksBinary(current) || looksBinary(base.content)) {
          store.removeBaseline(base.file);
          continue;
        }
        if (current === base.content || (current === null && base.content === null)) {
          store.removeBaseline(base.file);
          continue;
        }
        const cards = cardsForFile(base.file, base.content, current);
        const fileEntries: Entry[] = [];
        let open = 0;
        for (const card of cards) {
          const key = this.keyFor(store, card);
          const r = this.resolved[key];
          if (!r) open++;
          if (!r || this.showing.has(key)) fileEntries.push({ key, store, card, outcome: r?.outcome, picked: r?.picked });
        }
        if (open === 0 && !fileEntries.length) {
          // Everything in this file is reviewed: start fresh from here.
          store.removeBaseline(base.file);
          for (const [k, r] of Object.entries(this.resolved)) {
            if (k.startsWith(`${store.root}::`) && r.file === base.file) delete this.resolved[k];
          }
          dirty = true;
          continue;
        }
        out.push(...fileEntries);
      }
    }
    if (dirty) void this.memo.update(KEY, this.resolved);
    const order = new Map(sortCards(out.map((e) => e.card)).map((c, i) => [c, i]));
    return out.sort((a, b) => (order.get(a.card) ?? 0) - (order.get(b.card) ?? 0));
  }

  async resolve(entry: Entry, outcome: Outcome, picked?: number, { keepShowing = false } = {}) {
    this.resolved[entry.key] = { file: entry.card.hunk.file, outcome, picked, at: new Date().toISOString() };
    if (keepShowing) this.showing.add(entry.key);
    await this.memo.update(KEY, this.resolved);
  }

  /** Lets an answered card leave the deck. */
  dismiss(key: string) {
    this.showing.delete(key);
  }

  isShowing(key: string) {
    return this.showing.has(key);
  }
}
