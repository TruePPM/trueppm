/**
 * Read-only workspace Email & SMTP status (#639, ADR-0084 §5).
 *
 * The mail transport is configured via Django settings / Helm env; this hook
 * surfaces the safe subset (never credentials) for the workspace-admin status
 * page. Writable SMTP config is #712.
 */

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api';

export interface EmailSettingsStatus {
  transport: string;
  host: string;
  host_configured: boolean;
  port: number | null;
  use_tls: boolean;
  use_ssl: boolean;
  from_email: string;
  configured_via: string;
}

/** GET /api/v1/workspace/email-settings/ — org-admin gated, read-only. */
export function useEmailSettings() {
  return useQuery<EmailSettingsStatus, Error>({
    queryKey: ['workspace-email-settings'],
    queryFn: async () => {
      const res = await apiClient.get<EmailSettingsStatus>('/workspace/email-settings/');
      return res.data;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
