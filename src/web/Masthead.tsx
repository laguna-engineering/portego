import { type ReactNode, useEffect, useState } from "react";
import logoMark from "./assets/logo-mark.png";
import { CloseIcon, MenuIcon } from "./Icons.tsx";

export type MastheadProps = {
  email: string;
  onHome: () => void;
  onSignOut: () => void;
  /** Sits between the wordmark and the account, for a page that has its own chrome. */
  children?: ReactNode;
  /** Sits just before the account block, e.g. a page's own toggle. */
  trailing?: ReactNode;
  /** The page's rows in the phone menu, above the account. A row calls `close` to dismiss the menu. */
  menu?: (close: () => void) => ReactNode;
};

export function Masthead({ email, onHome, onSignOut, children, trailing, menu }: MastheadProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <header className="masthead">
      <button type="button" className="wordmark" onClick={onHome}>
        {/* Decorative: the text beside it already names the button. */}
        <img src={logoMark} alt="" width="22" height="22" />
        <span>portego</span>
      </button>
      {children}
      {/* A phone has no room for the account or a page's controls, so there they are a menu. */}
      <button
        type="button"
        className="icon-button menu-toggle"
        aria-label={menuOpen ? "Close menu" : "Menu"}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {menuOpen ? <CloseIcon /> : <MenuIcon />}
      </button>
      {menuOpen ? (
        <>
          {/* Taps on an artifact's frame never reach this document, so an element has to catch them. */}
          <button
            type="button"
            className="masthead-menu-backdrop"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setMenuOpen(false)}
          />
          <div className="masthead-menu">
            {menu?.(() => setMenuOpen(false))}
            <div className="masthead-menu-account">
              <span>{email}</span>
              <button type="button" onClick={onSignOut}>
                Sign out
              </button>
            </div>
          </div>
        </>
      ) : null}
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
