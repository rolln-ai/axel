"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CookiePreferencesButton } from "./CookiePreferencesButton";
import { Logo } from "./Logo";
import { NewsletterSignup } from "./NewsletterSignup";

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { href: "/#integrations", label: "Integrations" },
    { href: "/#pipeline", label: "Pipeline" },
    { href: "/#why", label: "Why Axel" },
    { href: "/pricing", label: "Pricing" },
    { href: "/docs", label: "Docs" },
    { href: "/security", label: "Security" },
    { href: "https://github.com/rolln-ai/axel", label: "GitHub" },
  ] as const;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 920) setMobileOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const closeMobile = () => setMobileOpen(false);

  return (
    <header className={`topbar${scrolled ? " scrolled" : ""}`}>
      <div className="container nav">
        <Link className="brand" href="/" aria-label="Axel home">
          <Logo size={24} />
          <span className="brandWord">Axel</span>
        </Link>

        <nav className="navLinks" aria-label="Primary">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="navRight">
          <button
            type="button"
            className="hamburger"
            aria-expanded={mobileOpen}
            aria-controls="mobile-menu"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            onClick={() => setMobileOpen((v) => !v)}
          >
            {mobileOpen ? "✕" : "☰"}
          </button>

          <div className="navCta">
            <a className="btn subtle" href="https://app.axelapp.ai/login">
              Sign in
            </a>
            <a className="btn" href="https://app.axelapp.ai/signup">
              Sign up free <span className="arrow">→</span>
            </a>
          </div>
        </div>
      </div>

      {mobileOpen && (
        <div id="mobile-menu" className="mobileMenu" role="dialog" aria-label="Mobile navigation">
          <nav aria-label="Primary mobile" className="mobileNavLinks">
            {navItems.map((item) => (
              <Link key={item.href} href={item.href} onClick={closeMobile}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer>
      <NewsletterSignup />
      <div className="container nav">
        <Link className="brand" href="/" aria-label="Axel home">
          <Logo size={24} />
          <span className="brandWord">Axel</span>
        </Link>
        <nav className="navLinks" aria-label="Footer">
          <Link href="/docs">Docs</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/security">Security</Link>
          <a href="https://github.com/rolln-ai/axel">GitHub</a>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/dpa">DPA</Link>
          <Link href="/legal">Legal</Link>
          <CookiePreferencesButton />
          <a href="mailto:founders@axelapp.ai">Contact</a>
        </nav>
        <span>© {new Date().getFullYear()} Axel</span>
      </div>
    </footer>
  );
}
