import React, { useEffect, useState, useRef } from "react";
import "./PnLCard.css";

/**
 * RacerBot PNL Card
 *
 * Self-contained, dependency-free React component (no Tailwind required —
 * styling lives in PnLCard.css). Drop both files into any React project.
 *
 * Usage:
 *   <PnLCard
 *     tokenSymbol="RCKT"
 *     pairSymbol="NEAR"
 *     side="long"
 *     entryPrice={0.000041}
 *     currentPrice={0.000397}
 *     entryMcap={41200}
 *     currentMcap={397800}
 *     positionSize={2400000}
 *     positionUnit="RCKT"
 *     profitAmount={2.84}
 *     profitUnit="NEAR"
 *     duration="4h 12m"
 *     handle="racerbot.near"
 *     date="Sep 25, 2026"
 *   />
 *
 * pnlPercent is derived from entryPrice/currentPrice automatically.
 * Pass pnlPercent directly instead if you already compute it upstream.
 */

export function formatPrice(value) {
  if (value === undefined || value === null || isNaN(value)) return "—";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value === 0) return "$0.00";
  // small decimals (typical for early-stage tokens): keep meaningful digits
  const abs = Math.abs(value);
  const precision = Math.min(8, Math.max(4, -Math.floor(Math.log10(abs)) + 2));
  return `$${value.toFixed(precision)}`;
}

export function formatCompact(value) {
  if (value === undefined || value === null || isNaN(value)) return "—";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

export function formatPosition(value, unit) {
  if (value === undefined || value === null || isNaN(value)) return "—";
  let out;
  if (value >= 1_000_000) out = `${(value / 1_000_000).toFixed(2)}M`;
  else if (value >= 1_000) out = `${(value / 1_000).toFixed(1)}K`;
  else out = `${Number(value).toFixed(2)}`;
  return `${out} ${unit || ""}`.trim();
}

export function BoltIcon({ className, gradient = true }) {
  return (
    <svg viewBox="0 0 40 40" className={className} xmlns="http://www.w3.org/2000/svg">
      {gradient && (
        <defs>
          <linearGradient id="racerbotBoltGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4ea8ff" />
            <stop offset="100%" stopColor="#9b6bff" />
          </linearGradient>
        </defs>
      )}
      <path
        d="M22 3 L10 22 H18 L16 37 L30 16 H21 L23 3 Z"
        fill={gradient ? "url(#racerbotBoltGrad)" : "currentColor"}
      />
    </svg>
  );
}

export default function PnLCard({
  botName = "RacerBot",
  tokenSymbol,
  pairSymbol = "NEAR",
  side = "long", // "long" | "short"
  entryPrice,
  currentPrice,
  pnlPercent, // optional override; derived from prices if omitted
  entryMcap,
  currentMcap,
  positionSize,
  positionUnit,
  profitAmount,
  profitUnit = "NEAR",
  duration,
  handle,
  date,
  isLive = false,
  className = "",
  style = {},
}) {
  const [flashClass, setFlashClass] = useState("");
  const prevPriceRef = useRef(currentPrice);

  useEffect(() => {
    if (prevPriceRef.current !== undefined && currentPrice !== undefined) {
      if (currentPrice > prevPriceRef.current) {
        setFlashClass("pnl-card__flash-up");
      } else if (currentPrice < prevPriceRef.current) {
        setFlashClass("pnl-card__flash-down");
      }
      const t = setTimeout(() => setFlashClass(""), 800);
      prevPriceRef.current = currentPrice;
      return () => clearTimeout(t);
    }
    prevPriceRef.current = currentPrice;
  }, [currentPrice]);

  const derivedPnl =
    pnlPercent !== undefined
      ? pnlPercent
      : entryPrice && currentPrice
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : 0;

  const isProfit = derivedPnl >= 0;
  const pnlLabel = `${isProfit ? "+" : ""}${Number(derivedPnl).toFixed(1)}%`;

  return (
    <div className={`pnl-card ${className}`.trim()} style={style}>
      <BoltIcon className="pnl-card__watermark" gradient={false} />

      <div className="pnl-card__row">
        <div className="pnl-card__brand">
          <BoltIcon className="pnl-card__brand-icon" />
          <span>{botName}</span>
          {isLive && (
            <div className="pnl-card__live-indicator" title="Live real-time feed">
              <span className="pnl-card__live-pulse" />
              LIVE
            </div>
          )}
        </div>
        {tokenSymbol && (
          <div className="pnl-card__pill">
            ${tokenSymbol} / {pairSymbol}
          </div>
        )}
      </div>

      <div className="pnl-card__hero">
        <div className="pnl-card__hero-top">
          {tokenSymbol && <span className="pnl-card__token">${tokenSymbol}</span>}
          <span className={`pnl-card__tag pnl-card__tag--${isProfit ? "profit" : "loss"}`}>
            <span className="pnl-card__dot" />
            {side === "long" ? "Long" : "Short"}
          </span>
        </div>

        <div className={`pnl-card__pnl pnl-card__pnl--${isProfit ? "profit" : "loss"}`}>
          {pnlLabel}
        </div>

        {profitAmount !== undefined && (
          <div className="pnl-card__sub">
            {profitAmount >= 0 ? "+" : ""}
            <b>
              {typeof profitAmount === "number" ? profitAmount.toFixed(4) : profitAmount} {profitUnit}
            </b>{" "}
            {isProfit ? "realized profit" : "realized loss"}
          </div>
        )}
      </div>

      <div className="pnl-card__divider">
        <i />
        <i />
        <i />
      </div>

      <div className="pnl-card__grid">
        <Field label="Entry price" value={formatPrice(entryPrice)} />
        <Field
          label="Current price"
          value={formatPrice(currentPrice)}
          className={flashClass}
        />
        <Field label="Entry cap" value={formatCompact(entryMcap)} />
        <Field
          label="Current cap"
          value={formatCompact(currentMcap)}
          className={flashClass}
        />
        <Field
          label="Position"
          value={formatPosition(positionSize, positionUnit ?? tokenSymbol)}
        />
        <Field label="Duration" value={duration ?? "—"} />
      </div>

      {(handle || date) && (
        <div className="pnl-card__footer">
          <span className="pnl-card__handle">{handle}</span>
          <span>{date}</span>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, className = "" }) {
  return (
    <div className="pnl-card__field">
      <label>{label}</label>
      <div className={className}>{value}</div>
    </div>
  );
}
