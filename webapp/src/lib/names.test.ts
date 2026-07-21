import { describe, expect, it } from "vitest";
import { Names, type KeyValueStore } from "./names";

/** In-memory KeyValueStore double (mirrors the store doubles in history/pods tests). */
class FakeStore implements KeyValueStore {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  /** Test-only peek at the raw stored keys, to assert the key prefix. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}

// A Pod ID long enough that its short-hex fallback is a strict prefix.
const POD = "a1b2c3d4e5f6";
const FALLBACK = "a1b2c3d4"; // first 8 chars

describe("Names — getName / fallback", () => {
  it("returns the short-hex fallback (first 8 chars) when unset", () => {
    const names = new Names({ store: new FakeStore() });
    expect(names.getName(POD)).toBe(FALLBACK);
  });

  it("returns the stored label once set", () => {
    const names = new Names({ store: new FakeStore() });
    names.setName(POD, "Living room");
    expect(names.getName(POD)).toBe("Living room");
  });

  it("falls back for a Pod whose ID is shorter than the fallback width", () => {
    const names = new Names({ store: new FakeStore() });
    expect(names.getName("abc")).toBe("abc");
  });
});

describe("Names — setName", () => {
  it("trims surrounding whitespace before storing", () => {
    const names = new Names({ store: new FakeStore() });
    names.setName(POD, "  Bedroom  ");
    expect(names.getName(POD)).toBe("Bedroom");
    expect(names.hasName(POD)).toBe(true);
  });

  it("storing a blank name clears the label (getName falls back, hasName is false)", () => {
    const names = new Names({ store: new FakeStore() });
    names.setName(POD, "Office");
    names.setName(POD, "   ");
    expect(names.hasName(POD)).toBe(false);
    expect(names.getName(POD)).toBe(FALLBACK);
  });

  it("persists across instances over the same store", () => {
    const store = new FakeStore();
    new Names({ store }).setName(POD, "Kitchen");
    expect(new Names({ store }).getName(POD)).toBe("Kitchen");
  });
});

describe("Names — hasName", () => {
  it("is false when unset and true only for a non-blank stored label", () => {
    const names = new Names({ store: new FakeStore() });
    expect(names.hasName(POD)).toBe(false);
    names.setName(POD, "Studio");
    expect(names.hasName(POD)).toBe(true);
  });
});

describe("Names — forget", () => {
  it("removes the label so getName falls back again", () => {
    const names = new Names({ store: new FakeStore() });
    names.setName(POD, "Garage");
    names.forget(POD);
    expect(names.hasName(POD)).toBe(false);
    expect(names.getName(POD)).toBe(FALLBACK);
  });

  it("forgets only that Pod, with no cross-Pod contamination", () => {
    const names = new Names({ store: new FakeStore() });
    names.setName("pod-1", "One");
    names.setName("pod-2", "Two");
    names.forget("pod-1");
    expect(names.getName("pod-1")).toBe("pod-1".slice(0, 8));
    expect(names.getName("pod-2")).toBe("Two");
  });
});

describe("Names — storage isolation", () => {
  it("uses a key prefix distinct from history (kuuki:history:)", () => {
    const store = new FakeStore();
    new Names({ store }).setName(POD, "Loft");
    for (const key of store.keys()) {
      expect(key.startsWith("kuuki:history:")).toBe(false);
    }
  });
});
