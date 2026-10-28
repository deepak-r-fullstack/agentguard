import { create } from "zustand";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  showToast: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  showToast: (message, tone = "success") => {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, tone, message }] });
    // Errors stay longer so people have time to read what to do.
    window.setTimeout(() => get().dismissToast(id), tone === "error" ? 8000 : 4500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),
}));

export const showToast = (message: string, tone?: ToastTone) => useToastStore.getState().showToast(message, tone);
