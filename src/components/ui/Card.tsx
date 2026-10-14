import React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
}

export const Card: React.FC<CardProps> = ({ children, className = '', ...props }) => {
  return (
    <div
      className={`bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 sm:p-5 shadow-sm ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};
