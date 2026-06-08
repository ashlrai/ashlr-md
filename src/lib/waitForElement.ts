/**
 * waitForElement — resolve once a selector is present in the DOM.
 *
 * Used after switching view modes, where the target element (e.g. the read
 * view's `.markdown-body`) mounts asynchronously. A `MutationObserver` is more
 * robust than a fixed `setTimeout` delay, which races on large docs or a cold
 * first render. Resolves with the element, or `null` after `timeoutMs`.
 */
export function waitForElement(
  selector: string,
  timeoutMs = 2500,
): Promise<Element | null> {
  const existing = document.querySelector(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (el: Element | null) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(el);
    };
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) finish(el);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => finish(document.querySelector(selector)), timeoutMs);
  });
}
