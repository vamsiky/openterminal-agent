// Node's own experimental `localStorage` global can shadow jsdom's and be unusable;
// give the zustand persist middleware a plain in-memory one.
const data = new Map<string, string>();
const storage: Storage = {
  get length() {
    return data.size;
  },
  clear: () => data.clear(),
  getItem: (k) => data.get(k) ?? null,
  key: (i) => [...data.keys()][i] ?? null,
  removeItem: (k) => void data.delete(k),
  setItem: (k, v) => void data.set(k, String(v)),
};
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
