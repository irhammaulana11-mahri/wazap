import React from 'react';
import { Loader2 } from 'lucide-react';

interface LoadingStateProps {
  message?: string;
  className?: string;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  message = 'Memuat data...',
  className = 'py-12',
}) => {
  return (
    <div className={`flex flex-col items-center justify-center text-slate-500 ${className}`}>
      <Loader2 className="w-8 h-8 animate-spin text-emerald-600 mb-2" />
      <p className="text-sm">{message}</p>
    </div>
  );
};
