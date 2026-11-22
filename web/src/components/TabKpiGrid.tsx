import React from 'react';
import { LucideIcon } from 'lucide-react';
import { InlineSparkline } from './DiagnosticsCharts.js';

export interface TabKpiItem {
  id: string;
  label: string;
  value: string | number;
  subtext: string;
  icon: LucideIcon;
  badge?: string;
  badgeType?: 'online' | 'info' | 'warning' | 'danger' | 'neutral';
  color?: string;
  sparkline?: number[];
  sparklineMin?: number;
  sparklineMax?: number;
  /** Makes the card a button, e.g. to apply the filter the KPI counts. */
  onClick?: () => void;
}

interface TabKpiGridProps {
  items: TabKpiItem[];
  columns?: number;
  className?: string;
}

export const TabKpiGrid: React.FC<TabKpiGridProps> = ({ items, columns = 4, className = '' }) => {
  const getBadgeClass = (type?: string) => {
    switch (type) {
      case 'online':
        return 'badge-online';
      case 'info':
        return 'badge-info';
      case 'warning':
        return 'badge-warning';
      case 'danger':
        return 'badge-danger';
      default:
        return 'badge-neutral';
    }
  };

  return (
    <div
      data-testid="tab-kpi-grid"
      className={`kpi-grid ${className}`}
      style={{ '--kpi-columns': columns } as React.CSSProperties}
    >
      {items.map((item) => {
        const Icon = item.icon;
        const accentColor = item.color || 'var(--emerald-accent)';

        return (
          <div
            key={item.id}
            data-testid={`kpi-card-${item.id}`}
            className="kpi-card"
            {...(item.onClick ? { role: 'button', tabIndex: 0, onClick: item.onClick, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.onClick!(); } } } : {})}
            style={{
              cursor: item.onClick ? 'pointer' : undefined,
              backgroundColor: 'var(--bg-panel)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              gap: '8px',
              transition: 'border-color 0.15s ease, transform 0.15s ease',
            }}
          >
            {/* Header: Icon, Label, Badge */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '26px',
                    height: '26px',
                    borderRadius: '6px',
                    backgroundColor: 'var(--bg-card)',
                    color: accentColor,
                  }}
                >
                  <Icon size={14} />
                </span>
                <span className="text-xs font-semibold text-main">{item.label}</span>
              </div>
              {item.badge && (
                <span className={`badge ${getBadgeClass(item.badgeType)} text-[10px] font-mono`}>
                  {item.badge}
                </span>
              )}
            </div>

            {/* Middle: Value & Sparkline Graph */}
            <div className="flex items-baseline justify-between gap-2 pt-1">
              <div className={`font-mono text-xl font-bold text-main tracking-tight kpi-value${
                item.value === 'Unavailable' || item.value === '—' || item.value === 'None yet' || item.value === 'Not started'
                  ? ' kpi-value-muted'
                  : ''
              }`}>
                {item.value}
              </div>

              {item.sparkline && item.sparkline.length > 0 && (
                <div style={{ flexShrink: 0 }}>
                  <InlineSparkline
                    values={item.sparkline}
                    color={accentColor}
                    fillColor={`color-mix(in srgb, ${accentColor} 14%, transparent)`}
                    width={75}
                    height={22}
                    min={item.sparklineMin}
                    max={item.sparklineMax}
                  />
                </div>
              )}
            </div>

            {/* Footer: Subtext Details */}
            <div className="text-[11px] font-mono text-dim truncate border-t border-subtle pt-1.5" title={item.subtext}>
              {item.subtext}
            </div>
          </div>
        );
      })}
    </div>
  );
};
