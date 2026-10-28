import type { ReactNode } from 'react';

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const IconDashboard = () => (
  <Icon><rect x="3" y="3" width="7" height="9" rx="2" /><rect x="14" y="3" width="7" height="5" rx="2" /><rect x="14" y="12" width="7" height="9" rx="2" /><rect x="3" y="16" width="7" height="5" rx="2" /></Icon>
);
export const IconAlert = () => (<Icon><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></Icon>);
export const IconCheck = () => (<Icon><circle cx="12" cy="12" r="9" /><path d="M8 12.5l3 3 5-6" /></Icon>);
export const IconMail = () => (<Icon><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 8l9 6 9-6" /></Icon>);
export const IconList = () => (<Icon><path d="M4 6h16M4 12h10M4 18h6" /></Icon>);
export const IconSettings = () => (
  <Icon><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></Icon>
);
export const IconCard = () => (<Icon><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 10h18M7 15h4" /></Icon>);
export const IconBack = () => (<Icon size={16}><path d="M15 6l-6 6 6 6" /></Icon>);
export const IconLock = () => (<Icon size={16}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Icon>);

export function LogoMark({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M4 12a8 8 0 0 1 14-5.3L20 9" /><path d="M20 4v5h-5" /><path d="M20 12a8 8 0 0 1-14 5.3L4 15" /><path d="M4 20v-5h5" />
    </svg>
  );
}
