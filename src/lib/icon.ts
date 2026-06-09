// The type of a lucide-solid icon component, for passing icons around as plain
// values (the command palette, the titlebar search preview, vault rows). lucide-solid
// generates every icon as `(props: LucideProps) => JSX.Element`, so we model exactly
// that — any icon is assignable, and it renders directly in JSX.

import type { JSX } from 'solid-js';
import type { LucideProps } from 'lucide-solid';

export type IconComponent = (props: LucideProps) => JSX.Element;
