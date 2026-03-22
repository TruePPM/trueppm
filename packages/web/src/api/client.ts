import axios from 'axios';
import { useAuthStore } from '@/stores/authStore';

export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach JWT access token to every request
apiClient.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Clear auth state on 401 — token refresh logic is added when the auth feature is built
apiClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      useAuthStore.getState().clearTokens();
    }
    // Re-throw as Error to satisfy @typescript-eslint/prefer-promise-reject-errors
    const err = error instanceof Error ? error : new Error(String(error));
    return Promise.reject(err);
  },
);
