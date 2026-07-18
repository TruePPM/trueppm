/**
 * Telemetry (OpenTelemetry export) card for Settings → Workspace → System Health
 * (#2110, ADR-0223 follow-up).
 *
 * READ-ONLY surface. OTel config is env/Helm only (ADR-0223); the OTLP bearer
 * token (OTEL_EXPORTER_OTLP_HEADERS) is never sent to the browser. The card lets a
 * self-hosting operator (a) get guided setup when nothing is configured, (b) see
 * the real exporter config, and (c) verify the export path with a Test-export probe.
 *
 * Honest state only: it does NOT show live span/metric counts — the exporters
 * don't record them (tracked in #2109). Card state is derived from config plus the
 * on-demand Test-export result, never fabricated numbers.
 */

import { useState } from 'react';
import { SettingsCard } from '../../SettingsShell';
import { Button } from '@/components/Button';
import { docsUrl } from '@/lib/docsUrl';
import {
  useTelemetryTestExport,
  type SystemHealthTelemetry,
  type TelemetryTestResult,
} from '@/hooks/useSystemHealth';

// ---------------------------------------------------------------------------
// Guided-setup snippets — accurate OTLP env / Helm config for common backends.
// Static content; the card can't edit config, so these are copy-paste reference.
// ---------------------------------------------------------------------------

interface Backend {
  id: string;
  label: string;
  proto: string;
  endpoint: string;
  note: string;
}

const BACKENDS: readonly Backend[] = [
  {
    id: 'tempo',
    label: 'Grafana Tempo',
    proto: 'grpc',
    endpoint: 'http://tempo.observability.svc:4317',
    note: 'Tempo ingests OTLP directly on :4317 (gRPC). In-cluster traffic usually needs no auth.',
  },
  {
    id: 'jaeger',
    label: 'Jaeger',
    proto: 'grpc',
    endpoint: 'http://jaeger-collector.observability.svc:4317',
    note: "Jaeger's collector accepts OTLP on :4317 (gRPC) and :4318 (HTTP). Use the collector service, not the query UI.",
  },
  {
    id: 'otlp',
    label: 'Generic OTLP collector',
    proto: 'http/protobuf',
    endpoint: 'http://otel-collector.observability.svc:4318',
    note: 'Any OpenTelemetry Collector. :4318 for HTTP/protobuf, :4317 for gRPC. Point TruePPM at the receiver, fan out downstream.',
  },
];

function envSnippet(b: Backend): string {
  return [
    '# Add to the TruePPM deployment env, then restart the pods.',
    'TRUEPPM_OTEL_ENABLED=true',
    `OTEL_EXPORTER_OTLP_ENDPOINT=${b.endpoint}`,
    `OTEL_EXPORTER_OTLP_PROTOCOL=${b.proto}`,
    'OTEL_SERVICE_NAME=trueppm-api',
    'OTEL_TRACES_SAMPLER=parentbased_traceidratio',
    'OTEL_TRACES_SAMPLER_ARG=0.1',
    '# Auth header — only if your collector requires it. Keep the token in a',
    '# Secret, never in plain config:',
    '# OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer <redacted>',
  ].join('\n');
}

function helmSnippet(b: Backend): string {
  return [
    '# values.yaml — then: helm upgrade trueppm trueppm/trueppm -f values.yaml',
    'extraEnv:',
    '  - name: TRUEPPM_OTEL_ENABLED',
    '    value: "true"',
    '  - name: OTEL_EXPORTER_OTLP_ENDPOINT',
    `    value: "${b.endpoint}"`,
    '  - name: OTEL_EXPORTER_OTLP_PROTOCOL',
    `    value: "${b.proto}"`,
    '  - name: OTEL_SERVICE_NAME',
    '    value: "trueppm-api"',
    '# Bearer token / headers: reference a Secret, never inline in values.',
    'envFrom:',
    '  - secretRef:',
    '      name: trueppm-otel-auth',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Icons (inline stroke SVG — this package has no icon dependency)
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function LockIcon({ className }: IconProps) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4.5 7.5V5.25a3.5 3.5 0 017 0V7.5M3.75 7.5h8.5v6h-8.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon({ className }: IconProps) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon({ className }: IconProps) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SendIcon({ className }: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M2 8l11.5-4.5L9.5 14 7 9 2 8z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Spinner({ className }: IconProps) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`animate-spin ${className ?? ''}`}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Copy button + code block
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy configuration to clipboard"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => {
            /* clipboard blocked — leave the button in its idle state */
          });
      }}
      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-control border border-neutral-border bg-neutral-surface-raised text-[12px] font-semibold text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
    >
      {copied ? <CheckIcon className="text-semantic-on-track" /> : null}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <div className="rounded-lg border border-neutral-border overflow-hidden bg-neutral-surface-sunken">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-border/55 bg-neutral-surface-raised">
        <span className="text-[11px] font-semibold text-neutral-text-secondary">
          read-only reference — set this outside the app
        </span>
        <div className="flex-1" />
        <CopyButton text={text} />
      </div>
      <pre className="tppm-mono m-0 px-3.5 py-3 text-[12.5px] leading-relaxed overflow-x-auto whitespace-pre text-neutral-text-primary">
        {text}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config summary + signals (configured states)
