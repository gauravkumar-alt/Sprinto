"use client";
/**
 * Motion layer (GSAP): drifting aurora background, staggered reveals, count-up numbers and bar fills.
 * Everything is skipped when the viewer prefers reduced motion.
 */
import gsap from "gsap";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;
export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Soft blurred colour blobs behind the glass panels, slowly drifting. */
export function Aurora() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || reducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>(".blob").forEach((b, i) => {
        gsap.to(b, {
          x: () => gsap.utils.random(-120, 120),
          y: () => gsap.utils.random(-80, 80),
          scale: () => gsap.utils.random(0.85, 1.2),
          duration: 14 + i * 3,
          ease: "sine.inOut",
          repeat: -1,
          yoyo: true,
          repeatRefresh: true,
        });
      });
    }, ref);
    return () => ctx.revert();
  }, []);
  return (
    <div className="aurora" ref={ref} aria-hidden>
      <span className="blob b1" />
      <span className="blob b2" />
      <span className="blob b3" />
      <span className="blob b4" />
    </div>
  );
}

/** Fade-and-rise children marked with [data-reveal] once, when `ready` first becomes true. */
export function Reveal({ ready, children, className }: { ready: boolean; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  useIso(() => {
    if (!ready || done.current || !ref.current) return;
    done.current = true;
    if (reducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.from("[data-reveal]", { y: 12, autoAlpha: 0, duration: 0.45, ease: "power3.out", stagger: 0.035, clearProps: "transform,opacity,visibility" });
    }, ref);
    return () => ctx.revert();
  }, [ready]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** A number that counts up to its value (and animates between later values). */
export function CountUp({ value }: { value: number | undefined }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || value === undefined) return;
    if (reducedMotion()) {
      el.textContent = String(value);
      last.current = value;
      return;
    }
    const o = { n: last.current };
    const tween = gsap.to(o, { n: value, duration: 0.9, ease: "power2.out", onUpdate: () => (el.textContent = String(Math.round(o.n))) });
    last.current = value;
    return () => {
      tween.kill();
    };
  }, [value]);
  return <span ref={ref}>{value === undefined ? "–" : 0}</span>;
}

/** A bar fill whose width animates from 0 (or its previous width) to `pct`. */
export function Fill({ pct, className }: { pct: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const w = `${Math.max(0, Math.min(100, pct))}%`;
    if (reducedMotion()) {
      ref.current.style.width = w;
      return;
    }
    const t = gsap.to(ref.current, { width: w, duration: 1, ease: "power3.out" });
    return () => {
      t.kill();
    };
  }, [pct]);
  return <div ref={ref} className={className ?? "fill"} style={{ width: 0 }} />;
}

/** Smoothly scroll an element into view and give it a brief highlight. */
export function focusSection(el: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  if (!reducedMotion()) gsap.fromTo(el, { boxShadow: "0 0 0 0 rgba(99,102,241,0.0)" }, { boxShadow: "0 0 0 4px rgba(99,102,241,0.25)", duration: 0.35, yoyo: true, repeat: 1, ease: "power1.out", delay: 0.25, clearProps: "boxShadow" });
}
