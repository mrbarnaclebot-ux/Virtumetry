/** Dynamic import of the viewer, for React.lazy on the web share page (Pattern 10). Own module so jest can mock it. */
export const loadViewer = () => import('@/viewer/world-viewer');
