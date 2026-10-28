import axios, { AxiosError } from "axios";
import { useAuthStore } from "utils/store/authStore";

// One axios instance for the whole app. In development Vite forwards /api to the server.
export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "/api",
  timeout: 60_000,
});

apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    // Expired or invalid session: sign out so the app shows the sign-in screen.
    if (error.response?.status === 401 && useAuthStore.getState().token) {
      useAuthStore.getState().signOut();
    }
    return Promise.reject(error);
  }
);

// Turns any error into one sentence a person can act on.
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const message = (error.response?.data as { message?: string } | undefined)?.message;
    if (message) return message;
    if (!error.response) return "Cannot reach the AgentGuard server. Check that it is running, then try again.";
  }
  return "Something went wrong. Please try again.";
}
