import { useState, useEffect, useCallback } from 'react';
import {
  Zap,
  Activity,
  Thermometer,
  TrendingDown,
  Cloud,
  HardDrive,
  Hash,
  X,
} from 'lucide-react';
import { useAppStore } from '../../lib/store';
import { getBase } from '../../lib/api';
import type { SavingsData } from '../../types';

interface EnergyData {
  total_energy_j?: number;
  energy_per_token_j?: number;
  avg_power_w?: number;
  cpu_temp_c?: number | null;
  gpu_temp_c?: number | null;
  /** False when the machine has no power-measurement backend at all. */
  energy_available?: boolean;
  energy_vendor?: string | null;
}

interface TelemetryStats {
  total_requests?: number;
  total_tokens?: number;
}

const CLOUD_PRICING = [
  { name: 'GPT-5.3', input: 2.00, output: 10.00, primary: true },
  { name: 'Claude Opus 4.6', input: 5.00, output: 25.00, primary: false },
  { name: 'Gemini 3.1 Pro', input: 2.00, output: 12.00, primary: false },
];

export function SystemPanel() {
  const savings = useAppStore((s) => s.savings);
  const toggleSystemPanel = useAppStore((s) => s.toggleSystemPanel);
  const [energy, setEnergy] = useState<EnergyData | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryStats | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const base = getBase();
      // Savings is polled here as well as on send. The counters below read
      // from it, so relying only on the post-message refresh left the panel
      // frozen whenever that call was skipped or failed.
      const [energyRes, telRes, savRes] = await Promise.allSettled([
        fetch(`${base}/v1/telemetry/energy`).then((r) => (r.ok ? r.json() : null)),
        fetch(`${base}/v1/telemetry/stats`).then((r) => (r.ok ? r.json() : null)),
        fetch(`${base}/v1/savings`).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (energyRes.status === 'fulfilled' && energyRes.value) {
        setEnergy(energyRes.value as EnergyData);
      }
      if (telRes.status === 'fulfilled' && telRes.value) {
        setTelemetry(telRes.value as TelemetryStats);
      }
      if (savRes.status === 'fulfilled' && savRes.value) {
        useAppStore.getState().setSavings(savRes.value as SavingsData);
      }
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // NOTE: no "re-fetch when savings changes" effect here. fetchData now
  // writes savings itself, and setSavings stores a fresh object every poll,
  // so depending on `savings` would re-enter fetchData on every tick and
  // spin into a request loop.

  // Cost comparison must reflect ALL tokens generated this session. Basing
  // it on total_* (local only) pinned every provider at $0.0000 whenever
  // the session ran on a cloud model.
  const promptK =
    (savings?.session_prompt_tokens ?? savings?.total_prompt_tokens ?? 0) / 1000;
  const completionK =
    (savings?.session_completion_tokens ?? savings?.total_completion_tokens ?? 0) / 1000;

  // `savings.total_calls` is local-only and is 0 for a cloud-only session.
  // It is a real 0, so `??` never fell through to the telemetry fallback —
  // that is why the counters sat at zero while requests were succeeding.
  const requests = savings?.session_calls ?? telemetry?.total_requests ?? savings?.total_calls ?? 0;
  const outputTokens =
    savings?.session_completion_tokens ?? telemetry?.total_tokens ?? savings?.total_completion_tokens ?? 0;
  const cloudCalls = savings?.cloud_calls ?? 0;
  const localCalls = savings?.total_calls ?? 0;

  // Only an explicit `false` means "this machine cannot measure power".
  // A missing field means an older server, where 0.0 is the old behaviour.
  const energyUnavailable = energy?.energy_available === false;

  return (
    <div
      className="flex flex-col h-full overflow-y-auto"
      style={{
        width: 280,
        minWidth: 280,
        background: 'var(--color-bg)',
        borderLeft: '1px solid var(--color-border)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)' }}
      >
        <span className="text-xs font-semibold tracking-wide uppercase" style={{ color: 'var(--color-text-secondary)' }}>
          System
        </span>
        <button
          onClick={toggleSystemPanel}
          className="p-1 rounded-md transition-colors cursor-pointer"
          style={{ color: 'var(--color-text-tertiary)' }}
          title="Close panel"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {/* Session Stats */}
        <section>
          <h4 className="text-[11px] font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-tertiary)' }}>
            Session
          </h4>
          <div className="grid grid-cols-2 gap-2">
            <MiniStat icon={Hash} label="Requests" value={String(requests)} />
            <MiniStat icon={Hash} label="Output Tokens" value={formatNumber(outputTokens)} />
          </div>
          {cloudCalls > 0 && (
            <div className="text-[10px] mt-1.5 px-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
              {cloudCalls} cloud · {localCalls} local
            </div>
          )}
        </section>

        {/* Device */}
        <section>
          <h4 className="text-[11px] font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-tertiary)' }}>
            Device
          </h4>
          <div className="grid grid-cols-2 gap-2">
            {energy?.cpu_temp_c != null && (
              <MiniStat icon={Thermometer} label="CPU Temp" value={String(Math.round(energy.cpu_temp_c))} unit="°C" />
            )}
            {energy?.gpu_temp_c != null && (
              <MiniStat icon={Thermometer} label="GPU Temp" value={String(Math.round(energy.gpu_temp_c))} unit="°C" />
            )}
            <MiniStat
              icon={Zap}
              label="Power"
              value={energyUnavailable ? 'n/a' : (energy?.avg_power_w ?? 0).toFixed(1)}
              unit={energyUnavailable ? undefined : 'W'}
            />
            <MiniStat
              icon={Activity}
              label="Energy"
              value={energyUnavailable ? 'n/a' : ((energy?.total_energy_j ?? 0) / 1000).toFixed(1)}
              unit={energyUnavailable ? undefined : 'kJ'}
            />
          </div>
          {energyUnavailable && (
            <div className="text-[10px] mt-1.5 px-0.5 leading-snug" style={{ color: 'var(--color-text-tertiary)' }}>
              No power sensor on this device — needs an NVIDIA GPU, an Apple
              chip, or Linux RAPL.
            </div>
          )}
        </section>


        {/* Cost Comparison */}
        <section>
          <h4 className="text-[11px] font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-tertiary)' }}>
            Cost Comparison
          </h4>

          {/* Local */}
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-2 mb-2"
            style={{ background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent)' }}
          >
            <HardDrive size={14} style={{ color: 'var(--color-accent)' }} />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>Local</div>
            </div>
            <div className="text-sm font-semibold" style={{ color: 'var(--color-success)' }}>
              ${(savings?.local_cost ?? 0).toFixed(4)}
            </div>
          </div>

          {/* Cloud providers */}
          <div className="flex flex-col gap-1.5">
            {CLOUD_PRICING.map((provider) => {
              const cost = (promptK * provider.input) / 1000 + (completionK * provider.output) / 1000;
              const saved = cost - (savings?.local_cost ?? 0);
              return (
                <div
                  key={provider.name}
                  className="flex items-center gap-2 rounded-lg px-3 py-2"
                  style={{
                    background: provider.primary ? 'var(--color-bg-secondary)' : 'var(--color-bg-secondary)',
                    border: provider.primary ? '1px solid var(--color-border-accent, var(--color-accent))' : '1px solid transparent',
                  }}
                >
                  <Cloud size={14} style={{ color: 'var(--color-text-tertiary)' }} />
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-xs truncate"
                      style={{
                        color: provider.primary ? 'var(--color-text)' : 'var(--color-text-secondary)',
                        fontWeight: provider.primary ? 500 : 400,
                      }}
                    >
                      {provider.name}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-mono" style={{ color: 'var(--color-text)' }}>
                      ${cost.toFixed(4)}
                    </div>
                    {saved > 0.0001 && (
                      <div className="text-[9px] flex items-center gap-0.5 justify-end" style={{ color: 'var(--color-success)' }}>
                        <TrendingDown size={8} />
                        ${saved.toFixed(4)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>


        </section>

        {/* The "Share Your Savings" leaderboard section used to sit here.
            Removed with the Supabase upload — see lib/api.ts. */}
      </div>
    </div>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  unit,
}: {
  icon: typeof Zap;
  label: string;
  value: string;
  unit?: string;
}) {
  return (
    <div
      className="rounded-lg px-2.5 py-2"
      style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}
    >
      <div className="flex items-center gap-1 mb-0.5">
        <Icon size={10} style={{ color: 'var(--color-accent)' }} />
        <span className="text-[10px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {label}
        </span>
      </div>
      <div className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        {value}
        {unit && (
          <span className="text-[10px] font-normal ml-0.5" style={{ color: 'var(--color-text-tertiary)' }}>
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
