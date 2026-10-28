import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { SessionUser } from "utils/types";

interface AuthState {
  token: string | null;
  user: SessionUser | null;
  setSession: (token: string, user: SessionUser) => void;
  signOut: () => void;
}

// localStorage can throw (private windows, blocked storage). Fall back to memory so sign-in still works.
const safeStorage = createJSONStorage(() => {
  try {
    const probe = "__agentguard_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    };
  }
});

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setSession: (token, user) => set({ token, user }),
      signOut: () => set({ token: null, user: null }),
    }),
    { name: "agentguard-session", storage: safeStorage }
  )
);
