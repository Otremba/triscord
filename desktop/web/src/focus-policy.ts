// null means no available controls; undefined lets native Tab traversal continue.
export function modalTabTarget<T>(controls: readonly T[], active: T | null, backwards: boolean): T | null | undefined {
  if (!controls.length) return null;
  const index = active === null ? -1 : controls.indexOf(active);
  if (index < 0) return backwards ? controls[controls.length - 1] : controls[0];
  if (backwards && index === 0) return controls[controls.length - 1];
  if (!backwards && index === controls.length - 1) return controls[0];
  return undefined;
}
