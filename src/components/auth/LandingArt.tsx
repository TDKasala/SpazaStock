import React from 'react';

/** Small isometric box used in the landing header and footer. */
export const LandingMark: React.FC<{ className?: string }> = ({ className = 'w-9 h-9' }) => (
  <svg viewBox="0 0 36 36" className={className} aria-hidden>
    <rect width="36" height="36" rx="10" fill="#10b981" />
    <path d="M18 7 L28 12.5 V23.5 L18 29 L8 23.5 V12.5 Z" fill="#064e3b" />
    <path d="M18 7 L28 12.5 L18 18 L8 12.5 Z" fill="#6ee7b7" />
    <path d="M18 18 L28 12.5 V23.5 L18 29 Z" fill="#059669" />
    <path d="M8 12.5 V23.5 L18 29 V18 Z" fill="#34d399" />
  </svg>
);

export type FeatureArtKind = 'scan' | 'expiry' | 'stock' | 'offline' | 'team' | 'grow';

/** Small illustration sitting on the right of a feature card. */
export const FeatureGlyph: React.FC<{ kind: FeatureArtKind; className?: string }> = ({ kind, className = '' }) => (
  <svg viewBox="0 0 112 88" className={className} aria-hidden>
    {kind === 'scan' && (
      <>
        <rect x="28" y="16" width="56" height="60" rx="8" fill="#facc15" />
        <rect x="36" y="28" width="40" height="28" fill="#854d0e" />
        <path d="M34 14 H22 V26 M78 14 H90 V26 M34 78 H22 V66 M78 78 H90 V66" fill="none" stroke="#34d399" strokeWidth="3" />
        <rect x="22" y="44" width="68" height="2" fill="#f43f5e" />
      </>
    )}
    {kind === 'expiry' && (
      <>
        <rect x="22" y="18" width="56" height="52" rx="8" fill="#e4e4e7" />
        <rect x="22" y="18" width="56" height="16" rx="8" fill="#34d399" />
        <rect x="34" y="12" width="6" height="12" rx="2" fill="#a1a1aa" />
        <rect x="60" y="12" width="6" height="12" rx="2" fill="#a1a1aa" />
        <circle cx="78" cy="58" r="16" fill="#ef4444" />
        <path d="M78 50 V58" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        <circle cx="78" cy="64" r="1.6" fill="#fff" />
      </>
    )}
    {kind === 'stock' && (
      <>
        <rect x="18" y="36" width="36" height="28" rx="3" fill="#a16207" />
        <rect x="40" y="22" width="36" height="28" rx="3" fill="#ca8a04" />
        <rect x="28" y="48" width="40" height="26" rx="3" fill="#d97706" />
        <circle cx="82" cy="30" r="14" fill="#10b981" />
        <path d="M75 30 L80 35 L90 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      </>
    )}
    {kind === 'offline' && (
      <>
        <rect x="34" y="16" width="36" height="58" rx="6" fill="#18181b" stroke="#3f3f46" />
        <rect x="40" y="24" width="24" height="36" rx="2" fill="#022c22" />
        <circle cx="78" cy="28" r="16" fill="#10b981" />
        <path d="M72 28 a8 8 0 0 1 12 0 M74 32 a5 5 0 0 1 8 0" fill="none" stroke="#fff" strokeWidth="2" />
        <circle cx="78" cy="36" r="1.5" fill="#fff" />
      </>
    )}
    {kind === 'team' && (
      <>
        <circle cx="40" cy="28" r="12" fill="#44403c" />
        <path d="M22 70 Q22 46 40 46 Q58 46 58 70" fill="#166534" />
        <circle cx="72" cy="26" r="12" fill="#292524" />
        <path d="M54 72 Q54 44 72 44 Q90 44 90 72" fill="#15803d" />
        <rect x="36" y="52" width="16" height="10" rx="2" fill="#d6d3d1" />
        <rect x="68" y="50" width="16" height="10" rx="2" fill="#e7e5e4" />
      </>
    )}
    {kind === 'grow' && (
      <>
        <rect x="22" y="52" width="14" height="22" rx="2" fill="#34d399" />
        <rect x="42" y="38" width="14" height="36" rx="2" fill="#10b981" />
        <rect x="62" y="24" width="14" height="50" rx="2" fill="#059669" />
        <path d="M24 30 L48 20 L70 12" fill="none" stroke="#6ee7b7" strokeWidth="3" strokeLinecap="round" />
        <path d="M62 12 H76 V24" fill="none" stroke="#6ee7b7" strokeWidth="3" strokeLinecap="round" />
      </>
    )}
  </svg>
);
