/**
 * Writable workspace Email & SMTP configuration (#712, ADR-0211).
 *
 * Upgrades the #639 read-only status hook to the writable surface: the transport
 * (TruePPM cloud / custom SMTP / SendGrid / SES), From identity, DKIM, delivery
 * limits, and bounce webhook. The SMTP password is write-only — the payload
 * never carries it, only `password_is_set`. Reads are org-admin gated; writes
 * (and the test-email / health actions) require the install operator, surfaced
 * to the UI as `can_edit`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api';

export type EmailTransportMode = 'cloud' | 'smtp' | 'sendgrid' | 'ses';
export type EmailSecurity = 'none' | 'tls' | 'ssl';
export type HealthStatus = 'pass' | 'warn' | 'fail' | 'unknown';

const QUERY_KEY = ['workspace-email-settings'] as const;

/** GET /workspace/email-settings/ shape. `password` is never present. */
export interface EmailSettings {
  transport_mode: EmailTransportMode;
  host: string;
  port: number;
  security: EmailSecurity;
  username: string;
  password_is_set: boolean;
  from_name: string;
  from_email: string;
  reply_to: string;
  dkim_selector: string;
  max_recipients: number;
  throttle_per_min: number;
  bounce_webhook_url: string;
  /** True only for the install operator (superuser) — gates the write form. */
  can_edit: boolean;
  /** Back-compat status flags preserved from the #639 read-only surface. */
  configured_via: string;
  host_configured: boolean;
}

/** PUT body. `password` omitted/blank keeps the stored secret (rotate-vs-keep). */
export interface EmailSettingsUpdate {
  transport_mode: EmailTransportMode;
  host: string;
  port: number;
  security: EmailSecurity;
  username: string;
  password: string;
  from_name: string;
  from_email: string;
  reply_to: string;
  dkim_selector: string;
  max_recipients: number;
  throttle_per_min: number;
  bounce_webhook_url: string;
}

export interface EmailHealth {
  available: boolean;
  domain: string;
  spf: HealthStatus;
  dkim: HealthStatus;
  dmarc: HealthStatus;
}

export interface SendTestResult {
  sent: boolean;
  recipient?: string;
  error?: string;
}

/** GET /api/v1/workspace/email-settings/ — org-admin readable. */
export function useEmailSettings() {
  return useQuery<EmailSettings, Error>({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await apiClient.get<EmailSettings>('/workspace/email-settings/');
      return res.data;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/** PUT /api/v1/workspace/email-settings/ — operator-only (validate-before-persist). */
export function useUpdateEmailSettings() {
  const qc = useQueryClient();
  return useMutation<EmailSettings, Error, EmailSettingsUpdate>({
    mutationFn: async (body: EmailSettingsUpdate) => {
      const res = await apiClient.put<EmailSettings>('/workspace/email-settings/', body);
      return res.data;
    },
    onSuccess: (data) => {
      qc.setQueryData(QUERY_KEY, data);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

/** Narrow an axios-style rejection to its response body without an `any` cast. */
function responseBody<T>(err: unknown): T | undefined {
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const response = (err as { response?: unknown }).response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      return (response as { data?: T }).data;
    }
  }
  return undefined;
}

/**
 * POST /api/v1/workspace/email-settings/send-test/ — send a test email.
 *
 * The endpoint returns 200 `{sent:true}` or 4xx/502 `{sent:false,error}`. The
 * error shapes are normalized back into the result so the caller renders one
 * inline outcome rather than a thrown error.
 */
export function useSendTestEmail() {
  return useMutation<SendTestResult, Error, void>({
    mutationFn: async () => {
      try {
        const res = await apiClient.post<SendTestResult>(
          '/workspace/email-settings/send-test/',
          {},
        );
        return res.data;
      } catch (err) {
        const body = responseBody<SendTestResult>(err);
        if (body && typeof body.sent === 'boolean') return body;
        throw err;
      }
    },
  });
}

/**
 * GET /api/v1/workspace/email-settings/health/ — lazy SPF/DKIM/DMARC check.
 *
 * Disabled by default (`enabled:false`) and run via `refetch`, so opening the
 * settings page never fires a DNS lookup for an admin who doesn't scroll to
 * Email (ADR-0146 mounts every section at once).
 */
export function useEmailHealth() {
  return useQuery<EmailHealth, Error>({
    queryKey: ['workspace-email-health'],
    queryFn: async () => {
      const res = await apiClient.get<EmailHealth>('/workspace/email-settings/health/');
      return res.data;
    },
    enabled: false,
    retry: false,
    gcTime: 0,
  });
}
