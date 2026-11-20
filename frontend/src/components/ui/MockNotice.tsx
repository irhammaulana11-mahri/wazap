import React from 'react';
import { Info } from 'lucide-react';

interface MockNoticeProps {
  endpoint: string;
}

export const MockNotice: React.FC<MockNoticeProps> = ({ endpoint }) => {
  return (
    <div className="mb-4 flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-xs">
      <Info className="w-4 h-4 shrink-0 text-amber-600" />
      <div>
        <span className="font-semibold uppercase tracking-wider">Development Preview</span>: Data di halaman ini disimulasikan (Typed Mock) karena endpoint backend <code className="bg-amber-100/80 px-1.5 py-0.5 rounded font-mono text-amber-900">{endpoint}</code> belum tersedia di backend.
      </div>
    </div>
  );
};
