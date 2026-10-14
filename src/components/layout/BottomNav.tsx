import React from 'react';
import { LayoutGrid, Boxes, ShoppingCart, Bell } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';

export interface BottomNavProps {
  currentTab: string;
  onSelectTab: (tab: string) => void;
}

export const BottomNav: React.FC<BottomNavProps> = ({ currentTab, onSelectTab }) => {
  const { t } = useLanguage();

  const tabs = [
    { id: 'dashboard', label: t('navigation.dashboard'), icon: LayoutGrid },
    { id: 'stock', label: t('navigation.stock'), icon: Boxes },
    { id: 'sales', label: t('navigation.sales'), icon: ShoppingCart },
    { id: 'alerts', label: t('navigation.alerts'), icon: Bell },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-zinc-950/90 backdrop-blur-md border-t border-zinc-800/80 pb-[env(safe-area-inset-bottom,0px)]">
      <div className="max-w-md sm:max-w-xl mx-auto px-4 grid grid-cols-4 h-16 items-center">
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
              <span className={`text-[11px] font-medium leading-none ${isActive ? 'font-semibold' : ''}`}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
