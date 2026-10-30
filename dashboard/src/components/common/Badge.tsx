import React from 'react'

export type BadgeVariant = 'cyan' | 'teal' | 'blue' | 'violet' | 'amber' | 'emerald' | 'rose'

interface BadgeProps {
  children: React.ReactNode
  variant?: BadgeVariant
  icon?: React.ReactNode
  className?: string
  title?: string
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'cyan',
  icon,
  className = '',
  title
}) => {
  return (
    <span className={`badge badge-${variant} ${className}`} title={title}>
      {icon}
      {children}
    </span>
  )
}

