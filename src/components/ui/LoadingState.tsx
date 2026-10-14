import React from 'react';
import { Loader2 } from 'lucide-react';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  label?: string;
}

export const Spinner: React.FC<SpinnerProps> = ({ size = 'md', className = '', label }) => {
  const sizeMap = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };

  return (
    <div className={`inline-flex items-center gap-2 text-emerald-500 ${className}`} role="status">
      <Loader2 className={`${sizeMap[size]} animate-spin shrink-0`} />
      {label && <span className="text-xs text-zinc-400 font-medium">{label}</span>}
      <span className="sr-only">Loading</span>
    </div>
  );
};

export interface SkeletonProps {
  className?: string;
}

export const Skeleton: React.FC<SkeletonProps> = ({ className = '' }) => {
  return (
    <div
      className={`animate-pulse bg-zinc-800/80 rounded-lg ${className}`}
      aria-hidden="true"
    />
  );
};

export interface LoadingStateProps {
  message?: string;
  className?: string;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  message = 'Loading...',
  className = '',
}) => {
  return (
    <div className={`flex flex-col items-center justify-center py-12 px-4 text-center ${className}`}>
      <Spinner size="lg" />
      <p className="mt-3 text-sm text-zinc-400 font-medium">{message}</p>
    </div>
  );
};
