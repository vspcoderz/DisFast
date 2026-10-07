import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * One shared IntersectionObserver for every deferred media element. Per
 * message this keeps heavy work (image/GIF decode, embed layout) off the
 * critical path when a channel opens with dozens of embeds.
 */
let observer: IntersectionObserver | null = null;
const pending = new WeakMap<Element, () => void>();

function getObserver(): IntersectionObserver {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const cb = pending.get(entry.target);
            if (cb) {
              pending.delete(entry.target);
              observer?.unobserve(entry.target);
              cb();
            }
          }
        }
      },
      // Start loading slightly before the element scrolls into view.
      { rootMargin: "800px 0px" },
    );
  }
  return observer;
}

interface Props {
  /** Rendered (cheap, text-only) until the element is near the viewport. */
  placeholder?: ReactNode;
  children: ReactNode;
}

/**
 * Defers children until within ~800px of the viewport. Used for embeds
 * and attachments, which are the expensive parts of a message.
 */
export function LazyMedia({ placeholder = null, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (shown) return;

    // If IntersectionObserver is unavailable, just render immediately.
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    const io = getObserver();
    const mark = () => setShown(true);
    pending.set(el, mark);
    io.observe(el);
    return () => {
      pending.delete(el);
      io.unobserve(el);
    };
  }, [shown]);

  return <div ref={ref}>{shown ? children : placeholder}</div>;
}