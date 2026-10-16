import React from 'react';

export interface ActionTileProps {
  id: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  accentColor?: 'default' | 'orange' | 'emerald';
  badge?: string | number;
}

export const ActionTile: React.FC<ActionTileProps> = ({
  title,
  icon,
  onClick,
  accentColor = 'default',
  badge,
}) => {
  const accentClasses = {
    default: 'text-zinc-100 hover:text-white',
    orange: 'text-amber-500 hover:text-amber-400',
    emerald: 'text-emerald-400 hover:text-emerald-300',
  };

  return (
    <button
      onClick={onClick}
      className="relative flex flex-col items-center justify-center p-3 h-24 bg-zinc-950/80 hover:bg-zinc-900 active:bg-black rounded-2xl border border-zinc-800 hover:border-zinc-700 transition-all duration-150 active:scale-[0.97] group shadow-lg text-center cursor-pointer select-none"
    >
      {badge !== undefined && (
        <span className="absolute top-3 right-3 bg-amber-500 text-zinc-950 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
          {badge}
        </span>
      )}

      {/* Icon Area */}
      <div className={`mb-1.5 transition-transform duration-150 group-hover:scale-105 ${accentClasses[accentColor]}`}>
        {icon}
      </div>

      {/* Title */}
      <span className="text-sm font-semibold text-zinc-100 tracking-tight leading-tight line-clamp-2 px-1">
        {title}
      </span>
    </button>
  );
};
