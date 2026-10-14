// Shared UI primitives: springs, a segmented control, toasts, formatting.
// No framework, no build step.
(() => {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  // Parameterised the way Apple does it: damping ratio + response (seconds).
  // State is position + velocity, so re-targeting mid-flight continues from the
  // live value with its velocity intact: interruptible by construction.
  class Spring {
    constructor(value = 0, { damping = 1, response = 0.35 } = {}) {
      this.x = this.target = value;
      this.v = 0;
      this.configure({ damping, response });
    }
    configure({ damping = 1, response = 0.35 }) {
      this.k = (2 * Math.PI / response) ** 2;
      this.c = (4 * Math.PI * damping) / response;
    }
    step(dt) {
      const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n; // fixed substeps keep it stable
      for (let i = 0; i < n; i++) {
        this.v += (-this.k * (this.x - this.target) - this.c * this.v) * h;
        this.x += this.v * h;
      }
      const eps = Math.max(0.01, Math.abs(this.target) * 1e-4);
      if (Math.abs(this.v) < eps && Math.abs(this.x - this.target) < eps) { this.x = this.target; this.v = 0; }
      return this.x;
    }
    jump(value) { this.x = this.target = value; this.v = 0; }
    get settled() { return this.v === 0 && this.x === this.target; }
  }

  // Drive one or more springs until they all settle. Returns a stop function.
  // Calling animate() again on the same key cancels the previous loop but keeps
  // the springs' live values, which is what makes interruption seamless.
  const loops = new Map();
  function animate(key, springs, render, done) {
    cancelAnimationFrame(loops.get(key));
    if (reducedMotion.matches) {
      springs.forEach((s) => s.jump(s.target));
      render(); done?.(); loops.delete(key); return () => {};
    }
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.064, (now - last) / 1000); last = now;
      springs.forEach((s) => s.step(dt));
      render();
      if (springs.every((s) => s.settled)) { loops.delete(key); done?.(); }
      else loops.set(key, requestAnimationFrame(tick));
    };
    loops.set(key, requestAnimationFrame(tick));
    return () => { cancelAnimationFrame(loops.get(key)); loops.delete(key); };
  }

  // Apple's momentum projection: where a flick would come to rest.
  const project = (velocity, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);

  // Progressive resistance past a boundary.
  const rubberband = (overshoot, dimension, c = 0.55) =>
    (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));

  // ---------- Segmented control ----------
  function segmented(root, onChange) {
    const thumb = root.querySelector(".thumb");
    const buttons = [...root.querySelectorAll("button")];
    const x = new Spring(0), w = new Spring(0); // independent springs per dimension
    const render = () => { thumb.style.transform = `translateX(${x.x}px)`; thumb.style.width = `${w.x}px`; };
    const place = (btn, animated) => {
      x.target = btn.offsetLeft; w.target = btn.offsetWidth;
      if (!animated) { x.jump(x.target); w.jump(w.target); render(); return; }
      animate(root, [x, w], render);
    };
    const select = (btn, { focus = false, silent = false } = {}) => {
      buttons.forEach((b) => { const on = b === btn; b.setAttribute("aria-checked", on); b.tabIndex = on ? 0 : -1; });
      if (focus) btn.focus();
      place(btn, true);
      if (!silent) onChange(btn.dataset.value);
    };
    buttons.forEach((b) => b.addEventListener("click", () => select(b)));
    root.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      const i = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true");
      select(buttons[(i + d + buttons.length) % buttons.length], { focus: true });
    });
    const current = () => buttons.find((b) => b.getAttribute("aria-checked") === "true");
    addEventListener("resize", () => place(current(), false));
    requestAnimationFrame(() => place(current(), false));
  }

  // ---------- Toast ----------
  // Rises from the bottom edge and leaves the same way. Resolves "action" if the
  // button was pressed, "timeout" otherwise.
  function toast(message, { action, duration = 5000 } = {}) {
    let host = document.querySelector(".toast-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "toast-host";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    host.querySelector(".toast")?.dispatchEvent(new Event("dismiss"));
    const el = document.createElement("div");
    el.className = "toast";
    const text = document.createElement("span");
    text.textContent = message;
    el.appendChild(text);
    const y = new Spring(80, { damping: 1, response: 0.35 });
    const render = () => {
      el.style.transform = `translateY(${y.x}px)`;
      el.style.opacity = String(Math.max(0, 1 - y.x / 80));
    };
    render();
    host.appendChild(el);
    y.target = 0;
    animate(el, [y], render);

    return new Promise((resolve) => {
      let settled = false;
      const close = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        y.target = 80;
        animate(el, [y], render, () => el.remove());
        resolve(result);
      };
      if (action) {
        const btn = document.createElement("button");
        btn.textContent = action;
        btn.addEventListener("click", () => close("action"));
        el.appendChild(btn);
      }
      el.addEventListener("dismiss", () => close("timeout"));
      const timer = setTimeout(() => close("timeout"), duration);
    });
  }

  // ---------- Nav scroll-edge effect ----------
  function stickyNav() {
    const nav = document.querySelector(".nav"), sentinel = document.querySelector(".sentinel");
    if (!nav || !sentinel) return;
    new IntersectionObserver(([e]) => nav.classList.toggle("stuck", !e.isIntersecting)).observe(sentinel);
  }

  // ---------- Formatting ----------
  const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
  const full = new Intl.NumberFormat();
  const fmt = (n) => (n < 10_000 ? full.format(n) : compact.format(n));
  const host = (url) => { try { return new URL(url).host; } catch { return url; } };
  function ago(seconds) {
    if (seconds == null) return "never";
    if (seconds < 2) return "just now";
    if (seconds < 60) return `${Math.round(seconds)}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${Math.round(seconds / 3600)}h ago`;
  }

  window.UI = { Spring, animate, project, rubberband, segmented, toast, stickyNav, fmt, host, ago, reducedMotion };
})();
