"use client";

import { useId, useState } from "react";

type Status = "idle" | "loading" | "success" | "error";

export function NewsletterSignup() {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState(""); // honeypot
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === "loading") return;

    setStatus("loading");
    setMessage("");

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, company }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };

      if (!res.ok) {
        setStatus("error");
        setMessage(data.error ?? "Something went wrong. Please try again.");
        return;
      }

      setStatus("success");
      setMessage("You're on the list. Check your inbox to confirm.");
      setEmail("");
    } catch {
      setStatus("error");
      setMessage("Couldn't reach the server. Please try again.");
    }
  };

  return (
    <section className="newsletter" aria-labelledby="newsletter-heading">
      <div className="newsletterCopy">
        <h2 className="newsletterTitle" id="newsletter-heading">
          Changelog, in your inbox
        </h2>
        <p className="newsletterSub">
          New connectors, replay tooling, and the occasional deep dive on running webhook
          infrastructure at scale. No more than once a month. Unsubscribe anytime.
        </p>
      </div>

      <form className="newsletterForm" noValidate onSubmit={submit}>
        <label className="srOnly" htmlFor={emailId}>
          Email address
        </label>
        <input
          autoComplete="email"
          className="newsletterInput"
          disabled={status === "loading"}
          id={emailId}
          inputMode="email"
          name="email"
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          required
          type="email"
          value={email}
        />

        {/* Honeypot — hidden from users and assistive tech, catnip for bots. */}
        <div aria-hidden="true" className="newsletterHoneypot">
          <label htmlFor="company">Company</label>
          <input
            autoComplete="off"
            id="company"
            name="company"
            onChange={(e) => setCompany(e.target.value)}
            tabIndex={-1}
            type="text"
            value={company}
          />
        </div>

        <button className="newsletterButton" disabled={status === "loading"} type="submit">
          {status === "loading" ? "Subscribing…" : "Subscribe"}
        </button>
      </form>

      <p
        aria-live="polite"
        className={`newsletterMessage${status === "error" ? " isError" : ""}${status === "success" ? " isSuccess" : ""}`}
      >
        {message}
      </p>
    </section>
  );
}
