import React from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'

export interface ToastMessage {
  id: string
  type: 'success' | 'error' | 'info'
  text: string
}

interface ToastProps {
  toasts: ToastMessage[]
  onDismiss: (id: string) => void
}

export const ToastContainer: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null

  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.type}`}>
          {toast.type === 'success' && <CheckCircle2 size={16} color="var(--accent-emerald)" />}
          {toast.type === 'error' && <AlertCircle size={16} color="var(--accent-rose)" />}
          {toast.type === 'info' && <Info size={16} color="var(--accent-cyan)" />}
          <span style={{ flex: 1 }}>{toast.text}</span>
          <button
            onClick={() => onDismiss(toast.id)}
            style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
            aria-label="Dismiss toast"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

