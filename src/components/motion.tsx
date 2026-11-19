"use client";
/**
 * Motion layer (GSAP): drifting aurora background, staggered reveals, count-up numbers and bar fills.
 * Everything is skipped when the viewer prefers reduced motion.
 */
import gsap from "gsap";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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

/**
 * Height-animated show/hide. Children stay mounted while closing so they can slide away,
 * then unmount. Overflow is clipped only during the animation (shadows and focus rings stay visible).
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [render, setRender] = useState(open);
  const first = useRef(true);
  useIso(() => {
    if (open) setRender(true);
  }, [open]);
  useIso(() => {
    const el = ref.current;
    if (first.current) {
      first.current = false;
      return;
    }
    if (!el) return;
    if (reducedMotion()) {
      if (!open) setRender(false);
      return;
    }
    const t = open
      ? gsap.fromTo(el, { height: 0, autoAlpha: 0, overflow: "hidden" }, { height: "auto", autoAlpha: 1, duration: 0.45, ease: "power3.out", clearProps: "height,overflow,visibility,opacity" })
      : gsap.to(el, { height: 0, autoAlpha: 0, overflow: "hidden", duration: 0.32, ease: "power2.in", onComplete: () => setRender(false) });
    return () => {
      t.kill();
    };
  }, [open, render]);
  if (!render) return null;
  return <div ref={ref}>{children}</div>;
}

/** Pops its content in (slight drop and scale) when it mounts or when `k` changes. */
export function Pop({ children, k, className }: { children: ReactNode; k?: string | number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useIso(() => {
    if (!ref.current || reducedMotion()) return;
    const t = gsap.fromTo(ref.current, { y: -8, scale: 0.985, autoAlpha: 0 }, { y: 0, scale: 1, autoAlpha: 1, duration: 0.45, ease: "back.out(1.6)", clearProps: "transform,opacity,visibility" });
    return () => {
      t.kill();
    };
  }, [k]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}

/** A gentle 3D tilt that follows the pointer (max ~5°), with a small lift. Mouse/pen only. */
export function useTilt<T extends HTMLElement>(max = 5) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || !window.matchMedia("(hover: hover)").matches) return;
    gsap.set(el, { transformPerspective: 700, transformStyle: "preserve-3d" });
    const rx = gsap.quickTo(el, "rotationX", { duration: 0.5, ease: "power3.out" });
    const ry = gsap.quickTo(el, "rotationY", { duration: 0.5, ease: "power3.out" });
    const lift = gsap.quickTo(el, "y", { duration: 0.4, ease: "power3.out" });
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ry(((e.clientX - r.left) / r.width - 0.5) * 2 * max);
      rx(-((e.clientY - r.top) / r.height - 0.5) * 2 * max);
    };
    const enter = () => lift(-3);
    const leave = () => {
      rx(0);
      ry(0);
      lift(0);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      gsap.set(el, { clearProps: "transform" });
    };
  }, [max]);
  return ref;
}

/** Re-animates the children matching `selector` (staggered rise) whenever `dep` changes, e.g. a filter. */
export function useStaggerOnChange<T extends HTMLElement = HTMLElement>(selector: string, dep: unknown) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useIso(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!ref.current || reducedMotion()) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(selector)).slice(0, 30);
    if (!items.length) return;
    const t = gsap.fromTo(items, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.4, ease: "power3.out", stagger: 0.03, clearProps: "transform,opacity,visibility" });
    return () => {
      t.kill();
    };
  }, [dep]);
  return ref;
}

/**
 * A highlight that glides to the active item of a group (filter pills, tabs).
 * Render <span className="glider" /> inside the container; the active item needs `activeSelector`.
 */
export function useGlider<T extends HTMLElement = HTMLDivElement>(activeSelector: string, dep: unknown) {
  const ref = useRef<T>(null);
  const last = useRef<{ box: T | null; dep: unknown }>({ box: null, dep: undefined });
  const observer = useRef<ResizeObserver | null>(null);
  // Runs after every render: the group may appear later (e.g. once data has loaded).
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const place = (animate: boolean) => {
      const glider = box.querySelector<HTMLElement>(":scope > .glider");
      const active = box.querySelector<HTMLElement>(activeSelector);
      if (!glider) return;
      if (!active) return void gsap.set(glider, { autoAlpha: 0 });
      const to = { x: active.offsetLeft, y: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight, autoAlpha: 1 };
      if (!animate || reducedMotion()) gsap.set(glider, to);
      else gsap.to(glider, { ...to, duration: 0.45, ease: "power3.out", overwrite: true });
    };
    if (last.current.box !== box) {
      // New (or first) group: place without animating and follow size changes.
      observer.current?.disconnect();
      observer.current = new ResizeObserver(() => place(false));
      observer.current.observe(box);
      place(false);
    } else if (last.current.dep !== dep) place(true);
    last.current = { box, dep };
  });
  useEffect(() => () => observer.current?.disconnect(), []);
  return ref;
}
