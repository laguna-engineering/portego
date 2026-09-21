import type { ReactNode } from "react";
import logoMark from "./assets/logo-mark.png";

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
        {/* Decorative: the text beside it already names the button. */}
        <img src={logoMark} alt="" width="22" height="22" />
        <span>portego</span>
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
