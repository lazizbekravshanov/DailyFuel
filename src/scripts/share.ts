// The Share control in the header. ShareButton.astro renders it hidden, so with
// JS off, or on a browser that can neither share nor copy, there's no button
// that does nothing. This script shows it when the browser has one of the two.
//
// A tap opens the share sheet with a plain sentence and the page's
// canonical URL. When there's no share sheet, or it fails for any reason other
// than the reader closing it, the link goes on the clipboard and the status
// next to the button says so. When copying fails too, the status shows the
// link itself so it can be copied by hand. Nothing is sent anywhere and
// nothing is stored.
//
// It ships as an inline script: the component prints `(${shareButton})(...)`,
// so the function must stand alone, with no imports and no helpers outside
// its body.

export function shareButton(doc: Document, nav: Navigator): void {
  const box = doc.querySelector("[data-share]");
  const button = box && box.querySelector("button");
  const status = box && box.querySelector("[data-share-status]");
  const canShare = typeof nav.share == "function";
  const clip = nav.clipboard;
  const canCopy = Boolean(clip && typeof clip.writeText == "function");
  if (!box || !button || !status || (!canShare && !canCopy)) return;
  const url = button.getAttribute("data-url") as string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const say = (words: string, clear: boolean) => {
    clearTimeout(timer);
    status.textContent = words;
    if (clear) timer = setTimeout(() => (status.textContent = ""), 5000);
  };
  // Shown until the next tap, since it's there to be copied.
  const byHand = () => say(`Copy this link: ${url}`, false);
  const copy = () => {
    try {
      clip.writeText(url).then(() => say("Link copied", true), byHand);
    } catch (err) {
      byHand();
    }
  };
  const fallback = canCopy ? copy : byHand;
  button.addEventListener("click", () => {
    if (!canShare) return copy();
    // The reader closing the share sheet is an AbortError, and that's not a failure.
    const failed = (err: { name?: string } | null) => {
      if (!err || err.name !== "AbortError") fallback();
    };
    try {
      nav.share({ title: doc.title, text: button.getAttribute("data-text") as string, url }).then(undefined, failed);
    } catch (err) {
      failed(err as { name?: string });
    }
  });
  box.removeAttribute("hidden");
}
