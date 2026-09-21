import type { ReactNode } from "react";

export type MastheadProps = {
  email: string;
  onHome: () => void;
  onSignOut: () => void;
  /** Sits between the wordmark and the account, for a page that has its own chrome. */
  children?: ReactNode;
  /** Sits just before the account block, e.g. a page's own toggle. */
  trailing?: ReactNode;
};

export function Masthead({ email, onHome, onSignOut, children, trailing }: MastheadProps) {
  return (
    <header className="masthead">
      <button type="button" className="wordmark" onClick={onHome}>
        portego
      </button>
      {children}
      <div className="masthead-end">
        {trailing}
        <div className="who">
          <span>{email}</span>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
