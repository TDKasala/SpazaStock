import React from 'react';
import { LayoutGrid, Boxes, ShoppingCart, Bell, ClipboardList, Ellipsis } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import type { AppTab } from '../../App';

export interface BottomNavProps {
  currentTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({ currentTab, onSelectTab }) => {
  const { t } = useLanguage();

  const tabs: Array<{ id: AppTab; label: string; icon: typeof LayoutGrid }> = [
    { id: 'dashboard', label: t('navigation.dashboard'), icon: LayoutGrid },
    { id: 'stock', label: t('navigation.stock'), icon: Boxes },
    { id: 'sales', label: t('navigation.sales'), icon: ShoppingCart },
    { id: 'alerts', label: t('navigation.alerts'), icon: Bell },
    { id: 'list', label: t('wholesale.open'), icon: ClipboardList },
    { id: 'more', label: t('navigation.more'), icon: Ellipsis },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-zinc-950/90 backdrop-blur-md border-t border-zinc-800/80 pb-[env(safe-area-inset-bottom,0px)]">
      <div className="max-w-md sm:max-w-xl mx-auto px-2 grid grid-cols-6 h-16 items-center">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onSelectTab(tab.id)}
              className={`flex flex-col items-center justify-center h-full py-1 gap-1 transition-colors select-none ${
                isActive ? 'text-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Icon className={`w-5 h-5 transition-transform ${isActive ? 'scale-110' : ''}`} />
              <span className={`max-w-full px-0.5 text-center text-[10px] font-medium leading-tight line-clamp-2 ${isActive ? 'font-semibold' : ''}`}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
