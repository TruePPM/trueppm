import { LogoMark } from '@/components/Icons';

export function Logo() {
  return (
    <span className="flex items-center gap-1.5 select-none" aria-label="TruePPM">
      <LogoMark className="text-brand-primary flex-shrink-0" aria-hidden="true" />
      <span className="text-sm font-semibold tracking-tight text-brand-primary">TruePPM</span>
    </span>
  );
}
