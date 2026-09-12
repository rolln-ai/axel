"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { COMMUNITY_SUPPORT_URL, SUPPORT_HREF } from "../../lib/contact";
import { Logo } from "./Logo";
import { SOURCE_URL, LICENSE_URL } from "../../lib/project";

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { href: "/#integrations", label: "Integrations" },
    { href: "/#open-source", label: "Open source" },
    { href: "/pricing", label: "Cloud pricing" },
    { href: "/docs", label: "Docs" },
    { href: SOURCE_URL, label: "GitHub" },
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
              Start on Cloud <span className="arrow">→</span>
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
      <section className="projectUpdates container" aria-labelledby="project-updates-heading">
        <div>
          <h2 id="project-updates-heading">Follow the project on GitHub.</h2>
          <p>Read the code, ask a question, or contribute a fix.</p>
        </div>
        <div className="projectLinks">
          <a href={`${SOURCE_URL}/commits/main`}>Recent changes ↗</a>
          <a href={COMMUNITY_SUPPORT_URL}>Discussions ↗</a>
          <a href={`${SOURCE_URL}/blob/main/CONTRIBUTING.md`}>Contribute ↗</a>
        </div>
      </section>
      <div className="container nav">
        <Link className="brand" href="/" aria-label="Axel home">
          <Logo size={24} />
          <span className="brandWord">Axel</span>
        </Link>
        <nav className="footerLinks" aria-label="Footer">
          <Link href="/docs">Docs</Link>
          <Link href="/docs#self-hosting">Self-hosting</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/security">Security</Link>
          <a href={SOURCE_URL}>GitHub</a>
          <a href={LICENSE_URL}>Apache-2.0</a>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/dpa">DPA</Link>
          <Link href="/legal">Legal</Link>
          <a href={SUPPORT_HREF ?? COMMUNITY_SUPPORT_URL}>
            {SUPPORT_HREF ? "Contact" : "Discussions"}
          </a>
        </nav>
        <span>© {new Date().getFullYear()} Axel</span>
      </div>
    </footer>
  );
}
