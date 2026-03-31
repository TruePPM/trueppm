import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuthStore } from '@/stores/authStore';

export function RequireAuth() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hasHydrated = useAuthStore((s) => s._hasHydrated);
  const location = useLocation();

  // Block rendering until Zustand has rehydrated from localStorage.
  // Without this gate, v5's async hydration causes the first render to see
  // accessToken: null even when a valid token exists in storage, resulting in
  // the API interceptor sending requests without an Authorization header.
  if (!hasHydrated) return null;

  if (!isAuthenticated) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return <Outlet />;
}
