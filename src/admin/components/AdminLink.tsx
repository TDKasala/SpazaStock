import React from 'react';
import { navigateAdmin } from '../router';

type AdminLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/** A real link (so it can be opened in a new tab) that navigates in place on a plain click. */
export const AdminLink: React.FC<AdminLinkProps> = ({ href, onClick, children, ...props }) => (
  <a
    href={href}
    onClick={(e) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigateAdmin(href);
    }}
    {...props}
  >
    {children}
  </a>
);
