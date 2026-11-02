import React from 'react'

interface KpiCardProps {
  title: string
  value: string | number
  subtitle: string
  unit?: string
  trend?: {
    value: string
    isPositive: boolean
  }
  icon?: React.ReactNode
  demoBadge?: boolean
}

export const KpiCard: React.FC<KpiCardProps> = ({
  title,
  value,
  subtitle,
  unit,
  trend,
  icon,
  demoBadge = true
}) => {
  return (
    <div className="kpi-card">
      <div className="kpi-top">
        <span className="kpi-title">{title}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {demoBadge && (
            <span style={{ fontSize: '9px', fontWeight: 600, color: 'var(--accent-amber)', padding: '1px 5px', borderRadius: '4px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
              DEMO
            </span>
          )}
          {icon && <div className="kpi-icon-pill">{icon}</div>}
        </div>
      </div>

      <div className="kpi-val-row">
        <span className="kpi-value">{value}</span>
        {unit && <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{unit}</span>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
        <span className="kpi-subtitle">{subtitle}</span>
        {trend && (
          <span className={`kpi-trend ${trend.isPositive ? 'positive' : 'neutral'}`}>
            {trend.value}
          </span>
        )}
      </div>
    </div>
  )
}

