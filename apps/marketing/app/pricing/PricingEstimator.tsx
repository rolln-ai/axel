"use client";

import { useMemo, useState, type CSSProperties } from "react";

const MONTHLY_CREDIT_DOLLARS = 20;
const RATE_PER_THOUSAND_EVENTS = 0.015;

const receivedOptions = [
  10_000,
  100_000,
  500_000,
  1_000_000,
  5_000_000,
  10_000_000,
  25_000_000,
  50_000_000,
];

const formatCount = (value: number) => {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(0))}k`;
  return String(value);
};

const formatMoney = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 100 ? 2 : 0,
  }).format(value);

export function PricingEstimator() {
  const [receivedIndex, setReceivedIndex] = useState(1);

  const estimate = useMemo(() => {
    const receivedEvents = receivedOptions[receivedIndex]!;
    const usageCost = (receivedEvents / 1000) * RATE_PER_THOUSAND_EVENTS;
    const invoice = Math.max(MONTHLY_CREDIT_DOLLARS, usageCost);
    const creditApplied = Math.min(MONTHLY_CREDIT_DOLLARS, usageCost);
    const overCredit = Math.max(0, usageCost - MONTHLY_CREDIT_DOLLARS);

    return {
      receivedEvents,
      usageCost,
      invoice,
      creditApplied,
      overCredit,
    };
  }, [receivedIndex]);

  return (
    <section className="feature pricingEstimatorSection" aria-labelledby="pricing-estimator-title">
      <div className="container">
        <div className="estimatorShell">
          <div className="estimatorCopy">
            <span className="kicker">Estimate usage</span>
            <h2 id="pricing-estimator-title">Your $20 plan is applied as monthly usage credit.</h2>
            <p className="lede">
              Only accepted inbound events are metered. Destination pushes and retries are included,
              so fan-out and broken endpoints do not multiply the bill.
            </p>
          </div>

          <div className="estimatorPanel">
            <label className="sliderGroup">
              <span className="sliderLabel">
                <span>Events received / month</span>
                <strong>{formatCount(estimate.receivedEvents)}</strong>
              </span>
              <input
                type="range"
                min="0"
                max={receivedOptions.length - 1}
                step="1"
                value={receivedIndex}
                style={{ "--fill": `${(receivedIndex / (receivedOptions.length - 1)) * 100}%` } as CSSProperties}
                onChange={(event) => setReceivedIndex(Number(event.currentTarget.value))}
                onInput={(event) => setReceivedIndex(Number(event.currentTarget.value))}
              />
            </label>

            <div className="estimateGrid" aria-label="Estimated monthly usage">
              <div>
                <span>Inbound events</span>
                <strong>{formatCount(estimate.receivedEvents)}</strong>
              </div>
              <div>
                <span>Rate / million</span>
                <strong>$15</strong>
              </div>
              <div>
                <span>Usage value</span>
                <strong>{formatMoney(estimate.usageCost)}</strong>
              </div>
            </div>

            <div className="invoiceBox">
              <div>
                <span>Monthly invoice</span>
                <strong>{formatMoney(estimate.invoice)}</strong>
              </div>
              <p>
                {formatMoney(estimate.creditApplied)} credit applied
                {estimate.overCredit > 0 ? `, ${formatMoney(estimate.overCredit)} usage above credit` : ", no usage above credit"}.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