// ---------------------------------------------------------------------------

function ConfigField({
  label,
  value,
  mono = true,
  redacted = false,
  span = false,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  redacted?: boolean;
  span?: boolean;
}) {
  return (
    <div
      className={`px-3 py-2.5 rounded-control bg-neutral-surface-raised border border-neutral-border/55 ${span ? 'sm:col-span-2' : ''}`}
    >
      <div className="text-[10px] uppercase tracking-wide font-semibold text-neutral-text-secondary">{label}</div>
      {redacted ? (
        <div className="mt-1 flex items-center gap-1.5">
          <LockIcon className="text-neutral-text-secondary" />
          <span className="tppm-mono text-[13px] tracking-widest text-neutral-text-secondary">••••••••</span>
          <span className="text-[11px] text-neutral-text-secondary">hidden — never displayed</span>
        </div>
      ) : (
        <div className={`mt-1 text-[13px] text-neutral-text-primary break-all ${mono ? 'tppm-mono' : ''}`}>
          {value}
        </div>
      )}
    </div>
  );
}

function ConfigSummary({ telemetry }: { telemetry: SystemHealthTelemetry }) {
  const sampler = telemetry.sampler_arg
    ? `${telemetry.sampler} · ${telemetry.sampler_arg}`
    : telemetry.sampler;
  return (
    <div className="px-4 py-3">
      <h3 className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-2.5">
        Active configuration
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <ConfigField label="Endpoint" value={telemetry.endpoint} span />
        <ConfigField label="Protocol" value={telemetry.protocol} />
        <ConfigField label="Service" value={`${telemetry.service_name} · ${telemetry.service_version}`} />
        <ConfigField label="Sampler" value={sampler} />
        <ConfigField label="Edition" value={telemetry.edition} mono={false} />
        <ConfigField label="Auth headers / bearer token" redacted span />
      </div>
    </div>
  );
}

