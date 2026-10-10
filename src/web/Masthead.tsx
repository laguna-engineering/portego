import { type ReactNode, useEffect, useState } from "react";
import { Avatar } from "./Avatar.tsx";
import { appName } from "./branding.ts";
import { CloseIcon, MenuIcon } from "./Icons.tsx";
import { NotificationBell } from "./NotificationBell.tsx";
import type { ArtifactTarget } from "./router.ts";

export type MastheadProps = {
  email: string;
  /** The URL of the user's avatar, or null for their initial. */
  avatar: string | null;
  onHome: () => void;
  onProfile: () => void;
  /** Marks the account button as the current page. */
  onProfilePage?: boolean;
  /** Opens an artifact picked from the notifications, on the version or comment it is about. */
  onOpenArtifact: (id: string, target?: ArtifactTarget) => void;
  /** Sits between the wordmark and the account, for a page that has its own chrome. */
  children?: ReactNode;
  /** The page's rows in the phone menu, above the account. A row calls `close` to dismiss the menu. */
  menu?: (close: () => void) => ReactNode;
  /** A short message shown just below the masthead, e.g. a change someone else made. */
  notice?: { message: string; onSelect: () => void } | null;
};

export function Masthead({
  email,
  avatar,
  onHome,
  onProfile,
  onProfilePage = false,
  onOpenArtifact,
  children,
  menu,
  notice,
}: MastheadProps) {
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
        <img src="/branding/logo-mark.png" alt="" width="22" height="22" />
        <span className="wordmark-label" role="img" aria-label={appName()} />
      </button>
      {children}
      <NotificationBell onOpenArtifact={onOpenArtifact} />
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
            <button
              type="button"
              className="masthead-menu-account"
              aria-pressed={onProfilePage}
              onClick={() => {
                setMenuOpen(false);
                onProfile();
              }}
            >
              <Avatar email={email} src={avatar} size="1.5rem" />
              <span className="masthead-menu-account-label">Profile</span>
              <span className="masthead-menu-account-email">{email}</span>
            </button>
          </div>
        </>
      ) : null}
      <div className="masthead-end">
        <button
          type="button"
          className="icon-button icon-only avatar-button"
          aria-pressed={onProfilePage}
          onClick={onProfile}
        >
          <Avatar email={email} src={avatar} />
          <span>Profile</span>
        </button>
      </div>
      {notice ? (
        <div className="masthead-notice" role="status">
          <button type="button" onClick={notice.onSelect}>
            {notice.message}
          </button>
        </div>
      ) : null}
    </header>
  );
}
