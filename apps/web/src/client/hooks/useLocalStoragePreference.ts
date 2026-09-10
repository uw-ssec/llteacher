import { useEffect, useState } from "react";

/** #302: shared by every "boolean preference persisted to localStorage,
 *  read once on mount, written on every change" pair in App.tsx -- the
 *  sidebar collapse state and the tutor rail's own collapse state were
 *  near-identical blocks (lazy-init reader + write effect) differing only
 *  in which key they used. Both call sites keep their own key constant;
 *  this hook only owns the read/write mechanics.
 *
 *  Fails closed to `defaultValue` (not just on read, but by construction --
 *  there is no other way to end up with a value this hook didn't either
 *  read from storage or default to) on a private-mode/quota exception from
 *  either `localStorage.getItem` or `.setItem`, matching both original
 *  call sites' identical try/catch-and-ignore posture. */
export function useLocalStoragePreference(
  key: string,
  defaultValue = false,
): [boolean, (value: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      return window.localStorage.getItem(key) === "true";
    } catch {
      /* Private mode / disabled storage -- fall back to the default. */
      return defaultValue;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      /* localStorage may throw (private mode quota, etc.) -- silently ignore. */
    }
  }, [key, value]);

  return [value, setValue];
}