function SignalRow({ name, on, first }: { name: string; on: boolean; first?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 px-3 py-2.5 ${first ? '' : 'border-t border-neutral-border/55'}`}>
      <span
        aria-hidden="true"
        className={`w-2.5 h-2.5 rounded-full shrink-0 ${on ? 'bg-semantic-on-track' : 'border-2 border-neutral-text-secondary'}`}
      />
      <span className="text-[13px] font-semibold text-neutral-text-primary min-w-[64px]">{name}</span>
      <span className="text-[12px] text-neutral-text-secondary flex-1">
        {on ? 'export enabled' : 'export disabled'}
      </span>
      <span
        className={`text-[10.5px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-control ${
          on
            ? 'text-semantic-on-track bg-semantic-on-track-bg'
            : 'text-neutral-text-secondary bg-neutral-surface-sunken border border-neutral-border/55'
        }`}
      >
        {on ? 'on' : 'off'}
      </span>
    </div>
  );
}

function Signals({ telemetry }: { telemetry: SystemHealthTelemetry }) {
  return (
    <div className="px-4 pb-1.5">
      <h3 className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-2">
        Signals
      </h3>
      <div className="rounded-lg border border-neutral-border/55 overflow-hidden">
        <SignalRow first name="Traces" on={telemetry.traces_enabled} />
        <SignalRow name="Metrics" on={telemetry.metrics_enabled} />
      </div>
      <p className="text-[11px] text-neutral-text-secondary mt-1.5">
        Per-signal switches are set via env (TRUEPPM_OTEL_TRACES_ENABLED / _METRICS_ENABLED) and can&apos;t be
        toggled here.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test export
// ---------------------------------------------------------------------------

// Full literal class strings per outcome — never build these dynamically, or
// Tailwind's JIT purges the color classes and the banner renders unstyled.
const OUTCOME_STYLE: Record<
  TelemetryTestResult['outcome'],
  { icon: 'check' | 'x'; title: string; text: string; border: string; bg: string }
> = {
  success: {
    icon: 'check',
    title: 'Collector accepted the canary span',
    text: 'text-semantic-on-track',
    border: 'border-semantic-on-track',
    bg: 'bg-semantic-on-track-bg',
  },
  reachable: {
    icon: 'check',
    title: 'Collector reachable — no span sent',
    text: 'text-semantic-at-risk',
    border: 'border-semantic-at-risk',
    bg: 'bg-semantic-at-risk-bg',
  },
  failure: {
    icon: 'x',
    title: 'Export could not reach the collector',
    text: 'text-semantic-critical',
    border: 'border-semantic-critical',
    bg: 'bg-semantic-critical-bg',
  },
};

function TestResult({ result }: { result: TelemetryTestResult }) {
  const style = OUTCOME_STYLE[result.outcome];
  // A failure is announced assertively (role="alert"); success/reachable stay polite.
  return (
    <div
      role={result.outcome === 'failure' ? 'alert' : 'status'}
      className={`mt-2.5 px-3 py-2.5 rounded-control border ${style.border} ${style.bg}`}
    >
      <div className="flex items-center gap-2">
        {style.icon === 'check' ? <CheckIcon className={style.text} /> : <XIcon className={style.text} />}
        <span className={`text-[13px] font-bold ${style.text}`}>{style.title}</span>
        <span className="text-[11px] text-neutral-text-secondary">· {result.duration_ms} ms</span>
      </div>
      <div className="text-[12px] text-neutral-text-secondary mt-1 leading-relaxed">{result.detail}</div>
    </div>
  );
}

function TestExport() {
  const mutation = useTelemetryTestExport();
  const pending = mutation.isPending;
  return (
    <div className="px-4 py-3.5 border-t border-neutral-border/55 bg-neutral-surface-raised">
      <div className="flex items-center gap-3 flex-wrap">
        {/* Shared Button primary recipe (sage-500 fill / navy-900 ink) — stays AA
            in both themes; a hand-rolled white-on-brand button fails dark-mode AA
            (the #2041 codemod regression). */}
        <Button
          variant="primary"
          size="lg"
          onClick={() => mutation.mutate()}
          disabled={pending}
          aria-busy={pending}
          className="font-semibold"
        >
          {pending ? <Spinner /> : <SendIcon />}
          {pending ? 'Sending canary span…' : 'Test export'}
        </Button>
        <span className="text-[12px] text-neutral-text-secondary flex-1 min-w-[180px] leading-snug">
          Sends one canary span and waits for the collector to ACK. Nothing is stored; the token is never sent
          to the browser.
        </span>
      </div>
      {mutation.data ? <TestResult result={mutation.data} /> : null}
      {mutation.isError && !mutation.data ? (
        <div role="alert" className="mt-2.5 px-3 py-2.5 rounded-control border border-semantic-critical bg-semantic-critical-bg">
          <div className="flex items-center gap-2">
            <XIcon className="text-semantic-critical" />
            <span className="text-[13px] font-bold text-semantic-critical">Could not run the test</span>
          </div>
          <div className="text-[12px] text-neutral-text-secondary mt-1">
            The request failed before it reached the collector. Check that you are still signed in as an admin.
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card header + status pill
// ---------------------------------------------------------------------------

type CardStatus = 'exporting' | 'off' | 'unconfigured';

function StatusPill({ status }: { status: CardStatus }) {
  if (status === 'exporting') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-chip text-[11px] font-semibold bg-semantic-on-track-bg text-semantic-on-track border border-semantic-on-track/40">
        <CheckIcon className="text-semantic-on-track" />
        Exporting
      </span>
    );
  }
  if (status === 'off') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold bg-semantic-at-risk-bg text-semantic-at-risk border border-semantic-at-risk/40">
        Export off
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-chip text-[11px] font-semibold bg-neutral-surface-sunken text-neutral-text-secondary border border-neutral-border">
      Not configured
    </span>
  );
}

function CardHeader({ status }: { status: CardStatus }) {
  return (
    <div className="px-4 py-3 border-b border-neutral-border/55">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h2 className="text-[13px] font-semibold text-neutral-text-primary">Telemetry</h2>
            <StatusPill status={status} />
          </div>
          <p className="text-[12px] text-neutral-text-secondary mt-1 leading-snug">
            OTLP trace &amp; metric export to your observability backend.
          </p>
          <div className="inline-flex items-center gap-1 mt-1.5 text-[11px] text-neutral-text-secondary">
            <LockIcon className="text-neutral-text-secondary" />
            {/* ADR-0223: config is env/Helm-only. Kept out of the visible copy —
                an operator can't resolve a bare ADR number. */}
            <span>Read-only — configured via environment / Helm</span>
          </div>
        </div>
        <a
          href={docsUrl('administration/observability')}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 inline-flex items-center h-8 px-3 rounded-control border border-neutral-border bg-neutral-surface-raised text-[12px] font-semibold text-neutral-text-primary hover:bg-neutral-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1"
        >
          Docs
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unconfigured — guided setup
// ---------------------------------------------------------------------------

function Segmented({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-9 px-3.5 rounded-control text-[12.5px] font-semibold border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-1 ${
        active
          ? 'border-brand-primary bg-brand-primary/10 text-brand-primary'
          : 'border-neutral-border bg-neutral-surface-raised text-neutral-text-secondary hover:bg-neutral-surface-sunken'
      }`}
    >
      {label}
    </button>
  );
}

