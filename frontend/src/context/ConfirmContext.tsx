import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { AlertTriangle, HelpCircle, Info, X } from 'lucide-react';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'primary';
}

interface ConfirmContextType {
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextType | undefined>(undefined);

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    options: ConfirmOptions;
  }>({
    isOpen: false,
    options: { message: '' },
  });

  const resolverRef = useRef<((value: boolean) => void) | null>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const modalBoxRef = useRef<HTMLDivElement>(null);

  const confirm = useCallback((options: ConfirmOptions | string): Promise<boolean> => {
    triggerElementRef.current = document.activeElement as HTMLElement | null;
    const resolvedOptions: ConfirmOptions =
      typeof options === 'string'
        ? { message: options }
        : options;

    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setModalState({
        isOpen: true,
        options: resolvedOptions,
      });
    });
  }, []);

  const handleResolve = (val: boolean) => {
    if (resolverRef.current) {
      resolverRef.current(val);
      resolverRef.current = null;
    }
    setModalState((prev) => ({ ...prev, isOpen: false }));
    if (triggerElementRef.current) {
      triggerElementRef.current.focus();
    }
  };

  // Keyboard navigation & focus trap
  useEffect(() => {
    if (!modalState.isOpen) return;

    // Auto-focus confirm button
    const timer = setTimeout(() => {
      confirmBtnRef.current?.focus();
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleResolve(false);
        return;
      }

      if (e.key === 'Tab') {
        const focusable = modalBoxRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable || focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            last.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === last) {
            first.focus();
            e.preventDefault();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [modalState.isOpen]);

  const { title, message, confirmLabel, cancelLabel, variant = 'danger' } = modalState.options;

  const defaultTitles = {
    danger: 'Konfirmasi Tindakan',
    warning: 'Peringatan',
    primary: 'Konfirmasi',
  };

  const currentTitle = title || defaultTitles[variant];

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}

      {modalState.isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-modal-title"
          aria-describedby="confirm-modal-description"
        >
          <div
            ref={modalBoxRef}
            className="bg-white rounded-3xl border border-slate-200/90 shadow-2xl max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-150 text-left"
          >
            {/* Header */}
            <div className="p-6 pb-4 flex items-start gap-3.5">
              <div
                className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border ${
                  variant === 'danger'
                    ? 'bg-rose-50 text-rose-600 border-rose-200'
                    : variant === 'warning'
                    ? 'bg-amber-50 text-amber-600 border-amber-200'
                    : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                }`}
              >
                {variant === 'danger' ? (
                  <AlertTriangle className="w-5 h-5" />
                ) : variant === 'warning' ? (
                  <AlertTriangle className="w-5 h-5" />
                ) : (
                  <HelpCircle className="w-5 h-5" />
                )}
              </div>

              <div className="min-w-0 flex-1 pt-0.5">
                <h3 id="confirm-modal-title" className="text-base font-bold text-slate-900">
                  {currentTitle}
                </h3>
                <p id="confirm-modal-description" className="mt-1.5 text-xs sm:text-sm text-slate-600 leading-relaxed">
                  {message}
                </p>
              </div>

              <button
                type="button"
                onClick={() => handleResolve(false)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition"
                aria-label="Tutup dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Footer Actions */}
            <div className="p-4 px-6 bg-slate-50/80 border-t border-slate-100 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => handleResolve(false)}
                className="px-4 py-2.5 rounded-xl border border-slate-200 text-xs sm:text-sm font-semibold text-slate-700 hover:bg-white transition"
              >
                {cancelLabel || 'Batal'}
              </button>

              <button
                ref={confirmBtnRef}
                type="button"
                onClick={() => handleResolve(true)}
                className={`px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold text-white shadow-xs transition ${
                  variant === 'danger'
                    ? 'bg-rose-600 hover:bg-rose-700 focus:ring-2 focus:ring-rose-500 focus:ring-offset-2'
                    : variant === 'warning'
                    ? 'bg-amber-600 hover:bg-amber-700 focus:ring-2 focus:ring-amber-500 focus:ring-offset-2'
                    : 'bg-emerald-600 hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2'
                }`}
              >
                {confirmLabel || 'Konfirmasi'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
};

export const useConfirm = () => {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return context;
};
