// Component tests for the Settings › Sidebar editor: reorder (arrows), show/hide,
// add divider, and add a saved view. Drives the real sidebar store (a singleton),
// reset to defaults per case. The drag itself is HTML5 DnD (not reproducible in
// jsdom); the reorder MATH is covered in lib/reorder.test.ts, so here we assert the
// affordance shape (grip draggable, row not) plus the non-drag mutators.

import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import SidebarSettings from './SidebarSettings.tsx';
import { DEFAULT_ORDER, isDividerId } from '../../lib/sidebarConfig.ts';
import { isHidden, resetSidebar, sidebar } from '../../state/sidebar.ts';

const all = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel));

describe('SidebarSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSidebar();
  });
  afterEach(cleanup);

  it('renders one reorderable row per entry; only the grip is draggable', () => {
    render(() => <SidebarSettings />);
    const rows = all('.sb-row');
    expect(rows.length).toBe(sidebar().order.length);
    for (const row of rows) expect(row.getAttribute('draggable')).not.toBe('true');
    const grips = all('.sb-row .sb-grip');
    expect(grips.length).toBe(rows.length);
    for (const grip of grips) expect(grip.getAttribute('draggable')).toBe('true');
  });

  it('Move down swaps the first two entries', () => {
    render(() => <SidebarSettings />);
    const [first, second] = DEFAULT_ORDER;
    fireEvent.click(all('button[title="Move down"]')[0]); // first row's down arrow
    expect(sidebar().order[0]).toBe(second);
    expect(sidebar().order[1]).toBe(first);
  });

  it('Hide marks a builtin hidden', () => {
    render(() => <SidebarSettings />);
    expect(isHidden('all')).toBe(false);
    fireEvent.click(all('button[title="Hide"]')[0]); // first row = "all"
    expect(isHidden('all')).toBe(true);
  });

  it('Add divider appends a divider entry', () => {
    render(() => <SidebarSettings />);
    const before = sidebar().order.length;
    fireEvent.click(all('.sb-add-divider')[0]);
    expect(sidebar().order.length).toBe(before + 1);
    expect(isDividerId(sidebar().order[sidebar().order.length - 1])).toBe(true);
  });

  it('adds a saved view from the form', () => {
    render(() => <SidebarSettings />);
    const input = document.querySelector<HTMLInputElement>('.sb-input');
    expect(input).toBeTruthy();
    fireEvent.input(input!, { target: { value: 'AWS logins' } });
    fireEvent.submit(input!.closest('form')!);
    const views = sidebar().queries;
    expect(views.length).toBe(1);
    expect(views[0].name).toBe('AWS logins');
  });
});