function GuidedSetup() {
  const [backendId, setBackendId] = useState<string>(BACKENDS[0].id);
  const [format, setFormat] = useState<'env' | 'helm'>('env');
  const backend = BACKENDS.find((b) => b.id === backendId) ?? BACKENDS[0];
  const snippet = format === 'env' ? envSnippet(backend) : helmSnippet(backend);
  return (
    <div className="px-4 py-3">
      <div className="px-3.5 py-3 rounded-lg bg-neutral-surface-raised border border-neutral-border mb-4">
        <div className="text-[13px] font-bold text-neutral-text-primary">
          Export is off — no collector endpoint set
        </div>
        <p className="text-[12.5px] text-neutral-text-secondary mt-1 leading-relaxed">
          <span className="tppm-mono text-neutral-text-primary">OTEL_EXPORTER_OTLP_ENDPOINT</span> isn&apos;t
          present on this deployment, so TruePPM isn&apos;t emitting traces or metrics. Set the variables below in
          your
          environment or Helm values, restart the pods, then come back to verify.
        </p>
      </div>

      <div className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary mb-2">
        1 · Pick your backend
      </div>
      <div className="flex gap-2 flex-wrap mb-2">
        {BACKENDS.map((b) => (
          <Segmented
            key={b.id}
            active={backendId === b.id}
            label={b.label}
            onClick={() => setBackendId(b.id)}
          />
        ))}
      </div>
      <p className="text-[12px] text-neutral-text-secondary leading-relaxed mb-4">{backend.note}</p>

      <div className="flex items-center gap-2.5 mb-2 flex-wrap">
        <span className="text-[11px] uppercase tracking-wide font-semibold text-neutral-text-secondary">
          2 · Copy config
        </span>
        <div className="flex-1" />
        <div className="flex gap-1.5">
          <Segmented active={format === 'env'} label="Env vars" onClick={() => setFormat('env')} />
          <Segmented active={format === 'helm'} label="Helm values" onClick={() => setFormat('helm')} />
        </div>
      </div>
      <CodeBlock text={snippet} />

      <div className="mt-4 flex gap-3 items-start px-3.5 py-3 rounded-lg bg-semantic-at-risk-bg border border-neutral-border/55">
        <LockIcon className="text-semantic-at-risk mt-0.5 shrink-0" />
        <p className="text-[12.5px] text-neutral-text-primary leading-relaxed">
          <b>This screen can&apos;t edit OTel config.</b> The exporter is configured only through environment
          variables / Helm. Store any bearer token in a Kubernetes Secret — it is never shown here.
          Once the pods restart with the endpoint set, this card switches to a live export view with a{' '}
          <b>Test export</b> action.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

export function TelemetryCard({ telemetry }: { telemetry: SystemHealthTelemetry }) {
  const status: CardStatus = !telemetry.endpoint_configured
    ? 'unconfigured'
    : telemetry.enabled
      ? 'exporting'
      : 'off';

  return (
    <SettingsCard>
      <CardHeader status={status} />
      {status === 'unconfigured' ? (
        <GuidedSetup />
      ) : (
        <>
          {status === 'off' ? (
            <div className="px-4 py-3 bg-semantic-at-risk-bg border-b border-neutral-border/55">
              <div className="text-[13px] font-bold text-semantic-at-risk">
                Export switched off — this is a config choice, not a failure
              </div>
              <p className="text-[12.5px] text-neutral-text-primary mt-1 leading-relaxed">
                An endpoint is configured, but the exporter isn&apos;t running (
                <span className="tppm-mono">TRUEPPM_OTEL_ENABLED=false</span>). Set it to{' '}
                <span className="tppm-mono">true</span> and restart the pods to resume. Test export still probes
                reachability so you can confirm the collector is healthy first.
              </p>
            </div>
          ) : null}
          <ConfigSummary telemetry={telemetry} />
          <Signals telemetry={telemetry} />
          <TestExport />
        </>
      )}
    </SettingsCard>
  );
}
