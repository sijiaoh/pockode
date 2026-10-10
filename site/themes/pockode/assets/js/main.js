// The one script every page loads: the compact menu, the install box's
// Windows preselect, the Copy buttons and the homepage's demo video and
// reveals. Without it the site still works: the menu shows as a row, the
// commands can be selected by hand, the demo is its poster and every visual
// is simply in place.

const nav = document.querySelector(".site-nav");
const menuToggle = nav?.querySelector(".menu-toggle");

function setMenuOpen(open) {
  nav.classList.toggle("is-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
}

if (menuToggle) {
  menuToggle.addEventListener("click", () => {
    setMenuOpen(!nav.classList.contains("is-open"));
  });
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenuOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (nav.classList.contains("is-open") && !nav.contains(event.target)) {
      setMenuOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("is-open")) {
      setMenuOpen(false);
      menuToggle.focus();
    }
  });
}

if (/Win/i.test(navigator.userAgentData?.platform || navigator.platform || "")) {
  const windows = document.getElementById("os-windows");
  if (windows) windows.checked = true;
}

// The install box copies only its install line; a shell block in the docs
// copies its commands without the `#` comment lines that explain them.
function textToCopy(btn) {
  const install = btn.closest(".install-box");
  if (install) return install.querySelector(".install-cmd").textContent;
  return btn
    .closest(".code-block")
    .querySelector("code")
    .textContent.split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
}

// Without clearing the pending timer, a second click's feedback is wiped by
// the first click's timeout instead of lasting its own 1.5s.
const flashTimers = new Map();

function flash(btn, text) {
  btn.textContent = text;
  clearTimeout(flashTimers.get(btn));
  flashTimers.set(
    btn,
    setTimeout(() => {
      btn.textContent = "Copy";
    }, 1500),
  );
}

if (navigator.clipboard) {
  document.documentElement.classList.add("has-clipboard");
  for (const btn of document.querySelectorAll(".copy-btn")) {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(textToCopy(btn)).then(
        () => flash(btn, "Copied"),
        () => flash(btn, "Failed"),
      );
    });
  }
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// On a wide screen the demo plays while half of it is in view. On a phone it
// waits to be played: it is over a megabyte on a mobile connection, and playing at
// load it repainted the hero for as long as Lighthouse watched, which cost the
// mobile homepage its performance score. Save-Data and reduced motion keep it
// waiting too. The visitor's own choice wins over all of that: once they pause
// it, it stays paused (WCAG 2.2.2 asks for the pause; resuming behind their
// back would undo it), and once they play it, it resumes in view.
const demo = document.querySelector(".demo");
if (demo) {
  const autoplay =
    !reducedMotion &&
    !navigator.connection?.saveData &&
    matchMedia("(min-width: 1024px)").matches;
  const video = demo.querySelector("video");
  const toggle = demo.querySelector(".demo-toggle");
  let choice = null; // "play" or "pause", once the visitor has pressed the toggle
  // play() rejects when a pause interrupts it or the browser refuses autoplay;
  // either way the toggle still says Play, which is the state to report.
  const play = () => video.play().catch(() => {});

  video.addEventListener("playing", () => {
    demo.classList.add("has-played", "is-playing");
    toggle.setAttribute("aria-label", "Pause demo");
  });
  video.addEventListener("pause", () => {
    demo.classList.remove("is-playing");
    toggle.setAttribute("aria-label", "Play demo");
  });
  toggle.addEventListener("click", () => {
    choice = video.paused ? "play" : "pause";
    if (video.paused) play();
    else video.pause();
  });

  new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) video.pause();
      else if (choice === "play" || (choice === null && autoplay)) play();
    },
    { threshold: 0.5 },
  ).observe(demo);
}

// Each screen's visual fades in once, the first time a fifth of it shows. One
// already in view when the script runs is shown without the transition.
const reveals = document.querySelectorAll(".reveal");
if (reducedMotion) {
  for (const el of reveals) el.classList.add("is-visible");
} else if (reveals.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.2 },
  );
  for (const el of reveals) {
    const { top, bottom } = el.getBoundingClientRect();
    if (top < innerHeight && bottom > 0) {
      el.classList.add("is-instant", "is-visible");
    } else {
      observer.observe(el);
    }
  }
}
