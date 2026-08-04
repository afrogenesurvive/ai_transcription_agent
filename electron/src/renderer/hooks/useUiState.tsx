/**
 * useUiState — React provider + hook for persisted UI preferences.
 *
 * Loads userData/ui-state.json once on mount (ui-state:get), holds the FULL object
 * in memory, and writes it back (ui-state:save) on a debounce plus on window
 * unload. Components subscribe to dotted paths like useState:
 *
 *   const [tab, setTab] = useUiStateValue("dev.tab", "live");
 *
 * Resets are done RENDERER-side (mutate local state + save) so the renderer stays
 * the single writer — a stale main-process copy can never resurrect a cleared
 * scope. Scope keys are top-level: "current", "history", "storage", "dev",
 * "config", "about", "newForm".
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

type UiState = Record<string, any>;

interface UiStateContextValue {
  /** Current full state object (changes identity on every write — consumers re-render). */
  state: UiState;
  /** True once the persisted state has finished loading (or failed) on mount. */
  ready: boolean;
  /** Read a dotted path, returning `fallback` when unset. */
  get: (path: string, fallback?: any) => any;
  /** Write a dotted path and schedule a debounced save. */
  set: (path: string, value: any) => void;
  /** Delete a top-level scope (e.g. "current") and schedule a save. */
  clearScope: (scope: string) => void;
}

const UiStateContext = createContext<UiStateContextValue | null>(null);

const DEBOUNCE_MS = 400;

/**
 * One-time migration from legacy localStorage keys (pre-0.7.x persistence).
 * Runs once after the initial ui-state load: any legacy key present in
 * localStorage is folded into the loaded state (only if the target path is
 * unset), then the legacy key is removed.
 */
const LEGACY_LOCALSTORAGE_KEYS: Array<[string, string, (raw: string) => any]> = [
  ["historyLeftColCollapsed", "history.leftColCollapsed", (raw) => raw === "true"],
  ["devpanel:sourceFilter", "dev.liveLog.sourceFilter", (raw) => raw],
  ["devpanel:levelFilter", "dev.liveLog.levelFilter", (raw) => raw],
  ["devpanel:autoScroll", "dev.liveLog.autoScroll", (raw) => raw === "true"],
];

function migrateLegacyKeys(state: UiState): UiState {
  let migrated = state;
  for (const [legacyKey, targetPath, convert] of LEGACY_LOCALSTORAGE_KEYS) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(legacyKey);
    } catch {
      raw = null;
    }
    if (raw === null) continue;
    try {
      if (getPath(migrated, targetPath) === undefined) {
        migrated = setPath(migrated, targetPath, convert(raw));
      }
      localStorage.removeItem(legacyKey);
    } catch {
      // Ignore conversion/storage errors — best-effort migration
    }
  }
  return migrated;
}

function splitPath(path: string): string[] {
  return path.split(".").filter(Boolean);
}

function getPath(state: UiState, path: string): any {
  let cur: any = state;
  for (const key of splitPath(path)) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Immutable set of a dotted path. Creates intermediate objects as needed. */
function setPath(state: UiState, path: string, value: any): UiState {
  const keys = splitPath(path);
  if (keys.length === 0) return state;
  const next: UiState = { ...state };
  let cur: any = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    const existing = cur[k];
    cur[k] = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return next;
}

export function UiStateProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<UiState>({});
  const [ready, setReady] = useState(false);
  const stateRef = useRef<UiState>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    window.electronAPI?.saveUiState(stateRef.current);
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, DEBOUNCE_MS);
  }, [flush]);

  // Load once on mount, then fold in any legacy localStorage keys
  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getUiState()
      .then((loaded) => {
        if (cancelled) return;
        const safe = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
        const migrated = migrateLegacyKeys(safe);
        stateRef.current = migrated;
        setState(migrated);
        if (migrated !== safe) flush();
        setReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        const migrated = migrateLegacyKeys({});
        stateRef.current = migrated;
        setState(migrated);
        if (Object.keys(migrated).length > 0) flush();
        setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [flush]);

  // Flush on window close / reload so debounced writes aren't lost
  useEffect(() => {
    const onUnload = () => flush();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [flush]);

  const set = useCallback(
    (path: string, value: any) => {
      stateRef.current = setPath(stateRef.current, path, value);
      setState(stateRef.current);
      scheduleSave();
    },
    [scheduleSave],
  );

  const clearScope = useCallback(
    (scope: string) => {
      if (!(scope in stateRef.current)) return;
      const next = { ...stateRef.current };
      delete next[scope];
      stateRef.current = next;
      setState(next);
      scheduleSave();
    },
    [scheduleSave],
  );

  const value = useMemo<UiStateContextValue>(
    () => ({
      state,
      ready,
      get: (path: string, fallback?: any) => {
        const v = getPath(stateRef.current, path);
        return v === undefined ? fallback : v;
      },
      set,
      clearScope,
    }),
    [state, ready, set, clearScope],
  );

  return <UiStateContext.Provider value={value}>{children}</UiStateContext.Provider>;
}

/** Access the ui-state context (throws outside <UiStateProvider>). */
export function useUiState(): UiStateContextValue {
  const ctx = useContext(UiStateContext);
  if (!ctx) throw new Error("useUiState must be used within <UiStateProvider>");
  return ctx;
}

/** useState-like binding to a dotted path, e.g. const [tab, setTab] = useUiStateValue("dev.tab", "live");
 *  The setter accepts either a plain value or an updater function (like useState). */
export function useUiStateValue<T = any>(path: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const { get, set } = useUiState();
  const value = get(path, fallback) as T;
  const setValue = useCallback(
    (v: T | ((prev: T) => T)) => {
      const next = typeof v === "function" ? (v as (prev: T) => T)(get(path, fallback) as T) : v;
      set(path, next);
    },
    [set, path, fallback],
  );
  return [value, setValue];
}
