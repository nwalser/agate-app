// Value-click copy feedback: the copied text itself pops — a quick scale + a
// flash in the success color — so clicking a password/username/field reads as
// "copied" without a toast. Buttons use CopyButton instead (which also counts the
// clipboard-wipe down); this is for the inline copyable values that are not
// buttons (the detail-pane field rows, the list value cells).
//
// transform-based, so the pop never nudges surrounding layout. The class is added,
// the animation restarted via a reflow (so rapid re-clicks re-fire it), and removed
// on animationend to leave the DOM clean.

export function copyPop(target: EventTarget | null): void {
  if (!(target instanceof HTMLElement)) return;
  target.classList.remove('copied-pop');
  void target.offsetWidth; // force reflow so re-adding the class restarts the animation
  target.classList.add('copied-pop');
  target.addEventListener('animationend', () => target.classList.remove('copied-pop'), {
    once: true,
  });
}
